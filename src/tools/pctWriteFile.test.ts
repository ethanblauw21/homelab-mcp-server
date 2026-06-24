import { describe, it, expect, beforeEach } from "vitest";
import { pctWriteFileHandler } from "./pctWriteFile.js";
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
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

describe("pctWriteFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pctwrite-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("writes a NEW file with default perms and audits with vmid", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/new.conf' '/tmp/tmp.W'", { stdout: "", stderr: "No such file", exitCode: 1 });
    t.setExecResult("pct push 101 '/tmp/tmp.W' '/etc/new.conf' --perms '0644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    const res = await pctWriteFileHandler(
      { vmid: 101, path: "/etc/new.conf", content: "new body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect(res.vmid).toBe(101);
    // ADR-008 §3 diff-on-write: new file ⇒ newFile true, diff against empty.
    expect("newFile" in res && res.newFile).toBe(true);
    expect("diff" in res && res.diff).toContain("+ new body");
    expect((await t.readFile("/tmp/tmp.W")).toString()).toBe("new body");
    const records = audit.readAll();
    expect(records[0].tool).toBe("pct_write_file");
    expect(records[0].vmid).toBe(101);
  });

  it("preserves the existing file's perms via stat on overwrite", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.W'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.W", "old body");
    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/app.conf'", { stdout: "640 0 33", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.W' '/etc/app.conf' --perms '640' --user 0 --group 33", { stdout: "", stderr: "", exitCode: 0 });

    const res = await pctWriteFileHandler(
      { vmid: 101, path: "/etc/app.conf", content: "new body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect(res.backupPath).toBeTruthy();
    // ADR-008 §3 diff-on-write: overwrite ⇒ newFile false, diff old→new.
    expect("newFile" in res && res.newFile).toBe(false);
    expect("diff" in res && res.diff).toContain("+ new body");
    // The push used the stat'd perms (640 0:33) — assert by the bytes staged.
    expect((await t.readFile("/tmp/tmp.W")).toString()).toBe("new body");
    const records = audit.readAll();
    expect(records[0].prevSha256).toBeTruthy();
  });

  it("stores the backup under a pct: file key (distinct from the host path)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.W'", { stdout: "", stderr: "No such file", exitCode: 1 });
    t.setExecResult("pct push 101 '/tmp/tmp.W' '/etc/app.conf' --perms '0644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    await pctWriteFileHandler(
      { vmid: 101, path: "/etc/app.conf", content: "body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    // The pct target should list a backup version; a host target for the same
    // path should not collide with it.
    const pctVersions = backupStore.listBackupsForPath({ kind: "pct", vmid: 101, remotePath: "/etc/app.conf" });
    const hostVersions = backupStore.listBackupsForPath({ kind: "host", remotePath: "/etc/app.conf" });
    expect(pctVersions.length).toBeGreaterThan(0);
    expect(hostVersions.length).toBe(0);
  });

  it("refuses to write to a stopped container (A3.1)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: stopped", stderr: "", exitCode: 0 });
    await expect(
      pctWriteFileHandler({ vmid: 101, path: "/etc/app.conf", content: "x", encoding: "utf8" }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not running/i);
  });

  it("surfaces a non-not-found pull error instead of treating it as a new file", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.W'", { stdout: "", stderr: "permission denied", exitCode: 1 });
    await expect(
      pctWriteFileHandler({ vmid: 101, path: "/etc/app.conf", content: "x", encoding: "utf8" }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/pct pull failed/i);
  });

  it("dryRun returns a unified diff and would-be metadata without side effects (ADR-004 §6)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.W'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.W", "a\nb\nc\n");

    const res = (await pctWriteFileHandler(
      { vmid: 101, path: "/etc/app.conf", content: "a\nB\nc\n", encoding: "utf8", dryRun: true },
      t, audit, backupStore, cfg
    )) as Extract<Awaited<ReturnType<typeof pctWriteFileHandler>>, { dryRun: true }>;

    expect(res.dryRun).toBe(true);
    expect(res.vmid).toBe(101);
    expect(res.isNewFile).toBe(false);
    expect(res.diff).toContain("- b");
    expect(res.diff).toContain("+ B");
    // No push attempted (no pct push exec result was registered — a push would throw).
    // No audit record, no backup blobs.
    expect(audit.readAll()).toHaveLength(0);
    expect(fs.existsSync(cfg.backup.baseDir)).toBe(false);
  });

  it("dryRun flags a new file in the preview", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/new.conf' '/tmp/tmp.W'", { stdout: "", stderr: "No such file", exitCode: 1 });

    const res = (await pctWriteFileHandler(
      { vmid: 101, path: "/etc/new.conf", content: "hello\n", encoding: "utf8", dryRun: true },
      t, audit, backupStore, cfg
    )) as Extract<Awaited<ReturnType<typeof pctWriteFileHandler>>, { dryRun: true }>;

    expect(res.isNewFile).toBe(true);
    expect(res.isLargeChange).toBe(true); // new file is a large change
    expect(res.diff).toContain("+ hello");
    expect(audit.readAll()).toHaveLength(0);
  });

  // ADR-022 gap 1 — the diff-on-write output reaches the audit.db projector via
  // the extras side-channel (previously only write_file/edit_file did this).
  it("forwards the unified diff to the audit.db projector on a text overwrite", async () => {
    const captured: Array<{ diff?: string | null }> = [];
    audit.setProjector({ project: (_r, extras) => captured.push(extras ?? {}) });

    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.W'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.W", "old body");
    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/app.conf'", { stdout: "644 0 0", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.W' '/etc/app.conf' --perms '644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    await pctWriteFileHandler(
      { vmid: 101, path: "/etc/app.conf", content: "new body", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].diff).toContain("+ new body");
    expect(captured[0].diff).toContain("- old body");
  });

  it("forwards diff: null to the projector on a binary write", async () => {
    const captured: Array<{ diff?: string | null }> = [];
    audit.setProjector({ project: (_r, extras) => captured.push(extras ?? {}) });

    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.W", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/blob.bin' '/tmp/tmp.W'", { stdout: "", stderr: "No such file", exitCode: 1 });
    t.setExecResult("pct push 101 '/tmp/tmp.W' '/etc/blob.bin' --perms '0644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    // A NUL byte makes the content non-text ⇒ diff omitted.
    await pctWriteFileHandler(
      { vmid: 101, path: "/etc/blob.bin", content: Buffer.from([0x00, 0x01, 0x02]).toString("base64"), encoding: "base64" },
      t, audit, backupStore, cfg
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].diff).toBeNull();
  });
});
