import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { dockerEditFileHandler } from "./dockerEditFile.js";
import { dockerWriteFileHandler, type DockerWriteFileResult } from "./dockerWriteFile.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildPctStatusCommand, buildMkTempCommand, buildPctPullCommand, buildStatCommand } from "./pctFiles.js";
import { buildDockerInspectCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { BackupStore } from "../backup/store.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

function makeConfig(tmpDir: string): Config {
  return {
    ssh: { host: "h", commandTimeoutMs: 5000 },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  } as unknown as Config;
}

const NODE_TMP = "/tmp/node1";
const BIND_MOUNTS = JSON.stringify([{ Type: "bind", Source: "/srv/config", Destination: "/config", RW: true }]);

/** Prime the bind-mount fast-path read of `/config/<file>` → host `/srv/config/<file>`. */
function primeBindRead(t: FakeTransport, vmid: number, container: string, srcPath: string, body: string | Buffer): void {
  t.setExecResult(buildPctStatusCommand(vmid), { stdout: "status: running\n", stderr: "", exitCode: 0 });
  t.setExecResult(buildMkTempCommand("/tmp"), { stdout: NODE_TMP + "\n", stderr: "", exitCode: 0 });
  t.setExecResult(buildPctExecCommand(vmid, buildDockerInspectCommand(container)), { stdout: `cid-abc ${BIND_MOUNTS}`, stderr: "", exitCode: 0 });
  t.setExecResult(buildPctPullCommand(vmid, srcPath, NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
  t.setFile(NODE_TMP, body);
  // perm stat for the fast-path push-back
  t.setExecResult(buildStatCommand(vmid, srcPath), { stdout: "644 0 0\n", stderr: "", exitCode: 0 });
}

describe("dockerEditFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockeredit-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("replaces a unique occurrence and audits under the honest tool name docker_edit_file", async () => {
    const t = new FakeTransport();
    primeBindRead(t, 101, "homepage", "/srv/config/services.yaml", "old: 1\nport: 8080\n");

    const res = (await dockerEditFileHandler(
      { vmid: 101, container: "homepage", path: "/config/services.yaml", oldString: "8080", newString: "9090", replaceAll: false },
      t, audit, backupStore, cfg
    )) as DockerWriteFileResult;

    expect(res.viaBindMount).toBe(true);
    expect((await t.readFile(NODE_TMP)).toString()).toBe("old: 1\nport: 9090\n");
    const rec = audit.readAll()[0];
    expect(rec.tool).toBe("docker_edit_file");
    expect(rec.container).toBe("homepage");
    expect(rec.containerId).toBe("cid-abc");
    expect(rec.historyCommitted).toBe(false);
    expect(rec.afterHash).toBeTruthy();
    expect(rec.beforeHash).toBeTruthy();
  });

  it("audit + backup parity: an edit matches the equivalent docker write byte-for-byte", async () => {
    const tw = new FakeTransport();
    primeBindRead(tw, 101, "homepage", "/srv/config/services.yaml", "k: old\n");
    await dockerWriteFileHandler(
      { vmid: 101, container: "homepage", path: "/config/services.yaml", content: "k: new\n", encoding: "utf8" },
      tw, audit, backupStore, cfg
    );
    const writeRec = audit.readAll()[0];

    const te = new FakeTransport();
    primeBindRead(te, 101, "homepage", "/srv/config/services.yaml", "k: old\n");
    await dockerEditFileHandler(
      { vmid: 101, container: "homepage", path: "/config/services.yaml", oldString: "old", newString: "new", replaceAll: false },
      te, audit, backupStore, cfg
    );
    const editRec = audit.readAll()[0];

    expect(editRec.afterHash).toBe(writeRec.afterHash);
    expect(editRec.beforeHash).toBe(writeRec.beforeHash);
  });

  it("refuses an ambiguous (non-unique) oldString and writes nothing", async () => {
    const t = new FakeTransport();
    primeBindRead(t, 101, "homepage", "/srv/config/a.yaml", "x\nx\n");
    await expect(
      dockerEditFileHandler({ vmid: 101, container: "homepage", path: "/config/a.yaml", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/occurs 2 times|must be unique/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses when oldString is not found", async () => {
    const t = new FakeTransport();
    primeBindRead(t, 101, "homepage", "/srv/config/a.yaml", "nothing here\n");
    await expect(
      dockerEditFileHandler({ vmid: 101, container: "homepage", path: "/config/a.yaml", oldString: "absent", newString: "z", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/not found/i);
  });

  it("refuses to edit a file that does not exist (points at docker_write_file)", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctStatusCommand(101), { stdout: "status: running\n", stderr: "", exitCode: 0 });
    t.setExecResult(buildMkTempCommand("/tmp"), { stdout: NODE_TMP + "\n", stderr: "", exitCode: 0 });
    t.setExecResult(buildPctExecCommand(101, buildDockerInspectCommand("homepage")), { stdout: `cid-abc ${BIND_MOUNTS}`, stderr: "", exitCode: 0 });
    t.setExecResult(buildPctPullCommand(101, "/srv/config/missing.yaml", NODE_TMP), { stdout: "", stderr: "No such file or directory", exitCode: 1 });
    await expect(
      dockerEditFileHandler({ vmid: 101, container: "homepage", path: "/config/missing.yaml", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/does not exist.*docker_write_file/i);
  });

  it("refuses to edit binary content (points at docker_write_file)", async () => {
    const t = new FakeTransport();
    primeBindRead(t, 101, "homepage", "/srv/config/blob.bin", Buffer.from([0x00, 0x01, 0xff, 0x00]));
    await expect(
      dockerEditFileHandler({ vmid: 101, container: "homepage", path: "/config/blob.bin", oldString: "x", newString: "y", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/binary/i);
  });

  it("rejects an invalid container name before any side effect", async () => {
    const t = new FakeTransport();
    await expect(
      dockerEditFileHandler({ vmid: 101, container: "bad name", path: "/x", oldString: "a", newString: "b", replaceAll: false }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/Invalid Docker container name/);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("dryRun returns a diff with zero side effects", async () => {
    const t = new FakeTransport();
    primeBindRead(t, 101, "homepage", "/srv/config/app.conf", "a\nb\nc\n");
    const res = await dockerEditFileHandler(
      { vmid: 101, container: "homepage", path: "/config/app.conf", oldString: "b", newString: "B", replaceAll: false, dryRun: true },
      t, audit, backupStore, cfg
    );
    expect("dryRun" in res && res.dryRun).toBe(true);
    expect(res.diff).toContain("+ B");
    expect(audit.readAll()).toHaveLength(0);
  });
});
