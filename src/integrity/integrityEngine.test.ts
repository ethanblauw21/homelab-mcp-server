import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import { IntegrityEngine, forestToNodePath } from "./integrityEngine.js";
import { MemoryNodeStore } from "./nodeStore.js";
import { AuditLog } from "../audit/log.js";
import { buildAuditRecord } from "../audit/record.js";
import { config as baseConfig, type Config } from "../config.js";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import path from "path";
import os from "os";

interface FsEntry {
  kind: "file" | "dir";
  mtime: number;
  content?: string;
}

/**
 * A node-FS-backed transport: answers `pct list`, `pct status`, the forest `find`
 * enumeration, and `sha256sum` from in-memory filesystems (host + per-vmid).
 */
class NodeFsTransport implements SshTransport {
  host = new Map<string, FsEntry>();
  containers = new Map<number, Map<string, FsEntry>>();
  runningVmids = new Set<number>();

  async exec(command: string): Promise<ExecResult> {
    if (command === "pct list") {
      const lines = ["VMID       Status     Lock         Name"];
      for (const vmid of this.containers.keys()) {
        lines.push(`${vmid}        ${this.runningVmids.has(vmid) ? "running" : "stopped"}              ct${vmid}`);
      }
      return ok(lines.join("\n") + "\n");
    }
    const statusMatch = /^pct status (\d+)$/.exec(command);
    if (statusMatch) {
      const vmid = Number(statusMatch[1]);
      return ok(`status: ${this.runningVmids.has(vmid) ? "running" : "stopped"}\n`);
    }
    const vmidExec = /pct exec (\d+) -- sh -c/.exec(command);
    const fsForCmd = vmidExec ? this.containers.get(Number(vmidExec[1])) ?? new Map() : this.host;
    if (command.includes("-printf '%y")) {
      const lines: string[] = [];
      for (const [p, e] of fsForCmd) lines.push(`${e.kind === "dir" ? "d" : "f"}\t${e.mtime}\t${p}`);
      return ok(lines.join("\n") + "\n");
    }
    if (command.includes("sha256sum")) {
      const lines: string[] = [];
      for (const [p, e] of fsForCmd) {
        if (e.kind === "file" && command.includes(`'${p}'`)) {
          lines.push(`${crypto.createHash("sha256").update(e.content ?? "").digest("hex")}  ${p}`);
        }
      }
      return ok(lines.join("\n") + "\n");
    }
    return ok("");
  }
  async stat() { return { size: 0 }; }
  async readFile() { return Buffer.alloc(0); }
  async writeFile() {}
  async list() { return []; }
  async close() {}
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function tmpAuditLog(): AuditLog {
  const p = path.join(os.tmpdir(), `int-engine-${crypto.randomUUID()}.jsonl`);
  return new AuditLog(p);
}

function cfg(over: Partial<Config["integrity"]> = {}): Config {
  return {
    ...baseConfig,
    ssh: { ...baseConfig.ssh, host: "node", commandTimeoutMs: 1000 },
    history: { ...baseConfig.history, hostWatchPaths: ["/etc"], containerWatchPaths: ["/etc"], excludePatterns: [] },
    integrity: { ...baseConfig.integrity, ...over },
  };
}

describe("forestToNodePath", () => {
  it("strips the host/ and pct/<vmid>/ namespaces", () => {
    expect(forestToNodePath("host/etc/pve/x")).toBe("/etc/pve/x");
    expect(forestToNodePath("pct/101/etc/a")).toBe("/etc/a");
    expect(forestToNodePath("host")).toBe("/");
  });
});

describe("IntegrityEngine.verify", () => {
  let transport: NodeFsTransport;
  let store: MemoryNodeStore;
  let audit: AuditLog;

  beforeEach(() => {
    transport = new NodeFsTransport();
    transport.host.set("/etc", { kind: "dir", mtime: 50 });
    transport.host.set("/etc/app.conf", { kind: "file", mtime: 100, content: "v1" });
    transport.host.set("/etc/data.bin", { kind: "file", mtime: 100, content: "blob" });
    store = new MemoryNodeStore();
    audit = tmpAuditLog();
  });

  it("seeds the baseline on first run and reports no drift", async () => {
    const engine = new IntegrityEngine(store, transport, cfg(), audit);
    const report = await engine.verify("l3");
    expect(report.baselineSeeded).toBe(true);
    expect(report.drift).toEqual([]);
    expect(store.allUnder("baseline", "l3", "/").length).toBeGreaterThan(0);
  });

  it("detects an unexplained config-content change at L3", async () => {
    const engine = new IntegrityEngine(store, transport, cfg(), audit);
    await engine.verify("l3"); // seed
    transport.host.set("/etc/app.conf", { kind: "file", mtime: 200, content: "v2-CHANGED" });
    const report = await engine.verify("l3");
    const hit = report.drift.find((d) => d.path === "host/etc/app.conf");
    expect(hit).toBeTruthy();
    expect(hit!.status).toBe("unexplained");
  });

  it("classifies a change as explained when an audit afterHash matches the new subtree hash", async () => {
    const engine = new IntegrityEngine(store, transport, cfg(), audit);
    await engine.verify("l3"); // seed
    transport.host.set("/etc/app.conf", { kind: "file", mtime: 200, content: "v2" });
    // Pre-compute what the new leaf hash will be and plant an audit record claiming it.
    const probe = await engine.verify("l3");
    const newHash = probe.drift.find((d) => d.path === "host/etc/app.conf")!.newHash!;
    await audit.append(buildAuditRecord({ tool: "write_file", path: "/etc/app.conf", afterHash: newHash }));
    const report = await engine.verify("l3");
    const hit = report.drift.find((d) => d.path === "host/etc/app.conf")!;
    expect(hit.status).toBe("explained");
    expect(hit.explainedBy?.tool).toBe("write_file");
  });

  it("smart mode reads no content when L1 is clean (escalation gate)", async () => {
    const engine = new IntegrityEngine(store, transport, cfg(), audit);
    await engine.verify("smart"); // seed all levels
    let sawSha = false;
    const orig = transport.exec.bind(transport);
    transport.exec = async (c: string) => {
      if (c.includes("sha256sum")) sawSha = true;
      return orig(c);
    };
    const report = await engine.verify("smart");
    expect(report.drift).toEqual([]);
    expect(sawSha).toBe(false); // clean L1 ⇒ never escalates to content hashing
  });
});

describe("IntegrityEngine accept-truth", () => {
  let transport: NodeFsTransport;
  let store: MemoryNodeStore;
  let audit: AuditLog;

  beforeEach(() => {
    transport = new NodeFsTransport();
    transport.host.set("/etc", { kind: "dir", mtime: 50 });
    transport.host.set("/etc/app.conf", { kind: "file", mtime: 100, content: "v1" });
    store = new MemoryNodeStore();
    audit = tmpAuditLog();
  });

  it("explicit acceptTruth folds current state into the baseline and audits it", async () => {
    const engine = new IntegrityEngine(store, transport, cfg(), audit);
    await engine.verify("l3"); // seed
    transport.host.set("/etc/app.conf", { kind: "file", mtime: 200, content: "v2" });
    const before = store.get("baseline", "l3", "host/etc/app.conf")!.hash;
    const res = await engine.acceptTruth();
    expect(store.get("baseline", "l3", "host/etc/app.conf")!.hash).not.toBe(before);
    expect(audit.readAll().some((r) => r.tool === "accept_truth" && r.id === res.auditId)).toBe(true);
    // After accept, a re-verify shows no drift (baseline matches reality).
    expect((await engine.verify("l3")).drift).toEqual([]);
  });

  it("autoAccept folds an unexplained L1-only mtime touch but flags an L2 config change", async () => {
    transport.host.set("/etc/noise.bin", { kind: "file", mtime: 100, content: "x" });
    const engine = new IntegrityEngine(store, transport, cfg({ maxUnexplainedL3: 0 }), audit);
    await engine.verify("smart"); // seed
    // L1-only touch: mtime moves, content identical → should auto-fold.
    transport.host.set("/etc/noise.bin", { kind: "file", mtime: 999, content: "x" });
    // L2 config content change → should stay flagged by default.
    transport.host.set("/etc/app.conf", { kind: "file", mtime: 200, content: "CHANGED" });
    const { folded, flagged } = await engine.autoAccept("smart");
    expect(folded.some((o) => o.path === "host/etc/noise.bin" && o.reason === "l1-only")).toBe(true);
    expect(flagged.some((o) => o.path === "host/etc/app.conf" && o.reason === "l2-config")).toBe(true);
    // every fold is audited
    expect(audit.readAll().filter((r) => r.tool === "accept_truth" && r.note?.includes("auto-accept")).length).toBe(
      folded.length
    );
  });

  it("autoAccept never folds a sensitive path even when unexplained and L1-only", async () => {
    transport.host.set("/etc/pve", { kind: "dir", mtime: 50 });
    transport.host.set("/etc/pve/storage.cfg", { kind: "file", mtime: 100, content: "s" });
    const engine = new IntegrityEngine(store, transport, cfg(), audit);
    await engine.verify("smart"); // seed
    transport.host.set("/etc/pve/storage.cfg", { kind: "file", mtime: 777, content: "s" }); // mtime touch only
    const { folded, flagged } = await engine.autoAccept("smart");
    expect(folded.some((o) => o.path.includes("/etc/pve/"))).toBe(false);
    expect(flagged.some((o) => o.path === "host/etc/pve/storage.cfg" && o.reason === "sensitive")).toBe(true);
  });
});
