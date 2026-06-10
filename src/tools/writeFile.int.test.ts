import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { inject } from "vitest";

const dockerAvailable = inject("dockerAvailable");
const describeIfDocker = dockerAvailable ? describe : describe.skip;
import fs from "fs";
import os from "os";
import path from "path";
import { Ssh2Transport } from "../ssh/ssh2Client.js";
import { writeFileHandler } from "./writeFile.js";
import { BackupStore } from "../backup/store.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

// Build a minimal config for each test run against real SSH + local temp dirs
function makeConfig(backupDir: string, auditPath: string): Config {
  return {
    ssh: {
      host: inject("sshHost"),
      port: inject("sshPort"),
      username: "root",
      privateKeyPath: inject("sshKeyPath"),
      keepaliveInterval: 5_000,
      reconnectDelay: 1_000,
      commandTimeoutMs: 10_000,
      commandTimeoutGraceMs: 10_000,
      skipHostVerification: true,
    },
    backup: {
      baseDir: backupDir,
      largeFileBytesThreshold: 1024,
      largeFilePolicy: "diff",
      perFileVersionCap: 10,
      globalSizeCapBytes: 50 * 1024 * 1024,
      diskPressureFailSafe: "warn",
    },
    audit: { logPath: auditPath },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: {
      commandDenylist: [],
      pathAllowlist: undefined,
      pathDenylist: [],
    },
  };
}

let transport: Ssh2Transport;
let tmpDir: string;

beforeAll(() => {
  transport = new Ssh2Transport({
    host: inject("sshHost"),
    port: inject("sshPort"),
    username: "root",
    privateKeyPath: inject("sshKeyPath"),
    keepaliveInterval: 5_000,
    reconnectDelay: 1_000,
    commandTimeoutMs: 10_000,
    commandTimeoutGraceMs: 10_000,
    skipHostVerification: true,
  });
});

afterAll(async () => {
  await transport.close();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-write-"));
});

function makeDeps(tmpDir: string) {
  const backupDir = path.join(tmpDir, "backups");
  const auditPath = path.join(tmpDir, "audit.jsonl");
  const cfg = makeConfig(backupDir, auditPath);
  const backupStore = new BackupStore(cfg.backup);
  const audit = new AuditLog(auditPath);
  return { cfg, backupStore, audit, backupDir, auditPath };
}

describeIfDocker("writeFile end-to-end (real SSH + local backup/audit)", () => {
  const remotePath = "/tmp/mcp-int-writefile-test.txt";
  const v1 = "version one content";
  const v2 = "version two content — changed";

  it("writes a file and creates a backup + audit entry", async () => {
    const { cfg, backupStore, audit, auditPath } = makeDeps(tmpDir);

    const result = await writeFileHandler(
      { path: remotePath, content: v1, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    expect(result.auditId).toBeTruthy();
    // New file: backup exists (gzip-full of... nothing, since there was no prev)
    // The audit log should have one record
    const records = new AuditLog(auditPath).readAll();
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe("write_file");
    expect(records[0].path).toBe(remotePath);
    expect(records[0].newSha256).toBeTruthy();
    expect(records[0].id).toBe(result.auditId);
    // Verify the file was actually written on the remote
    const written = await transport.readFile(remotePath);
    expect(written.toString()).toBe(v1);
  });

  it("backs up the prior version before overwriting", async () => {
    const { cfg, backupStore, audit, auditPath } = makeDeps(tmpDir);

    // Write v1
    await writeFileHandler(
      { path: remotePath, content: v1, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    // Write v2 — must back up v1 first
    const result2 = await writeFileHandler(
      { path: remotePath, content: v2, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    expect(result2.revertible).toBe(true);
    expect(result2.backupPath).toBeTruthy();

    const records = new AuditLog(auditPath).readAll();
    const r2 = records.find((r) => r.id === result2.auditId)!;
    expect(r2.prevSha256).toBeTruthy();
    expect(r2.prevBackup).toBe(result2.backupPath);
  });

  it("revert restores byte-identical content", async () => {
    const { cfg, backupStore, audit } = makeDeps(tmpDir);

    // Write v1, then v2
    await writeFileHandler(
      { path: remotePath, content: v1, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );
    const result2 = await writeFileHandler(
      { path: remotePath, content: v2, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    // Delta backups need the current file content (v2) to apply against.
    const currentContent = await transport.readFile(remotePath);
    const restored = await backupStore.restore(result2.backupPath!, currentContent);
    expect(restored).not.toBeNull();
    expect(restored!.toString()).toBe(v1);

    // Actually write it back and verify
    await transport.writeFile(remotePath, restored!);
    const final = await transport.readFile(remotePath);
    expect(final.toString()).toBe(v1);
  });

  it("dedup: two writes with identical content store exactly one backup blob", async () => {
    const { cfg, backupStore, audit, backupDir } = makeDeps(tmpDir);

    await writeFileHandler(
      { path: remotePath, content: v1, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    // Second write with identical content
    await writeFileHandler(
      { path: remotePath, content: v1, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    // Count all .gz blobs under backupDir — should be at most 1 (dedup)
    const gzFiles = fs.readdirSync(backupDir, { recursive: true, encoding: "utf8" })
      .filter((f) => (f as string).endsWith(".gz"));
    expect(gzFiles.length).toBeLessThanOrEqual(1);
  });

  it("audit log is append-only: records survive across handler calls", async () => {
    const { cfg, backupStore, audit, auditPath } = makeDeps(tmpDir);

    await writeFileHandler(
      { path: remotePath, content: v1, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );
    await writeFileHandler(
      { path: remotePath, content: v2, encoding: "utf8" },
      transport,
      audit,
      backupStore,
      cfg
    );

    const records = new AuditLog(auditPath).readAll();
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.tool === "write_file")).toBe(true);
  });
});

describeIfDocker("cleanup / retention (real filesystem)", () => {
  const remotePath = "/tmp/mcp-int-retention-test.txt";

  it("evicts oldest entries when over per-file cap", async () => {
    const { cfg, backupDir } = makeDeps(tmpDir);
    const tightCfg: Config = {
      ...cfg,
      backup: { ...cfg.backup, perFileVersionCap: 3, globalSizeCapBytes: 50 * 1024 * 1024 },
    };
    const tightStore = new BackupStore(tightCfg.backup);
    const audit = new AuditLog(tightCfg.audit.logPath);

    // Write 5 distinct versions
    for (let i = 0; i < 5; i++) {
      await writeFileHandler(
        { path: remotePath, content: `version ${i}`, encoding: "utf8" },
        transport,
        audit,
        tightStore,
        tightCfg
      );
      // Tiny sleep so timestamps are distinct
      await new Promise((r) => setTimeout(r, 20));
    }

    // Manually run eviction to ensure cap is applied
    tightStore.runEviction();

    const gzFiles = fs.readdirSync(backupDir, { recursive: true, encoding: "utf8" })
      .filter((f) => (f as string).endsWith(".gz"));
    expect(gzFiles.length).toBeLessThanOrEqual(3);
  });

  it("global size cap: evicts until total is within cap", async () => {
    const { cfg, backupDir } = makeDeps(tmpDir);
    // tiny 512-byte cap — each write will push us over it
    const tightCfg: Config = {
      ...cfg,
      backup: { ...cfg.backup, perFileVersionCap: 100, globalSizeCapBytes: 512 },
    };
    const tightStore = new BackupStore(tightCfg.backup);
    const audit = new AuditLog(tightCfg.audit.logPath);

    for (let i = 0; i < 5; i++) {
      await writeFileHandler(
        { path: remotePath, content: `content version ${i} — with some padding to bulk it up a bit`, encoding: "utf8" },
        transport,
        audit,
        tightStore,
        tightCfg
      );
      await new Promise((r) => setTimeout(r, 20));
    }

    tightStore.runEviction();

    const totalSize = fs.readdirSync(backupDir, { recursive: true, encoding: "utf8" })
      .filter((f) => (f as string).endsWith(".gz"))
      .reduce((sum, f) => sum + fs.statSync(path.join(backupDir, f as string)).size, 0);

    expect(totalSize).toBeLessThanOrEqual(512);
  });
});
