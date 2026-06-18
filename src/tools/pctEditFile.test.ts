import { describe, it, expect, beforeEach } from "vitest";
import { pctEditFileHandler } from "./pctEditFile.js";
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

/** Register the read plumbing (status + pull) so readPctPrev returns `body`. */
function primeRead(t: FakeTransport, vmid: number, p: string, body: string | Buffer | null): void {
  t.setExecResult(`pct status ${vmid}`, { stdout: "status: running", stderr: "", exitCode: 0 });
  t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.E", stderr: "", exitCode: 0 });
  if (body === null) {
    t.setExecResult(`pct pull ${vmid} '${p}' '/tmp/tmp.E'`, { stdout: "", stderr: "No such file", exitCode: 1 });
  } else {
    t.setExecResult(`pct pull ${vmid} '${p}' '/tmp/tmp.E'`, { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.E", body);
  }
}

describe("pctEditFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pctedit-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("replaces a unique occurrence and audits under the honest tool name pct_edit_file", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/app.conf", "port = 8080\n");
    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/app.conf'", { stdout: "644 0 0", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.E' '/etc/app.conf' --perms '644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    const res = await pctEditFileHandler(
      { vmid: 101, path: "/etc/app.conf", oldString: "8080", newString: "9090", replaceAll: false },
      t, audit, backupStore, cfg
    );

    expect(res.vmid).toBe(101);
    expect((await t.readFile("/tmp/tmp.E")).toString()).toBe("port = 9090\n");
    const records = audit.readAll();
    expect(records[0].tool).toBe("pct_edit_file");
    expect(records[0].afterHash).toBeTruthy();
    expect(records[0].beforeHash).toBeTruthy();
  });

  it("replaceAll replaces every occurrence", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/hosts", "10.0.0.1 a\n10.0.0.1 b\n");
    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/hosts'", { stdout: "644 0 0", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.E' '/etc/hosts' --perms '644' --user 0 --group 0", { stdout: "", stderr: "", exitCode: 0 });

    await pctEditFileHandler(
      { vmid: 101, path: "/etc/hosts", oldString: "10.0.0.1", newString: "10.0.0.2", replaceAll: true },
      t, audit, backupStore, cfg
    );
    expect((await t.readFile("/tmp/tmp.E")).toString()).toBe("10.0.0.2 a\n10.0.0.2 b\n");
  });

  it("refuses an ambiguous (non-unique) oldString and writes nothing", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/hosts", "10.0.0.1 a\n10.0.0.1 b\n");
    await expect(
      pctEditFileHandler({ vmid: 101, path: "/etc/hosts", oldString: "10.0.0.1", newString: "x", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/occurs 2 times|must be unique/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses when oldString is not found", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/app.conf", "nothing here\n");
    await expect(
      pctEditFileHandler({ vmid: 101, path: "/etc/app.conf", oldString: "absent", newString: "x", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not found/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses a no-op edit", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/app.conf", "same\n");
    await expect(
      pctEditFileHandler({ vmid: 101, path: "/etc/app.conf", oldString: "same", newString: "same", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not change/i);
  });

  it("refuses to edit a file that does not exist (points at pct_write_file)", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/missing.conf", null);
    await expect(
      pctEditFileHandler({ vmid: 101, path: "/etc/missing.conf", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/does not exist.*pct_write_file/i);
  });

  it("refuses to edit binary content (points at pct_write_file)", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/blob.bin", Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    await expect(
      pctEditFileHandler({ vmid: 101, path: "/etc/blob.bin", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/binary/i);
  });

  it("dryRun returns a diff with zero side effects", async () => {
    const t = new FakeTransport();
    primeRead(t, 101, "/etc/app.conf", "a\nb\nc\n");
    const res = await pctEditFileHandler(
      { vmid: 101, path: "/etc/app.conf", oldString: "b", newString: "B", replaceAll: false, dryRun: true },
      t, audit, backupStore, cfg
    );
    if (!("dryRun" in res)) throw new Error("expected dryRun result");
    expect(res.diff).toContain("+ B");
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses to edit in a stopped container (A3.1)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: stopped", stderr: "", exitCode: 0 });
    await expect(
      pctEditFileHandler({ vmid: 101, path: "/etc/app.conf", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not running/i);
  });
});
