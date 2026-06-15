import { describe, it, expect, beforeEach } from "vitest";
import { listBackupsHandler } from "./listBackups.js";
import { BackupStore } from "../backup/store.js";
import type { Config } from "../config.js";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
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

// Must match BackupStore's internal fileKey function
function fileKey(remotePath: string): string {
  return crypto.createHash("sha256").update(remotePath).digest("hex").slice(0, 16);
}

// fileKey for a docker target (descriptor docker:<vmid>:<container>:<path>).
function dockerKey(vmid: number, container: string, remotePath: string): string {
  return crypto.createHash("sha256").update(`docker:${vmid}:${container}:${remotePath}`).digest("hex").slice(0, 16);
}

function seedGzEntry(keyDir: string, ts: string, content = "data"): void {
  const gzBlob = zlib.gzipSync(Buffer.from(content));
  fs.writeFileSync(path.join(keyDir, `${ts}.gz`), gzBlob);
  fs.writeFileSync(path.join(keyDir, `${ts}.meta`), JSON.stringify({ kind: "gzip-full", hash: "abc" }));
}

function seedMetaEntry(keyDir: string, ts: string): void {
  fs.writeFileSync(path.join(keyDir, `${ts}.meta`), JSON.stringify({ kind: "metadata-only" }));
}

describe("listBackupsHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-backups-unit-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
  });

  it("returns the requested path in the result", async () => {
    const result = await listBackupsHandler({ path: "/tmp/test.txt" }, backupStore, cfg);
    expect(result.path).toBe("/tmp/test.txt");
  });

  it("returns empty array when no backups exist", async () => {
    const result = await listBackupsHandler({ path: "/tmp/test.txt" }, backupStore, cfg);
    expect(result.versions).toHaveLength(0);
  });

  it("lists a single gzip backup entry", async () => {
    const remotePath = "/tmp/test.txt";
    const key = fileKey(remotePath);
    const keyDir = path.join(cfg.backup.baseDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    seedGzEntry(keyDir, "2024-01-01T00-00-00-000Z");

    const result = await listBackupsHandler({ path: remotePath }, backupStore, cfg);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].revertible).toBe(true);
    expect(result.versions[0].kind).toBe("gzip-full");
    expect(result.versions[0].sizeBytes).toBeGreaterThan(0);
    expect(result.versions[0].timestamp).toBe("2024-01-01T00-00-00-000Z");
  });

  it("marks metadata-only entries as not revertible", async () => {
    const remotePath = "/tmp/test.txt";
    const key = fileKey(remotePath);
    const keyDir = path.join(cfg.backup.baseDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    seedMetaEntry(keyDir, "2024-01-01T00-00-00-000Z");

    const result = await listBackupsHandler({ path: remotePath }, backupStore, cfg);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].revertible).toBe(false);
    expect(result.versions[0].kind).toBe("metadata-only");
  });

  it("returns entries sorted newest first", async () => {
    const remotePath = "/tmp/test.txt";
    const key = fileKey(remotePath);
    const keyDir = path.join(cfg.backup.baseDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    seedGzEntry(keyDir, "2024-01-03T00-00-00-000Z");
    seedGzEntry(keyDir, "2024-01-01T00-00-00-000Z");
    seedGzEntry(keyDir, "2024-01-02T00-00-00-000Z");

    const result = await listBackupsHandler({ path: remotePath }, backupStore, cfg);
    expect(result.versions).toHaveLength(3);
    expect(result.versions[0].timestamp).toBe("2024-01-03T00-00-00-000Z");
    expect(result.versions[1].timestamp).toBe("2024-01-02T00-00-00-000Z");
    expect(result.versions[2].timestamp).toBe("2024-01-01T00-00-00-000Z");
  });

  it("returns nothing for a different path even when backupDir has other entries", async () => {
    const remotePath1 = "/tmp/test.txt";
    const remotePath2 = "/etc/hosts";
    const key1 = fileKey(remotePath1);
    const keyDir = path.join(cfg.backup.baseDir, key1);
    fs.mkdirSync(keyDir, { recursive: true });
    seedGzEntry(keyDir, "2024-01-01T00-00-00-000Z");

    const result = await listBackupsHandler({ path: remotePath2 }, backupStore, cfg);
    expect(result.versions).toHaveLength(0);
  });

  it("handles mixed gzip and metadata-only entries for the same path", async () => {
    const remotePath = "/tmp/test.txt";
    const key = fileKey(remotePath);
    const keyDir = path.join(cfg.backup.baseDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    seedGzEntry(keyDir, "2024-01-01T00-00-00-000Z");
    seedMetaEntry(keyDir, "2024-01-02T00-00-00-000Z");

    const result = await listBackupsHandler({ path: remotePath }, backupStore, cfg);
    expect(result.versions).toHaveLength(2);
    const revertible = result.versions.filter((v) => v.revertible);
    const metaOnly = result.versions.filter((v) => !v.revertible);
    expect(revertible).toHaveLength(1);
    expect(metaOnly).toHaveLength(1);
  });

  it("lists docker backups keyed on docker:<vmid>:<container>:<path>", async () => {
    const remotePath = "/config/app.conf";
    const keyDir = path.join(cfg.backup.baseDir, dockerKey(101, "web", remotePath));
    fs.mkdirSync(keyDir, { recursive: true });
    seedGzEntry(keyDir, "2024-01-01T00-00-00-000Z");

    const result = await listBackupsHandler({ path: remotePath, vmid: 101, container: "web" }, backupStore, cfg);
    expect(result.container).toBe("web");
    expect(result.versions).toHaveLength(1);
    // A pct-scoped query for the same vmid+path must NOT collide with the docker key.
    const pctResult = await listBackupsHandler({ path: remotePath, vmid: 101 }, backupStore, cfg);
    expect(pctResult.versions).toHaveLength(0);
  });

  it("rejects a container without a vmid", async () => {
    await expect(
      listBackupsHandler({ path: "/config/app.conf", container: "web" }, backupStore, cfg)
    ).rejects.toThrow(/requires `vmid`/i);
  });

  it("rejects a relative path", async () => {
    await expect(
      listBackupsHandler({ path: "relative/path.txt" }, backupStore, cfg)
    ).rejects.toThrow(/invalid path/i);
  });

  it("rejects a path traversal attempt", async () => {
    await expect(
      listBackupsHandler({ path: "/etc/../etc/shadow" }, backupStore, cfg)
    ).rejects.toThrow(/invalid path/i);
  });
});
