import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  configSweepHandler,
  buildFindEnumCommand,
  buildSha256Command,
} from "./configSweep.js";
import { ConfigHistory } from "../history/configHistory.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(Buffer.from(s)).digest("hex");
}

describe("config_sweep command builders", () => {
  it("buildFindEnumCommand emits tab-separated size/path find (host + container)", () => {
    expect(buildFindEnumCommand(["/etc"])).toBe(
      "find '/etc' -type f -printf '%s\\t%p\\n' 2>/dev/null"
    );
    expect(buildFindEnumCommand(["/etc"], 104)).toBe(
      "pct exec 104 -- sh -c 'find '\\''/etc'\\'' -type f -printf '\\''%s\\t%p\\n'\\'' 2>/dev/null'"
    );
  });

  it("buildSha256Command is null for no candidates and quotes paths otherwise", () => {
    expect(buildSha256Command([])).toBeNull();
    expect(buildSha256Command(["/etc/hosts", "/etc/issue"])).toBe(
      "sha256sum -- '/etc/hosts' '/etc/issue'"
    );
  });
});

describe.skipIf(!gitAvailable)("configSweepHandler (real git temp repo)", () => {
  let dir: string;
  let history: ConfigHistory;
  let audit: AuditLog;
  let cfg: Config;

  function makeCfg(): Config {
    return {
      ssh: { host: "node1", commandTimeoutMs: 1000 },
      container: { nodeTempDir: "/tmp" },
      history: {
        configHistoryDir: dir,
        pushMode: "local-only",
        remote: undefined,
        hostWatchPaths: ["/etc"],
        containerWatchPaths: ["/etc"],
        excludePatterns: ["**/*.lock"],
        sweepFileSizeCapBytes: 1000,
      },
    } as unknown as Config;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
    history = new ConfigHistory({
      configHistoryDir: dir,
      pushMode: "local-only",
      hostWatchPaths: ["/etc"],
      containerWatchPaths: ["/etc"],
      excludePatterns: ["**/*.lock"],
      sweepFileSizeCapBytes: 1000,
    } as Config["history"]);
    await history.init();
    audit = new AuditLog(path.join(dir, "audit.jsonl"));
    cfg = makeCfg();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedHostSweep(t: FakeTransport, content: string, opts: { lock?: boolean } = {}): void {
    // Enumerate returns the config file (and optionally an excluded lockfile).
    let enumOut = `${content.length}\t/etc/hosts\n`;
    if (opts.lock) enumOut += `5\t/etc/app.lock\n`;
    t.setExecResult(buildFindEnumCommand(["/etc"]), { stdout: enumOut, stderr: "", exitCode: 0 });
    // Hash for the (non-excluded) candidate.
    t.setExecResult(buildSha256Command(["/etc/hosts"]) as string, {
      stdout: `${sha256Hex(content)}  /etc/hosts\n`,
      stderr: "",
      exitCode: 0,
    });
    // stat for the manifest.
    t.setExecResult("stat -c '%a %u %g %n' -- '/etc/hosts'", {
      stdout: "644 0 0 /etc/hosts",
      stderr: "",
      exitCode: 0,
    });
    // The actual file bytes fetched over SFTP.
    t.setFile("/etc/hosts", content);
  }

  it("fetches a new file, writes the manifest, and makes one commit", async () => {
    const t = new FakeTransport();
    seedHostSweep(t, "127.0.0.1 localhost\n", { lock: true });

    const r = await configSweepHandler({ targets: ["host"] }, t, history, audit, cfg);

    expect(r.historyCommitted).toBe(true);
    expect(r.targets[0]).toMatchObject({ added: 1, changed: 0, excluded: 1, deleted: 0 });
    expect(fs.readFileSync(path.join(dir, "host/etc/hosts"), "utf8")).toBe("127.0.0.1 localhost\n");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifests/host.json"), "utf8"));
    expect(manifest.files["/etc/hosts"]).toEqual({ mode: "644", uid: 0, gid: 0 });

    const log = spawnSync("git", ["-C", dir, "log", "--format=%s%n%b"]).stdout.toString();
    expect(log).toContain("config_sweep host");
    expect(log).toContain(`audit: ${r.auditId}`);
  });

  it("a second sweep with identical content fetches nothing (hash-compare)", async () => {
    const t = new FakeTransport();
    seedHostSweep(t, "same\n");
    await configSweepHandler({ targets: ["host"] }, t, history, audit, cfg);

    const r2 = await configSweepHandler({ targets: ["host"] }, t, history, audit, cfg);
    expect(r2.targets[0]).toMatchObject({ added: 0, changed: 0, unchanged: 1 });
  });

  it("records a deletion when the file disappears from the node", async () => {
    const t = new FakeTransport();
    seedHostSweep(t, "x\n");
    await configSweepHandler({ targets: ["host"] }, t, history, audit, cfg);

    // Now the node has no files under /etc.
    t.setExecResult(buildFindEnumCommand(["/etc"]), { stdout: "", stderr: "", exitCode: 0 });
    const r = await configSweepHandler({ targets: ["host"] }, t, history, audit, cfg);
    expect(r.targets[0]).toMatchObject({ deleted: 1 });
    expect(fs.existsSync(path.join(dir, "host/etc/hosts"))).toBe(false);
  });

  it("skips a stopped container with a structured note", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 104", { stdout: "status: stopped", stderr: "", exitCode: 0 });
    const r = await configSweepHandler({ targets: [{ vmid: 104 }] }, t, history, audit, cfg);
    expect(r.targets[0].skipped).toMatch(/not running/i);
  });

  it("isolates a per-target enumerate failure as a recorded error", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildFindEnumCommand(["/etc"]), { stdout: "", stderr: "boom", exitCode: 1 });
    const r = await configSweepHandler({ targets: ["host"] }, t, history, audit, cfg);
    expect(r.targets[0].error).toMatch(/enumerate failed/i);
  });
});
