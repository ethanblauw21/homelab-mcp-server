import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeFileHandler, type WriteFileDryRunResult } from "./writeFile.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { BackupStore } from "../backup/store.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

function makeConfig(tmpDir: string): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, commandTimeoutGraceMs: 10000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

describe("writeFileHandler dryRun (ADR-004 §6)", () => {
  let tmpDir: string;
  let transport: FakeTransport;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-dry-"));
    transport = new FakeTransport();
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("returns a unified diff and would-be metadata without side effects", async () => {
    transport.setFile("/etc/app.conf", "a\nb\nc\n");

    const r = (await writeFileHandler(
      { path: "/etc/app.conf", content: "a\nB\nc\n", encoding: "utf8", dryRun: true },
      transport,
      audit,
      backupStore,
      cfg
    )) as WriteFileDryRunResult;

    expect(r.dryRun).toBe(true);
    expect(r.diff).toContain("- b");
    expect(r.diff).toContain("+ B");
    expect(r.isNewFile).toBe(false);

    // No write
    expect((await transport.readFile("/etc/app.conf")).toString()).toBe("a\nb\nc\n");
    // No audit record
    expect(audit.readAll()).toHaveLength(0);
    // No backup blobs
    expect(fs.existsSync(cfg.backup.baseDir)).toBe(false);
  });

  it("flags a new file in the preview", async () => {
    const r = (await writeFileHandler(
      { path: "/etc/new.conf", content: "hello\n", encoding: "utf8", dryRun: true },
      transport,
      audit,
      backupStore,
      cfg
    )) as WriteFileDryRunResult;

    expect(r.isNewFile).toBe(true);
    expect(r.isLargeChange).toBe(true); // new file is a large change
    expect(r.diff).toContain("+ hello");
    expect(audit.readAll()).toHaveLength(0);
  });

  it("omits the diff for binary content", async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64");
    const r = (await writeFileHandler(
      { path: "/etc/blob.bin", content: bin, encoding: "base64", dryRun: true },
      transport,
      audit,
      backupStore,
      cfg
    )) as WriteFileDryRunResult;

    expect(r.diff).toBeNull();
    expect(r.note).toMatch(/binary/i);
  });
});
