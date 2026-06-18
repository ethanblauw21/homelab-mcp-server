import { describe, it, expect, beforeEach } from "vitest";
import {
  snapshotCreateHandler,
  snapshotListHandler,
  snapshotRollbackHandler,
  snapshotDeleteHandler,
} from "./snapshotTools.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import fs from "fs";
import os from "os";
import path from "path";

function makeConfig(tmpDir: string, overrides: Partial<Config["snapshot"]> = {}): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    snapshot: { perGuestCap: 3, vmstate: false, ...overrides },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

const PCT_LIST_101 = "VMID       Status     Lock         Name\n       101 running              ct1";
const NOW = new Date(Date.UTC(2026, 5, 9, 21, 30, 0)); // → mcp-20260609-213000

describe("snapshotCreateHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    cfg = makeConfig(tmpDir);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("creates a container snapshot, auto-detecting pct", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct snapshot 101 mcp-20260609-213000 --description 'before upgrade'", { stdout: "", stderr: "", exitCode: 0 });

    const res = await snapshotCreateHandler({ vmid: 101, note: "before upgrade" }, t, audit, cfg, NOW);
    expect(res).toMatchObject({ name: "mcp-20260609-213000", guestType: "pct", evicted: [] });
    expect(audit.readAll()[0].tool).toBe("snapshot_create");
    expect(audit.readAll()[0].vmid).toBe(101);
  });

  it("evicts the oldest mcp- snapshot when at cap, leaving user snapshots alone", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", {
      stdout: [
        "`-> keep-me              2026-01-01 manual",
        "`-> mcp-20260101-000000 2026-01-01 auto",
        "`-> mcp-20260102-000000 2026-01-02 auto",
        "`-> mcp-20260103-000000 2026-01-03 auto",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    t.setExecResult("pct delsnapshot 101 mcp-20260101-000000", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct snapshot 101 mcp-20260609-213000 --description 'x'", { stdout: "", stderr: "", exitCode: 0 });

    const res = await snapshotCreateHandler({ vmid: 101, note: "x" }, t, audit, cfg, NOW);
    expect(res.evicted).toEqual(["mcp-20260101-000000"]);
  });

  it("auto-detects qm and follows the vmstate config flag (A3.2)", async () => {
    const t = new FakeTransport();
    cfg = makeConfig(tmpDir, { vmstate: true });
    audit = new AuditLog(cfg.audit.logPath);
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 }); // 200 absent → qm
    t.setExecResult("qm listsnapshot 200", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("qm snapshot 200 mcp-20260609-213000 --vmstate 1", { stdout: "", stderr: "", exitCode: 0 });

    const res = await snapshotCreateHandler({ vmid: 200 }, t, audit, cfg, NOW);
    expect(res.guestType).toBe("qm");
  });

  it("surfaces storage-driver errors verbatim", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct snapshot 101 mcp-20260609-213000", { stdout: "", stderr: "storage does not support snapshots", exitCode: 1 });
    await expect(snapshotCreateHandler({ vmid: 101 }, t, audit, cfg, NOW)).rejects.toThrow(/does not support snapshots/i);
  });

  it("enriches a 'feature is not available' failure with the bind-mount blocker (#15)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct snapshot 101 mcp-20260609-213000", {
      stdout: "",
      stderr: "snapshot feature is not available",
      exitCode: 255,
    });
    // The CT101 real case: mp0 bind-mounts /mnt/media.
    t.setExecResult("pct config 101", {
      stdout: ["rootfs: local-lvm:vm-101-disk-0,size=8G", "mp0: /mnt/media,mp=/data"].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    await expect(snapshotCreateHandler({ vmid: 101 }, t, audit, cfg, NOW)).rejects.toThrow(
      /mp0 \(host dir \/mnt\/media bind-mounted at \/data\).*guest_backup/s
    );
    // The raw Proxmox string is preserved for the operator.
    await expect(snapshotCreateHandler({ vmid: 101 }, t, audit, cfg, NOW)).rejects.toThrow(
      /proxmox: snapshot feature is not available/
    );
  });

  it("falls back to the raw error when the config read fails (#15)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct snapshot 101 mcp-20260609-213000", {
      stdout: "",
      stderr: "snapshot feature is not available",
      exitCode: 255,
    });
    t.setExecResult("pct config 101", { stdout: "", stderr: "permission denied", exitCode: 1 });
    const err = await snapshotCreateHandler({ vmid: 101 }, t, audit, cfg, NOW).catch((e) => e as Error);
    expect(err.message).toContain("snapshot feature is not available");
    expect(err.message).not.toContain("[proxmox:"); // no enrichment wrapper
  });

  it("does NOT read the config for an unrelated failure (#15)", async () => {
    const t = new FakeTransport();
    const seen: string[] = [];
    const wrapped: typeof t.exec = async (cmd, ms) => {
      seen.push(cmd);
      return t.exec(cmd, ms);
    };
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct snapshot 101 mcp-20260609-213000", {
      stdout: "",
      stderr: "got lock request timeout",
      exitCode: 1,
    });
    await expect(
      snapshotCreateHandler({ vmid: 101 }, { ...t, exec: wrapped } as typeof t, audit, cfg, NOW)
    ).rejects.toThrow(/lock request timeout/);
    expect(seen).not.toContain("pct config 101");
  });
});

describe("snapshotListHandler", () => {
  it("lists snapshots and flags mcp-managed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    const cfg = makeConfig(tmpDir);
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct listsnapshot 101", { stdout: "`-> mcp-x 2026 auto\n`-> manual 2026 hand", stderr: "", exitCode: 0 });

    const res = await snapshotListHandler({ vmid: 101 }, t, cfg);
    expect(res.guestType).toBe("pct");
    expect(res.snapshots.find((s) => s.name === "mcp-x")?.mcpManaged).toBe(true);
    expect(res.snapshots.find((s) => s.name === "manual")?.mcpManaged).toBe(false);
  });
});

describe("snapshotRollbackHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    cfg = makeConfig(tmpDir);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("refuses without confirm: true", async () => {
    const t = new FakeTransport();
    await expect(
      snapshotRollbackHandler({ vmid: 101, name: "mcp-x", confirm: false, stopIfRunning: false }, t, audit, cfg)
    ).rejects.toThrow(/confirm: true/i);
  });

  it("refuses to roll back a non-mcp snapshot", async () => {
    const t = new FakeTransport();
    await expect(
      snapshotRollbackHandler({ vmid: 101, name: "manual", confirm: true, stopIfRunning: false }, t, audit, cfg)
    ).rejects.toThrow(/mcp-\*/i);
  });

  it("refuses a running guest without stopIfRunning", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    await expect(
      snapshotRollbackHandler({ vmid: 101, name: "mcp-x", confirm: true, stopIfRunning: false }, t, audit, cfg)
    ).rejects.toThrow(/stopIfRunning: true/i);
  });

  it("stops, rolls back, and restarts a running guest", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("pct stop 101", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct rollback 101 mcp-x", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct start 101", { stdout: "", stderr: "", exitCode: 0 });

    const res = await snapshotRollbackHandler({ vmid: 101, name: "mcp-x", confirm: true, stopIfRunning: true }, t, audit, cfg);
    expect(res).toMatchObject({ name: "mcp-x", guestType: "pct", restarted: true });
    const rec = audit.readAll()[0];
    expect(rec.tool).toBe("snapshot_rollback");
    expect(rec.isLargeChange).toBe(true);
  });

  it("records the disk-only consequence for VM rollbacks (A3.2)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 }); // 200 absent → qm
    t.setExecResult("qm status 200", { stdout: "status: stopped", stderr: "", exitCode: 0 });
    t.setExecResult("qm rollback 200 mcp-x", { stdout: "", stderr: "", exitCode: 0 });

    await snapshotRollbackHandler({ vmid: 200, name: "mcp-x", confirm: true, stopIfRunning: false }, t, audit, cfg);
    expect(audit.readAll()[0].note).toMatch(/disk-only/i);
  });
});

describe("snapshotDeleteHandler", () => {
  it("refuses to delete a non-mcp snapshot", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    const cfg = makeConfig(tmpDir);
    const audit = new AuditLog(cfg.audit.logPath);
    const t = new FakeTransport();
    await expect(snapshotDeleteHandler({ vmid: 101, name: "manual" }, t, audit, cfg)).rejects.toThrow(/mcp-\*/i);
  });

  it("deletes an mcp- snapshot and audits", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    const cfg = makeConfig(tmpDir);
    const audit = new AuditLog(cfg.audit.logPath);
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: PCT_LIST_101, stderr: "", exitCode: 0 });
    t.setExecResult("pct delsnapshot 101 mcp-x", { stdout: "", stderr: "", exitCode: 0 });

    const res = await snapshotDeleteHandler({ vmid: 101, name: "mcp-x" }, t, audit, cfg);
    expect(res).toMatchObject({ name: "mcp-x", guestType: "pct" });
    expect(audit.readAll()[0].tool).toBe("snapshot_delete");
  });
});
