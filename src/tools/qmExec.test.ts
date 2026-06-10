import { describe, it, expect, beforeEach } from "vitest";
import { qmExecHandler } from "./qmExec.js";
import { qmListHandler } from "./qmList.js";
import { qmAgentPingHandler } from "./qmAgentPing.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import fs from "fs";
import os from "os";
import path from "path";

function makeConfig(tmpDir: string): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "backups"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    snapshot: { perGuestCap: 3, vmstate: false },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  } as unknown as Config;
}

const AGENT_OK = { stdout: "", stderr: "", exitCode: 0 };

describe("qmListHandler", () => {
  it("parses qm list rows", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm list", {
      stdout: "      VMID NAME        STATUS     MEM(MB)    BOOTDISK(GB) PID\n       100 web         running    2048       32           1234\n       101 db          stopped    4096       64           -\n",
      stderr: "",
      exitCode: 0,
    });
    const res = await qmListHandler({}, t);
    expect(res.vms).toHaveLength(2);
    expect(res.vms[0]).toMatchObject({ vmid: 100, name: "web", status: "running", pid: 1234 });
    expect(res.vms[1]!.pid).toBeUndefined();
  });
});

describe("qmAgentPingHandler", () => {
  it("reports available on exit 0", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 100 ping", AGENT_OK);
    expect(await qmAgentPingHandler({ vmid: 100 }, t)).toEqual({ available: true });
  });

  it("reports unavailable with the node's reason on failure", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 100 ping", { stdout: "", stderr: "No QEMU guest agent configured", exitCode: 255 });
    const res = await qmAgentPingHandler({ vmid: 100 }, t);
    expect(res.available).toBe(false);
    expect(res.error).toMatch(/No QEMU guest agent/);
  });
});

describe("qmExecHandler", () => {
  let tmpDir: string;
  let cfg: Config;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qmexec-"));
    cfg = makeConfig(tmpDir);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("runs an allowed command, parses the agent JSON, and audits with vmid", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 100 ping", AGENT_OK);
    t.setExecResult("qm guest exec 100 --timeout 5 -- sh -c 'uptime'", {
      stdout: JSON.stringify({ exited: 1, exitcode: 0, "out-data": "up 3 days\n" }),
      stderr: "",
      exitCode: 0,
    });

    const res = await qmExecHandler({ vmid: 100, command: "uptime" }, t, audit, cfg);
    expect(res.stdout).toBe("up 3 days\n");
    expect(res.exitCode).toBe(0);

    const records = audit.readAll();
    expect(records[0]).toMatchObject({ tool: "qm_exec", vmid: 100 });
  });

  it("refuses a DENY-tier command before pinging or executing", async () => {
    const t = new FakeTransport();
    await expect(
      qmExecHandler({ vmid: 100, command: "rm -rf /" }, t, audit, cfg)
    ).rejects.toThrow(/denied/i);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("refuses a CONFIRM-tier command without confirm:true, allows with it", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 100 ping", AGENT_OK);
    t.setExecResult("qm guest exec 100 --timeout 5 -- sh -c 'reboot'", {
      stdout: JSON.stringify({ exited: 1, exitcode: 0, "out-data": "" }),
      stderr: "",
      exitCode: 0,
    });

    await expect(
      qmExecHandler({ vmid: 100, command: "reboot" }, t, audit, cfg)
    ).rejects.toThrow(/confirm/i);

    await qmExecHandler({ vmid: 100, command: "reboot", confirm: true }, t, audit, cfg);
    expect(audit.readAll()[0]!.confirmGated).toBe(true);
  });

  it("errors with a fix-naming message when the agent is unavailable", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 100 ping", { stdout: "", stderr: "not running", exitCode: 255 });
    await expect(
      qmExecHandler({ vmid: 100, command: "uptime" }, t, audit, cfg)
    ).rejects.toThrow(/qemu-guest-agent/i);
  });

  it("records timedOut + guest pid in the audit note when the agent reports not-exited", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 100 ping", AGENT_OK);
    t.setExecResult("qm guest exec 100 --timeout 5 -- sh -c 'sleep 999'", {
      stdout: JSON.stringify({ exited: 0, pid: 5151, "out-data": "" }),
      stderr: "",
      exitCode: 0,
    });
    const res = await qmExecHandler({ vmid: 100, command: "sleep 999" }, t, audit, cfg);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    const note = audit.readAll()[0]!.note ?? "";
    expect(note).toMatch(/5151/);
  });
});
