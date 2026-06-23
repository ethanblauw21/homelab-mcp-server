import { describe, it, expect } from "vitest";
import { FakeTransport } from "../ssh/fakeTransport.js";
import {
  shQuote,
  buildPctStatusCommand,
  parsePctStatus,
  buildMkTempCommand,
  buildRmCommand,
  buildPctPullCommand,
  buildPctPushCommand,
  buildStatCommand,
  buildFileExistsCommand,
  parseStatPerms,
  classifyPullError,
  assertContainerRunning,
  containerFileExists,
  pullContainerFile,
  statContainerPerms,
  pushContainerFile,
} from "./pctFiles.js";

describe("pctFiles — pure builders/parsers", () => {
  it("shQuote escapes embedded single quotes", () => {
    expect(shQuote("/etc/foo")).toBe("'/etc/foo'");
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });

  it("parsePctStatus extracts the state", () => {
    expect(parsePctStatus("status: running")).toBe("running");
    expect(parsePctStatus("status: stopped")).toBe("stopped");
    expect(parsePctStatus("garbage")).toBe("");
  });

  it("builds pull/push/stat/status/mktemp/rm commands with quoting", () => {
    expect(buildPctStatusCommand(101)).toBe("pct status 101");
    expect(buildMkTempCommand("/tmp")).toBe("mktemp -p '/tmp'");
    expect(buildRmCommand("/tmp/x")).toBe("rm -f '/tmp/x'");
    expect(buildPctPullCommand(101, "/etc/app.conf", "/tmp/t")).toBe(
      "pct pull 101 '/etc/app.conf' '/tmp/t'"
    );
    expect(buildPctPushCommand(101, "/tmp/t", "/etc/app.conf", { mode: "640", uid: 0, gid: 33 })).toBe(
      "pct push 101 '/tmp/t' '/etc/app.conf' --perms '640' --user 0 --group 33"
    );
    expect(buildStatCommand(101, "/etc/app.conf")).toBe(
      "pct exec 101 -- stat -c '%a %u %g' '/etc/app.conf'"
    );
    expect(buildFileExistsCommand(101, "/etc/app.conf")).toBe(
      "pct exec 101 -- test -e '/etc/app.conf'"
    );
  });

  it("parseStatPerms parses mode/uid/gid or returns null", () => {
    expect(parseStatPerms("644 0 0")).toEqual({ mode: "644", uid: 0, gid: 0 });
    expect(parseStatPerms("  640 33 33 \n")).toEqual({ mode: "640", uid: 33, gid: 33 });
    expect(parseStatPerms("no such file")).toBeNull();
  });

  it("classifyPullError distinguishes not-found from other failures", () => {
    expect(classifyPullError("error: No such file or directory")).toBe("not-found");
    expect(classifyPullError("file does not exist")).toBe("not-found");
    expect(classifyPullError("Connection reset by peer")).toBe("other");
  });
});

describe("pctFiles — I/O helpers (FakeTransport)", () => {
  it("assertContainerRunning passes for running, refuses otherwise", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct status 101", { stdout: "status: running", stderr: "", exitCode: 0 });
    await expect(assertContainerRunning(t, 101, 5000)).resolves.toBeUndefined();

    t.setExecResult("pct status 102", { stdout: "status: stopped", stderr: "", exitCode: 0 });
    await expect(assertContainerRunning(t, 102, 5000)).rejects.toThrow(/not running.*stopped/i);
  });

  it("containerFileExists maps test -e exit code to a boolean", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct exec 101 -- test -e '/etc/app.conf'", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("pct exec 101 -- test -e '/etc/missing'", { stdout: "", stderr: "", exitCode: 1 });
    expect(await containerFileExists(t, 101, "/etc/app.conf", 5000)).toBe(true);
    expect(await containerFileExists(t, 101, "/etc/missing", 5000)).toBe(false);
  });

  it("pullContainerFile returns null on an absent file even when pct pull exits 0 (ADR-023 §1)", async () => {
    // The dogfood regression: on some Proxmox builds `pct pull` of a missing source
    // exits 0 and leaves the pre-created mktemp EMPTY. Existence must be decided by
    // `test -e`, not by reading that empty temp — otherwise a missing file is misread
    // as an existing 0-byte file (breaking new-file detection + the backup base).
    const t = new FakeTransport();
    t.setExecResult("pct exec 101 -- test -e '/etc/missing'", { stdout: "", stderr: "", exitCode: 1 });
    // Even with a (buggy) exit-0 pull and an empty temp staged, content must be null:
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.EMPTY", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/missing' '/tmp/tmp.EMPTY'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.EMPTY", "");
    const { content } = await pullContainerFile(t, 101, "/etc/missing", "/tmp", 5000);
    expect(content).toBeNull();
  });

  it("pullContainerFile threads the mktemp path, reads bytes, cleans up", async () => {
    const t = new FakeTransport();
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.AAA\n", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.AAA'", { stdout: "", stderr: "", exitCode: 0 });
    t.setFile("/tmp/tmp.AAA", "hello world");

    const { content } = await pullContainerFile(t, 101, "/etc/app.conf", "/tmp", 5000);
    expect(content?.toString()).toBe("hello world");
  });

  it("pullContainerFile returns null content on file-not-found", async () => {
    const t = new FakeTransport();
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.BBB", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/missing' '/tmp/tmp.BBB'", {
      stdout: "",
      stderr: "No such file or directory",
      exitCode: 1,
    });
    const { content } = await pullContainerFile(t, 101, "/etc/missing", "/tmp", 5000);
    expect(content).toBeNull();
  });

  it("pullContainerFile throws on a non-not-found pull failure", async () => {
    const t = new FakeTransport();
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.CCC", stderr: "", exitCode: 0 });
    t.setExecResult("pct pull 101 '/etc/app.conf' '/tmp/tmp.CCC'", {
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });
    await expect(pullContainerFile(t, 101, "/etc/app.conf", "/tmp", 5000)).rejects.toThrow(/pct pull failed/i);
  });

  it("statContainerPerms returns parsed perms or null", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/app.conf'", {
      stdout: "640 0 33",
      stderr: "",
      exitCode: 0,
    });
    expect(await statContainerPerms(t, 101, "/etc/app.conf", 5000)).toEqual({ mode: "640", uid: 0, gid: 33 });

    t.setExecResult("pct exec 101 -- stat -c '%a %u %g' '/etc/missing'", {
      stdout: "",
      stderr: "No such file",
      exitCode: 1,
    });
    expect(await statContainerPerms(t, 101, "/etc/missing", 5000)).toBeNull();
  });

  it("pushContainerFile writes the temp then pushes with perms", async () => {
    const t = new FakeTransport();
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.PUSH", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.PUSH' '/etc/app.conf' --perms '644' --user 0 --group 0", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    await pushContainerFile(t, 101, "/etc/app.conf", Buffer.from("data"), { mode: "644", uid: 0, gid: 0 }, "/tmp", 5000);
    // bytes were staged to the node temp before push
    expect((await t.readFile("/tmp/tmp.PUSH")).toString()).toBe("data");
  });

  it("pushContainerFile throws when pct push fails", async () => {
    const t = new FakeTransport();
    t.setExecResult("mktemp -p '/tmp'", { stdout: "/tmp/tmp.FAIL", stderr: "", exitCode: 0 });
    t.setExecResult("pct push 101 '/tmp/tmp.FAIL' '/etc/app.conf' --perms '644' --user 0 --group 0", {
      stdout: "",
      stderr: "push error",
      exitCode: 1,
    });
    await expect(
      pushContainerFile(t, 101, "/etc/app.conf", Buffer.from("data"), { mode: "644", uid: 0, gid: 0 }, "/tmp", 5000)
    ).rejects.toThrow(/pct push failed/i);
  });
});
