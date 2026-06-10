import { describe, it, expect } from "vitest";
import {
  buildAgentFileReadCommand,
  buildAgentFileWriteCommand,
  parseAgentFileRead,
  classifyAgentFileError,
  resolveNodeName,
  assertAgentAvailable,
  readVmFile,
  writeVmFile,
} from "./qmFiles.js";
import { FakeTransport } from "../ssh/fakeTransport.js";

describe("qmFiles pure builders", () => {
  it("buildAgentFileReadCommand quotes the API path and file, requests json", () => {
    const cmd = buildAgentFileReadCommand("pve", 200, "/etc/test.conf");
    expect(cmd).toBe(
      "pvesh get '/nodes/pve/qemu/200/agent/file-read' --file '/etc/test.conf' --output-format json"
    );
  });

  it("buildAgentFileWriteCommand passes content as already-base64 (--encode 0)", () => {
    const cmd = buildAgentFileWriteCommand("pve", 200, "/etc/test.conf", "YWJj");
    expect(cmd).toBe(
      "pvesh create '/nodes/pve/qemu/200/agent/file-write' --file '/etc/test.conf' --content 'YWJj' --encode 0"
    );
  });

  it("single-quotes in a path are escaped so they cannot break out", () => {
    const cmd = buildAgentFileReadCommand("pve", 1, "/etc/o'd");
    // shQuote turns ' into '\'' — the path stays a single shell token.
    expect(cmd).toContain("'/etc/o'\\''d'");
  });
});

describe("parseAgentFileRead", () => {
  it("decodes the content field as UTF-8", () => {
    const r = parseAgentFileRead(JSON.stringify({ content: "hello world" }));
    expect(r.content.toString("utf8")).toBe("hello world");
    expect(r.truncated).toBe(false);
  });

  it("treats truncated as truthy across bool/number/string forms", () => {
    expect(parseAgentFileRead(JSON.stringify({ content: "", truncated: true })).truncated).toBe(true);
    expect(parseAgentFileRead(JSON.stringify({ content: "", truncated: 1 })).truncated).toBe(true);
    expect(parseAgentFileRead(JSON.stringify({ content: "", truncated: "1" })).truncated).toBe(true);
    expect(parseAgentFileRead(JSON.stringify({ content: "", truncated: 0 })).truncated).toBe(false);
  });

  it("throws on non-JSON output", () => {
    expect(() => parseAgentFileRead("not json")).toThrow(/non-JSON/i);
  });

  it("throws on a non-object JSON value", () => {
    expect(() => parseAgentFileRead("42")).toThrow(/non-object/i);
  });

  it("defaults missing content to empty rather than guessing", () => {
    expect(parseAgentFileRead(JSON.stringify({ truncated: false })).content.length).toBe(0);
  });
});

describe("classifyAgentFileError", () => {
  it.each([
    "No such file or directory",
    "file does not exist",
    "cannot stat '/x'",
    "failed to open file",
  ])("classifies %s as not-found", (msg) => {
    expect(classifyAgentFileError(msg)).toBe("not-found");
  });

  it("classifies anything else as other", () => {
    expect(classifyAgentFileError("permission denied")).toBe("other");
    expect(classifyAgentFileError("agent not running")).toBe("other");
  });
});

describe("resolveNodeName", () => {
  it("returns the trimmed hostname", async () => {
    const t = new FakeTransport();
    t.setExecResult("hostname", { stdout: "pve\n", stderr: "", exitCode: 0 });
    expect(await resolveNodeName(t)).toBe("pve");
  });

  it("throws when hostname exits non-zero", async () => {
    const t = new FakeTransport();
    t.setExecResult("hostname", { stdout: "", stderr: "boom", exitCode: 1 });
    await expect(resolveNodeName(t)).rejects.toThrow(/resolve node name/i);
  });

  it("rejects a hostname that fails the charset guard", async () => {
    const t = new FakeTransport();
    t.setExecResult("hostname", { stdout: "bad host name!\n", stderr: "", exitCode: 0 });
    await expect(resolveNodeName(t)).rejects.toThrow(/valid hostname/i);
  });
});

describe("assertAgentAvailable", () => {
  it("passes when the agent ping succeeds", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "", exitCode: 0 });
    await expect(assertAgentAvailable(t, 200)).resolves.toBeUndefined();
  });

  it("throws a fix-naming error mentioning qemu-guest-agent when absent", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "QEMU guest agent is not running", exitCode: 1 });
    await expect(assertAgentAvailable(t, 200)).rejects.toThrow(/qemu-guest-agent/i);
  });
});

describe("readVmFile", () => {
  it("returns decoded content on success", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/x.conf"), {
      stdout: JSON.stringify({ content: "body", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const r = await readVmFile(t, "pve", 200, "/etc/x.conf");
    expect(r.content?.toString("utf8")).toBe("body");
  });

  it("returns null content on a not-found read failure", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/missing"), {
      stdout: "",
      stderr: "No such file or directory",
      exitCode: 1,
    });
    const r = await readVmFile(t, "pve", 200, "/etc/missing");
    expect(r.content).toBeNull();
  });

  it("throws on a non-not-found read failure instead of inventing a new file", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/x.conf"), {
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });
    await expect(readVmFile(t, "pve", 200, "/etc/x.conf")).rejects.toThrow(/file-read failed/i);
  });
});

describe("writeVmFile", () => {
  it("base64-encodes locally and issues the write command", async () => {
    const t = new FakeTransport();
    const content = Buffer.from("hello");
    t.setExecResult(buildAgentFileWriteCommand("pve", 200, "/etc/x.conf", content.toString("base64")), {
      stdout: "", stderr: "", exitCode: 0,
    });
    await expect(writeVmFile(t, "pve", 200, "/etc/x.conf", content)).resolves.toBeUndefined();
  });

  it("throws when the write command exits non-zero", async () => {
    const t = new FakeTransport();
    // No matching exec result registered → FakeTransport returns exit 0 by default,
    // so register an explicit failure for the exact command.
    const content = Buffer.from("hello");
    t.setExecResult(buildAgentFileWriteCommand("pve", 200, "/etc/x.conf", content.toString("base64")), {
      stdout: "", stderr: "disk full", exitCode: 1,
    });
    await expect(writeVmFile(t, "pve", 200, "/etc/x.conf", content)).rejects.toThrow(/file-write failed/i);
  });
});
