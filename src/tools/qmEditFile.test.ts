import { describe, it, expect, beforeEach } from "vitest";
import { qmEditFileHandler } from "./qmEditFile.js";
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

function primeAgent(t: FakeTransport, vmid: number, node: string): void {
  t.setExecResult(`qm agent ${vmid} ping`, { stdout: "", stderr: "", exitCode: 0 });
  t.setExecResult("hostname", { stdout: `${node}\n`, stderr: "", exitCode: 0 });
}
/** Prime the agent read of `p` to return `body` (or not-found when null). */
function primeRead(t: FakeTransport, node: string, vmid: number, p: string, body: string | null): void {
  if (body === null) {
    t.setExecResult(buildAgentFileReadCommand(node, vmid, p), { stdout: "", stderr: "No such file or directory", exitCode: 1 });
  } else {
    t.setExecResult(buildAgentFileReadCommand(node, vmid, p), {
      stdout: JSON.stringify({ content: body, truncated: false }),
      stderr: "",
      exitCode: 0,
    });
  }
}
function primeWrite(t: FakeTransport, node: string, vmid: number, p: string, content: Buffer): void {
  t.setExecResult(buildAgentFileWriteCommand(node, vmid, p, content.toString("base64")), { stdout: "", stderr: "", exitCode: 0 });
}

describe("qmEditFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qmedit-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("replaces a unique occurrence and audits under the honest tool name qm_edit_file", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", "port = 8080\n");
    primeWrite(t, "pve", 200, "/etc/app.conf", Buffer.from("port = 9090\n"));

    const res = await qmEditFileHandler(
      { vmid: 200, path: "/etc/app.conf", oldString: "8080", newString: "9090", replaceAll: false },
      t, audit, backupStore, cfg
    );

    expect("backupPath" in res && res.vmid).toBe(200);
    const records = audit.readAll();
    expect(records[0].tool).toBe("qm_edit_file");
    expect(records[0].afterHash).toBeTruthy();
    expect(records[0].beforeHash).toBeTruthy();
  });

  it("audit + backup parity: an edit matches the equivalent qm write byte-for-byte", async () => {
    const tw = new FakeTransport();
    primeAgent(tw, 200, "pve");
    primeRead(tw, "pve", 200, "/etc/p.conf", "k = old\n");
    primeWrite(tw, "pve", 200, "/etc/p.conf", Buffer.from("k = new\n"));
    await qmWriteFileHandler({ vmid: 200, path: "/etc/p.conf", content: "k = new\n", encoding: "utf8" }, tw, audit, backupStore, cfg);
    const writeRec = audit.readAll()[0];

    const te = new FakeTransport();
    primeAgent(te, 200, "pve");
    primeRead(te, "pve", 200, "/etc/p.conf", "k = old\n");
    primeWrite(te, "pve", 200, "/etc/p.conf", Buffer.from("k = new\n"));
    await qmEditFileHandler({ vmid: 200, path: "/etc/p.conf", oldString: "old", newString: "new", replaceAll: false }, te, audit, backupStore, cfg);
    const editRec = audit.readAll()[0];

    expect(editRec.afterHash).toBe(writeRec.afterHash);
    expect(editRec.beforeHash).toBe(writeRec.beforeHash);
  });

  it("refuses an ambiguous (non-unique) oldString and writes nothing", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/hosts", "10.0.0.1 a\n10.0.0.1 b\n");
    await expect(
      qmEditFileHandler({ vmid: 200, path: "/etc/hosts", oldString: "10.0.0.1", newString: "x", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/occurs 2 times|must be unique/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses when oldString is not found", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", "nothing here\n");
    await expect(
      qmEditFileHandler({ vmid: 200, path: "/etc/app.conf", oldString: "absent", newString: "x", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not found/i);
  });

  it("refuses to edit a file that does not exist (points at qm_write_file)", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/missing.conf", null);
    await expect(
      qmEditFileHandler({ vmid: 200, path: "/etc/missing.conf", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/does not exist.*qm_write_file/i);
  });

  it("refuses an edit that grows the file past the guest-agent write cap", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    // 30-byte file; replacing 'x' with 30 'y's pushes it well past the 32-byte cap.
    primeRead(t, "pve", 200, "/etc/app.conf", "x".repeat(30));
    await expect(
      qmEditFileHandler({ vmid: 200, path: "/etc/app.conf", oldString: "x".repeat(30), newString: "y".repeat(40), replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/over the 32-byte guest-agent write cap/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("fails closed when the guest agent is unavailable", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "agent down", exitCode: 1 });
    await expect(
      qmEditFileHandler({ vmid: 200, path: "/etc/app.conf", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/qemu-guest-agent/i);
  });

  it("dryRun returns a diff with zero side effects", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    primeRead(t, "pve", 200, "/etc/app.conf", "a\nb\nc\n");
    const res = await qmEditFileHandler(
      { vmid: 200, path: "/etc/app.conf", oldString: "b", newString: "B", replaceAll: false, dryRun: true },
      t, audit, backupStore, cfg
    );
    if (!("dryRun" in res)) throw new Error("expected dryRun result");
    expect(res.diff).toContain("+ B");
    expect(audit.readAll()).toHaveLength(0);
  });
});
