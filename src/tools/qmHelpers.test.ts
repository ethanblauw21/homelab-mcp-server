import { describe, it, expect } from "vitest";
import {
  parseAgentExec,
  buildQmGuestExecCommand,
  buildQmAgentPingCommand,
} from "./qmHelpers.js";

describe("buildQmAgentPingCommand", () => {
  it("builds the ping command", () => {
    expect(buildQmAgentPingCommand(101)).toBe("qm agent 101 ping");
  });
});

describe("buildQmGuestExecCommand", () => {
  it("wraps the command in sh -c with single-quote escaping and a timeout", () => {
    expect(buildQmGuestExecCommand(101, "echo hi", { timeoutSecs: 30 })).toBe(
      "qm guest exec 101 --timeout 30 -- sh -c 'echo hi'"
    );
  });

  it("omits --timeout when not given and escapes embedded quotes", () => {
    expect(buildQmGuestExecCommand(7, "echo 'a'")).toBe(
      "qm guest exec 7 -- sh -c 'echo '\\''a'\\'''"
    );
  });

  it("honors an explicit shell override", () => {
    expect(buildQmGuestExecCommand(7, "echo hi", { shell: "bash", timeoutSecs: 5 })).toBe(
      "qm guest exec 7 --timeout 5 -- bash -c 'echo hi'"
    );
  });
});

describe("parseAgentExec", () => {
  it("maps a normal exit onto ExecResult", () => {
    const r = parseAgentExec(
      JSON.stringify({ exited: 1, exitcode: 0, "out-data": "hello\n", "err-data": "" })
    );
    expect(r).toMatchObject({ stdout: "hello\n", stderr: "", exitCode: 0 });
    expect(r.timedOut).toBeUndefined();
  });

  it("maps a non-zero exit and stderr", () => {
    const r = parseAgentExec(
      JSON.stringify({ exited: 1, exitcode: 2, "out-data": "", "err-data": "boom\n" })
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("boom\n");
  });

  it("surfaces out-truncated as a result field", () => {
    const r = parseAgentExec(
      JSON.stringify({ exited: 1, exitcode: 0, "out-data": "x", "out-truncated": true })
    );
    expect(r.outTruncated).toBe(true);
  });

  it("maps not-exited onto timedOut with null exit code and pid", () => {
    const r = parseAgentExec(JSON.stringify({ exited: 0, pid: 4242, "out-data": "partial" }));
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(true);
    expect(r.pid).toBe(4242);
    expect(r.stdout).toBe("partial");
  });

  it("maps a signal kill onto exitCode null with a signal label (never 0)", () => {
    const r = parseAgentExec(JSON.stringify({ exited: 1, signal: 9, "out-data": "" }));
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe("signal 9");
  });

  it("throws a structured error on malformed JSON", () => {
    expect(() => parseAgentExec("not json{")).toThrow(/unparseable JSON/i);
  });

  it("throws on a non-object payload", () => {
    expect(() => parseAgentExec("[1,2,3]")).toThrow(/non-object/i);
  });
});
