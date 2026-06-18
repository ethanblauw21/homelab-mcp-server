import { describe, it, expect } from "vitest";
import { dockerPsHandler } from "./dockerPs.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerPsCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

const cfg = { ssh: { commandTimeoutMs: 5000 } } as unknown as Config;

describe("dockerPsHandler", () => {
  it("runs docker ps inside the LXC and parses the listing", async () => {
    const t = new FakeTransport();
    const out = [
      JSON.stringify({ ID: "a1", Names: "portainer", Image: "portainer/portainer-ce", Status: "Up 1h", State: "running", Ports: "", Labels: "com.docker.compose.project=infra" }),
      JSON.stringify({ ID: "b2", Names: "homepage", Image: "homepage", Status: "Up 2h", State: "running", Ports: "", Labels: "" }),
    ].join("\n");
    t.setExecResult(buildPctExecCommand(101, buildDockerPsCommand()), { stdout: out, stderr: "", exitCode: 0 });

    const r = await dockerPsHandler({ vmid: 101 }, t, cfg);
    expect(r.vmid).toBe(101);
    expect(r.containers).toHaveLength(2);
    expect(r.containers[0].composeProject).toBe("infra");
  });

  it("throws a helpful error when docker ps fails", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctExecCommand(101, buildDockerPsCommand()), {
      stdout: "",
      stderr: "docker: command not found",
      exitCode: 127,
    });
    await expect(dockerPsHandler({ vmid: 101 }, t, cfg)).rejects.toThrow(/docker ps failed.*127/s);
  });
});
