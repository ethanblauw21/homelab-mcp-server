import { describe, it, expect } from "vitest";
import { diffConfigHandler } from "./diffConfig.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildPctStatusCommand, buildPctPullCommand } from "./pctFiles.js";
import { buildDockerInspectCommand } from "./dockerHelpers.js";
import { contentHash } from "../backup/policy.js";
import type { BackupStore, BackupTarget, BackupVersionInfo } from "../backup/store.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    ssh: { host: "h", commandTimeoutMs: 5000 },
    tools: { dryRunDiffMaxLines: 200 },
    container: { nodeTempDir: "/tmp" },
  } as unknown as Config;
}

/** Minimal fake exposing only the three BackupStore methods diff_config calls. */
function fakeStore(opts: {
  target?: BackupTarget;
  versions: BackupVersionInfo[];
  restoreContent?: Buffer | null;
}): BackupStore {
  return {
    readBackupTarget: () => {
      if (!opts.target) throw new Error("no meta");
      return opts.target;
    },
    listBackupsForPath: () => opts.versions,
    restore: async () => opts.restoreContent ?? null,
  } as unknown as BackupStore;
}

const HOST_TARGET: BackupTarget = { kind: "host", remotePath: "/etc/hosts" };

describe("diffConfigHandler", () => {
  it("diffs current → backup for a host file (latest revertible version)", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/hosts", "127.0.0.1 localhost\n10.0.0.5 new\n");
    const store = fakeStore({
      target: HOST_TARGET,
      versions: [
        { backupPath: "/b/aaa.gz", timestamp: "aaa", kind: "gzip-full", sizeBytes: 10, revertible: true },
      ],
      restoreContent: Buffer.from("127.0.0.1 localhost\n"),
    });

    const res = await diffConfigHandler({ path: "/etc/hosts" }, t, store, makeConfig());

    expect(res.revertible).toBe(true);
    expect(res.backupPath).toBe("/b/aaa.gz");
    // current has the extra "10.0.0.5 new" line that a revert would remove.
    expect(res.removedLines).toBe(1);
    expect(res.addedLines).toBe(0);
    expect(res.diff).toContain("- 10.0.0.5 new");
    expect(res.currentSha256).toBeDefined();
    expect(res.backupSha256).toBeDefined();
    expect(res.currentSha256).not.toBe(res.backupSha256);
  });

  it("treats a missing current file as empty content (diff shows full add)", async () => {
    const t = new FakeTransport(); // /etc/hosts not set → readFile throws
    const store = fakeStore({
      target: HOST_TARGET,
      versions: [{ backupPath: "/b/aaa.gz", timestamp: "aaa", kind: "gzip-full", sizeBytes: 10, revertible: true }],
      restoreContent: Buffer.from("line1\nline2\n"),
    });

    const res = await diffConfigHandler({ path: "/etc/hosts" }, t, store, makeConfig());
    expect(res.revertible).toBe(true);
    expect(res.addedLines).toBe(2);
    expect(res.removedLines).toBe(0);
  });

  it("returns a non-revertible structured response for metadata-only backups", async () => {
    const t = new FakeTransport();
    const store = fakeStore({
      target: HOST_TARGET,
      versions: [
        { backupPath: "/b/aaa.meta", timestamp: "aaa", kind: "metadata-only", sizeBytes: 5, revertible: false },
      ],
    });

    const res = await diffConfigHandler({ path: "/etc/hosts" }, t, store, makeConfig());
    expect(res.revertible).toBe(false);
    expect(res.diff).toBeUndefined();
    expect(res.note).toMatch(/metadata-only/i);
  });

  it("resolves a specific version by backupPath", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/hosts", "current\n");
    const store = fakeStore({
      target: HOST_TARGET,
      versions: [
        { backupPath: "/b/newer.gz", timestamp: "newer", kind: "gzip-full", sizeBytes: 10, revertible: true },
        { backupPath: "/b/older.gz", timestamp: "older", kind: "gzip-full", sizeBytes: 10, revertible: true },
      ],
      restoreContent: Buffer.from("older content\n"),
    });

    const res = await diffConfigHandler({ backupPath: "/b/older.gz" }, t, store, makeConfig());
    expect(res.backupPath).toBe("/b/older.gz");
    expect(res.timestamp).toBe("older");
  });

  it("throws when no backups exist for the target", async () => {
    const t = new FakeTransport();
    const store = fakeStore({ target: HOST_TARGET, versions: [] });
    await expect(diffConfigHandler({ path: "/etc/hosts" }, t, store, makeConfig())).rejects.toThrow(/no backups/i);
  });

  it("requires either backupPath or path", async () => {
    const t = new FakeTransport();
    const store = fakeStore({ versions: [] });
    await expect(diffConfigHandler({}, t, store, makeConfig())).rejects.toThrow(/either/i);
  });

  it("reads current docker content via the bind-mount flow and diffs current → backup", async () => {
    const BIND = JSON.stringify([{ Type: "bind", Source: "/srv/config", Destination: "/config", RW: true }]);
    const t = new FakeTransport();
    // docker target: status → inspect → bind read (pct pull lxcPath).
    t.setExecResult(buildPctStatusCommand(101), { stdout: "status: running\n", stderr: "", exitCode: 0 });
    t.setExecResult(buildPctExecCommand(101, buildDockerInspectCommand("web")), { stdout: `cid-web ${BIND}`, stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/node1", stderr: "", exitCode: 0 });
    t.setExecResult(buildPctPullCommand(101, "/srv/config/app.conf", "/tmp/node1"), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/node1", "a=1\nb=2\n");

    const store = fakeStore({
      target: { kind: "docker", vmid: 101, container: "web", remotePath: "/config/app.conf" },
      versions: [{ backupPath: "/b/d.gz", timestamp: "d", kind: "gzip-full", sizeBytes: 10, revertible: true }],
      restoreContent: Buffer.from("a=1\n"),
    });

    const res = await diffConfigHandler({ backupPath: "/b/d.gz" }, t, store, makeConfig());

    expect(res.revertible).toBe(true);
    // current has the extra "b=2" line a revert would remove.
    expect(res.removedLines).toBe(1);
    expect(res.diff).toContain("- b=2");
  });

  // ADR-014 §1 — a delta backup whose recorded base no longer matches the live file
  // (an out-of-band edit broke the chain) is reported as a structured non-revertible
  // response with a reason, instead of surfacing restore()'s raw "changed since" throw.
  it("returns structured non-revertible when a delta's base drifted out-of-band", async () => {
    const t = new FakeTransport();
    t.setFile("/etc/hosts", "EDITED OUT OF BAND\n");
    const restoreCalled = { value: false };
    const store = {
      readBackupTarget: () => HOST_TARGET,
      listBackupsForPath: (): BackupVersionInfo[] => [
        {
          backupPath: "/b/delta.gz",
          timestamp: "delta",
          kind: "gzip-diff",
          sizeBytes: 10,
          revertible: true, // content-bearing per the listing; the handler overlays the honest verdict
          hash: "newh",
          requiresBaseHash: contentHash(Buffer.from("WHAT WE LAST WROTE\n")),
        },
      ],
      restore: async () => {
        restoreCalled.value = true;
        return Buffer.from("never reached\n");
      },
    } as unknown as BackupStore;

    const res = await diffConfigHandler({ path: "/etc/hosts" }, t, store, makeConfig());
    expect(res.revertible).toBe(false);
    expect(res.revertReason).toMatch(/out-of-band|no longer be applied/i);
    expect(res.diff).toBeUndefined();
    // The classify gate must short-circuit BEFORE restore is attempted.
    expect(restoreCalled.value).toBe(false);
  });

  it("still diffs a delta backup when the live file matches its recorded base", async () => {
    const t = new FakeTransport();
    const live = "127.0.0.1 localhost\nextra\n";
    t.setFile("/etc/hosts", live);
    const store = fakeStore({
      target: HOST_TARGET,
      versions: [
        {
          backupPath: "/b/delta.gz",
          timestamp: "delta",
          kind: "gzip-diff",
          sizeBytes: 10,
          revertible: true,
          hash: "newh",
          requiresBaseHash: contentHash(Buffer.from(live)),
        },
      ],
      restoreContent: Buffer.from("127.0.0.1 localhost\n"),
    });

    const res = await diffConfigHandler({ path: "/etc/hosts" }, t, store, makeConfig());
    expect(res.revertible).toBe(true);
    expect(res.removedLines).toBe(1);
  });
});
