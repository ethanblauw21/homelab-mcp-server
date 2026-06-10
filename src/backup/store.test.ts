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
