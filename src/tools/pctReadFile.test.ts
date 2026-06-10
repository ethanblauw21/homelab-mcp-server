import { describe, it, expect } from "vitest";
import { pctReadFileHandler } from "./pctReadFile.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, skipHostVerification: true },
    backup: { baseDir: "/tmp/b", largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: "/tmp/a.jsonl" },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    snapshot: { perGuestCap: 3, vmstate: false },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

describe("pctReadFileHandler", () => {
  it("reads a file from a running container", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.R", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.R'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.R", "container file body");

    const res = await pctReadFileHandler({ vmid: 101, path: "/etc/app.conf", encoding: "utf8" }, t, makeConfig());
    expect(res.content).toBe("container file body");
  });

  it("refuses when the container is not running (A3.1)", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: stopped", stderr: "", exitCode: 0 });
    await expect(
      pctReadFileHandler({ vmid: 101, path: "/etc/app.conf", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/not running/i);
  });

  it("throws file-not-found when the file is absent inside the container", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.R", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/missing' '/tmp/tmp.R'", { stdout: "", stderr: "No such file", exitCode: 1 });
    await expect(
      pctReadFileHandler({ vmid: 101, path: "/etc/missing", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/file not found inside container/i);
  });

  it("rejects an invalid path before touching the container", async () => {
    const t = new FakeTransport();
    await expect(
      pctReadFileHandler({ vmid: 101, path: "relative/path", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/invalid path/i);
  });
});
