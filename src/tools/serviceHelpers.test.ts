import { describe, it, expect } from "vitest";
import {
  buildServiceStatusCommand,
  buildServiceRestartCommand,
  parseServiceShow,
} from "./serviceHelpers.js";

describe("buildServiceStatusCommand", () => {
  it("builds a single-quoted systemctl show with the fixed property set", () => {
    expect(buildServiceStatusCommand("nginx")).toBe(
      "systemctl show -p ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,MainPID --no-pager 'nginx'"
    );
  });

  it("accepts a templated instance unit", () => {
    expect(buildServiceStatusCommand("getty@tty1.service")).toContain("'getty@tty1.service'");
  });

  it("refuses a unit name with shell metacharacters", () => {
    expect(() => buildServiceStatusCommand("nginx; rm -rf /")).toThrow(/Invalid unit name/);
    expect(() => buildServiceStatusCommand("$(reboot)")).toThrow(/Invalid unit name/);
  });
});

describe("buildServiceRestartCommand", () => {
  it("builds a single-quoted systemctl restart", () => {
    expect(buildServiceRestartCommand("docker")).toBe("systemctl restart 'docker'");
  });

  it("refuses an invalid unit name", () => {
    expect(() => buildServiceRestartCommand("a b")).toThrow(/Invalid unit name/);
  });
});

describe("parseServiceShow", () => {
  it("parses a running unit with all fields", () => {
    const out = [
      "ActiveState=active",
      "SubState=running",
      "UnitFileState=enabled",
      "ActiveEnterTimestamp=Sun 2026-06-22 10:00:00 UTC",
      "MainPID=1234",
    ].join("\n");
    expect(parseServiceShow(out)).toEqual({
      active: "active",
      sub: "running",
      enabled: "enabled",
      since: "Sun 2026-06-22 10:00:00 UTC",
      mainPid: 1234,
    });
  });

  it("collapses MainPID=0 and an empty timestamp to undefined", () => {
    const out = [
      "ActiveState=inactive",
      "SubState=dead",
      "UnitFileState=disabled",
      "ActiveEnterTimestamp=",
      "MainPID=0",
    ].join("\n");
    const r = parseServiceShow(out);
    expect(r).toEqual({ active: "inactive", sub: "dead", enabled: "disabled" });
    expect(r.since).toBeUndefined();
    expect(r.mainPid).toBeUndefined();
  });

  it("defaults missing keys to empty strings (stable shape)", () => {
    expect(parseServiceShow("ActiveState=failed")).toEqual({
      active: "failed",
      sub: "",
      enabled: "",
    });
  });

  it("tolerates blank lines and values containing '='", () => {
    const out = "\nActiveState=active\nUnitFileState=enabled-runtime\n\nMainPID=7\n";
    const r = parseServiceShow(out);
    expect(r.active).toBe("active");
    expect(r.enabled).toBe("enabled-runtime");
    expect(r.mainPid).toBe(7);
  });
});
