import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { executeHandler } from "./execute.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

function makeConfig(tmpDir: string, denylist: string[] = []): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, commandTimeoutGraceMs: 10000, skipHostVerification: true },
    backup: { baseDir: path.join(tmpDir, "b"), largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    tools: { readFileMaxBytes: 2 * 1024 * 1024, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: denylist, pathAllowlist: undefined, pathDenylist: [] },
  };
}

describe("executeHandler (ADR-004 confirm gate + honest exit)", () => {
  let tmpDir: string;
  let transport: FakeTransport;
  let audit: AuditLog;
  let cfg: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-unit-"));
    transport = new FakeTransport();
    cfg = makeConfig(tmpDir);
    audit = new AuditLog(cfg.audit.logPath);
  });

  it("throws for a DENY-tier command", async () => {
    await expect(executeHandler({ command: "rm -rf /" }, transport, audit, cfg)).rejects.toThrow(
      /denied/i
    );
  });

  it("refuses a CONFIRM-tier command without confirm:true", async () => {
    await expect(executeHandler({ command: "reboot" }, transport, audit, cfg)).rejects.toThrow(
      /requires confirmation.*confirm:true/is
    );
  });

  it("runs a CONFIRM-tier command with confirm:true and audits confirmGated", async () => {
    transport.setExecResult("reboot", { stdout: "", stderr: "", exitCode: 0 });
    await executeHandler({ command: "reboot", confirm: true }, transport, audit, cfg);
    const records = audit.readAll();
    expect(records[0].confirmGated).toBe(true);
  });

  it("propagates signal/timedOut/null exitCode into the result and audit", async () => {
    transport.setExecResult("dmesg", { stdout: "", stderr: "", exitCode: null, signal: "SIGKILL" });
    const r = await executeHandler({ command: "dmesg" }, transport, audit, cfg);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe("SIGKILL");
    const records = audit.readAll();
    expect(records[0].exitCode).toBeNull();
    expect(records[0].signal).toBe("SIGKILL");
  });

  it("records timeoutSecs in the audit log", async () => {
    transport.setExecResult("uptime", { stdout: "", stderr: "", exitCode: 0 });
    await executeHandler({ command: "uptime", timeoutMs: 4000 }, transport, audit, cfg);
    const records = audit.readAll();
    expect(records[0].timeoutSecs).toBe(4);
  });

  it("runs a plain allowed command", async () => {
    transport.setExecResult("ls /", { stdout: "bin\n", stderr: "", exitCode: 0 });
    const r = await executeHandler({ command: "ls /" }, transport, audit, cfg);
    expect(r.stdout).toBe("bin\n");
    expect(audit.readAll()[0].confirmGated).toBeUndefined();
  });

  // ADR-008 §4 — heavy patterns must run WITHOUT confirm and annotate isHeavy,
  // never isLargeChange (which is for large file writes) and never confirmGated.
  describe("heavy-pattern annotation (ADR-008 §4)", () => {
    const heavy: Array<[string, string]> = [
      ["curl health check", "curl http://localhost:3000/health"],
      ["wget download", "wget https://example.com/file.iso"],
      ["tar archive", "tar -czf backup.tar.gz /var"],
      ["rsync mirror", "rsync -av /src /dst"],
    ];

    for (const [label, cmd] of heavy) {
      it(`runs ${label} without confirm and annotates isHeavy`, async () => {
        transport.setExecResult(cmd, { stdout: "ok", stderr: "", exitCode: 0 });
        const r = await executeHandler({ command: cmd }, transport, audit, cfg);
        expect(r.exitCode).toBe(0);
        const rec = audit.readAll()[0];
        expect(rec.isHeavy).toBe(true);
        expect(rec.isLargeChange).toBeUndefined();
        expect(rec.confirmGated).toBeUndefined();
      });
    }

    it("does not annotate isHeavy on an ordinary command", async () => {
      transport.setExecResult("ls /", { stdout: "bin\n", stderr: "", exitCode: 0 });
      await executeHandler({ command: "ls /" }, transport, audit, cfg);
      expect(audit.readAll()[0].isHeavy).toBeUndefined();
    });
  });
});
