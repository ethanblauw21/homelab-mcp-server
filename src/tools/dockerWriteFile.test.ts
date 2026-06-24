import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { dockerWriteFileHandler, type DockerWriteFileResult } from "./dockerWriteFile.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import {
  buildPctStatusCommand,
  buildMkTempCommand,
  buildPctPullCommand,
  buildStatCommand,
} from "./pctFiles.js";
import {
  buildDockerInspectCommand,
  buildDockerCpFromContainer,
  buildDockerStatCommand,
} from "./dockerHelpers.js";
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
const LXC_TMP = "/tmp/lxctmp";
const BIND_MOUNTS = JSON.stringify([{ Type: "bind", Source: "/srv/config", Destination: "/config", RW: true }]);
// A volume on a NON-local driver (NFS) stays on the docker cp slow path; a
// local-driver named volume (/var/lib/docker/volumes/<n>/_data) would now take
// the fast path per ADR-016 §4, so the slow-path test uses a non-host-visible source.
const VOLUME_MOUNTS = JSON.stringify([{ Type: "volume", Source: "/mnt/nfs/data", Destination: "/data", RW: true }]);

function primeRunning(t: FakeTransport, vmid: number) {
  t.setExecResult(buildPctStatusCommand(vmid), { stdout: "status: running\n", stderr: "", exitCode: 0 });
}
function primeNodeTemp(t: FakeTransport) {
  t.setExecResult(buildMkTempCommand("/tmp"), { stdout: NODE_TMP + "\n", stderr: "", exitCode: 0 });
}
function primeLxcTemp(t: FakeTransport, vmid: number) {
  t.setExecResult(buildPctExecCommand(vmid, buildMkTempCommand("/tmp")), { stdout: LXC_TMP + "\n", stderr: "", exitCode: 0 });
}
function primeInspect(t: FakeTransport, vmid: number, container: string, payload: string) {
  t.setExecResult(buildPctExecCommand(vmid, buildDockerInspectCommand(container)), { stdout: payload, stderr: "", exitCode: 0 });
}

describe("dockerWriteFileHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let backupStore: BackupStore;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerwrite-"));
    cfg = makeConfig(tmpDir);
    backupStore = new BackupStore(cfg.backup);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("writes via the bind-mount fast path, backs up under the docker: key, and audits container + id", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "homepage", `cid-abc ${BIND_MOUNTS}`);
    // prev content (read phase) pulled from the LXC source path
    t.setExecResult(buildPctPullCommand(101, "/srv/config/services.yaml", NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "old: 1\n");
    // perm preservation on the fast-path push
    t.setExecResult(buildStatCommand(101, "/srv/config/services.yaml"), { stdout: "644 0 0\n", stderr: "", exitCode: 0 });

    const res = (await dockerWriteFileHandler(
      { vmid: 101, container: "homepage", path: "/config/services.yaml", content: "old: 1\nnew: 2\n", encoding: "utf8" },
      t, audit, backupStore, cfg
    )) as DockerWriteFileResult;

    expect(res.viaBindMount).toBe(true);
    expect(res.newFile).toBe(false);
    expect(res.diff).toContain("new: 2");
    expect(res.backupPath).toBeTruthy();

    const rec = audit.readAll()[0];
    expect(rec.tool).toBe("docker_write_file");
    expect(rec.vmid).toBe(101);
    expect(rec.container).toBe("homepage");
    expect(rec.containerId).toBe("cid-abc");
    expect(rec.prevSha256).toBeTruthy();
    expect(rec.newSha256).toBeTruthy();
    expect(rec.historyCommitted).toBe(false); // docker has no git-mirror layout
  });

  // ADR-022 gap 1 — the diff-on-write output reaches the audit.db projector.
  it("forwards the unified diff to the audit.db projector on a text write", async () => {
    const captured: Array<{ diff?: string | null }> = [];
    audit.setProjector({ project: (_r, extras) => captured.push(extras ?? {}) });

    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "homepage", `cid-abc ${BIND_MOUNTS}`);
    t.setExecResult(buildPctPullCommand(101, "/srv/config/services.yaml", NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "old: 1\n");
    t.setExecResult(buildStatCommand(101, "/srv/config/services.yaml"), { stdout: "644 0 0\n", stderr: "", exitCode: 0 });

    await dockerWriteFileHandler(
      { vmid: 101, container: "homepage", path: "/config/services.yaml", content: "old: 1\nnew: 2\n", encoding: "utf8" },
      t, audit, backupStore, cfg
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].diff).toContain("new: 2");
  });

  it("writes via the slow path and restores ownership (stat-before, chown/chmod-after)", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeLxcTemp(t, 101);
    primeInspect(t, 101, "sonarr", `cid-xyz ${VOLUME_MOUNTS}`);
    // read phase (slow): docker cp out, then pull
    t.setExecResult(buildPctExecCommand(101, buildDockerCpFromContainer("sonarr", "/data/config.xml", LXC_TMP)), { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult(buildPctPullCommand(101, LXC_TMP, NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "<Config><A>1</A></Config>");
    // prev perms via docker exec stat
    t.setExecResult(buildPctExecCommand(101, buildDockerStatCommand("sonarr", "/data/config.xml")), { stdout: "640 1000 1000\n", stderr: "", exitCode: 0 });
    // chown/chmod/docker cp in / temp ops all default exit 0

    const res = (await dockerWriteFileHandler(
      { vmid: 101, container: "sonarr", path: "/data/config.xml", content: "<Config><A>2</A></Config>", encoding: "utf8" },
      t, audit, backupStore, cfg
    )) as DockerWriteFileResult;

    expect(res.viaBindMount).toBe(false);
    expect(res.note).toBeUndefined(); // chown+chmod returned 0 → no best-effort warning
    expect(res.diff).toContain("<A>2</A>");
    expect(audit.readAll()[0].containerId).toBe("cid-xyz");
  });

  it("dryRun previews with a diff and has zero side effects", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "web", `cid ${BIND_MOUNTS}`);
    t.setExecResult(buildPctPullCommand(101, "/srv/config/app.conf", NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "a=1\n");

    const res = await dockerWriteFileHandler(
      { vmid: 101, container: "web", path: "/config/app.conf", content: "a=2\n", encoding: "utf8", dryRun: true },
      t, audit, backupStore, cfg
    );

    expect("dryRun" in res && res.dryRun).toBe(true);
    expect(res.diff).toContain("a=2");
    expect(audit.readAll()).toHaveLength(0);
    expect(fs.existsSync(cfg.backup.baseDir)).toBe(false);
  });

  it("handles a new file: newFile true, diff against empty, no prev hash", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "web", `cid ${BIND_MOUNTS}`);
    // read phase: pct pull reports not-found ⇒ new file
    t.setExecResult(buildPctPullCommand(101, "/srv/config/fresh.yml", NODE_TMP), { stdout: "", stderr: "No such file or directory", exitCode: 1 });
    // fast-path push perm stat fails (new file) ⇒ defaults used
    t.setExecResult(buildStatCommand(101, "/srv/config/fresh.yml"), { stdout: "", stderr: "", exitCode: 1 });

    const res = (await dockerWriteFileHandler(
      { vmid: 101, container: "web", path: "/config/fresh.yml", content: "hello: world\n", encoding: "utf8" },
      t, audit, backupStore, cfg
    )) as DockerWriteFileResult;

    expect(res.newFile).toBe(true);
    expect(res.diff).toContain("hello: world");
    expect(audit.readAll()[0].prevSha256).toBeUndefined();
  });

  it("rejects an invalid container name before any side effect", async () => {
    const t = new FakeTransport();
    await expect(
      dockerWriteFileHandler({ vmid: 101, container: "bad name", path: "/x", content: "y", encoding: "utf8" }, t, audit, backupStore, cfg)
    ).rejects.toThrow(/Invalid Docker container name/);
    expect(audit.readAll()).toHaveLength(0);
  });
});
