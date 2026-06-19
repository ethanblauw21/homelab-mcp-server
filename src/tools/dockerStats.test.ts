import { describe, it, expect } from "vitest";
import { dockerStatsHandler } from "./dockerStats.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerStatsCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

const cfg = { ssh: { commandTimeoutMs: 5000 } } as unknown as Config;

describe("dockerStatsHandler (ADR-016 §2)", () => {
  it("runs docker stats --no-stream and returns mem-sorted rows", async () => {
    const t = new FakeTransport();
    const out = [
      JSON.stringify({ Name: "small", CPUPerc: "0.10%", MemUsage: "5MiB / 1GiB", MemPerc: "0.49%", NetIO: "0B / 0B", BlockIO: "0B / 0B" }),
      JSON.stringify({ Name: "big", CPUPerc: "30.00%", MemUsage: "800MiB / 1GiB", MemPerc: "78.00%", NetIO: "1MB / 2MB", BlockIO: "0B / 0B" }),
    ].join("\n");
    t.setExecResult(buildPctExecCommand(101, buildDockerStatsCommand()), { stdout: out, stderr: "", exitCode: 0 });

    const r = await dockerStatsHandler({ vmid: 101 }, t, cfg);
    expect(r.vmid).toBe(101);
    expect(r.stats.map((s) => s.name)).toEqual(["big", "small"]);
    expect(r.stats[0]!.cpuPct).toBe(30);
  });

  it("throws a helpful error when docker stats fails", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctExecCommand(101, buildDockerStatsCommand()), {
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      exitCode: 1,
    });
    await expect(dockerStatsHandler({ vmid: 101 }, t, cfg)).rejects.toThrow(/docker stats failed.*1/s);
  });
});
