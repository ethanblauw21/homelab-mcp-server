import { describe, it, expect } from "vitest";
import { dockerReadFileHandler } from "./dockerReadFile.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import {
  buildPctStatusCommand,
  buildMkTempCommand,
  buildPctPullCommand,
} from "./pctFiles.js";
import {
  buildDockerInspectCommand,
  buildDockerCpFromContainer,
} from "./dockerHelpers.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

function makeConfig(overrides: Partial<{ readFileMaxBytes: number }> = {}): Config {
  return {
    ssh: { commandTimeoutMs: 5000 },
    container: { nodeTempDir: "/tmp", newFileMode: "0644", newFileUid: 0, newFileGid: 0 },
    tools: { readFileMaxBytes: overrides.readFileMaxBytes ?? 2 * 1024 * 1024 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  } as unknown as Config;
}

const NODE_TMP = "/tmp/node1";
const LXC_TMP = "/tmp/lxctmp";

function primeRunning(t: FakeTransport, vmid: number) {
  t.setExecResult(buildPctStatusCommand(vmid), { stdout: "status: running\n", stderr: "", exitCode: 0 });
}
function primeNodeTemp(t: FakeTransport) {
  t.setExecResult(buildMkTempCommand("/tmp"), { stdout: NODE_TMP + "\n", stderr: "", exitCode: 0 });
}
function primeLxcTemp(t: FakeTransport, vmid: number) {
  t.setExecResult(buildPctExecCommand(vmid, buildMkTempCommand("/tmp")), { stdout: LXC_TMP + "\n", stderr: "", exitCode: 0 });
}
function primeInspect(t: FakeTransport, vmid: number, container: string, payload: string) {
  t.setExecResult(buildPctExecCommand(vmid, buildDockerInspectCommand(container)), { stdout: payload, stderr: "", exitCode: 0 });
}

const BIND_MOUNTS = JSON.stringify([{ Type: "bind", Source: "/srv/config", Destination: "/config", RW: true }]);
const VOLUME_MOUNTS = JSON.stringify([{ Type: "volume", Source: "/var/lib/docker/volumes/data/_data", Destination: "/data", RW: true }]);

describe("dockerReadFileHandler", () => {
  it("reads via the bind-mount fast path (pct pull on the LXC source)", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "web", `id123 ${BIND_MOUNTS}`);
    // The bind source /srv/config + remainder /app.yml is what gets pulled.
    t.setExecResult(buildPctPullCommand(101, "/srv/config/app.yml", NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "fast-path body");

    const r = await dockerReadFileHandler({ vmid: 101, container: "web", path: "/config/app.yml", encoding: "utf8" }, t, makeConfig());
    expect(r.content).toBe("fast-path body");
    expect(r.viaBindMount).toBe(true);
    expect(r.container).toBe("web");
  });

  it("reads via the docker cp slow path for a non-bind path", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeLxcTemp(t, 101);
    primeInspect(t, 101, "web", `id123 ${VOLUME_MOUNTS}`);
    t.setExecResult(buildPctExecCommand(101, buildDockerCpFromContainer("web", "/data/db.txt", LXC_TMP)), { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult(buildPctPullCommand(101, LXC_TMP, NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "slow-path body");

    const r = await dockerReadFileHandler({ vmid: 101, container: "web", path: "/data/db.txt", encoding: "utf8" }, t, makeConfig());
    expect(r.content).toBe("slow-path body");
    expect(r.viaBindMount).toBe(false);
  });

  it("throws File not found when docker cp reports a missing file", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeLxcTemp(t, 101);
    primeInspect(t, 101, "web", `id123 ${VOLUME_MOUNTS}`);
    t.setExecResult(buildPctExecCommand(101, buildDockerCpFromContainer("web", "/data/missing", LXC_TMP)), {
      stdout: "",
      stderr: "Error: No such file or directory in container",
      exitCode: 1,
    });

    await expect(
      dockerReadFileHandler({ vmid: 101, container: "web", path: "/data/missing", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/File not found inside Docker container/);
  });

  it("enforces the read cap on a non-windowed read", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "web", `id123 ${BIND_MOUNTS}`);
    t.setExecResult(buildPctPullCommand(101, "/srv/config/big", NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "X".repeat(50));

    await expect(
      dockerReadFileHandler({ vmid: 101, container: "web", path: "/config/big", encoding: "utf8" }, t, makeConfig({ readFileMaxBytes: 10 }))
    ).rejects.toThrow(/over the 10-byte read_file cap/);
  });

  it("serves a windowed read past the cap", async () => {
    const t = new FakeTransport();
    primeRunning(t, 101);
    primeNodeTemp(t);
    primeInspect(t, 101, "web", `id123 ${BIND_MOUNTS}`);
    t.setExecResult(buildPctPullCommand(101, "/srv/config/big", NODE_TMP), { stdout: "", stderr: "", exitCode: 0 });
    t.setFile(NODE_TMP, "0123456789ABCDEF");

    const r = await dockerReadFileHandler(
      { vmid: 101, container: "web", path: "/config/big", encoding: "utf8", offset: 4, maxBytes: 5 },
      t,
      makeConfig({ readFileMaxBytes: 10 })
    );
    expect(r.content).toBe("45678");
    expect(r.offset).toBe(4);
  });

  it("rejects an invalid container name", async () => {
    const t = new FakeTransport();
    await expect(
      dockerReadFileHandler({ vmid: 101, container: "bad name", path: "/x", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/Invalid Docker container name/);
  });
});
