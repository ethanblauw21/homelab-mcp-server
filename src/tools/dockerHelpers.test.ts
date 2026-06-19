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
  isHostVisibleMount,
  buildContainerInspectCommand,
  parseContainerInspect,
  projectInspectFields,
  buildDockerStatsCommand,
  parseDockerStats,
  parseDockerSize,
  buildComposeUpCommand,
  parseComposeProjects,
  parseDockerLabels,
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

  it("ADR-016 §4: resolves a local-driver named volume via its host-visible _data source", () => {
    const r = resolveBindMount(binds, "/data/db.sqlite");
    expect(r).not.toBeNull();
    expect(r!.lxcPath).toBe("/var/lib/docker/volumes/data/_data/db.sqlite");
    expect(r!.mount.type).toBe("volume");
  });

  it("ADR-016 §4: a non-local-driver volume (source not under /var/lib/docker/volumes) stays slow-path", () => {
    const nfs: DockerMount[] = [
      { type: "volume", source: "/mnt/nfs/share", destination: "/data", rw: true },
    ];
    expect(resolveBindMount(nfs, "/data/db.sqlite")).toBeNull();
  });

  it("ADR-016 §4: tmpfs / overlay-only paths are never host-visible", () => {
    const tmp: DockerMount[] = [{ type: "tmpfs", source: "", destination: "/tmp", rw: true }];
    expect(resolveBindMount(tmp, "/tmp/x")).toBeNull();
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

// ===========================================================================
// ADR-016 — Docker introspection
// ===========================================================================

describe("isHostVisibleMount (ADR-016 §4)", () => {
  it("binds are always host-visible", () => {
    expect(isHostVisibleMount({ type: "bind", source: "/srv/x", destination: "/x", rw: true })).toBe(true);
  });
  it("local-driver named volumes under /var/lib/docker/volumes/<name>/_data are host-visible", () => {
    expect(
      isHostVisibleMount({ type: "volume", source: "/var/lib/docker/volumes/cfg/_data", destination: "/c", rw: true })
    ).toBe(true);
    expect(
      isHostVisibleMount({ type: "volume", source: "/var/lib/docker/volumes/cfg/_data/sub", destination: "/c", rw: true })
    ).toBe(true);
  });
  it("non-local volumes and tmpfs are not host-visible", () => {
    expect(isHostVisibleMount({ type: "volume", source: "/mnt/nfs/x", destination: "/c", rw: true })).toBe(false);
    expect(isHostVisibleMount({ type: "tmpfs", source: "", destination: "/tmp", rw: true })).toBe(false);
    // a volume name that merely contains the substring but isn't the _data root
    expect(isHostVisibleMount({ type: "volume", source: "/opt/var/lib/docker/volumes/x/_data", destination: "/c", rw: true })).toBe(false);
  });
});

describe("docker_inspect projection (ADR-016 §1)", () => {
  const FIXTURE = JSON.stringify([
    {
      Id: "abc123def456",
      Name: "/gluetun",
      Image: "sha256:deadbeefcafe",
      State: { Status: "running", Health: { Status: "healthy" } },
      Config: {
        Image: "qmcgaw/gluetun:v3.39.0",
        Env: [
          "TZ=America/New_York",
          "WIREGUARD_PRIVATE_KEY=aB3xYzSecretKeyMaterialHere0000000000000000=",
          "PUID=1000",
        ],
        Labels: {
          "com.docker.compose.project": "media",
          "com.docker.compose.project.config_files": "/opt/media/docker-compose.yml",
          "com.docker.compose.service": "gluetun",
        },
      },
      HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
      NetworkSettings: {
        Networks: { media_default: {}, bridge: {} },
        Ports: {
          "8888/tcp": [{ HostIp: "0.0.0.0", HostPort: "8888" }],
          "53/udp": null,
        },
      },
      Mounts: [
        { Type: "volume", Source: "/var/lib/docker/volumes/gluetun_config/_data", Destination: "/gluetun", RW: true },
      ],
    },
  ]);

  it("builds the full-JSON inspect command (no --format)", () => {
    expect(buildContainerInspectCommand("gluetun")).toBe("docker inspect 'gluetun'");
    expect(() => buildContainerInspectCommand("bad name")).toThrow(/Invalid Docker container name/);
  });

  it("projects the operator-relevant slice with the image id as the pin", () => {
    const v = parseContainerInspect(FIXTURE);
    expect(v.id).toBe("abc123def456");
    expect(v.name).toBe("gluetun"); // leading slash stripped
    expect(v.image).toBe("qmcgaw/gluetun:v3.39.0");
    expect(v.imageId).toBe("sha256:deadbeefcafe");
    expect(v.status).toBe("running");
    expect(v.health).toBe("healthy");
    expect(v.restartPolicy).toBe("unless-stopped");
    expect(v.networks.sort()).toEqual(["bridge", "media_default"]);
    expect(v.mounts).toHaveLength(1);
    expect(v.ports).toEqual([{ containerPort: "8888/tcp", hostIp: "0.0.0.0", hostPort: "8888" }]); // null udp dropped
    expect(v.composeProject).toBe("media");
    expect(v.composeConfigFiles).toBe("/opt/media/docker-compose.yml");
  });

  it("keeps env NAMES but redacts secret VALUES on the parsed map (dimension-C directive)", () => {
    const v = parseContainerInspect(FIXTURE);
    expect(Object.keys(v.env).sort()).toEqual(["PUID", "TZ", "WIREGUARD_PRIVATE_KEY"]);
    expect(v.env.TZ).toBe("America/New_York"); // benign config stays readable
    expect(v.env.PUID).toBe("1000");
    expect(v.env.WIREGUARD_PRIVATE_KEY).toMatch(/REDACTED/i); // secret-named key masked
    expect(v.env.WIREGUARD_PRIVATE_KEY).not.toContain("SecretKeyMaterial");
    expect(v.envRedactedCount).toBeGreaterThanOrEqual(1);
  });

  it("formats on-failure restart policy with its retry count", () => {
    const f = JSON.parse(FIXTURE);
    f[0].HostConfig.RestartPolicy = { Name: "on-failure", MaximumRetryCount: 5 };
    expect(parseContainerInspect(JSON.stringify(f)).restartPolicy).toBe("on-failure:5");
  });

  it("omits health when no healthcheck is defined", () => {
    const f = JSON.parse(FIXTURE);
    delete f[0].State.Health;
    expect(parseContainerInspect(JSON.stringify(f)).health).toBeUndefined();
  });

  it("throws on empty array (no such container) and invalid JSON", () => {
    expect(() => parseContainerInspect("[]")).toThrow(/no such container/i);
    expect(() => parseContainerInspect("not json")).toThrow(/valid JSON/i);
  });

  it("projectInspectFields narrows to requested fields, always keeping id+name", () => {
    const v = parseContainerInspect(FIXTURE);
    const narrowed = projectInspectFields(v, ["image", "mounts"]);
    expect(Object.keys(narrowed).sort()).toEqual(["id", "image", "mounts", "name"]);
    // empty / undefined returns the full view unchanged
    expect(projectInspectFields(v, [])).toBe(v);
    expect(projectInspectFields(v)).toBe(v);
    // unknown field names are ignored
    expect(Object.keys(projectInspectFields(v, ["nope"])).sort()).toEqual(["id", "name"]);
  });
});

describe("docker_stats parsing (ADR-016 §2)", () => {
  it("builds the no-stream stats command", () => {
    expect(buildDockerStatsCommand()).toBe("docker stats --no-stream --format '{{json .}}'");
  });

  it("parseDockerSize handles binary and decimal suffixes", () => {
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("100MiB")).toBe(100 * 1024 ** 2);
    expect(parseDockerSize("2GiB")).toBe(2 * 1024 ** 3);
    expect(parseDockerSize("1.5GB")).toBe(1.5e9);
    expect(parseDockerSize("512kB")).toBe(512e3);
    expect(parseDockerSize("garbage")).toBe(0);
  });

  it("parses stats and sorts by memory used descending", () => {
    const out = [
      JSON.stringify({ Name: "small", CPUPerc: "0.50%", MemUsage: "10MiB / 2GiB", MemPerc: "0.49%", NetIO: "1kB / 2kB", BlockIO: "0B / 0B" }),
      JSON.stringify({ Name: "big", CPUPerc: "12.30%", MemUsage: "1.5GiB / 2GiB", MemPerc: "75.00%", NetIO: "3MB / 4MB", BlockIO: "5MB / 6MB" }),
      "garbage line",
    ].join("\n");
    const stats = parseDockerStats(out);
    expect(stats.map((s) => s.name)).toEqual(["big", "small"]); // sorted desc by mem
    expect(stats[0]!.cpuPct).toBe(12.3);
    expect(stats[0]!.memUsedBytes).toBe(Math.round(1.5 * 1024 ** 3));
    expect(stats[0]!.memLimitBytes).toBe(2 * 1024 ** 3);
    expect(stats[0]!.memPct).toBe(75);
    expect(stats[0]!.netIO).toBe("3MB / 4MB");
    expect(stats[1]!.blockIO).toBe("0B / 0B");
  });

  it("returns an empty array on empty input", () => {
    expect(parseDockerStats("")).toEqual([]);
  });
});

describe("compose_discover parsing (ADR-016 §3)", () => {
  it("parseDockerLabels splits a comma-joined k=v label string", () => {
    const m = parseDockerLabels("com.docker.compose.project=media,com.docker.compose.service=sonarr,foo=bar");
    expect(m["com.docker.compose.project"]).toBe("media");
    expect(m["com.docker.compose.service"]).toBe("sonarr");
    expect(m.foo).toBe("bar");
  });

  it("groups running containers into compose projects, sorted + deduped", () => {
    const psOut = [
      JSON.stringify({ Names: "sonarr", Image: "linuxserver/sonarr:4", Ports: "0.0.0.0:8989->8989/tcp",
        Labels: "com.docker.compose.project=media,com.docker.compose.project.config_files=/opt/media/dc.yml,com.docker.compose.service=sonarr" }),
      JSON.stringify({ Names: "radarr", Image: "linuxserver/radarr:5", Ports: "0.0.0.0:7878->7878/tcp",
        Labels: "com.docker.compose.project=media,com.docker.compose.project.config_files=/opt/media/dc.yml,com.docker.compose.service=radarr" }),
      JSON.stringify({ Names: "adguard", Image: "adguard/adguardhome:latest", Ports: "53->53/udp",
        Labels: "com.docker.compose.project=dns,com.docker.compose.service=adguard" }),
      JSON.stringify({ Names: "loner", Image: "busybox", Ports: "", Labels: "foo=bar" }), // no compose label → skipped
    ].join("\n");
    const projects = parseComposeProjects(psOut);
    expect(projects.map((p) => p.project)).toEqual(["dns", "media"]); // sorted, loner excluded
    const media = projects.find((p) => p.project === "media")!;
    expect(media.configFile).toBe("/opt/media/dc.yml");
    expect(media.services.map((s) => s.name)).toEqual(["radarr", "sonarr"]); // sorted
    expect(media.services[0]!.image).toBe("linuxserver/radarr:5");
    const dns = projects.find((p) => p.project === "dns")!;
    expect(dns.configFile).toBeUndefined(); // no config_files label
    expect(dns.services[0]!.ports).toBe("53->53/udp");
  });

  it("returns an empty array when nothing carries a compose label", () => {
    expect(parseComposeProjects(JSON.stringify({ Names: "x", Labels: "" }))).toEqual([]);
  });

  it("(sanity) buildComposeUpCommand still quotes the path", () => {
    expect(buildComposeUpCommand("/opt/media/dc.yml")).toBe("docker compose -f '/opt/media/dc.yml' up -d");
  });
});
