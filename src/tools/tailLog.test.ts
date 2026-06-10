import { describe, it, expect } from "vitest";
import {
  tailLogHandler,
  buildTailCommand,
  validateUnitName,
  validateSince,
  clampLines,
  type TailLogInput,
} from "./tailLog.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    ssh: { host: "h", commandTimeoutMs: 5000 },
    tools: { tailLinesCap: 500 },
    health: { probeTimeoutMs: 5000 },
    census: { redactionExtraKeys: [] },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: ["/proc", "/sys", "/dev"] },
  } as unknown as Config;
}

describe("validateUnitName", () => {
  it("accepts real unit names, rejects shell metacharacters", () => {
    expect(validateUnitName("sshd.service")).toBe(true);
    expect(validateUnitName("getty@tty1.service")).toBe(true);
    expect(validateUnitName("foo; rm -rf /")).toBe(false);
    expect(validateUnitName("a b")).toBe(false);
    expect(validateUnitName("$(reboot)")).toBe(false);
  });
});

describe("validateSince", () => {
  it("accepts ISO and relative grammar, rejects free-form", () => {
    expect(validateSince("2026-06-10")).toBe(true);
    expect(validateSince("2026-06-10 14:30:00")).toBe(true);
    expect(validateSince("30 min ago")).toBe(true);
    expect(validateSince("2 hours ago")).toBe(true);
    expect(validateSince("yesterday")).toBe(false);
    expect(validateSince("`reboot`")).toBe(false);
  });
});

describe("clampLines", () => {
  it("defaults sanely and clamps to the cap", () => {
    expect(clampLines(undefined, 500)).toBe(100);
    expect(clampLines(9999, 500)).toBe(500);
    expect(clampLines(10, 500)).toBe(10);
    expect(clampLines(0, 500)).toBe(1);
  });
});

describe("buildTailCommand", () => {
  const cfg = makeConfig();

  it("builds a journalctl command for unit mode with since", () => {
    const r = buildTailCommand(
      { target: { kind: "host" }, unit: "sshd.service", lines: 50, since: "30 min ago" } as TailLogInput,
      cfg
    );
    expect(r.command).toBe("journalctl -u 'sshd.service' -n 50 --no-pager --since '30 min ago'");
    expect(r.mode).toBe("unit");
  });

  it("builds a tail command for path mode, routed through pct exec for containers", () => {
    const r = buildTailCommand(
      { target: { kind: "pct", vmid: 101 }, path: "/var/log/syslog", lines: 20 } as TailLogInput,
      cfg
    );
    expect(r.command).toBe("pct exec 101 -- bash -c 'tail -n 20 '\\''/var/log/syslog'\\'''");
    expect(r.mode).toBe("path");
  });

  it("rejects providing both unit and path", () => {
    expect(() =>
      buildTailCommand({ target: { kind: "host" }, unit: "a.service", path: "/x" } as TailLogInput, cfg)
    ).toThrow(/exactly one/i);
  });

  it("rejects providing neither", () => {
    expect(() => buildTailCommand({ target: { kind: "host" } } as TailLogInput, cfg)).toThrow(/exactly one/i);
  });

  it("rejects an invalid unit name and a denylisted path", () => {
    expect(() =>
      buildTailCommand({ target: { kind: "host" }, unit: "a;reboot" } as TailLogInput, cfg)
    ).toThrow(/invalid unit/i);
    expect(() =>
      buildTailCommand({ target: { kind: "host" }, path: "/proc/1/mem" } as TailLogInput, cfg)
    ).toThrow(/invalid path/i);
  });

  it("rejects `since` in path mode", () => {
    expect(() =>
      buildTailCommand(
        { target: { kind: "host" }, path: "/var/log/syslog", since: "2026-06-10" } as TailLogInput,
        cfg
      )
    ).toThrow(/since.*only valid/i);
  });
});

describe("tailLogHandler — redaction is mandatory", () => {
  it("redacts secrets in returned log content", async () => {
    const t = new FakeTransport();
    const cmd = "journalctl -u 'app.service' -n 100 --no-pager";
    t.setExecResult(cmd, {
      stdout:
        "starting app\nAuthorization: Bearer sk-supersecrettoken12345\nDB_PASSWORD=hunter2 connecting\nok\n",
      stderr: "",
      exitCode: 0,
    });
    const res = await tailLogHandler({ target: { kind: "host" }, unit: "app.service" } as TailLogInput, t, makeConfig());

    expect(res.content).not.toContain("sk-supersecrettoken12345");
    expect(res.content).not.toContain("hunter2");
    expect(res.content).toContain("[REDACTED]");
    expect(res.content).toContain("starting app"); // non-secret lines preserved
  });
});
