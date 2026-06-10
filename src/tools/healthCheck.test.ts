import { describe, it, expect } from "vitest";
import { healthCheckHandler } from "./healthCheck.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    ssh: { host: "h", commandTimeoutMs: 5000 },
    health: {
      loadWarnRatio: 0.8,
      loadCritRatio: 1.5,
      memWarnPercent: 85,
      memCritPercent: 95,
      fsWarnPercent: 80,
      fsCritPercent: 90,
      failedUnitsCritList: [],
      pendingUpdatesWarnCount: 50,
      probeTimeoutMs: 5000,
    },
  } as unknown as Config;
}

describe("healthCheckHandler", () => {
  it("rolls up to crit when memory is over the crit threshold and isolates section errors", async () => {
    const t = new FakeTransport();
    t.setExecResult("nproc", { stdout: "8\n", stderr: "", exitCode: 0 });
    t.setExecResult("cat /proc/loadavg", { stdout: "0.20 0.10 0.05 1/100 1", stderr: "", exitCode: 0 });
    // 99% memory → crit
    t.setExecResult("free -b", { stdout: "Mem: 100 99 1 0 0 1\nSwap: 0 0 0", stderr: "", exitCode: 0 });
    t.setExecResult("zpool status -x", { stdout: "all pools are healthy", stderr: "", exitCode: 0 });
    // storage probe fails → recorded as a section error, doesn't abort
    t.setExecResult("df -B1 --output=target,size,used,avail", { stdout: "", stderr: "df: boom", exitCode: 1 });

    const res = await healthCheckHandler({ sections: ["node", "storage"] }, t, makeConfig());

    expect(res.status).toBe("crit");
    const mem = res.findings.find((f) => f.check === "memory");
    expect(mem?.status).toBe("crit");
    expect(res.findings.find((f) => f.check === "zfs")?.status).toBe("ok");
    expect(res.errors.some((e) => e.section === "storage")).toBe(true);
  });

  it("tolerates absent ZFS (soft probe) and reports ok overall", async () => {
    const t = new FakeTransport();
    t.setExecResult("nproc", { stdout: "8\n", stderr: "", exitCode: 0 });
    t.setExecResult("cat /proc/loadavg", { stdout: "0.10 0.10 0.10 1/1 1", stderr: "", exitCode: 0 });
    t.setExecResult("free -b", { stdout: "Mem: 100 10 90 0 0 90\nSwap: 0 0 0", stderr: "", exitCode: 0 });
    t.setExecResult("zpool status -x", { stdout: "", stderr: "zpool: not found", exitCode: 127 });

    const res = await healthCheckHandler({ sections: ["node"] }, t, makeConfig());
    expect(res.status).toBe("ok");
    expect(res.findings.some((f) => f.check === "zfs")).toBe(false); // soft-skipped
    expect(res.errors).toHaveLength(0);
  });

  it("flags onboot-but-stopped guests as warn", async () => {
    const t = new FakeTransport();
    t.setExecResult("pct list", { stdout: "VMID Status Lock Name\n101 stopped gluetun", stderr: "", exitCode: 0 });
    t.setExecResult("qm list", { stdout: "VMID NAME STATUS\n100 truenas running", stderr: "", exitCode: 0 });
    t.setExecResult(
      "grep -H '^onboot:' /etc/pve/lxc/*.conf /etc/pve/qemu-server/*.conf 2>/dev/null || true",
      { stdout: "/etc/pve/lxc/101.conf:onboot: 1\n/etc/pve/qemu-server/100.conf:onboot: 1", stderr: "", exitCode: 0 }
    );

    const res = await healthCheckHandler({ sections: ["guests"] }, t, makeConfig());
    const g = res.findings.find((f) => f.check === "onboot-guests");
    expect(g?.status).toBe("warn");
    expect(g?.detail).toContain("101:gluetun");
  });

  it("counts pending updates via apt-get -s without running apt update", async () => {
    const t = new FakeTransport();
    t.setExecResult("apt-get -s -o Debug::NoLocking=true upgrade", {
      stdout: "Inst a [1] (2 ...)\nConf a\nInst b [1] (2 ...)",
      stderr: "",
      exitCode: 0,
    });
    const res = await healthCheckHandler({ sections: ["updates"] }, t, makeConfig());
    expect(res.findings.find((f) => f.check === "updates")?.finding).toContain("2 pending");
  });
});
