import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { ExecResult } from "../ssh/transport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { dockerRestartHandler, DockerRestartInputSchema } from "./dockerRestart.js";
import { imageUpdatesHandler, ImageUpdatesInputSchema, resolveDiunLocation } from "./imageUpdates.js";
import { ScriptTransport, identityRow, makeConfig } from "./dockerUpdateTestkit.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "diun");
const D = (c: string): string => "sha256:" + c.repeat(64).slice(0, 64);
const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

const IDENTITY = /docker ps -q --no-trunc \| xargs -r docker inspect/;
/** The inner command as written, undoing pct exec's '\'' quoting of single quotes. */
const inner = (cmd: string): string => cmd.replace(/'\\''/g, "'");
const has = (...parts: string[]) => (cmd: string): boolean => parts.every((p) => inner(cmd).includes(p));

describe("docker_restart", () => {
  let tmp: string;
  let t: ScriptTransport;
  let audit: AuditLog;
  let cfg: Config;
  const run = (i: Record<string, unknown>) =>
    dockerRestartHandler(DockerRestartInputSchema.parse({ vmid: 101, ...i }), t, audit, cfg);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dockerrestart-"));
    cfg = makeConfig(tmp);
    audit = new AuditLog(cfg.audit.logPath);
    const tsId = "f".repeat(64);
    t = new ScriptTransport().on(
      IDENTITY,
      ok(
        [
          identityRow({ name: "tailscale", id: tsId }),
          identityRow({ name: "sonarr", networkMode: "container:" + tsId }),
          identityRow({ name: "radarr", networkMode: "container:" + tsId }),
          identityRow({ name: "dozzle" }),
        ].join("\n")
      )
    );
  });

  it("requires confirm and a valid name, before touching the node", async () => {
    await expect(run({ container: "dozzle" })).rejects.toThrow(/confirm: true/);
    await expect(run({ container: "bad name", confirm: true })).rejects.toThrow(/Invalid Docker container name/);
    expect(t.commands).toHaveLength(0);
  });

  it("restarts a plain container and writes a structured audit row", async () => {
    const r = await run({ container: "dozzle", confirm: true, timeoutSec: 5 });
    expect(r.restarted).toEqual(["dozzle"]);
    expect(inner(t.commands.at(-1)!)).toContain("docker restart -t 5 'dozzle'");
    const rec = audit.readAll()[0]!;
    expect(rec).toMatchObject({ tool: "docker_restart", vmid: 101, container: "dozzle", hashScope: "unknown", confirmGated: true, exitCode: 0 });
  });

  it("refuses a netns provider by default and names the dependents (no restart, no audit)", async () => {
    await expect(run({ container: "tailscale", confirm: true })).rejects.toThrow(/sonarr, radarr/);
    expect(t.commands.some((c) => c.includes("docker restart"))).toBe(false);
    expect(audit.readAll()).toHaveLength(0);
  });

  it("netnsDependents: restart → provider first, then the dependents", async () => {
    const r = await run({ container: "tailscale", confirm: true, netnsDependents: "restart" });
    const restarts = t.commands.filter((c) => c.includes("docker restart")).map(inner);
    expect(restarts[0]).toContain("docker restart 'tailscale'");
    expect(restarts[1]).toContain("docker restart 'sonarr' 'radarr'");
    expect(r.restarted).toEqual(["tailscale", "sonarr", "radarr"]);
  });

  it("does not restart dependents when the provider restart fails", async () => {
    t.on(has("docker restart 'tailscale'"), { stdout: "", stderr: "boom", exitCode: 1 });
    const r = await run({ container: "tailscale", confirm: true, netnsDependents: "restart" });
    expect(r.restarted).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(t.commands.filter((c) => c.includes("docker restart"))).toHaveLength(1);
    expect(audit.readAll()[0]!.exitCode).toBe(1);
  });

  it("netnsDependents: ignore → proceeds with a warning", async () => {
    const r = await run({ container: "tailscale", confirm: true, netnsDependents: "ignore" });
    expect(r.restarted).toEqual(["tailscale"]);
    expect(r.warnings.join(" ")).toMatch(/sonarr, radarr/);
  });

  it("propagates a signal-kill honestly (exitCode null, never 0)", async () => {
    t.on(/docker restart/, { stdout: "", stderr: "", exitCode: null, signal: "KILL" });
    const r = await run({ container: "dozzle", confirm: true });
    expect(r.exitCode).toBeNull();
    expect(audit.readAll()[0]!.exitCode).toBeNull();
  });
});

describe("image_updates", () => {
  let tmp: string;
  let t: ScriptTransport;
  let cfg: Config;
  const SONARR_OLD = "sha256:c19aa4ecdf03d73e1d5c901da33744cb7eb4d921f89bafed1ca264601d7fa224";
  const SONARR_NEW = "sha256:dffc730adcb8b4f4342792fbb27fcad9c62fb8660523f2aeb082416980d7fe0c";
  const DOZZLE = "sha256:ba65da5af3d2147cfc2ee68ea5a6e35b75d2dff7eeff226151a65c9d77831c02";
  const run = (i: Record<string, unknown> = {}) =>
    imageUpdatesHandler(ImageUpdatesInputSchema.parse({ vmid: 101, ...i }), t, cfg, () => new Date("2026-10-13T00:00:00Z"));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imageupdates-"));
    cfg = makeConfig(tmp);
    t = new ScriptTransport()
      .on(
        IDENTITY,
        ok(
          [
            identityRow({ name: "sonarr", ref: "lscr.io/linuxserver/sonarr:latest", imageId: SONARR_OLD, composeProject: "1", composeService: "sonarr" }),
            identityRow({ name: "dozzle", ref: "amir20/dozzle:latest", imageId: DOZZLE, watchtowerLabel: "true" }),
            identityRow({ name: "spotify", ref: "spotify-history:local", imageId: D("5"), diunLabel: "false" }),
            identityRow({ name: "scrutiny", ref: "ghcr.io/analogj/scrutiny:master-omnibus@" + D("6"), imageId: D("6") }),
            identityRow({ name: "watchtower", ref: "containrrr/watchtower:latest", imageId: D("7") }),
            identityRow({ name: "diun", ref: "crazymax/diun:latest", imageId: D("8") }),
          ].join("\n")
        )
      )
      .on(
        /docker image inspect --format/,
        ok(
          [
            `${SONARR_OLD}\t["lscr.io/linuxserver/sonarr@${SONARR_OLD}"]\t4.0.19.2979-ls322\t`,
            `${DOZZLE}\t["amir20/dozzle@${DOZZLE}"]\tv11.3.1\t`,
            `${D("5")}\t[]\t\t`,
            `${D("6")}\t["ghcr.io/analogj/scrutiny@${D("6")}"]\t\t`,
            `${D("7")}\t["containrrr/watchtower@${D("7")}"]\t\t`,
            `${D("8")}\t["crazymax/diun@${D("8")}"]\t4.33.0\t`,
          ].join("\n")
        )
      )
      .on(
        has("{{json .Config.Env}}", "'watchtower'"),
        ok(`["WATCHTOWER_LABEL_ENABLE=true","WATCHTOWER_CLEANUP=true","WATCHTOWER_SCHEDULE=0 0 3 * * 6","SECRET=x"]\tnull`)
      )
      .on(
        has("{{json .Config.Env}}", "'diun'"),
        ok(`["DIUN_WATCH_SCHEDULE=0 0 6 * * 1","DIUN_NOTIF_DISCORD_WEBHOOKURL=https://discord.com/api/webhooks/1/secret"]\tnull`)
      )
      .on(
        /imagetools inspect/,
        ok(
          [
            `lscr.io/linuxserver/sonarr:latest\t0\t${SONARR_NEW}`,
            `amir20/dozzle:latest\t0\t${DOZZLE}`,
            `containrrr/watchtower:latest\t0\t${D("7")}`,
            `crazymax/diun:latest\t1\tERROR: rate limited`,
          ].join("\n")
        )
      )
      .on(/diun image list --raw/, ok(fs.readFileSync(path.join(FIX, "image-list.raw.txt"), "utf8")));
  });

  it("joins registry verdicts with Diun versions and Watchtower ownership", async () => {
    const r = await run();
    const by = Object.fromEntries(r.containers.map((c) => [c.name, c]));
    expect(by.sonarr).toMatchObject({
      status: "update-available",
      verdictSource: "registry",
      localDigest: SONARR_OLD,
      remoteDigest: SONARR_NEW,
      currentVersion: "4.0.19.2979-ls322",
      availableVersion: "4.0.20.3014-ls327",
      diunStale: false,
      managedBy: null,
      project: "1",
      service: "sonarr",
    });
    expect(by.dozzle).toMatchObject({ status: "up-to-date", managedBy: "watchtower", availableVersion: "v11.3.1" });
    expect(by.spotify).toMatchObject({ status: "unknown", diun: { tracked: false, reason: "opted out (diun.enable=false)" } });
    expect(by.scrutiny!.status).toBe("pinned");
    expect(r.summary["update-available"]).toBe(1);
    expect(r.sources.diun).toMatchObject({ available: true, container: "diun", version: "v4.33.0", schedule: "0 0 6 * * 1", watchRepoEnabled: false });
    expect(r.watchtower).toEqual({ container: "watchtower", schedule: "0 0 3 * * 6", labelEnable: true, cleanup: true });
    expect(r.notes.join(" ")).toMatch(/watch_repo/);
  });

  it("never queries the registry for local or pinned images", async () => {
    await run();
    const q = t.commands.find((c) => c.includes("imagetools"))!;
    expect(q).not.toContain("spotify-history");
    expect(q).not.toContain("scrutiny");
  });

  it("never returns env values beyond the named schedule keys", async () => {
    const r = await run();
    const text = JSON.stringify(r);
    expect(text).not.toContain("webhooks");
    expect(text).not.toContain("SECRET");
  });

  it("source: diun skips the registry and labels Diun verdicts as possibly stale", async () => {
    const r = await run({ source: "diun" });
    expect(t.commands.some((c) => c.includes("imagetools"))).toBe(false);
    const sonarr = r.containers.find((c) => c.name === "sonarr")!;
    expect(sonarr).toMatchObject({ status: "update-available", verdictSource: "diun" });
    expect(sonarr.reason).toMatch(/may be stale/);
  });

  it("source: registry skips Diun entirely", async () => {
    const r = await run({ source: "registry" });
    expect(t.commands.some((c) => c.includes("diun image"))).toBe(false);
    expect(r.containers.every((c) => c.diun === null)).toBe(true);
  });

  it("flags Diun as stale when its digest disagrees with the registry", async () => {
    t.on(/imagetools inspect/, ok(`lscr.io/linuxserver/sonarr:latest\t0\t${D("9")}`));
    const r = await run({ container: "sonarr" });
    expect(r.containers[0]).toMatchObject({ status: "update-available", diunStale: true });
  });

  it("degrades (never guesses) on unrecognized Diun output", async () => {
    t.on(/diun image list --raw/, ok('v9.0.0\n@@DIUN@@\n{"somethingElse":true}'));
    const r = await run();
    expect(r.sources.diun.available).toBe(false);
    expect(r.sources.diun.reason).toMatch(/unrecognized Diun output/);
    expect(r.containers.find((c) => c.name === "sonarr")!.status).toBe("update-available");
  });

  it("reports Diun absent without failing", async () => {
    t.on(IDENTITY, ok(identityRow({ name: "sonarr", ref: "lscr.io/linuxserver/sonarr:latest", imageId: SONARR_OLD })));
    const r = await run();
    expect(r.sources.diun).toMatchObject({ available: false, reason: expect.stringMatching(/no running Diun/) });
  });

  it("returns ranked tag candidates when Diun tracks several tags (watch_repo)", async () => {
    const list = {
      images: [
        {
          name: "lscr.io/linuxserver/sonarr",
          manifestsCount: "3",
          latest: { tag: "latest", digest: SONARR_NEW, created: "2026-10-10T00:00:00Z", labels: {} },
        },
      ],
    };
    const inspect = {
      image: {
        name: "lscr.io/linuxserver/sonarr",
        manifests: [
          { tag: "latest", digest: SONARR_NEW, created: "2026-10-10T00:00:00Z" },
          { tag: "4.0.20.3014-ls327", digest: SONARR_NEW, created: "2026-10-10T00:00:00Z" },
          { tag: "4.0.19.2979-ls322", digest: SONARR_OLD, created: "2026-09-01T00:00:00Z" },
        ],
      },
    };
    t.on(/diun image list --raw/, ok("v4.33.0\n@@DIUN@@\n" + JSON.stringify(list)));
    t.on(/diun image inspect/, ok("@@IMG@@lscr.io/linuxserver/sonarr\n" + JSON.stringify(inspect)));
    const r = await run({ container: "sonarr" });
    expect(r.containers[0]!.candidates!.map((c) => [c.tag, c.current])).toEqual([
      ["4.0.20.3014-ls327", false],
      ["4.0.19.2979-ls322", true],
    ]);
  });

  it("throws for a named container that is not running", async () => {
    await expect(run({ container: "nope" })).rejects.toThrow(/No running container named 'nope'/);
  });

  it("resolveDiunLocation honours DOCKER_DIUN_CONTAINER and validates its shape", () => {
    expect(resolveDiunLocation("102:diun", 101, [])).toEqual({ vmid: 102, container: "diun" });
    expect(resolveDiunLocation("diun", 101, [])).toMatchObject({ error: expect.stringMatching(/<vmid>:<name>/) });
  });
});
