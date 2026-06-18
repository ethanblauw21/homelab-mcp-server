import { describe, it, expect, beforeEach } from "vitest";
import { BackupStore } from "./store.js";
import { writeFileHandler } from "../tools/writeFile.js";
import { revertFileHandler } from "../tools/revertFile.js";
import { contentHash } from "./policy.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
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

describe("BackupStore — dedup → revert round-trip (regression for meta/blob defect)", () => {
  let tmpDir: string;
  let cfg: Config;
  let store: BackupStore;
  let audit: AuditLog;
  let transport: FakeTransport;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
    cfg = makeConfig(tmpDir);
    store = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
    transport = new FakeTransport();
  });

  it("a deduplicated backup points at a blob (not a .meta) and is revertible", async () => {
    transport.setFile("/etc/app.conf", "ORIGINAL");

    // First write of NEW content X — establishes a backup blob for X's hash.
    await writeFileHandler({ path: "/etc/app.conf", content: "NEWCONTENT", encoding: "utf8" }, transport, audit, store, cfg);
    // Simulate the file now holding the written content.
    transport.setFile("/etc/app.conf", "NEWCONTENT");

    // Second write of the SAME content X — must deduplicate.
    const second = await writeFileHandler({ path: "/etc/app.conf", content: "NEWCONTENT", encoding: "utf8" }, transport, audit, store, cfg);

    expect(second.revertible).toBe(true);
    // The defect: dedup resolved hash → .meta, which restore() refuses. The fix
    // resolves hash → blob, so the dedup backupPath is a real .gz blob.
    expect(second.backupPath).toMatch(/\.gz$/);

    // Reverting via the dedup pointer must succeed (not throw "metadata-only").
    const result = await revertFileHandler(
      { backupPath: second.backupPath!, path: "/etc/app.conf" },
      transport, audit, store, cfg
    );
    expect(result.bytes).toBeGreaterThan(0);
  });
});

describe("BackupStore — #20 re-anchor on out-of-band drift (end-to-end)", () => {
  let tmpDir: string;
  let cfg: Config;
  let store: BackupStore;
  let audit: AuditLog;
  let transport: FakeTransport;
  const TARGET = { kind: "host" as const, remotePath: "/etc/app.conf" };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
    cfg = makeConfig(tmpDir);
    store = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
    transport = new FakeTransport();
  });

  const write = (content: string) =>
    writeFileHandler({ path: "/etc/app.conf", content, encoding: "utf8" }, transport, audit, store, cfg);

  it("latestBaseHash tracks the hash of the most recently written content", async () => {
    expect(store.latestBaseHash(TARGET)).toBeNull(); // nothing written yet

    transport.setFile("/etc/app.conf", "line1\nline2\n");
    await write("line1\nline2\nline3\n");
    transport.setFile("/etc/app.conf", "line1\nline2\nline3\n"); // write landed

    // The newest backup's base is the live content the next delta will diff against.
    expect(store.latestBaseHash(TARGET)).toBe(contentHash(Buffer.from("line1\nline2\nline3\n")));
  });

  it("a delta backup reports honestly: non-revertible without a live hash, revertible with the matching one", async () => {
    transport.setFile("/etc/app.conf", "line1\nline2\n");
    await write("line1\nline2\nline3\n"); // delta of "line1\nline2\n", anchored to hash(new)
    transport.setFile("/etc/app.conf", "line1\nline2\nline3\n");

    const liveHash = contentHash(Buffer.from("line1\nline2\nline3\n"));

    // Observe-tier list (no node access): a delta cannot be confirmed.
    const blind = store.listBackupsForPath(TARGET);
    expect(blind[0].revertible).toBe(false);
    expect(blind[0].requiresLiveMatch).toBe(true);
    expect(blind[0].baseHash).toBe(liveHash);

    // Companion-tier list with the matching live hash: now confirmed revertible.
    const seeing = store.listBackupsForPath(TARGET, liveHash);
    expect(seeing[0].revertible).toBe(true);

    // A non-matching live hash (drifted): still non-revertible, stale-base.
    const drifted = store.listBackupsForPath(TARGET, contentHash(Buffer.from("something-else")));
    expect(drifted[0].revertible).toBe(false);
    expect(drifted[0].revertibleReason).toBe("stale-base");
  });

  it("re-anchors to a self-contained full copy when the live file drifted out-of-band", async () => {
    transport.setFile("/etc/app.conf", "line1\nline2\n");
    await write("line1\nline2\nline3\n");
    transport.setFile("/etc/app.conf", "line1\nline2\nline3\n"); // managed write landed

    // Out-of-band edit (a hand `sed -i`, a package upgrade) the server never saw.
    transport.setFile("/etc/app.conf", "line1\nEDITED\nline3\n");

    // Next managed write: prevHash != lastBackupBaseHash → re-anchor.
    await write("line1\nEDITED\nline3\nline4\n");

    // The newest backup must be self-contained (a delta would be born stale).
    const versions = store.listBackupsForPath(TARGET); // no live hash on purpose
    const newest = versions[0];
    expect(newest.revertible).toBe(true);
    expect(newest.requiresLiveMatch).toBeFalsy();

    // And it restores the pre-write out-of-band content WITHOUT needing live bytes.
    const restored = await store.restore(newest.backupPath);
    expect(restored?.toString("utf8")).toBe("line1\nEDITED\nline3\n");
  });
});

describe("BackupStore — meta target descriptor", () => {
  let tmpDir: string;
  let cfg: Config;
  let store: BackupStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
    cfg = makeConfig(tmpDir);
    store = new BackupStore(cfg.backup);
  });

  it("round-trips a pct target descriptor through the meta", async () => {
    const target = { kind: "pct" as const, vmid: 101, remotePath: "/etc/app.conf" };
    const res = await store.storeBackup(target, { type: "gzip-full", blob: Buffer.from("x") }, "hash123");
    const read = store.readBackupTarget(res.backupPath!);
    expect(read).toEqual(target);
  });

  it("interprets legacy meta without a target as a host write", async () => {
    const keyDir = path.join(cfg.backup.baseDir, "legacykey");
    fs.mkdirSync(keyDir, { recursive: true });
    const metaPath = path.join(keyDir, "ts.meta");
    fs.writeFileSync(metaPath, JSON.stringify({ remotePath: "/etc/legacy.conf", hash: "h" }));
    expect(store.readBackupTarget(metaPath)).toEqual({ kind: "host", remotePath: "/etc/legacy.conf" });
  });
});
