import { describe, it, expect, beforeEach } from "vitest";
import { revertFileHandler } from "./revertFile.js";
import { pctWriteFileHandler } from "./pctWriteFile.js";
import { buildAgentFileReadCommand, buildAgentFileWriteCommand } from "./qmFiles.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildPctStatusCommand, buildPctPullCommand, buildStatCommand } from "./pctFiles.js";
import { buildDockerInspectCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { RollbackBreaker } from "../guardrails/rollbackBreaker.js";
import { BackupStore } from "../backup/store.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

function makeFullConfig(tmpDir: string): Config {
  return {
    ssh: { host: "test-host", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    snapshot: { perGuestCap: 3, vmstate: false },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

function makeConfig(tmpDir: string): Config {
  return {
    ssh: { host: "test-host", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, commandTimeoutGraceMs: 10000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

function makeGzBackup(backupDir: string, content: string): string {
  const keyDir = path.join(backupDir, "anykey");
  fs.mkdirSync(keyDir, { recursive: true });
  const backupPath = path.join(keyDir, "2024-01-01T00-00-00-000Z.gz");
  fs.writeFileSync(backupPath, zlib.gzipSync(Buffer.from(content)));
  return backupPath;
}

describe("revertFileHandler", () => {
  let tmpDir: string;
  let transport: FakeTransport;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "revert-unit-"));
    transport = new FakeTransport();
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("throws for a non-existent backup path", async () => {
    await expect(
      revertFileHandler(
        { path: "/tmp/test.txt", backupPath: "/nonexistent/backup.gz" },
        transport, audit, backupStore, cfg
      )
    ).rejects.toThrow(/backup not found/i);
  });

  it("throws for a metadata-only backup (non-revertible)", async () => {
    const keyDir = path.join(cfg.backup.baseDir, "anykey");
    fs.mkdirSync(keyDir, { recursive: true });
    const metaPath = path.join(keyDir, "ts.meta");
    fs.writeFileSync(metaPath, JSON.stringify({ remotePath: "/tmp/test.txt", revertible: false }));

    await expect(
      revertFileHandler(
        { path: "/tmp/test.txt", backupPath: metaPath },
        transport, audit, backupStore, cfg
      )
    ).rejects.toThrow(/metadata-only/i);
  });

  it("restores file content from a gzip backup", async () => {
    const originalContent = "original file content";
    const backupPath = makeGzBackup(cfg.backup.baseDir, originalContent);
    transport.setFile("/tmp/test.txt", "current overwritten content");

    const result = await revertFileHandler(
      { path: "/tmp/test.txt", backupPath },
      transport, audit, backupStore, cfg
    );

    expect(result.restoredFrom).toBe(backupPath);
    expect(result.bytes).toBe(Buffer.from(originalContent).length);

    const written = await transport.readFile("/tmp/test.txt");
    expect(written.toString()).toBe(originalContent);
  });

  // ADR-022 gap 1 — a revert is a write, so its current→restored diff reaches the
  // audit.db projector via the extras side-channel.
  it("forwards the current→restored diff to the audit.db projector", async () => {
    const captured: Array<{ diff?: string | null }> = [];
    audit.setProjector({ project: (_r, extras) => captured.push(extras ?? {}) });

    const backupPath = makeGzBackup(cfg.backup.baseDir, "line one\nORIGINAL\nline three\n");
    transport.setFile("/tmp/test.txt", "line one\nCHANGED\nline three\n");

    await revertFileHandler(
      { path: "/tmp/test.txt", backupPath },
      transport, audit, backupStore, cfg
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].diff).toContain("- CHANGED");
    expect(captured[0].diff).toContain("+ ORIGINAL");
  });

  it("appends an audit record with tool=revert_file", async () => {
    const backupPath = makeGzBackup(cfg.backup.baseDir, "content");
    transport.setFile("/tmp/test.txt", "current");

    const result = await revertFileHandler(
      { path: "/tmp/test.txt", backupPath },
      transport, audit, backupStore, cfg
    );

    const records = audit.readAll();
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe("revert_file");
    expect(records[0].id).toBe(result.auditId);
    expect(records[0].path).toBe("/tmp/test.txt");
    expect(records[0].newSha256).toBeTruthy();
  });

  it("records prevSha256 of the file before restoring", async () => {
    const backupPath = makeGzBackup(cfg.backup.baseDir, "prev content");
    transport.setFile("/tmp/test.txt", "current content");

    await revertFileHandler(
      { path: "/tmp/test.txt", backupPath },
      transport, audit, backupStore, cfg
    );

    const records = audit.readAll();
    expect(records[0].prevSha256).toBeTruthy();
  });

  it("works when the target file does not yet exist (no prevSha256)", async () => {
    const backupPath = makeGzBackup(cfg.backup.baseDir, "fresh content");
    // transport has no file set for /tmp/new.txt — readFile will throw

    const result = await revertFileHandler(
      { path: "/tmp/new.txt", backupPath },
      transport, audit, backupStore, cfg
    );

    expect(result.auditId).toBeTruthy();
    const records = audit.readAll();
    expect(records[0].prevSha256).toBeUndefined();
  });

  it("rejects a relative path", async () => {
    await expect(
      revertFileHandler(
        { path: "relative/path.txt", backupPath: "/some/backup.gz" },
        transport, audit, backupStore, cfg
      )
    ).rejects.toThrow(/invalid path/i);
  });

  it("rejects a path traversal attempt", async () => {
    await expect(
      revertFileHandler(
        { path: "/etc/../etc/passwd", backupPath: "/some/backup.gz" },
        transport, audit, backupStore, cfg
      )
    ).rejects.toThrow(/invalid path/i);
  });

  // --- ADR-023 #6: latest-resolution when backupPath is omitted ---

  it("reverts the NEWEST revertible backup for a host path when backupPath is omitted", async () => {
    transport.setFile("/tmp/test.txt", "current\n");
    let seenTarget: unknown;
    const store = {
      readBackupTarget: () => {
        throw new Error("readBackupTarget must not be called on the latest-resolution path");
      },
      listBackupsForPath: (target: unknown) => {
        seenTarget = target;
        // newest-first; the newest is metadata-only so the newest REVERTIBLE wins.
        return [
          { backupPath: "/b/newest.meta", timestamp: "n", kind: "metadata-only", sizeBytes: 0, revertible: false },
          { backupPath: "/b/revertible.gz", timestamp: "r", kind: "gzip-full", sizeBytes: 9, revertible: true },
          { backupPath: "/b/older.gz", timestamp: "o", kind: "gzip-full", sizeBytes: 9, revertible: true },
        ];
      },
      restore: async (bp: string) => {
        expect(bp).toBe("/b/revertible.gz");
        return Buffer.from("reverted\n");
      },
    } as unknown as BackupStore;

    const res = await revertFileHandler({ path: "/tmp/test.txt" }, transport, audit, store, cfg);
    expect(seenTarget).toEqual({ kind: "host", remotePath: "/tmp/test.txt" });
    expect(res.restoredFrom).toBe("/b/revertible.gz");
    expect((await transport.readFile("/tmp/test.txt")).toString()).toBe("reverted\n");
    expect(audit.readAll()[0].note).toContain("/b/revertible.gz");
  });

  it("resolves a docker target from path+vmid+container for latest-resolution", async () => {
    let seenTarget: unknown;
    const store = {
      readBackupTarget: () => {
        throw new Error("unused");
      },
      listBackupsForPath: (target: unknown) => {
        seenTarget = target;
        return [];
      },
      restore: async () => Buffer.from(""),
    } as unknown as BackupStore;

    await expect(
      revertFileHandler({ path: "/config/app.conf", vmid: 101, container: "web" }, transport, audit, store, cfg)
    ).rejects.toThrow(/No backups found/);
    expect(seenTarget).toEqual({ kind: "docker", vmid: 101, container: "web", remotePath: "/config/app.conf" });
  });

  it("throws when neither backupPath nor path is supplied", async () => {
    await expect(revertFileHandler({}, transport, audit, backupStore, cfg)).rejects.toThrow(/either `backupPath`, or `path`/i);
  });

  it("throws when no revertible version exists for the target (only metadata-only)", async () => {
    const store = {
      readBackupTarget: () => {
        throw new Error("unused");
      },
      listBackupsForPath: () => [
        { backupPath: "/b/a.meta", timestamp: "a", kind: "metadata-only", sizeBytes: 0, revertible: false },
      ],
      restore: async () => null,
    } as unknown as BackupStore;
    await expect(
      revertFileHandler({ path: "/tmp/test.txt" }, transport, audit, store, cfg)
    ).rejects.toThrow(/No revertible.*backup found/i);
  });

  it("refuses a docker `container` without a `vmid` (shared resolver)", async () => {
    await expect(
      revertFileHandler({ path: "/config/app.conf", container: "web" }, transport, audit, backupStore, cfg)
    ).rejects.toThrow(/container.*requires.*vmid/i);
  });

  it("rejects a denylist path", async () => {
    const cfgWithDenylist: Config = {
      ...cfg,
      guardrails: { ...cfg.guardrails, pathDenylist: ["/proc"] },
    };

    await expect(
      revertFileHandler(
        { path: "/proc/self/mem", backupPath: "/some/backup.gz" },
        transport, audit, new BackupStore(cfgWithDenylist.backup), cfgWithDenylist
      )
    ).rejects.toThrow(/invalid path/i);
  });
});

describe("revertFileHandler — meta-routed targets", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "revert-route-"));
    cfg = makeFullConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("rejects a supplied path that does not match the backup meta", async () => {
    const res = await backupStore.storeBackup(
      { kind: "host", remotePath: "/etc/a.conf" },
      { type: "gzip-full", blob: zlib.gzipSync(Buffer.from("x")) },
      "h"
    );
    await expect(
      revertFileHandler({ backupPath: res.backupPath!, path: "/etc/b.conf" }, new FakeTransport(), audit, backupStore, cfg)
    ).rejects.toThrow(/path mismatch/i);
  });

  it("routes a container backup revert through the pct push flow", async () => {
    const t = new FakeTransport();
    // Establish a pct backup via an overwrite write.
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.RT", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.RT'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.RT", "OLD");
    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/app.conf'", { stdout: "644 0 0", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.RT' '/etc/app.conf' --perms '644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    const write = await pctWriteFileHandler(
      { vmid: 101, path: "/etc/app.conf", content: "NEW", encoding: "utf8" },
      t, audit, backupStore, cfg
    );
    // After the push, the node temp holds the freshly written bytes ("NEW"),
    // which the revert's pull will read back as the current content.

    const result = await revertFileHandler(
      { backupPath: write.backupPath! },
      t, audit, backupStore, cfg
    );

    expect(result.vmid).toBe(101);
    expect(result.bytes).toBe(3); // "OLD"
    // The revert pushed the restored bytes back through the temp.
    expect((await t.readFile("/tmp/tmp.RT")).toString()).toBe("OLD");
    const rec = audit.readAll().find((r) => r.tool === "revert_file");
    expect(rec?.vmid).toBe(101);
  });

  it("routes a VM backup revert through the guest-agent write flow", async () => {
    const t = new FakeTransport();
    // Stash a qm-targeted backup holding "OLD" (the content to restore).
    const stored = await backupStore.storeBackup(
      { kind: "qm", vmid: 200, remotePath: "/etc/app.conf" },
      { type: "gzip-full", blob: zlib.gzipSync(Buffer.from("OLD")) },
      "h"
    );

    // Revert flow: ping (agent) → hostname (node) → file-read (current) → file-write (restore).
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("hostname", { stdout: "pve\n", stderr: "", exitCode: 0 });
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/app.conf"), {
      stdout: JSON.stringify({ content: "NEW", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    t.setExecResult(buildAgentFileWriteCommand("pve", 200, "/etc/app.conf", Buffer.from("OLD").toString("base64")), {
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await revertFileHandler(
      { backupPath: stored.backupPath! },
      t, audit, backupStore, cfg
    );

    expect(result.vmid).toBe(200);
    expect(result.bytes).toBe(3); // "OLD"
    const rec = audit.readAll().find((r) => r.tool === "revert_file");
    expect(rec?.vmid).toBe(200);
    expect(rec?.prevSha256).toBeTruthy(); // current "NEW" was hashed before restore
  });

  it("routes a docker backup revert through the bind-mount write flow", async () => {
    const t = new FakeTransport();
    const BIND = JSON.stringify([{ Type: "bind", Source: "/srv/config", Destination: "/config", RW: true }]);
    // Stash a docker-targeted backup holding "OLD" (the bytes to restore).
    const stored = await backupStore.storeBackup(
      { kind: "docker", vmid: 101, container: "web", remotePath: "/config/app.conf" },
      { type: "gzip-full", blob: zlib.gzipSync(Buffer.from("OLD")) },
      "h"
    );

    // Revert flow: pct status → docker inspect → bind read (pct pull lxcPath) →
    // restore → bind write (stat perms + pct push lxcPath).
    t.setExecResult(buildPctStatusCommand(101), { stdout: "status: running\n", stderr: "", exitCode: 0 });
    t.setExecResult(buildPctExecCommand(101, buildDockerInspectCommand("web")), { stdout: `cid-web ${BIND}`, stderr: "", exitCode: 0 });
    // bind source path for /config/app.conf is /srv/config/app.conf
    t.setExecResult(buildPctPullCommand(101, "/srv/config/app.conf", "/tmp/node1"), { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/node1", stderr: "", exitCode: 0 });
    t.setFile("/tmp/node1", "NEW");
    t.setExecResult(buildStatCommand(101, "/srv/config/app.conf"), { stdout: "644 0 0\n", stderr: "", exitCode: 0 });

    const result = await revertFileHandler(
      { backupPath: stored.backupPath! },
      t, audit, backupStore, cfg
    );

    expect(result.vmid).toBe(101);
    expect(result.bytes).toBe(3); // "OLD"
    const rec = audit.readAll().find((r) => r.tool === "revert_file");
    expect(rec?.vmid).toBe(101);
    expect(rec?.container).toBe("web");
    expect(rec?.containerId).toBe("cid-web");
    expect(rec?.prevSha256).toBeTruthy(); // current "NEW" hashed before restore
  });
});

describe("revertFileHandler — rollback circuit breaker (ADR-021)", () => {
  let tmpDir: string;
  let transport: FakeTransport;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "revert-breaker-"));
    transport = new FakeTransport();
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  async function revertOnce(breaker: RollbackBreaker, overrideCircuitBreaker?: boolean) {
    const backupPath = makeGzBackup(cfg.backup.baseDir, "restored content");
    transport.setFile("/tmp/test.txt", "current content");
    return revertFileHandler(
      { path: "/tmp/test.txt", backupPath, overrideCircuitBreaker },
      transport, audit, backupStore, cfg, undefined, breaker
    );
  }

  it("refuses the Nth revert of one target and audits a refused row", async () => {
    const breaker = new RollbackBreaker({ enabled: true, limit: 3, windowMs: 600_000 });
    await revertOnce(breaker); // 1
    await revertOnce(breaker); // 2
    await expect(revertOnce(breaker)).rejects.toThrow(/circuit breaker tripped/i); // 3 ⇒ refuse

    const records = audit.readAll();
    const refusal = records.find((r) => r.refused);
    expect(refusal).toMatchObject({
      tool: "revert_file",
      refused: true,
      path: "/tmp/test.txt",
      circuitBreaker: { recentCount: 3, limit: 3, windowMs: 600_000 },
    });
    // The two successful reverts produced normal (non-refused) rows.
    expect(records.filter((r) => r.tool === "revert_file" && !r.refused)).toHaveLength(2);
  });

  it("override bypasses a tripped breaker and flags the success row", async () => {
    const breaker = new RollbackBreaker({ enabled: true, limit: 3, windowMs: 600_000 });
    await revertOnce(breaker); // 1
    await revertOnce(breaker); // 2
    await expect(revertOnce(breaker)).rejects.toThrow(/circuit breaker/i); // 3 ⇒ refuse

    const result = await revertOnce(breaker, true); // override ⇒ proceeds
    expect(result.bytes).toBeGreaterThan(0);
    const overridden = audit.readAll().find((r) => r.circuitBreakerOverridden);
    expect(overridden).toMatchObject({ tool: "revert_file", circuitBreakerOverridden: true });
    expect(overridden?.refused).toBeUndefined();
  });

  it("does not trip across distinct targets", async () => {
    const breaker = new RollbackBreaker({ enabled: true, limit: 2, windowMs: 600_000 });
    const back = makeGzBackup(cfg.backup.baseDir, "x");
    transport.setFile("/tmp/a.txt", "cur");
    transport.setFile("/tmp/b.txt", "cur");
    await revertFileHandler({ path: "/tmp/a.txt", backupPath: back }, transport, audit, backupStore, cfg, undefined, breaker);
    // A second revert of a DIFFERENT path must not trip B's (independent) counter.
    await expect(
      revertFileHandler({ path: "/tmp/b.txt", backupPath: back }, transport, audit, backupStore, cfg, undefined, breaker)
    ).resolves.toBeTruthy();
  });
});
