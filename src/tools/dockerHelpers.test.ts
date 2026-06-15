import { describe, it, expect } from "vitest";
import {
  validateDockerName,
  assertDockerName,
  buildDockerPsCommand,
  parseDockerPs,
  buildDockerInspectCommand,
  parseDockerInspect,
  parseDockerMounts,
  resolveBindMount,
  buildDockerExecCommand,
  buildDockerLogsCommand,
  buildDockerCpFromContainer,
  buildDockerCpToContainer,
  buildDockerStatCommand,
  parseDockerStatPerms,
  buildDockerChownCommand,
  buildDockerChmodCommand,
  type DockerMount,
} from "./dockerHelpers.js";

describe("validateDockerName / assertDockerName (ADR-008 §1 charset)", () => {
  it("accepts typical names", () => {
    for (const n of ["portainer", "homepage", "sonarr", "my_app", "a.b-c", "Web2", "x"]) {
      expect(validateDockerName(n)).toBe(true);
    }
  });

  it("rejects names that do not start alphanumeric", () => {
    for (const n of ["_leading", ".dot", "-dash", ""]) {
      expect(validateDockerName(n)).toBe(false);
    }
  });

  it("rejects shell metacharacters and spaces", () => {
    for (const n of ["a b", "a;b", "a$(b)", "a/b", "a'b", "a|b", "a&b", "a`b`"]) {
      expect(validateDockerName(n)).toBe(false);
    }
  });

  it("assertDockerName throws with the offending value", () => {
    expect(() => assertDockerName("bad name")).toThrow(/Invalid Docker container name.*bad name/s);
  });

  it("assertDockerName passes a valid name silently", () => {
    expect(() => assertDockerName("portainer")).not.toThrow();
  });
});

describe("buildDockerPsCommand / parseDockerPs", () => {
  it("builds the per-line JSON ps command", () => {
    expect(buildDockerPsCommand()).toBe("docker ps --no-trunc --format '{{json .}}'");
  });

  it("parses one container per line with all fields", () => {
    const out = [
      JSON.stringify({
        ID: "abc123",
        Names: "portainer",
        Image: "portainer/portainer-ce:latest",
        Status: "Up 2 hours",
        State: "running",
        Ports: "0.0.0.0:9000->9000/tcp",
        Labels: "com.docker.compose.project=infra,com.docker.compose.service=portainer",
      }),
      JSON.stringify({
        ID: "def456",
        Names: "homepage",
        Image: "ghcr.io/gethomepage/homepage",
        Status: "Up 5 minutes",
        State: "running",
        Ports: "",
        Labels: "",
      }),
    ].join("\n");
    const rows = parseDockerPs(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "abc123",
      name: "portainer",
      image: "portainer/portainer-ce:latest",
      status: "Up 2 hours",
      state: "running",
      ports: "0.0.0.0:9000->9000/tcp",
      composeProject: "infra",
    });
    expect(rows[1].composeProject).toBeUndefined();
  });

  it("skips blank and malformed lines without aborting", () => {
    const out = ["", "  ", "not json", JSON.stringify({ Names: "good", Image: "img" }), "{bad"].join(
      "\n"
    );
    const rows = parseDockerPs(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("good");
  });

  it("returns empty for empty output", () => {
    expect(parseDockerPs("")).toEqual([]);
  });

  it("tolerates a missing compose-project label among other labels", () => {
    const out = JSON.stringify({ Names: "x", Labels: "maintainer=foo,role=bar" });
    expect(parseDockerPs(out)[0].composeProject).toBeUndefined();
  });
});

describe("buildDockerInspectCommand / parseDockerInspect", () => {
  it("builds the combined id+mounts inspect command", () => {
    expect(buildDockerInspectCommand("portainer")).toBe(
      "docker inspect --format '{{.Id}} {{json .Mounts}}' 'portainer'"
    );
  });

  it("validates the name before interpolation", () => {
    expect(() => buildDockerInspectCommand("bad name")).toThrow(/Invalid Docker container name/);
  });

  it("parses id then the JSON mounts array", () => {
    const mounts = JSON.stringify([
      { Type: "bind", Source: "/srv/config", Destination: "/config", RW: true },
    ]);
    const r = parseDockerInspect(`deadbeef1234 ${mounts}`);
    expect(r.id).toBe("deadbeef1234");
    expect(r.mounts).toHaveLength(1);
    expect(r.mounts[0].destination).toBe("/config");
  });

  it("handles a container with id only (no mounts payload)", () => {
    const r = parseDockerInspect("deadbeef1234");
    expect(r.id).toBe("deadbeef1234");
    expect(r.mounts).toEqual([]);
  });

  it("handles a null mounts payload", () => {
    const r = parseDockerInspect("deadbeef1234 null");
    expect(r.id).toBe("deadbeef1234");
    expect(r.mounts).toEqual([]);
  });
});

describe("parseDockerMounts", () => {
  it("maps Type/Source/Destination/RW for each entry", () => {
    const json = JSON.stringify([
      { Type: "bind", Source: "/srv/a", Destination: "/a", RW: true },
      { Type: "volume", Name: "vol", Source: "/var/lib/docker/volumes/vol/_data", Destination: "/data", RW: false },
    ]);
    const m = parseDockerMounts(json);
    expect(m).toEqual([
      { type: "bind", source: "/srv/a", destination: "/a", rw: true },
      { type: "volume", source: "/var/lib/docker/volumes/vol/_data", destination: "/data", rw: false },
    ]);
  });

  it("returns [] for null / empty / non-array / malformed", () => {
    expect(parseDockerMounts("null")).toEqual([]);
    expect(parseDockerMounts("")).toEqual([]);
    expect(parseDockerMounts("   ")).toEqual([]);
    expect(parseDockerMounts("{}")).toEqual([]);
    expect(parseDockerMounts("not json")).toEqual([]);
  });

  it("defaults RW to true when absent", () => {
    const m = parseDockerMounts(JSON.stringify([{ Type: "bind", Source: "/s", Destination: "/d" }]));
    expect(m[0].rw).toBe(true);
  });

  it("skips non-object array members", () => {
    const m = parseDockerMounts(JSON.stringify(["x", null, { Type: "bind", Source: "/s", Destination: "/d" }]));
    expect(m).toHaveLength(1);
  });
});

describe("resolveBindMount (fast path — ADR-008 §2)", () => {
  const binds: DockerMount[] = [
    { type: "bind", source: "/srv/config", destination: "/config", rw: true },
    { type: "bind", source: "/srv/config/secrets", destination: "/config/secrets", rw: true },
    { type: "volume", source: "/var/lib/docker/volumes/data/_data", destination: "/data", rw: true },
  ];

  it("rewrites a path under a bind mount to its LXC source", () => {
    const r = resolveBindMount(binds, "/config/app.yml");
    expect(r).not.toBeNull();
    expect(r!.lxcPath).toBe("/srv/config/app.yml");
    expect(r!.mount.destination).toBe("/config");
  });

  it("matches the mount destination itself", () => {
    const r = resolveBindMount(binds, "/config");
    expect(r!.lxcPath).toBe("/srv/config");
  });

  it("longest-prefix wins for nested binds", () => {
    const r = resolveBindMount(binds, "/config/secrets/key.txt");
    expect(r!.mount.destination).toBe("/config/secrets");
    expect(r!.lxcPath).toBe("/srv/config/secrets/key.txt");
  });

  it("returns null for a volume mount (slow path)", () => {
    expect(resolveBindMount(binds, "/data/db.sqlite")).toBeNull();
  });

  it("returns null for an unmounted path", () => {
    expect(resolveBindMount(binds, "/etc/hostname")).toBeNull();
  });

  it("does not false-match a sibling prefix (/config vs /configuration)", () => {
    expect(resolveBindMount(binds, "/configuration/x")).toBeNull();
  });

  it("handles a trailing slash on the mount destination", () => {
    const m: DockerMount[] = [{ type: "bind", source: "/srv/c/", destination: "/config/", rw: true }];
    const r = resolveBindMount(m, "/config/app.yml");
    expect(r!.lxcPath).toBe("/srv/c/app.yml");
  });

  it("handles a root bind mount", () => {
    const m: DockerMount[] = [{ type: "bind", source: "/srv/root", destination: "/", rw: true }];
    const r = resolveBindMount(m, "/etc/foo");
    expect(r!.lxcPath).toBe("/srv/root/etc/foo");
  });

  it("returns null on no mounts", () => {
    expect(resolveBindMount([], "/config/app.yml")).toBeNull();
  });
});

describe("buildDockerExecCommand", () => {
  it("wraps the inner command in sh -c by default", () => {
    expect(buildDockerExecCommand("web", "echo hi")).toBe("docker exec 'web' sh -c 'echo hi'");
  });

  it("supports a bash shell override", () => {
    expect(buildDockerExecCommand("web", "echo hi", { shell: "bash" })).toBe(
      "docker exec 'web' bash -c 'echo hi'"
    );
  });

  it("composes the in-container timeout wrapper", () => {
    expect(buildDockerExecCommand("web", "sleep 1", { timeoutSecs: 10 })).toBe(
      "docker exec 'web' timeout --signal=TERM --kill-after=5 10 sh -c 'sleep 1'"
    );
  });

  it("escapes single quotes in the inner command", () => {
    expect(buildDockerExecCommand("web", "echo 'hi'")).toBe(
      "docker exec 'web' sh -c 'echo '\\''hi'\\'''"
    );
  });

  it("validates the container name", () => {
    expect(() => buildDockerExecCommand("bad name", "echo")).toThrow(/Invalid Docker container name/);
  });
});

describe("buildDockerLogsCommand", () => {
  it("builds with tail only", () => {
    expect(buildDockerLogsCommand("web", { tail: 100 })).toBe("docker logs --tail 100 'web'");
  });

  it("includes a validated since when present", () => {
    expect(buildDockerLogsCommand("web", { tail: 50, since: "30 min ago" })).toBe(
      "docker logs --tail 50 --since '30 min ago' 'web'"
    );
  });

  it("omits since when empty", () => {
    expect(buildDockerLogsCommand("web", { tail: 10, since: "" })).toBe("docker logs --tail 10 'web'");
  });

  it("validates the container name", () => {
    expect(() => buildDockerLogsCommand("bad name", { tail: 10 })).toThrow(/Invalid Docker container name/);
  });
});

describe("docker cp builders (slow-path relay)", () => {
  it("builds cp out of the container with name unquoted before the colon", () => {
    expect(buildDockerCpFromContainer("web", "/etc/conf", "/tmp/abc")).toBe(
      "docker cp web:'/etc/conf' '/tmp/abc'"
    );
  });

  it("builds cp into the container", () => {
    expect(buildDockerCpToContainer("/tmp/abc", "web", "/etc/conf")).toBe(
      "docker cp '/tmp/abc' web:'/etc/conf'"
    );
  });

  it("validates the name on both directions", () => {
    expect(() => buildDockerCpFromContainer("bad name", "/p", "/t")).toThrow(/Invalid Docker container name/);
    expect(() => buildDockerCpToContainer("/t", "bad name", "/p")).toThrow(/Invalid Docker container name/);
  });
});

describe("ownership restoration (best-effort)", () => {
  it("builds the stat command", () => {
    expect(buildDockerStatCommand("web", "/etc/conf")).toBe(
      "docker exec 'web' stat -c '%a %u %g' '/etc/conf'"
    );
  });

  it("parses stat perms", () => {
    expect(parseDockerStatPerms("644 0 0")).toEqual({ mode: "644", uid: 0, gid: 0 });
    expect(parseDockerStatPerms("  600 1000 1000  \n")).toEqual({ mode: "600", uid: 1000, gid: 1000 });
  });

  it("returns null when stat output is unrecognized (stat-less image / new file)", () => {
    expect(parseDockerStatPerms("")).toBeNull();
    expect(parseDockerStatPerms("stat: not found")).toBeNull();
    expect(parseDockerStatPerms("rw-r--r-- 0 0")).toBeNull();
  });

  it("builds chown and chmod restoration commands", () => {
    const perms = { mode: "640", uid: 33, gid: 33 };
    expect(buildDockerChownCommand("web", perms, "/etc/conf")).toBe(
      "docker exec 'web' chown 33:33 '/etc/conf'"
    );
    expect(buildDockerChmodCommand("web", perms, "/etc/conf")).toBe(
      "docker exec 'web' chmod '640' '/etc/conf'"
    );
  });

  it("validates the name on chown/chmod/stat", () => {
    const perms = { mode: "644", uid: 0, gid: 0 };
    expect(() => buildDockerStatCommand("bad name", "/p")).toThrow(/Invalid Docker container name/);
    expect(() => buildDockerChownCommand("bad name", perms, "/p")).toThrow(/Invalid Docker container name/);
    expect(() => buildDockerChmodCommand("bad name", perms, "/p")).toThrow(/Invalid Docker container name/);
  });
});
