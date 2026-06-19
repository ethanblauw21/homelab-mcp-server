import { describe, it, expect } from "vitest";
import { dockerInspectHandler } from "./dockerInspect.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildContainerInspectCommand } from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

const cfg = {
  ssh: { commandTimeoutMs: 5000 },
  census: { redactionExtraKeys: [] },
} as unknown as Config;

const INSPECT = JSON.stringify([
  {
    Id: "abc123",
    Name: "/qbittorrent",
    Image: "sha256:cafe",
    State: { Status: "running" },
    Config: {
      Image: "linuxserver/qbittorrent:latest",
      Env: ["TZ=UTC", "WEBUI_PASSWORD=hunter2supersecretvalue"],
      Labels: { "com.docker.compose.project": "media" },
    },
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    NetworkSettings: { Networks: { media_default: {} }, Ports: {} },
    Mounts: [],
  },
]);

describe("dockerInspectHandler (ADR-016 §1)", () => {
  it("runs docker inspect inside the LXC and returns a redacted projection", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctExecCommand(101, buildContainerInspectCommand("qbittorrent")), {
      stdout: INSPECT,
      stderr: "",
      exitCode: 0,
    });
    const r = await dockerInspectHandler({ vmid: 101, container: "qbittorrent" }, t, cfg);
    expect(r.vmid).toBe(101);
    expect(r.container).toBe("qbittorrent");
    expect(r.inspect.image).toBe("linuxserver/qbittorrent:latest");
    expect(r.inspect.imageId).toBe("sha256:cafe");
    expect(r.inspect.env!.TZ).toBe("UTC");
    expect(r.inspect.env!.WEBUI_PASSWORD).toMatch(/REDACTED/i);
    expect(r.inspect.env!.WEBUI_PASSWORD).not.toContain("hunter2");
  });

  it("narrows the projection when fields[] is given", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctExecCommand(101, buildContainerInspectCommand("qbittorrent")), {
      stdout: INSPECT,
      stderr: "",
      exitCode: 0,
    });
    const r = await dockerInspectHandler(
      { vmid: 101, container: "qbittorrent", fields: ["image"] },
      t,
      cfg
    );
    expect(Object.keys(r.inspect).sort()).toEqual(["id", "image", "name"]);
    expect(r.inspect.env).toBeUndefined();
  });

  it("rejects an invalid container name before any exec", async () => {
    const t = new FakeTransport();
    await expect(
      dockerInspectHandler({ vmid: 101, container: "bad name" }, t, cfg)
    ).rejects.toThrow(/Invalid Docker container name/);
  });

  it("throws a helpful error when docker inspect fails", async () => {
    const t = new FakeTransport();
    t.setExecResult(buildPctExecCommand(101, buildContainerInspectCommand("ghost")), {
      stdout: "",
      stderr: "Error: No such object: ghost",
      exitCode: 1,
    });
    await expect(
      dockerInspectHandler({ vmid: 101, container: "ghost" }, t, cfg)
    ).rejects.toThrow(/docker inspect failed.*ghost/s);
  });
});
