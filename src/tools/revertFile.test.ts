import { describe, it, expect, beforeEach } from "vitest";
import { revertFileHandler } from "./revertFile.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { BackupStore } from "../backup/store.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

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
