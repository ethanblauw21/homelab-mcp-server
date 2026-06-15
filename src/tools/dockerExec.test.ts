import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { dockerExecHandler } from "./dockerExec.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerExecCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { AuditLog } from "../audit/log.js";
import { timeoutMsToSecs } from "../ssh/command.js";
import type { Config } from "../config.js";

function makeConfig(tmpDir: string): Config {
  return {
    ssh: { host: "h", commandTimeoutMs: 5000 },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  } as unknown as Config;
}

/** Build the exact command the handler will issue for a given inner command. */
function execCmd(vmid: number, container: string, cmd: string, timeoutMs = 5000): string {
  const docker = buildDockerExecCommand(container, cmd, { timeoutSecs: timeoutMsToSecs(timeoutMs) });
  return buildPctExecCommand(vmid, docker);
}

describe("dockerExecHandler (denylist v2 + confirm — the 4th exec path)", () => {
  let tmpDir: string;
  let t: FakeTransport;
  let audit: AuditLog;
  let cfg: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerexec-"));
    t = new FakeTransport();
    cfg = makeConfig(tmpDir);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("runs an allowed command and audits container + tool", async () => {
    t.setExecResult(execCmd(101, "web", "cat /etc/hostname"), { stdout: "web\n", stderr: "", exitCode: 0 });
    const r = await dockerExecHandler({ vmid: 101, container: "web", command: "cat /etc/hostname" }, t, audit, cfg);
    expect(r.stdout).toBe("web\n");
    const rec = audit.readAll()[0];
    expect(rec.tool).toBe("docker_exec");
    expect(rec.vmid).toBe(101);
    expect(rec.container).toBe("web");
  });

  it("denies a DENY-tier command", async () => {
    await expect(
      dockerExecHandler({ vmid: 101, container: "web", command: "rm -rf /" }, t, audit, cfg)
    ).rejects.toThrow(/denied/i);
  });

  it("refuses a CONFIRM-tier command without confirm:true", async () => {
    await expect(
      dockerExecHandler({ vmid: 101, container: "web", command: "reboot" }, t, audit, cfg)
    ).rejects.toThrow(/requires confirmation/i);
  });

  it("runs a CONFIRM-tier command with confirm:true and audits confirmGated", async () => {
    t.setExecResult(execCmd(101, "web", "reboot"), { stdout: "", stderr: "", exitCode: 0 });
    await dockerExecHandler({ vmid: 101, container: "web", command: "reboot", confirm: true }, t, audit, cfg);
    expect(audit.readAll()[0].confirmGated).toBe(true);
  });

  it("annotates isHeavy (never gates) on a heavy command", async () => {
    t.setExecResult(execCmd(101, "web", "curl http://localhost/health"), { stdout: "ok", stderr: "", exitCode: 0 });
    const r = await dockerExecHandler({ vmid: 101, container: "web", command: "curl http://localhost/health" }, t, audit, cfg);
    expect(r.exitCode).toBe(0);
    const rec = audit.readAll()[0];
    expect(rec.isHeavy).toBe(true);
    expect(rec.isLargeChange).toBeUndefined();
    expect(rec.confirmGated).toBeUndefined();
  });

  it("rejects an invalid container name before running anything", async () => {
    await expect(
      dockerExecHandler({ vmid: 101, container: "bad name", command: "ls" }, t, audit, cfg)
    ).rejects.toThrow(/Invalid Docker container name/);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("propagates honest exit semantics (null exitCode / signal)", async () => {
    t.setExecResult(execCmd(101, "web", "sleep 99"), { stdout: "", stderr: "", exitCode: null, signal: "SIGKILL" });
    const r = await dockerExecHandler({ vmid: 101, container: "web", command: "sleep 99" }, t, audit, cfg);
    expect(r.exitCode).toBeNull();
    expect(audit.readAll()[0].signal).toBe("SIGKILL");
  });
});
