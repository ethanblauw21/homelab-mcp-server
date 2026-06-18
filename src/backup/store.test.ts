import { describe, it, expect, beforeEach } from "vitest";
import { BackupStore } from "./store.js";
import { writeFileHandler } from "../tools/writeFile.js";
import { revertFileHandler } from "../tools/revertFile.js";
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

describe("BackupStore — ADR-014 chain anchor + dedup-map exclusion", () => {
  let tmpDir: string;
  let cfg: Config;
  let store: BackupStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-014-"));
    cfg = makeConfig(tmpDir);
    store = new BackupStore(cfg.backup);
  });

  const target = { kind: "host" as const, remotePath: "/etc/svc.conf" };

  it("latestBaseHash returns null with no backups, then the newest meta hash", async () => {
    expect(store.latestBaseHash(target)).toBeNull();

    await store.storeBackup(target, { type: "gzip-full", blob: Buffer.from("a") }, "HASH_OLD");
    await new Promise((r) => setTimeout(r, 5)); // distinct ISO timestamp
    await store.storeBackup(target, { type: "gzip-full", blob: Buffer.from("b") }, "HASH_NEW");

    expect(store.latestBaseHash(target)).toBe("HASH_NEW");
  });

  it("storeBackup persists requiresBaseHash + reanchored into the meta", async () => {
    const res = await store.storeBackup(
      target,
      { type: "gzip-diff", blob: Buffer.from("d"), requiresBaseHash: "BASE" },
      "NEWH"
    );
    const meta = JSON.parse(fs.readFileSync(res.backupPath!.replace(/\.gz$/, ".meta"), "utf8"));
    expect(meta.requiresBaseHash).toBe("BASE");
    expect(meta.reanchored).toBe(false);

    const versions = store.listBackupsForPath(target);
    expect(versions[0].requiresBaseHash).toBe("BASE");
    expect(versions[0].reanchored).toBe(false);
    expect(versions[0].hash).toBe("NEWH");
  });

  it("a re-anchor snapshot is excluded from the dedup map (blob ≠ meta hash)", async () => {
    // The blob holds prevContent ("DRIFTED") but the meta hash records newContent.
    await store.storeBackup(
      target,
      { type: "gzip-full", blob: Buffer.from("DRIFTED"), reanchored: true },
      "NEWCONTENT_HASH"
    );
    const map = store.buildExistingHashMap(cfg.backup.baseDir);
    expect(map.has("NEWCONTENT_HASH")).toBe(false);
  });

  it("a normal gzip-full IS in the dedup map", async () => {
    await store.storeBackup(target, { type: "gzip-full", blob: Buffer.from("x") }, "NORMAL_HASH");
    const map = store.buildExistingHashMap(cfg.backup.baseDir);
    expect(map.has("NORMAL_HASH")).toBe(true);
  });
});
