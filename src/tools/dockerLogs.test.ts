import { describe, it, expect } from "vitest";
import { dockerLogsHandler } from "./dockerLogs.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerLogsCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

const cfg = {
  ssh: { commandTimeoutMs: 5000 },
  health: { probeTimeoutMs: 5000 },
  tools: { tailLinesCap: 500 },
  census: { redactionExtraKeys: [] },
} as unknown as Config;

function logCmd(vmid: number, container: string, tail: number, since?: string): string {
  return buildPctExecCommand(vmid, buildDockerLogsCommand(container, { tail, since }));
}

describe("dockerLogsHandler", () => {
  it("tails logs and clamps to the cap", async () => {
    const t = new FakeTransport();
    t.setExecResult(logCmd(101, "web", 500), { stdout: "line1\nline2\n", stderr: "", exitCode: 0 });
    const r = await dockerLogsHandler({ vmid: 101, container: "web", tail: 99999 }, t, cfg);
    expect(r.lines).toBe(500); // clamped to tailLinesCap
    expect(r.content).toContain("line1");
  });

  it("passes a validated since through", async () => {
    const t = new FakeTransport();
    t.setExecResult(logCmd(101, "web", 100, "30 min ago"), { stdout: "recent\n", stderr: "", exitCode: 0 });
    const r = await dockerLogsHandler({ vmid: 101, container: "web", tail: 100, since: "30 min ago" }, t, cfg);
    expect(r.content).toContain("recent");
  });

  it("rejects a free-form since", async () => {
    const t = new FakeTransport();
    await expect(
      dockerLogsHandler({ vmid: 101, container: "web", since: "yesterday-ish" }, t, cfg)
    ).rejects.toThrow(/Invalid `since`/);
  });

  it("rejects an invalid container name", async () => {
    const t = new FakeTransport();
    await expect(
      dockerLogsHandler({ vmid: 101, container: "bad name" }, t, cfg)
    ).rejects.toThrow(/Invalid Docker container name/);
  });

  it("ALWAYS redacts secrets in the output (mandatory, like tail_log)", async () => {
    const t = new FakeTransport();
    const leak = "starting up\napi_key=SUPERSECRETVALUE123\nAuthorization: Bearer abcdef.ghijkl.mnopqr\n";
    t.setExecResult(logCmd(101, "web", 100), { stdout: leak, stderr: "", exitCode: 0 });
    const r = await dockerLogsHandler({ vmid: 101, container: "web", tail: 100 }, t, cfg);
    expect(r.content).not.toContain("SUPERSECRETVALUE123");
    expect(r.content).toContain("[REDACTED]");
  });

  it("redacts error text too and surfaces a failure", async () => {
    const t = new FakeTransport();
    t.setExecResult(logCmd(101, "web", 100), {
      stdout: "",
      stderr: "cannot connect using token=LEAKEDTOKEN",
      exitCode: 1,
    });
    await expect(dockerLogsHandler({ vmid: 101, container: "web", tail: 100 }, t, cfg)).rejects.toThrow(
      /docker_logs failed/
    );
    await expect(dockerLogsHandler({ vmid: 101, container: "web", tail: 100 }, t, cfg)).rejects.not.toThrow(
      /LEAKEDTOKEN/
    );
  });
});
