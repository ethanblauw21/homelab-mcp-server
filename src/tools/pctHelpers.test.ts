import { describe, it, expect } from "vitest";
import { parsePctList, buildPctExecCommand } from "./pctHelpers.js";

const SAMPLE_PCT_LIST = `VMID       Status     Lock         Name
100        running                 gluetun
101        stopped                 tailscale
102        running                 portainer
200        stopped    backup       somevm`;

describe("parsePctList", () => {
  it("parses a typical pct list output", () => {
    const containers = parsePctList(SAMPLE_PCT_LIST);
    expect(containers).toHaveLength(4);
  });

  it("parses running container correctly", () => {
    const containers = parsePctList(SAMPLE_PCT_LIST);
    const gluetun = containers.find((c) => c.vmid === 100);
    expect(gluetun).toBeDefined();
    expect(gluetun?.status).toBe("running");
    expect(gluetun?.name).toBe("gluetun");
  });

  it("parses stopped container correctly", () => {
    const containers = parsePctList(SAMPLE_PCT_LIST);
    const tailscale = containers.find((c) => c.vmid === 101);
    expect(tailscale?.status).toBe("stopped");
    expect(tailscale?.name).toBe("tailscale");
  });

  it("parses vmid as a number", () => {
    const containers = parsePctList(SAMPLE_PCT_LIST);
    containers.forEach((c) => expect(typeof c.vmid).toBe("number"));
  });

  it("handles empty output", () => {
    expect(parsePctList("")).toHaveLength(0);
    expect(parsePctList("VMID  Status  Lock  Name\n")).toHaveLength(0);
  });

  it("handles a container with a lock field", () => {
    const containers = parsePctList(SAMPLE_PCT_LIST);
    const locked = containers.find((c) => c.vmid === 200);
    expect(locked?.lock).toBe("backup");
  });
});

describe("buildPctExecCommand", () => {
  it("builds a basic pct exec command (bash by default, A4.1)", () => {
    const cmd = buildPctExecCommand(100, "ls /");
    expect(cmd).toBe("pct exec 100 -- bash -c 'ls /'");
  });

  it("escapes single quotes in the command", () => {
    const cmd = buildPctExecCommand(101, "echo 'hello world'");
    expect(cmd).toBe("pct exec 101 -- bash -c 'echo '\\''hello world'\\'''");
  });

  it("handles commands with double quotes", () => {
    const cmd = buildPctExecCommand(102, 'grep "error" /var/log/syslog');
    expect(cmd).toBe('pct exec 102 -- bash -c \'grep "error" /var/log/syslog\'');
  });

  it("uses the correct vmid", () => {
    const cmd = buildPctExecCommand(999, "id");
    expect(cmd).toMatch(/^pct exec 999/);
  });

  it("wraps command in bash -c", () => {
    const cmd = buildPctExecCommand(100, "uptime");
    expect(cmd).toContain("bash -c");
  });

  it("falls back to sh -c for minimal guests", () => {
    const cmd = buildPctExecCommand(100, "uptime", { shell: "sh" });
    expect(cmd).toBe("pct exec 100 -- sh -c 'uptime'");
  });

  it("composes an in-container timeout wrapper when timeoutSecs is set", () => {
    const cmd = buildPctExecCommand(100, "sleep 99", { timeoutSecs: 5 });
    expect(cmd).toBe(
      "pct exec 100 -- timeout --signal=TERM --kill-after=5 5 bash -c 'sleep 99'"
    );
  });
});
