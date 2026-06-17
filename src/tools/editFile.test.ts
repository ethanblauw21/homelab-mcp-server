import { describe, it, expect, beforeEach } from "vitest";
import { editFileHandler } from "./editFile.js";
import { writeFileHandler } from "./writeFile.js";
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
  } as unknown as Config;
}

type WriteResult = Awaited<ReturnType<typeof editFileHandler>>;
const real = (r: WriteResult) => {
  if ("dryRun" in r) throw new Error("expected a real write result");
  return r;
};

describe("editFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "editfile-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("replaces a unique occurrence and writes the full new file", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/app.conf", "port = 8080\nname = x\n");

    const res = real(
      await editFileHandler(
        { path: "/etc/app.conf", oldString: "8080", newString: "9090", replaceAll: false },
        t, audit, backupStore, cfg
      )
    );

    expect((await t.readFile("/etc/app.conf")).toString()).toBe("port = 9090\nname = x\n");
    expect(res.newFile).toBe(false);
    expect(res.diff).toContain("+ port = 9090");
    expect(res.backupPath).toBeTruthy();
  });

  it("records the audit under the HONEST tool name edit_file (not write_file)", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/app.conf", "a=1\n");
    await editFileHandler(
      { path: "/etc/app.conf", oldString: "a=1", newString: "a=2", replaceAll: false },
      t, audit, backupStore, cfg
    );
    const records = audit.readAll();
    expect(records[0].tool).toBe("edit_file");
    // ADR-009 hash anchors are stamped exactly as a write would (pipeline parity).
    expect(records[0].afterHash).toBeTruthy();
    expect(records[0].beforeHash).toBeTruthy();
    expect(records[0].hashScope).toBe("/etc/app.conf");
  });

  it("audit + backup parity: an edit is indistinguishable from the equivalent write", async () => {
    // Same starting file, same resulting bytes — one via write, one via edit.
    const tw = new FakeTransport();
    tw.setFile("/etc/p.conf", "k = old\n");
    await writeFileHandler({ path: "/etc/p.conf", content: "k = new\n", encoding: "utf8" }, tw, audit, backupStore, cfg);
    const writeRec = audit.readAll()[0];

    const te = new FakeTransport();
    te.setFile("/etc/p.conf", "k = old\n");
    await editFileHandler({ path: "/etc/p.conf", oldString: "old", newString: "new", replaceAll: false }, te, audit, backupStore, cfg);
    const editRec = audit.readAll()[0]; // newest first

    expect((await te.readFile("/etc/p.conf")).toString()).toBe((await tw.readFile("/etc/p.conf")).toString());
    // Identical mutation ⇒ identical content anchors; only the tool name differs.
    expect(editRec.afterHash).toBe(writeRec.afterHash);
    expect(editRec.beforeHash).toBe(writeRec.beforeHash);
  });

  it("replaceAll replaces every occurrence", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/hosts", "10.0.0.1 a\n10.0.0.1 b\n");
    const res = real(
      await editFileHandler(
        { path: "/etc/hosts", oldString: "10.0.0.1", newString: "10.0.0.2", replaceAll: true },
        t, audit, backupStore, cfg
      )
    );
    expect((await t.readFile("/etc/hosts")).toString()).toBe("10.0.0.2 a\n10.0.0.2 b\n");
    expect(res.diff).toContain("10.0.0.2");
  });

  it("refuses an ambiguous (non-unique) oldString and writes nothing", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/hosts", "10.0.0.1 a\n10.0.0.1 b\n");
    await expect(
      editFileHandler({ path: "/etc/hosts", oldString: "10.0.0.1", newString: "x", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/occurs 2 times|must be unique/i);
    expect(audit.readAll()).toHaveLength(0);
    expect((await t.readFile("/etc/hosts")).toString()).toBe("10.0.0.1 a\n10.0.0.1 b\n");
  });

  it("refuses when oldString is not found", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/app.conf", "nothing here\n");
    await expect(
      editFileHandler({ path: "/etc/app.conf", oldString: "absent", newString: "x", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not found/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses a no-op edit (oldString === newString)", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/app.conf", "same\n");
    await expect(
      editFileHandler({ path: "/etc/app.conf", oldString: "same", newString: "same", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not change/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses to edit a file that does not exist (points at write_file)", async () => {
    const t = new FakeTransport();
    await expect(
      editFileHandler({ path: "/etc/missing.conf", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/does not exist.*write_file/i);
  });

  it("refuses to edit binary content (points at write_file)", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/blob.bin", Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    await expect(
      editFileHandler({ path: "/etc/blob.bin", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/binary/i);
  });

  it("dryRun returns a diff with zero side effects", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/app.conf", "a\nb\nc\n");
    const res = await editFileHandler(
      { path: "/etc/app.conf", oldString: "b", newString: "B", replaceAll: false, dryRun: true }, t, audit, backupStore, cfg
    );
    if (!("dryRun" in res)) throw new Error("expected dryRun result");
    expect(res.dryRun).toBe(true);
    expect(res.diff).toContain("+ B");
    expect(audit.readAll()).toHaveLength(0);
    // File untouched.
    expect((await t.readFile("/etc/app.conf")).toString()).toBe("a\nb\nc\n");
  });
});
