import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  assertImageRef,
  parseImageRef,
  normalizeImageName,
  isDigestPinned,
  localDigestFor,
  extractImageVersion,
  parseContainerIdentities,
  buildComposeCommand,
  probeBindingWarning,
  parseImageInfo,
  buildImageInfoCommand,
  pickEnv,
  parseWatchtowerConfig,
  watchtowerManages,
  isWatchtowerImage,
  isDiunImage,
  buildRemoteDigestCommand,
  parseRemoteDigests,
  classifyImageUpdate,
  parseDiunImageList,
  parseDiunImageInspect,
  splitDiunListOutput,
  splitDiunInspectOutput,
  DiunParseError,
  rankCandidateTags,
  findNetnsDependents,
  buildDockerRestartCommand,
  buildComposeCommand,
  holdTagFor,
  configFilesInclude,
  assertComposeProject,
  assertComposeService,
  parseHealthSample,
  evaluateHealthPoll,
  type ContainerIdentity,
  type DiunManifest,
  type HealthSample,
} from "./dockerUpdate.js";
import { imageInfoRow, ociVersion } from "./dockerUpdateTestkit.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "diun");
const fixture = (f: string): string => fs.readFileSync(path.join(FIX, f), "utf8");

const D = (c: string): string => "sha256:" + c.repeat(64).slice(0, 64);

function ident(over: Partial<ContainerIdentity>): ContainerIdentity {
  return {
    name: "x",
    id: "a".repeat(64),
    ref: "nginx:latest",
    imageId: D("1"),
    state: "running",
    composeProject: "",
    composeService: "",
    composeConfigFiles: "",
    watchtowerLabel: "",
    diunLabel: "",
    diunWatchRepoLabel: "",
    networkMode: "bridge",
    ...over,
  };
}

describe("image refs", () => {
  it("normalizes Docker Hub short names under docker.io / library", () => {
    expect(normalizeImageName("nginx")).toBe("docker.io/library/nginx");
    expect(normalizeImageName("nginx:1.27")).toBe("docker.io/library/nginx");
    expect(normalizeImageName("amir20/dozzle:latest")).toBe("docker.io/amir20/dozzle");
    expect(normalizeImageName("index.docker.io/amir20/dozzle")).toBe("docker.io/amir20/dozzle");
  });

  it("keeps explicit registries (incl. host:port and localhost)", () => {
    expect(normalizeImageName("lscr.io/linuxserver/sonarr:latest")).toBe("lscr.io/linuxserver/sonarr");
    expect(normalizeImageName("registry.lan:5000/team/app:1")).toBe("registry.lan:5000/team/app");
    expect(normalizeImageName("localhost/app")).toBe("localhost/app");
  });

  it("splits tag and digest without confusing a registry port for a tag", () => {
    expect(parseImageRef("registry.lan:5000/app")).toEqual({ name: "registry.lan:5000/app", repo: "registry.lan:5000/app" });
    const p = parseImageRef("ghcr.io/analogj/scrutiny:master-omnibus@sha256:" + "1".repeat(64));
    expect(p.tag).toBe("master-omnibus");
    expect(p.digest).toBe("sha256:" + "1".repeat(64));
    expect(p.repo).toBe("ghcr.io/analogj/scrutiny");
  });

  it("detects digest pins", () => {
    expect(isDigestPinned("a/b@sha256:" + "f".repeat(64))).toBe(true);
    expect(isDigestPinned("a/b:latest")).toBe(false);
  });

  it("refuses refs outside the charset before they can reach a shell", () => {
    expect(() => assertImageRef("nginx; rm -rf /")).toThrow(/Invalid image reference/);
    expect(() => assertImageRef("$(id)")).toThrow();
    expect(() => assertImageRef("lscr.io/linuxserver/sonarr:latest")).not.toThrow();
  });

  it("finds the RepoDigests entry for the ref's repository across spellings", () => {
    const rd = ["amir20/dozzle@" + D("2"), "lscr.io/linuxserver/sonarr@" + D("3")];
    expect(localDigestFor("docker.io/amir20/dozzle:latest", rd)).toBe(D("2"));
    expect(localDigestFor("lscr.io/linuxserver/sonarr:latest", rd)).toBe(D("3"));
    expect(localDigestFor("nginx", rd)).toBeNull();
  });
});

describe("extractImageVersion", () => {
  it("prefers the OCI version label", () => {
    expect(extractImageVersion("v11.3.1", undefined)).toBe("v11.3.1");
  });
  it("falls back to the linuxserver build_version segment", () => {
    expect(extractImageVersion("", "Linuxserver.io version:- 4.0.19.2979-ls322 Build-date:- 2026")).toBe("4.0.19.2979-ls322");
  });
  it("treats <no value> as missing and never infers from a tag", () => {
    expect(extractImageVersion("<no value>", "<no value>")).toBeNull();
  });
});

describe("container identity + image info parsing", () => {
  it("parses tab rows, strips the leading slash, folds <no value>", () => {
    const line = [
      "/sonarr", "c".repeat(64), "lscr.io/linuxserver/sonarr:latest", D("4"), "running", "1", "sonarr",
      "/data/compose/1/docker-compose.yml", "<no value>", "", "true", "container:" + "d".repeat(64),
    ].join("\t");
    const [c] = parseContainerIdentities(line + "\n\nshort\tline\n");
    expect(c).toMatchObject({
      name: "sonarr",
      composeProject: "1",
      composeService: "sonarr",
      watchtowerLabel: "",
      diunWatchRepoLabel: "true",
      networkMode: "container:" + "d".repeat(64),
    });
  });

  it("parses RepoDigests + version per image id, tolerating bad JSON", () => {
    const out =
      imageInfoRow(D("4"), [`lscr.io/linuxserver/sonarr@${D("4")}`], { build_version: "Linuxserver.io version:- 4.0.19.2979-ls322 Build" }) +
      "\n" +
      `${D("5")}\tnot-json\t${JSON.stringify({ Labels: ociVersion("1.2.3") })}\n` +
      `${D("6")}\t[]\tnot-json\n`;
    const m = parseImageInfo(out);
    expect(m.get(D("4"))).toEqual({ id: D("4"), repoDigests: [`lscr.io/linuxserver/sonarr@${D("4")}`], version: "4.0.19.2979-ls322" });
    expect(m.get(D("5"))).toEqual({ id: D("5"), repoDigests: [], version: "1.2.3" });
    expect(m.get(D("6"))).toEqual({ id: D("6"), repoDigests: [], version: null });
  });

  it("an image with NO Labels key (or a null Config) parses version-less alongside labelled ones", () => {
    const out = [
      imageInfoRow(D("4"), [`a/b@${D("4")}`], ociVersion("1.0")),
      imageInfoRow(D("5"), [`louislam/uptime-kuma@${D("5")}`], null),
      `${D("6")}\t[]\tnull`,
      `${D("7")}\t[]\t${JSON.stringify({ Labels: null })}`,
    ].join("\n");
    const m = parseImageInfo(out);
    expect(m.get(D("4"))?.version).toBe("1.0");
    expect(m.get(D("5"))).toEqual({ id: D("5"), repoDigests: [`louislam/uptime-kuma@${D("5")}`], version: null });
    expect(m.get(D("6"))?.version).toBeNull();
    expect(m.get(D("7"))?.version).toBeNull();
  });

  it("the image template never dereferences .Config.Labels (a label-less image fails the whole batch)", () => {
    const cmd = buildImageInfoCommand([D("4"), D("5")]);
    expect(cmd).not.toContain(".Config.Labels");
    expect(cmd).not.toMatch(/\{\{\s*index /);
    expect(cmd).toContain("{{json .Config}}");
    expect(cmd).toContain(`${D("4")} ${D("5")}`);
  });
});

describe("pickEnv — names only", () => {
  it("returns ONLY the requested keys (never the rest of the env)", () => {
    const out = JSON.stringify(["WATCHTOWER_CLEANUP=true", "SECRET_TOKEN=hunter2", "WATCHTOWER_LABEL_ENABLE=true"]) + "\t" + JSON.stringify(["--interval", "30"]);
    const { env, args } = pickEnv(out, ["WATCHTOWER_CLEANUP", "WATCHTOWER_LABEL_ENABLE"]);
    expect(env).toEqual({ WATCHTOWER_CLEANUP: "true", WATCHTOWER_LABEL_ENABLE: "true" });
    expect(JSON.stringify(env)).not.toContain("hunter2");
    expect(args).toEqual(["--interval", "30"]);
  });
});

describe("Watchtower ownership", () => {
  it("recognizes Watchtower and its forks", () => {
    expect(isWatchtowerImage("containrrr/watchtower:latest")).toBe(true);
    expect(isWatchtowerImage("nickfedor/watchtower")).toBe(true);
    expect(isWatchtowerImage("nginx")).toBe(false);
  });

  it("reads settings from env or args", () => {
    expect(parseWatchtowerConfig("wt", { WATCHTOWER_LABEL_ENABLE: "true", WATCHTOWER_CLEANUP: "true", WATCHTOWER_SCHEDULE: "0 0 3 * * 6" }, [])).toEqual({
      container: "wt", schedule: "0 0 3 * * 6", labelEnable: true, cleanup: true,
    });
    expect(parseWatchtowerConfig("wt", {}, ["--label-enable", "--interval", "300"])).toEqual({
      container: "wt", schedule: "every 300s", labelEnable: true, cleanup: false,
    });
  });

  it("label-enable mode manages only containers labelled true (the lab's setup)", () => {
    const wt = { container: "watchtower", schedule: null, labelEnable: true, cleanup: true };
    expect(watchtowerManages(wt, ident({ name: "dozzle", watchtowerLabel: "true" }))).toBe(true);
    expect(watchtowerManages(wt, ident({ name: "sonarr" }))).toBe(false);
    expect(watchtowerManages(wt, ident({ name: "watchtower", watchtowerLabel: "true" }))).toBe(false);
  });

  it("without label-enable it manages everything not labelled false", () => {
    const wt = { container: "watchtower", schedule: null, labelEnable: false, cleanup: false };
    expect(watchtowerManages(wt, ident({ name: "sonarr" }))).toBe(true);
    expect(watchtowerManages(wt, ident({ name: "pinned", watchtowerLabel: "false" }))).toBe(false);
    expect(watchtowerManages(null, ident({}))).toBe(false);
  });
});

describe("registry check", () => {
  it("quotes every ref into the loop and emits nothing for an empty list", () => {
    expect(buildRemoteDigestCommand([])).toBe("true");
    const cmd = buildRemoteDigestCommand(["lscr.io/linuxserver/sonarr:latest", "nginx"]);
    expect(cmd).toContain("for r in 'lscr.io/linuxserver/sonarr:latest' 'nginx'; do");
    expect(cmd).toContain("imagetools inspect \"$r\" --format '{{.Manifest.Digest}}'");
  });

  it("parses per-ref digests and isolates failures", () => {
    const m = parseRemoteDigests(`a:latest\t0\t${D("6")}\nb:latest\t1\tERROR: unauthorized\nc\t0\tgarbage\n`);
    expect(m.get("a:latest")).toEqual({ ref: "a:latest", digest: D("6") });
    expect(m.get("b:latest")).toEqual({ ref: "b:latest", digest: null, error: "ERROR: unauthorized" });
    expect(m.get("c")?.digest).toBeNull();
  });

  it("classifies against index digests", () => {
    const r = { ref: "x", digest: D("7") };
    expect(classifyImageUpdate({ ref: "a:1", localDigest: D("7"), remote: r }).status).toBe("up-to-date");
    expect(classifyImageUpdate({ ref: "a:1", localDigest: D("8"), remote: r }).status).toBe("update-available");
    expect(classifyImageUpdate({ ref: "a@" + D("7"), localDigest: D("7"), remote: r }).status).toBe("pinned");
    expect(classifyImageUpdate({ ref: "app:local", localDigest: null, remote: undefined })).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/local-image/),
    });
    expect(classifyImageUpdate({ ref: "a:1", localDigest: D("7"), remote: { ref: "a:1", digest: null, error: "boom" } })).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/boom/),
    });
    expect(classifyImageUpdate({ ref: D("9"), localDigest: null, remote: undefined }).status).toBe("unknown");
  });
});

describe("Diun parsing (v4.33.0 fixtures, ADR-025 §0)", () => {
  it("splits the version line off the list output and parses images", () => {
    const { version, body } = splitDiunListOutput(fixture("image-list.raw.txt"));
    expect(version).toBe("v4.33.0");
    const imgs = parseDiunImageList(body);
    expect(imgs).toHaveLength(4);
    const sonarr = imgs.find((i) => i.name === "lscr.io/linuxserver/sonarr")!;
    expect(sonarr.manifestsCount).toBe(1); // a STRING in Diun's JSON
    expect(sonarr.latest).toMatchObject({
      tag: "latest",
      digest: "sha256:dffc730adcb8b4f4342792fbb27fcad9c62fb8660523f2aeb082416980d7fe0c",
      version: "4.0.20.3014-ls327",
    });
    expect(imgs.find((i) => i.name === "docker.io/louislam/uptime-kuma")!.latest?.version).toBeNull();
  });

  it("parses inspect manifests and maps the fatal not-found line to null", () => {
    const ms = parseDiunImageInspect(fixture("image-inspect-sonarr.raw.json"))!;
    expect(ms).toHaveLength(1);
    expect(ms[0]!.version).toBe("4.0.20.3014-ls327");
    expect(parseDiunImageInspect(fixture("image-inspect-not-found.txt"))).toBeNull();
  });

  it("refuses an unrecognized shape instead of guessing", () => {
    expect(() => parseDiunImageList('{"things":[]}')).toThrow(DiunParseError);
    expect(() => parseDiunImageList('{"images":[{"name":"a","manifestsCount":"many"}]}')).toThrow(DiunParseError);
    expect(() => parseDiunImageList("no json here")).toThrow(DiunParseError);
    expect(() => parseDiunImageInspect('{"level":"fatal","error":"connection refused"}')).toThrow(/connection refused/);
  });

  it("splits batched inspect output per image", () => {
    const m = splitDiunInspectOutput("@@IMG@@a/b\n{\"x\":1}\n@@IMG@@c/d\n{}\n");
    expect([...m.keys()]).toEqual(["a/b", "c/d"]);
    expect(m.get("a/b")).toContain('"x":1');
  });

  it("recognizes the Diun image", () => {
    expect(isDiunImage("crazymax/diun:latest")).toBe(true);
    expect(isDiunImage("ghcr.io/crazy-max/diun:4")).toBe(true);
  });
});

describe("rankCandidateTags", () => {
  const m = (tag: string, digest: string, created = "2026-01-01"): DiunManifest => ({ tag, digest, created, version: null });
  const manifests = [
    m("latest", D("a")),
    m("4.0.19", D("b"), "2026-09-01"),
    m("4.0.20", D("a"), "2026-10-10"),
    m("4.0.9", D("c"), "2026-01-01"),
    m("v5", D("d")),
    m("develop", D("e")),
  ];

  it("a moving tag gets the version-shaped tags, newest version first, current marked", () => {
    const r = rankCandidateTags("latest", D("a"), manifests, 10);
    expect(r.map((c) => c.tag)).toEqual(["v5", "4.0.20", "4.0.19", "4.0.9"]);
    expect(r.find((c) => c.tag === "4.0.20")!.current).toBe(true);
  });

  it("a version tag keeps the same v-prefix family, numerically ordered (4.0.20 > 4.0.9)", () => {
    expect(rankCandidateTags("4.0.19", D("b"), manifests, 10).map((c) => c.tag)).toEqual(["4.0.20", "4.0.19", "4.0.9"]);
  });

  it("caps the list", () => {
    expect(rankCandidateTags("latest", null, manifests, 2)).toHaveLength(2);
  });
});

describe("docker_restart helpers", () => {
  it("finds netns dependents by id, id prefix, or name — never the target itself", () => {
    const provider = ident({ name: "tailscale", id: "f".repeat(64) });
    const all = [
      provider,
      ident({ name: "sonarr", id: "1".repeat(64), networkMode: "container:" + "f".repeat(64) }),
      ident({ name: "radarr", id: "2".repeat(64), networkMode: "container:" + "f".repeat(12) }),
      ident({ name: "jelly", id: "3".repeat(64), networkMode: "container:tailscale" }),
      ident({ name: "other", id: "4".repeat(64), networkMode: "bridge" }),
    ];
    expect(findNetnsDependents(provider, all).map((c) => c.name)).toEqual(["sonarr", "radarr", "jelly"]);
  });

  it("builds a quoted restart with an optional stop timeout", () => {
    expect(buildDockerRestartCommand(["a", "b"])).toBe("docker restart 'a' 'b'");
    expect(buildDockerRestartCommand(["a"], 5)).toBe("docker restart -t 5 'a'");
  });
});

describe("compose_update helpers", () => {
  it("runs compose from the file's directory with an explicit project", () => {
    expect(buildComposeCommand("/data/compose/1/docker-compose.yml", "1", "pull sonarr")).toBe(
      "cd '/data/compose/1' && docker compose -p 1 -f '/data/compose/1/docker-compose.yml' pull sonarr"
    );
  });

  it("names the hold tag under the running repo", () => {
    expect(holdTagFor("lscr.io/linuxserver/sonarr:latest", "sonarr")).toBe("lscr.io/linuxserver/sonarr:mcp-hold-sonarr");
    expect(holdTagFor("nginx", "web")).toBe("nginx:mcp-hold-web");
  });

  it("matches config_files labels exactly (comma-separated)", () => {
    expect(configFilesInclude("/a/docker-compose.yml,/a/override.yml", "/a/override.yml")).toBe(true);
    expect(configFilesInclude("/a/docker-compose.yml", "/a/docker-compose.yaml")).toBe(false);
  });

  it("validates project and service names", () => {
    expect(() => assertComposeProject("1")).not.toThrow();
    expect(() => assertComposeProject("My Stack")).toThrow();
    expect(() => assertComposeService("sonarr")).not.toThrow();
    expect(() => assertComposeService("x;rm")).toThrow();
  });

  it("parses a health sample", () => {
    expect(parseHealthSample(`running\thealthy\t0\tfalse\t${D("1")}\n`, 5)).toEqual({
      t: 5, status: "running", health: "healthy", restartCount: 0, restarting: false, imageId: D("1"),
    });
    expect(parseHealthSample("garbage", 0)).toBeNull();
  });
});

describe("evaluateHealthPoll (pure; no sleeping)", () => {
  const s = (t: number, over: Partial<HealthSample> = {}): HealthSample => ({
    t, status: "running", health: "none", restartCount: 0, restarting: false, ...over,
  });

  it("HEALTHCHECK healthy passes, unhealthy fails, starting is pending", () => {
    expect(evaluateHealthPoll([s(0, { health: "starting" })], 0).state).toBe("pending");
    expect(evaluateHealthPoll([s(0, { health: "starting" }), s(1, { health: "healthy" })], 0)).toMatchObject({ state: "pass", mode: "healthcheck" });
    expect(evaluateHealthPoll([s(0, { health: "unhealthy" })], 0).state).toBe("fail");
  });

  it("without a HEALTHCHECK, passes only after stableMs of running", () => {
    expect(evaluateHealthPoll([s(0), s(10_000)], 20_000).state).toBe("pending");
    expect(evaluateHealthPoll([s(0), s(10_000), s(20_000)], 20_000)).toMatchObject({ state: "pass", mode: "stability" });
  });

  it("a restarting sample resets the stability window", () => {
    expect(evaluateHealthPoll([s(0), s(15_000, { restarting: true }), s(30_000)], 20_000).state).toBe("pending");
  });

  it("a restart-count increase (crash loop) or an exit fails immediately", () => {
    expect(evaluateHealthPoll([s(0), s(2_000, { restartCount: 1 })], 20_000).state).toBe("fail");
    expect(evaluateHealthPoll([s(0), s(2_000, { status: "exited" })], 20_000).state).toBe("fail");
  });

  it("no samples is pending", () => {
    expect(evaluateHealthPoll([], 0).state).toBe("pending");
  });
});

describe("ADR-027 — env files, published ports, probe binding check", () => {
  it("parses the environment_file label and published ports from the identity row; old 12-field rows still parse", () => {
    const base = ["/searxng", "c".repeat(64), "searxng/searxng:latest", D("4"), "running", "s", "searxng", "/x.yml", "", "", "", "bridge"];
    const ports = JSON.stringify({ "8080/tcp": [{ HostIp: "10.0.0.52", HostPort: "8888" }], "53/udp": null });
    const [c] = parseContainerIdentities([...base, "/data/segmem/.env", ports].join("\t"));
    expect(c!.composeEnvFiles).toBe("/data/segmem/.env");
    expect(c!.publishedPorts).toEqual([{ containerPort: "8080/tcp", hostIp: "10.0.0.52", hostPort: "8888" }]);
    const [old] = parseContainerIdentities(base.join("\t"));
    expect(old).toMatchObject({ composeEnvFiles: "", publishedPorts: [] });
    const [bad] = parseContainerIdentities([...base, "<no value>", "not-json"].join("\t"));
    expect(bad).toMatchObject({ composeEnvFiles: "", publishedPorts: [] });
  });

  it("buildComposeCommand puts each --env-file (quoted) before the subcommand", () => {
    expect(buildComposeCommand("/data/segmem/repo/compose.yml", "segmem", "config --format json", ["/data/segmem/.env", "/x/it's.env"])).toBe(
      "cd '/data/segmem/repo' && docker compose -p segmem -f '/data/segmem/repo/compose.yml' " +
        "--env-file '/data/segmem/.env' --env-file '/x/it'\\''s.env' config --format json"
    );
    expect(buildComposeCommand("/a/c.yml", "p", "pull x")).toBe("cd '/a' && docker compose -p p -f '/a/c.yml' pull x");
  });

  const c = (publishedPorts: Array<{ containerPort: string; hostIp: string; hostPort: string }>, networkMode = "bridge") => ({
    name: "searxng",
    networkMode,
    publishedPorts,
  });

  it("probeBindingWarning: the searxng case (published on 10.0.0.52 only, probe on 127.0.0.1)", () => {
    const w = probeBindingWarning("http://127.0.0.1:8888/healthz", c([{ containerPort: "8080/tcp", hostIp: "10.0.0.52", hostPort: "8888" }]));
    expect(w).toMatch(/publishes port 8888 only on 10\.0\.0\.52/);
  });

  it("probeBindingWarning: null when the binding is reachable", () => {
    const wild = c([{ containerPort: "8080/tcp", hostIp: "0.0.0.0", hostPort: "8888" }]);
    expect(probeBindingWarning("http://127.0.0.1:8888/", wild)).toBeNull();
    expect(probeBindingWarning("http://10.0.0.52:8888/", c([{ containerPort: "8080/tcp", hostIp: "10.0.0.52", hostPort: "8888" }]))).toBeNull();
    expect(probeBindingWarning("http://localhost:8888/", c([{ containerPort: "8080/tcp", hostIp: "127.0.0.1", hostPort: "8888" }]))).toBeNull();
    expect(probeBindingWarning("https://127.0.0.1/", c([{ containerPort: "443/tcp", hostIp: "", hostPort: "443" }]))).toBeNull();
  });

  it("probeBindingWarning: warns on a port nothing publishes", () => {
    expect(probeBindingWarning("http://127.0.0.1:9000/", c([]))).toMatch(/it publishes no ports/);
    expect(probeBindingWarning("http://127.0.0.1:9000/", c([{ containerPort: "80/tcp", hostIp: "0.0.0.0", hostPort: "8080" }]))).toMatch(
      /does not match any port searxng publishes \(published bindings: 0\.0\.0\.0:8080\)/
    );
  });

  it("probeBindingWarning: declines to judge hostnames and shared/host network namespaces", () => {
    expect(probeBindingWarning("http://searxng:8080/", c([]))).toBeNull();
    expect(probeBindingWarning("http://127.0.0.1:9000/", c([], "container:" + "d".repeat(64)))).toBeNull();
    expect(probeBindingWarning("http://127.0.0.1:9000/", c([], "host"))).toBeNull();
    expect(probeBindingWarning("not a url", c([]))).toBeNull();
  });
});
