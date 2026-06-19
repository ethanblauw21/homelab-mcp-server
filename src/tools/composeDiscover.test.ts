import { describe, it, expect } from "vitest";
import { composeDiscoverHandler } from "./composeDiscover.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerPsCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

const cfg = { ssh: { commandTimeoutMs: 5000 } } as unknown as Config;

describe("composeDiscoverHandler (ADR-016 §3)", () => {
  it("discovers compose projects from running containers' labels", async () => {
    const t = new FakeTransport();
    const out = [
      JSON.stringify({ Names: "sonarr", Image: "linuxserver/sonarr:4", Ports: "0.0.0.0:8989->8989/tcp",
        Labels: "com.docker.compose.project=media,com.docker.compose.project.config_files=/opt/media/dc.yml,com.docker.compose.service=sonarr" }),
      JSON.stringify({ Names: "standalone", Image: "busybox", Ports: "", Labels: "" }),
    ].join("\n");
    t.setExecResult(buildPctExecCommand(101, buildDockerPsCommand()), { stdout: out, stderr: "", exitCode: 0 });

    const r = await composeDiscoverHandler({ vmid: 101 }, t, cfg);
    expect(r.vmid).toBe(101);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]!.project).toBe("media");
    expect(r.projects[0]!.configFile).toBe("/opt/media/dc.yml");
    expect(r.projects[0]!.services[0]!.name).toBe("sonarr");
    expect(r.note).toMatch(/running containers/i);
  });

  it("throws a helpful error when docker ps fails", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctExecCommand(101, buildDockerPsCommand()), {
      stdout: "",
      stderr: "docker: command not found",
      exitCode: 127,
    });
    await expect(composeDiscoverHandler({ vmid: 101 }, t, cfg)).rejects.toThrow(/docker ps failed.*127/s);
  });
});
