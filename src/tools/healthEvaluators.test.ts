import { describe, it, expect } from "vitest";
import {
  statusFromThresholds,
  evaluateLoad,
  evaluateMemory,
  evaluateUsage,
  evaluateZpool,
  evaluateFailedUnits,
  evaluateOnbootStopped,
  evaluatePendingUpdates,
  rollupStatus,
  parseOnbootConfig,
  parseAptUpgradeCount,
} from "./healthEvaluators.js";

describe("statusFromThresholds (boundaries)", () => {
  it("is ok below warn, warn at/above warn, crit at/above crit", () => {
    expect(statusFromThresholds(0.79, 0.8, 1.5)).toBe("ok");
    expect(statusFromThresholds(0.8, 0.8, 1.5)).toBe("warn"); // inclusive
    expect(statusFromThresholds(1.49, 0.8, 1.5)).toBe("warn");
    expect(statusFromThresholds(1.5, 0.8, 1.5)).toBe("crit"); // inclusive
  });
});

describe("evaluateLoad", () => {
  it("uses the 1m/cores ratio and guards against zero cores", () => {
    expect(evaluateLoad(8, 8, { warnRatio: 0.8, critRatio: 1.5 }).status).toBe("warn"); // ratio 1.0
    expect(evaluateLoad(16, 8, { warnRatio: 0.8, critRatio: 1.5 }).status).toBe("crit"); // ratio 2.0
    expect(evaluateLoad(0.1, 0, { warnRatio: 0.8, critRatio: 1.5 }).status).toBe("ok"); // cores→1
  });
});

describe("evaluateMemory / evaluateUsage", () => {
  it("computes percentages and statuses", () => {
    expect(evaluateMemory(95, 100, { warnPercent: 85, critPercent: 95 }).status).toBe("crit");
    expect(evaluateMemory(86, 100, { warnPercent: 85, critPercent: 95 }).status).toBe("warn");
    expect(evaluateMemory(10, 100, { warnPercent: 85, critPercent: 95 }).status).toBe("ok");
    expect(evaluateUsage("fs:/", 0, 0, { warnPercent: 80, critPercent: 90 }).status).toBe("ok"); // no div-by-zero
  });
});

describe("evaluateZpool", () => {
  it("crit on unhealthy, ok on healthy", () => {
    expect(evaluateZpool({ healthy: true, detail: "all pools are healthy" }).status).toBe("ok");
    expect(evaluateZpool({ healthy: false, detail: "pool tank DEGRADED" }).status).toBe("crit");
  });
});

describe("evaluateFailedUnits", () => {
  it("ok when none, warn when some, crit when a critical unit failed", () => {
    expect(evaluateFailedUnits([], []).status).toBe("ok");
    expect(evaluateFailedUnits(["smartd.service"], []).status).toBe("warn");
    expect(evaluateFailedUnits(["sshd.service", "x.service"], ["sshd.service"]).status).toBe("crit");
  });
});

describe("evaluateOnbootStopped", () => {
  it("warns only on guests that are onboot AND not running", () => {
    expect(
      evaluateOnbootStopped([
        { vmid: 1, name: "a", onboot: true, status: "running" },
        { vmid: 2, name: "b", onboot: false, status: "stopped" },
      ]).status
    ).toBe("ok");
    const r = evaluateOnbootStopped([{ vmid: 3, name: "c", onboot: true, status: "stopped" }]);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("3:c");
  });
});

describe("evaluatePendingUpdates", () => {
  it("warns strictly above the configured count", () => {
    expect(evaluatePendingUpdates(50, 50).status).toBe("ok");
    expect(evaluatePendingUpdates(51, 50).status).toBe("warn");
  });
});

describe("rollupStatus", () => {
  it("returns the worst status present", () => {
    expect(rollupStatus([{ status: "ok" }, { status: "warn" }])).toBe("warn");
    expect(rollupStatus([{ status: "warn" }, { status: "crit" }])).toBe("crit");
    expect(rollupStatus([{ status: "ok" }, { status: "ok" }])).toBe("ok");
  });
});

describe("parseOnbootConfig", () => {
  it("maps vmid → onboot from grep -H output for both lxc and qemu paths", () => {
    const out = [
      "/etc/pve/lxc/101.conf:onboot: 1",
      "/etc/pve/lxc/102.conf:onboot: 0",
      "/etc/pve/qemu-server/100.conf:onboot: 1",
      "garbage line",
    ].join("\n");
    const m = parseOnbootConfig(out);
    expect(m.get(101)).toBe(true);
    expect(m.get(102)).toBe(false);
    expect(m.get(100)).toBe(true);
    expect(m.size).toBe(3);
  });
});

describe("parseAptUpgradeCount", () => {
  it("counts only Inst lines from apt-get -s output", () => {
    const out = [
      "Reading package lists...",
      "Inst libc6 [2.31-13] (2.31-14 Debian:11/stable [amd64])",
      "Conf libc6 (2.31-14 ...)",
      "Inst openssl [1.1.1n] (1.1.1w ...)",
    ].join("\n");
    expect(parseAptUpgradeCount(out)).toBe(2);
    expect(parseAptUpgradeCount("")).toBe(0);
  });
});
