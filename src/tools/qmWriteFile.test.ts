import { describe, it, expect, beforeEach } from "vitest";
import { qmWriteFileHandler } from "./qmWriteFile.js";
import { buildAgentFileReadCommand, buildAgentFileWriteCommand } from "./qmFiles.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { BackupStore } from "../backup/store.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import fs from "fs";
import os from "os";
import path from "path";

function makeConfig(tmpDir: string): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    snapshot: { perGuestCap: 3, vmstate: false },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200, qmWriteMaxBytes: 32 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  } as unknown as Config;
}

/** Prime the agent precheck (ping) + node resolution (hostname). */
function primeAgent(t: FakeTransport, vmid: number, node: string): void {
  t.setExecResult(`qm agent ${vmid} ping`, { stdout: "", stderr: "", exitCode: 0 });
  t.setExecResult("hostname", { stdout: `${node}\n`, stderr: "", exitCode: 0 });
}

function primeRead(t: FakeTransport, node: string, vmid: number, p: string, result: { stdout: string; stderr: string; exitCode: number }): void {
  t.setExecResult(buildAgentFileReadCommand(node, vmid, p), result);
}

function primeWrite(t: FakeTransport, node: string, vmid: number, p: string, content: Buffer): void {
  t.setExecResult(buildAgentFileWriteCommand(node, vmid, p, content.toString("base64")), {
    stdout: "", stderr: "", exitCode: 0,
  });
}

describe("qmWriteFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qmwrite-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("writes a NEW file via the agent and audits with vmid + qm_write_file", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/new.conf", { stdout: "", stderr: "No such file or directory", exitCode: 1 });
    primeWrite(t, "pve", 200, "/etc/new.conf", Buffer.from("new body"));

    const res = await qmWriteFileHandler(
      { vmid: 200, path: "/etc/new.conf", content: "new body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect("backupPath" in res && res.vmid).toBe(200);
    const records = audit.readAll();
    expect(records[0].tool).toBe("qm_write_file");
    expect(records[0].vmid).toBe(200);
    expect(records[0].prevSha256).toBeUndefined(); // new file → no prev hash
  });

  it("backs up the previous content before overwriting", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", {
      stdout: JSON.stringify({ content: "old body", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    primeWrite(t, "pve", 200, "/etc/app.conf", Buffer.from("new body"));

    const res = await qmWriteFileHandler(
      { vmid: 200, path: "/etc/app.conf", content: "new body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect("backupPath" in res && res.backupPath).toBeTruthy();
    const records = audit.readAll();
    expect(records[0].prevSha256).toBeTruthy();
  });

  // ADR-022 gap 1 — the hoisted diff-on-write output reaches the audit.db projector.
  it("forwards the unified diff to the audit.db projector on a text overwrite", async () => {
    const captured: Array<{ diff?: string | null }> = [];
    audit.setProjector({ project: (_r, extras) => captured.push(extras ?? {}) });

    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", {
      stdout: JSON.stringify({ content: "old body", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    primeWrite(t, "pve", 200, "/etc/app.conf", Buffer.from("new body"));

    await qmWriteFileHandler(
      { vmid: 200, path: "/etc/app.conf", content: "new body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].diff).toContain("+ new body");
    expect(captured[0].diff).toContain("- old body");
  });

  it("stores the backup under a qm: file key (distinct from host and pct)", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", { stdout: "", stderr: "No such file", exitCode: 1 });
    primeWrite(t, "pve", 200, "/etc/app.conf", Buffer.from("body"));

    await qmWriteFileHandler(
      { vmid: 200, path: "/etc/app.conf", content: "body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    const qmVersions = backupStore.listBackupsForPath({ kind: "qm", vmid: 200, remotePath: "/etc/app.conf" });
    const hostVersions = backupStore.listBackupsForPath({ kind: "host", remotePath: "/etc/app.conf" });
    const pctVersions = backupStore.listBackupsForPath({ kind: "pct", vmid: 200, remotePath: "/etc/app.conf" });
    expect(qmVersions.length).toBeGreaterThan(0);
    expect(hostVersions.length).toBe(0);
    expect(pctVersions.length).toBe(0);
  });

  it("refuses content over the guest-agent write cap", async () => {
    const t = new FakeTransport();
    // Cap is 32 in the test config; 40 bytes must be refused BEFORE any agent call.
    await expect(
      qmWriteFileHandler(
        { vmid: 200, path: "/etc/app.conf", content: "x".repeat(40), encoding: "utf8" },
        t, audit, backupStore, cfg
      )
    ).rejects.toThrow(/over the 32-byte guest-agent write cap/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("fails closed when the guest agent is unavailable (before any write)", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "agent down", exitCode: 1 });
    await expect(
      qmWriteFileHandler({ vmid: 200, path: "/etc/app.conf", content: "x", encoding: "utf8" }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/qemu-guest-agent/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("surfaces a non-not-found read error instead of treating it as a new file", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", { stdout: "", stderr: "permission denied", exitCode: 1 });
    await expect(
      qmWriteFileHandler({ vmid: 200, path: "/etc/app.conf", content: "x", encoding: "utf8" }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/file-read failed/i);
  });

  it("dryRun returns a unified diff and would-be metadata with zero side effects", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", {
      stdout: JSON.stringify({ content: "a\nb\nc\n", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    // NOTE: deliberately register NO write exec — a real write would still exit 0
    // by FakeTransport default, so assert side-effect-freeness via audit + backups.

    const res = (await qmWriteFileHandler(
      { vmid: 200, path: "/etc/app.conf", content: "a\nB\nc\n", encoding: "utf8", dryRun: true },
      t, audit, backupStore, cfg
    )) as Extract<Awaited<ReturnType<typeof qmWriteFileHandler>>, { dryRun: true }>;

    expect(res.dryRun).toBe(true);
    expect(res.vmid).toBe(200);
    expect(res.isNewFile).toBe(false);
    expect(res.diff).toContain("- b");
    expect(res.diff).toContain("+ B");
    expect(audit.readAll()).toHaveLength(0);
    expect(fs.existsSync(cfg.backup.baseDir)).toBe(false);
  });

  it("throws when the agent write itself fails (after backup)", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", { stdout: "", stderr: "No such file", exitCode: 1 });
    // Register the write command with a failure exit.
    t.setExecResult(buildAgentFileWriteCommand("pve", 200, "/etc/app.conf", Buffer.from("body").toString("base64")), {
      stdout: "", stderr: "guest disk full", exitCode: 1,
    });
    await expect(
      qmWriteFileHandler({ vmid: 200, path: "/etc/app.conf", content: "body", encoding: "utf8" }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/file-write failed/i);
  });
});
