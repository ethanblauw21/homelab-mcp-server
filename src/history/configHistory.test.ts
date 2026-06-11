import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { ConfigHistory } from "./configHistory.js";
import { GitEngine } from "./gitEngine.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { buildStatCommand } from "../tools/pctFiles.js";
import type { Config } from "../config.js";

// These tests drive REAL git in a temp dir (the ADR's "Unit (FakeTransport +
// temp repo)" row). Skip gracefully where git is absent.
const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

function historyCfg(dir: string, over: Partial<Config["history"]> = {}): Config["history"] {
  return {
    configHistoryDir: dir,
    pushMode: "local-only",
    remote: undefined,
    hostWatchPaths: ["/etc"],
    containerWatchPaths: ["/etc"],
    excludePatterns: [],
    sweepFileSizeCapBytes: 1024 * 1024,
    ...over,
  };
}

describe("GitEngine.detectVersion", () => {
  it.skipIf(!gitAvailable)("returns a version string when git is present", async () => {
    const eng = new GitEngine(os.tmpdir());
    expect(await eng.detectVersion()).toMatch(/git version/i);
  });

  it("returns null when the git binary is missing", async () => {
    const eng = new GitEngine(os.tmpdir(), "definitely-not-a-real-git-binary-xyz");
    expect(await eng.detectVersion()).toBeNull();
  });
});

describe("ConfigHistory (real git temp repo)", () => {
  let dir: string;
  let history: ConfigHistory;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-"));
    history = new ConfigHistory(historyCfg(dir));
    if (gitAvailable) await history.init();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!gitAvailable)("init creates a repo and enables the subsystem", () => {
    expect(history.enabled).toBe(true);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".gitattributes"), "utf8")).toContain("* -text");
  });

  it.skipIf(!gitAvailable)(
    "recordMutation commits the new content + manifest entry",
    async () => {
      const t = new FakeTransport();
      t.setExecResult("stat -c '%a %u %g' '/etc/hosts'", {
        stdout: "644 0 0",
        stderr: "",
        exitCode: 0,
      });
      const ok = await history.recordMutation(
        t,
        { kind: "host", remotePath: "/etc/hosts" },
        Buffer.from("127.0.0.1 localhost\n"),
        "write_file",
        "audit-uuid-1",
        1000
      );
      expect(ok).toBe(true);

      // Mirror content landed.
      expect(fs.readFileSync(path.join(dir, "host/etc/hosts"), "utf8")).toBe(
        "127.0.0.1 localhost\n"
      );
      // Manifest entry recorded the perms.
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifests/host.json"), "utf8"));
      expect(manifest.files["/etc/hosts"]).toEqual({ mode: "644", uid: 0, gid: 0 });

      // A commit exists with the greppable message + audit uuid.
      const log = spawnSync("git", ["-C", dir, "log", "--format=%s%n%b"]);
      const text = log.stdout.toString();
      expect(text).toContain("write_file host:/etc/hosts");
      expect(text).toContain("audit: audit-uuid-1");
    }
  );

  it.skipIf(!gitAvailable)(
    "an identical re-write reports committed=true but makes no new commit",
    async () => {
      const t = new FakeTransport();
      const target = { kind: "host" as const, remotePath: "/etc/issue" };
      const content = Buffer.from("hello\n");
      await history.recordMutation(t, target, content, "write_file", "a1", 1000);
      const count1 = spawnSync("git", ["-C", dir, "rev-list", "--count", "HEAD"]).stdout
        .toString()
        .trim();
      const ok = await history.recordMutation(t, target, content, "write_file", "a2", 1000);
      expect(ok).toBe(true);
      const count2 = spawnSync("git", ["-C", dir, "rev-list", "--count", "HEAD"]).stdout
        .toString()
        .trim();
      expect(count2).toBe(count1); // no new commit
    }
  );

  it.skipIf(!gitAvailable)("records a container target under pct/<vmid>/", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildStatCommand(104, "/etc/wireguard/wg0.conf"), {
      stdout: "600 0 0",
      stderr: "",
      exitCode: 0,
    });
    const ok = await history.recordMutation(
      t,
      { kind: "pct", vmid: 104, remotePath: "/etc/wireguard/wg0.conf" },
      Buffer.from("[Interface]\n"),
      "pct_write_file",
      "a3",
      1000
    );
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "pct/104/etc/wireguard/wg0.conf"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifests/pct-104.json"), "utf8"));
    expect(manifest.files["/etc/wireguard/wg0.conf"]).toEqual({ mode: "600", uid: 0, gid: 0 });
  });

  it.skipIf(!gitAvailable)("skips qm targets (no mirror layout) and returns false", async () => {
    const t = new FakeTransport();
    const ok = await history.recordMutation(
      t,
      { kind: "qm", vmid: 200, remotePath: "/etc/x" },
      Buffer.from("x"),
      "revert_file",
      "a4",
      1000
    );
    expect(ok).toBe(false);
  });

  it("recordMutation returns false when the subsystem is disabled", async () => {
    const disabled = new ConfigHistory(historyCfg(path.join(dir, "nope")));
    // never init()'d → disabled
    const ok = await disabled.recordMutation(
      new FakeTransport(),
      { kind: "host", remotePath: "/etc/hosts" },
      Buffer.from("x"),
      "write_file",
      "a5",
      1000
    );
    expect(ok).toBe(false);
  });
});

describe("ConfigHistory push (real git, local bare remote)", () => {
  let dir: string;
  let remoteDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-push-"));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-remote-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it.skipIf(!gitAvailable)("local-only never adds a remote and never pushes", async () => {
    const history = new ConfigHistory(historyCfg(dir, { pushMode: "local-only" }));
    await history.init();
    await history.recordMutation(
      new FakeTransport(),
      { kind: "host", remotePath: "/etc/hosts" },
      Buffer.from("x\n"),
      "write_file",
      "a1",
      1000
    );
    // No remote was configured.
    const remotes = spawnSync("git", ["-C", dir, "remote"]).stdout.toString().trim();
    expect(remotes).toBe("");
  });

  it.skipIf(!gitAvailable)("push-lan pushes the commit to the configured remote", async () => {
    // A bare repo standing in for a LAN remote (file:// transport; git handles it).
    expect(spawnSync("git", ["init", "--bare", remoteDir]).status).toBe(0);

    const history = new ConfigHistory(
      historyCfg(dir, { pushMode: "push-lan", remote: remoteDir })
    );
    await history.init();
    await history.recordMutation(
      new FakeTransport(),
      { kind: "host", remotePath: "/etc/hosts" },
      Buffer.from("pushed\n"),
      "write_file",
      "push-audit-1",
      1000
    );

    // The bare remote now holds the same commit (greppable message proves it).
    const log = spawnSync("git", ["-C", remoteDir, "log", "--format=%s%n%b", "HEAD"]);
    expect(log.status).toBe(0);
    expect(log.stdout.toString()).toContain("audit: push-audit-1");
  });
});
