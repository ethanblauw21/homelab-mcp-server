import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import path from "path";
import os from "os";
import {
  ComputeTreeInputSchema,
  VerifyIntegrityInputSchema,
  AcceptTruthInputSchema,
  computeTreeHandler,
  verifyIntegrityHandler,
  acceptTruthHandler,
} from "./integrity.js";
import { IntegrityEngine } from "../integrity/integrityEngine.js";
import { MemoryNodeStore } from "../integrity/nodeStore.js";
import { AuditLog } from "../audit/log.js";
import { buildAuditRecord } from "../audit/record.js";
import { config as baseConfig, type Config } from "../config.js";
import type { ExecResult, SshTransport } from "../ssh/transport.js";

/** Minimal host-only transport: answers `pct list` (none) + a fixed /etc enumeration + sha256. */
class HostTransport implements SshTransport {
  files = new Map<string, { mtime: number; content: string }>([
    ["/etc/app.conf", { mtime: 100, content: "v1" }],
  ]);
  dirs = new Set(["/etc"]);

  async exec(command: string): Promise<ExecResult> {
    if (command === "pct list") return ok("VMID       Status     Lock         Name\n");
    if (command.includes("-printf '%y")) {
      const lines = [...this.dirs].map((d) => `d\t50\t${d}`);
      for (const [p, e] of this.files) lines.push(`f\t${e.mtime}\t${p}`);
      return ok(lines.join("\n") + "\n");
    }
    if (command.includes("sha256sum")) {
      const lines: string[] = [];
      for (const [p, e] of this.files) {
        if (command.includes(`'${p}'`)) lines.push(`${sha(e.content)}  ${p}`);
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

function sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function cfg(over: Partial<Config["integrity"]> = {}): Config {
  return {
    ...baseConfig,
    ssh: { ...baseConfig.ssh, host: "node", commandTimeoutMs: 1000 },
    history: { ...baseConfig.history, hostWatchPaths: ["/etc"], containerWatchPaths: ["/etc"], excludePatterns: [] },
    integrity: { ...baseConfig.integrity, ...over },
  };
}
function tmpAudit(): AuditLog {
  return new AuditLog(path.join(os.tmpdir(), `int-tool-${crypto.randomUUID()}.jsonl`));
}

describe("integrity tool input schemas", () => {
  it("accepts forest paths and rejects shell metacharacters in scope", () => {
    expect(ComputeTreeInputSchema.safeParse({ scope: "host/etc" }).success).toBe(true);
    expect(VerifyIntegrityInputSchema.safeParse({ level: "smart", autoAccept: true }).success).toBe(true);
    expect(AcceptTruthInputSchema.safeParse({ scope: "pct/101/etc" }).success).toBe(true);
    expect(AcceptTruthInputSchema.safeParse({ scope: "host/etc; rm -rf /" }).success).toBe(false);
    expect(VerifyIntegrityInputSchema.safeParse({ scope: "$(whoami)" }).success).toBe(false);
  });
});

describe("integrity handlers", () => {
  let transport: HostTransport;
  let store: MemoryNodeStore;
  let audit: AuditLog;
  let engine: IntegrityEngine;

  beforeEach(() => {
    transport = new HostTransport();
    store = new MemoryNodeStore();
    audit = tmpAudit();
    engine = new IntegrityEngine(store, transport, cfg(), audit);
  });

  it("compute_tree builds a baseline and writes an audit record", async () => {
    const res = await computeTreeHandler({ level: "l3" }, engine, audit, cfg());
    expect(res.nodeCount).toBeGreaterThan(0);
    expect(res.rootHash).toBeTruthy();
    expect(audit.readAll().some((r) => r.tool === "compute_tree" && r.id === res.auditId)).toBe(true);
  });

  it("verify_integrity seeds then reports an unexplained change (read-only, no audit)", async () => {
    await verifyIntegrityHandler({ level: "l3" }, engine, cfg()); // seed
    const auditCountAfterSeed = audit.readAll().length;
    transport.files.set("/etc/app.conf", { mtime: 200, content: "TAMPERED" });
    const report = (await verifyIntegrityHandler({ level: "l3" }, engine, cfg())) as {
      drift: { path: string; status: string }[];
    };
    const hit = report.drift.find((d) => d.path === "host/etc/app.conf");
    expect(hit?.status).toBe("unexplained");
    // verify is read-only: it must not append audit records.
    expect(audit.readAll().length).toBe(auditCountAfterSeed);
  });

  it("verify_integrity autoAccept folds an explained change and audits the fold", async () => {
    await verifyIntegrityHandler({ level: "l3" }, engine, cfg()); // seed
    transport.files.set("/etc/app.conf", { mtime: 200, content: "v2" });
    const probe = (await verifyIntegrityHandler({ level: "l3" }, engine, cfg())) as {
      drift: { path: string; newHash?: string }[];
    };
    const newHash = probe.drift.find((d) => d.path === "host/etc/app.conf")!.newHash!;
    await audit.append(buildAuditRecord({ tool: "write_file", path: "/etc/app.conf", afterHash: newHash }));
    const res = (await verifyIntegrityHandler({ level: "l3", autoAccept: true }, engine, cfg())) as {
      autoAccepted: { path: string }[];
    };
    expect(res.autoAccepted.some((o) => o.path === "host/etc/app.conf")).toBe(true);
  });

  it("accept_truth folds current state and labels the scope", async () => {
    await verifyIntegrityHandler({ level: "l3" }, engine, cfg()); // seed
    transport.files.set("/etc/app.conf", { mtime: 200, content: "v2" });
    const res = await acceptTruthHandler({}, engine, cfg());
    expect(res.scope).toBe("/");
    expect(audit.readAll().some((r) => r.tool === "accept_truth" && r.id === res.auditId)).toBe(true);
    const after = (await verifyIntegrityHandler({ level: "l3" }, engine, cfg())) as { drift: unknown[] };
    expect(after.drift).toEqual([]);
  });
});
