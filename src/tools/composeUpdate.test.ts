import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { ExecResult } from "../ssh/transport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { RollbackBreaker } from "../guardrails/rollbackBreaker.js";
import { composeUpdateHandler, ComposeUpdateInputSchema } from "./composeUpdate.js";
import { ScriptTransport, identityRow, imageInfoRow, makeConfig, ociVersion } from "./dockerUpdateTestkit.js";

const D = (c: string): string => "sha256:" + c.repeat(64).slice(0, 64);
const OLD = D("a");
const NEW = D("b");
const PATH = "/data/compose/1/docker-compose.yml";
const REF = "lscr.io/linuxserver/sonarr:latest";
const HOLD = "lscr.io/linuxserver/sonarr:mcp-hold-sonarr";
const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "boom"): ExecResult => ({ stdout: "", stderr, exitCode: 1 });
const inner = (cmd: string): string => cmd.replace(/'\\''/g, "'");
const has = (...parts: string[]) => (cmd: string): boolean => parts.every((p) => inner(cmd).includes(p));

function composeJson(services: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({ name: "1", services });
}

describe("compose_update", () => {
  let tmp: string;
  let t: ScriptTransport;
  let audit: AuditLog;
  let cfg: Config;
  let breaker: RollbackBreaker;
  let clock: number;
  let samples: string[];
  let rollbackSamples: string[];
  let rolledBack: boolean;

  const sample = (status: string, health: string, restarts = 0, image = NEW): string =>
    `${status}\t${health}\t${restarts}\tfalse\t${image}`;

  const run = (i: Record<string, unknown> = {}) =>
    composeUpdateHandler(
      ComposeUpdateInputSchema.parse({ vmid: 101, composePath: PATH, service: "sonarr", confirm: true, ...i }),
      t,
      audit,
      cfg,
      breaker,
      async (ms) => {
        clock += ms;
      },
      () => clock
    );

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "composeupdate-"));
    cfg = makeConfig(tmp, { updateHealthTimeoutSec: 60, updateStableSec: 10, updatePollIntervalMs: 2_000 });
    audit = new AuditLog(cfg.audit.logPath);
    breaker = new RollbackBreaker({ enabled: true, limit: 2, windowMs: 600_000 });
    clock = 0;
    samples = [sample("running", "starting"), sample("running", "healthy")];
    rollbackSamples = [sample("running", "healthy", 0, OLD)];
    rolledBack = false;
    const tsId = "f".repeat(64);
    t = new ScriptTransport()
      .on(
        /docker ps -q --no-trunc \| xargs -r docker inspect/,
        ok(
          [
            identityRow({ name: "sonarr", ref: REF, imageId: OLD, composeProject: "1", composeService: "sonarr", composeConfigFiles: PATH }),
            identityRow({ name: "tailscale", id: tsId, ref: "tailscale/tailscale:latest", composeProject: "1", composeService: "tailscale", composeConfigFiles: PATH }),
            identityRow({ name: "dozzle", ref: "amir20/dozzle:latest", composeProject: "1", composeService: "dozzle", composeConfigFiles: PATH, watchtowerLabel: "true" }),
            identityRow({ name: "watchtower", ref: "containrrr/watchtower:latest" }),
          ].join("\n")
        )
      )
      .on(has("{{json .Config.Env}}", "'watchtower'"), ok(`["WATCHTOWER_LABEL_ENABLE=true","WATCHTOWER_CLEANUP=true"]\tnull`))
      .on(
        has("config --format json"),
        ok(
          composeJson({
            sonarr: { image: REF, network_mode: "service:tailscale" },
            tailscale: { image: "tailscale/tailscale:latest" },
            dozzle: { image: "amir20/dozzle:latest" },
            builder: { image: "me/app:1", build: { context: "." } },
            pinned: { image: "nginx@" + D("c") },
          })
        )
      )
      .on(has("docker image inspect --format", "RepoDigests"), (cmd) =>
        ok(
          [
            inner(cmd).includes(OLD) ? imageInfoRow(OLD, [`lscr.io/linuxserver/sonarr@${OLD}`], ociVersion("4.0.19")) : "",
            inner(cmd).includes(NEW) ? imageInfoRow(NEW, [`lscr.io/linuxserver/sonarr@${NEW}`], ociVersion("4.0.20")) : "",
          ].join("\n")
        )
      )
      .on(has("docker image inspect --format '{{.Id}}'"), ok(NEW + "\n"))
      .on(has("docker tag", HOLD + " " + REF), () => {
        rolledBack = true;
        return ok();
      })
      .on(has("{{if .State.Health}}"), () => {
        const q = rolledBack ? rollbackSamples : samples;
        return ok(q.length > 1 ? q.shift()! : q[0]!);
      });
  });

  const stepNames = (r: { steps: Array<{ step: string }> }) => r.steps.map((s) => s.step);

  it("updates: pull → hold → recreate → healthy, audited and revertible", async () => {
    const r = await run();
    expect(r.outcome).toBe("updated");
    expect(stepNames(r)).toEqual(["pull", "resolve", "hold", "recreate"]);
    expect(r).toMatchObject({ oldImageId: OLD, newImageId: NEW, currentVersion: "4.0.19", newVersion: "4.0.20", holdTag: HOLD, project: "1" });
    expect(r.health).toMatchObject({ mode: "healthcheck", status: "pass" });
    const cmds = t.commands.map(inner);
    expect(cmds.find((c) => c.includes("docker tag"))).toContain(`docker tag ${OLD} ${HOLD}`);
    expect(cmds.find((c) => c.includes("pull sonarr"))).toContain(
      `cd '/data/compose/1' && docker compose -p 1 -f '${PATH}' pull sonarr`
    );
    expect(cmds.some((c) => c.includes("up -d --no-deps sonarr"))).toBe(true);
    const rec = audit.readAll().at(-1)!;
    expect(rec).toMatchObject({ tool: "compose_update", vmid: 101, container: "sonarr", path: PATH, isRevertible: true, confirmGated: true });
    expect(rec.note).toMatch(/updated/);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(0);
  });

  it("label-less images (no Labels key) still hold, update and report version-less", async () => {
    t.on(has("docker image inspect --format", "RepoDigests"), (cmd) =>
      ok(
        [
          inner(cmd).includes(OLD) ? imageInfoRow(OLD, [`lscr.io/linuxserver/sonarr@${OLD}`], null) : "",
          inner(cmd).includes(NEW) ? imageInfoRow(NEW, [`lscr.io/linuxserver/sonarr@${NEW}`], null) : "",
        ].join("\n")
      )
    );
    const r = await run();
    expect(r.outcome).toBe("updated");
    expect(r).toMatchObject({ oldRepoDigest: OLD, currentVersion: null, newVersion: null });
    const infoCmd = t.commands.map(inner).find((c) => c.includes("RepoDigests"))!;
    expect(infoCmd).not.toContain(".Config.Labels");
  });

  it("already-current: same image after pull → no recreate", async () => {
    t.on(has("docker image inspect --format '{{.Id}}'"), ok(OLD));
    const r = await run();
    expect(r.outcome).toBe("already-current");
    expect(t.commands.some((c) => c.includes("up -d"))).toBe(false);
  });

  // --- Hold tag must survive a no-op run (ops finding 2026-10-17, searxng mcp-hold) ---

  const PREV_HOLD = D("9"); // the image a previous real update held
  const holdCmds = () => t.commands.map(inner).filter((c) => /docker tag \S+ \S+:mcp-hold-/.test(c));

  it("already-current never re-points an existing hold tag, and reports what it points at", async () => {
    t.on(has("docker image inspect --format '{{.Id}}'", REF), ok(OLD + "\n")); // pulled == running
    t.on(has("docker image inspect --format '{{.Id}}'", HOLD), ok(PREV_HOLD + "\n"));
    const r = await run();
    expect(r.outcome).toBe("already-current");
    expect(holdCmds()).toEqual([]);
    expect(t.commands.some((c) => inner(c).includes("docker tag"))).toBe(false);
    expect(stepNames(r)).toEqual(["pull", "resolve"]);
    expect(r.existingHoldImageId).toBe(PREV_HOLD);
  });

  it("already-current with no previous hold creates none and reports null", async () => {
    t.on(has("docker image inspect --format '{{.Id}}'", REF), ok(OLD + "\n"));
    t.on(has("docker image inspect --format '{{.Id}}'", HOLD), fail("No such image"));
    const r = await run();
    expect(holdCmds()).toEqual([]);
    expect(r.existingHoldImageId).toBeNull();
  });

  it("a real update holds the RUNNING image id under the hold tag, after the pull and before the recreate", async () => {
    const r = await run();
    expect(r.outcome).toBe("updated");
    expect(holdCmds()).toEqual([`pct exec 101 -- bash -c 'docker tag ${OLD} ${HOLD}'`].map(inner));
    const cmds = t.commands.map(inner);
    const pull = cmds.findIndex((c) => c.includes("pull sonarr"));
    const hold = cmds.findIndex((c) => c.includes(`docker tag ${OLD} ${HOLD}`));
    const up = cmds.findIndex((c) => c.includes("up -d --no-deps sonarr"));
    expect(pull).toBeLessThan(hold);
    expect(hold).toBeLessThan(up);
  });

  it("a failed hold recreates nothing and puts the ref back on the running image", async () => {
    t.on(has("docker tag", OLD, HOLD), fail("no space"));
    await expect(run()).rejects.toThrow(/Could not pin the running image.*nothing was recreated; .* points at the running image again/);
    const cmds = t.commands.map(inner);
    expect(cmds.some((c) => c.includes(`docker tag ${OLD} ${REF}`))).toBe(true);
    expect(cmds.some((c) => c.includes("up -d"))).toBe(false);
  });

  it("unhealthy → re-tags the held image and recreates with --pull never → rolled-back", async () => {
    samples = [sample("running", "unhealthy")];
    const r = await run();
    expect(r.outcome).toBe("rolled-back");
    expect(stepNames(r)).toEqual(["pull", "resolve", "hold", "recreate", "rollback-retag", "rollback-recreate"]);
    const cmds = t.commands.map(inner);
    expect(cmds.some((c) => c.includes(`docker tag ${HOLD} ${REF}`))).toBe(true);
    expect(cmds.some((c) => c.includes("up -d --no-deps --pull never sonarr"))).toBe(true);
    expect(r.rollbackHealth?.status).toBe("pass");
    expect(r.warnings.join(" ")).toMatch(/not volume data/);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(1);
    expect(audit.readAll().at(-1)!.failed).toBeUndefined();
  });

  it("crash loop (restart count rises) fails the gate", async () => {
    samples = [sample("running", "none", 0), sample("running", "none", 1)];
    const r = await run();
    expect(r.health).toMatchObject({ status: "fail", detail: expect.stringMatching(/crash loop/) });
    expect(r.outcome).toBe("rolled-back");
  });

  it("stability mode passes after stableSec of running without a HEALTHCHECK", async () => {
    samples = [sample("running", "none")];
    const r = await run();
    expect(r.outcome).toBe("updated");
    expect(r.health).toMatchObject({ mode: "stability", status: "pass" });
    expect(clock).toBeGreaterThanOrEqual(10_000);
  });

  it("times out a HEALTHCHECK stuck in starting, then rolls back", async () => {
    samples = [sample("running", "starting")];
    const r = await run();
    expect(r.health).toMatchObject({ status: "fail", detail: expect.stringMatching(/timed out/) });
    expect(r.outcome).toBe("rolled-back");
  });

  it("rollback-failed when the rolled-back container is also unhealthy (audited failed)", async () => {
    samples = [sample("running", "unhealthy")];
    rollbackSamples = [sample("exited", "none", 0, OLD)];
    const r = await run();
    expect(r.outcome).toBe("rollback-failed");
    expect(audit.readAll().at(-1)!.failed).toBe(true);
  });

  it("rollback-failed when the hold tag is gone (never falls through to whatever the tag names)", async () => {
    samples = [sample("running", "unhealthy")];
    t.on(has("docker tag", HOLD + " " + REF), fail("No such image"));
    const r = await run();
    expect(r.outcome).toBe("rollback-failed");
    expect(r.rollbackHealth?.detail).toMatch(/hold tag/);
    expect(t.commands.some((c) => c.includes("--pull never"))).toBe(false);
  });

  it("pull-failed: nothing recreated", async () => {
    t.on(has("pull sonarr"), fail("manifest unknown"));
    const r = await run();
    expect(r.outcome).toBe("pull-failed");
    expect(t.commands.some((c) => c.includes("up -d"))).toBe(false);
    expect(audit.readAll().at(-1)!.failed).toBe(true);
  });

  /** True once the NEW image has been recreated (and until a rollback re-tag). */
  const newImageUp = (): boolean => t.commands.some((c) => inner(c).includes("up -d --no-deps sonarr")) && !rolledBack;

  it("a failed probe fails the gate even when the container is healthy", async () => {
    // The probe gates the rollback too: the new image answers 503, the old one 200.
    t.on(has("curl -k"), () => ok(newImageUp() ? "503 0 0.01" : "200 2 0.01"));
    const r = await run({ probe: { url: "http://localhost:8989/ping" } });
    expect(r.health).toMatchObject({ status: "fail", detail: expect.stringMatching(/503/), probeOnly: true });
    expect(r.outcome).toBe("rolled-back");
    expect(r.rollbackHealth?.detail).toMatch(/probe 200/);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(1);
  });

  // --- ADR-027: probe sanity (ops finding 2026-10-17, searxng) ---

  const SEARX = (ports = [{ containerPort: "8080/tcp", hostIp: "10.0.0.52", hostPort: "8888" }]) =>
    identityRow({ name: "sonarr", ref: REF, imageId: OLD, composeProject: "1", composeService: "sonarr", composeConfigFiles: PATH, publishedPorts: ports });

  it("refuses up front when the probe already fails against the running image, naming the binding mismatch", async () => {
    t.on(/docker ps -q --no-trunc \| xargs -r docker inspect/, ok(SEARX()));
    t.on(has("curl -k"), { stdout: "000 0 0.00", stderr: "", exitCode: 7 });
    const err = await run({ probe: { url: "http://127.0.0.1:8888/healthz" } }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/already fails against the running image \(curl exit 7\)/);
    expect((err as Error).message).toMatch(/publishes port 8888 only on 10\.0\.0\.52/);
    expect((err as Error).message).toMatch(/Nothing was changed/);
    const cmds = t.commands.map(inner);
    expect(cmds.some((c) => c.includes("docker tag") || c.includes(" pull ") || c.includes("up -d"))).toBe(false);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(0);
  });

  it("probe failing on BOTH images while both pass the gate → rollback-ok-probe-failed, not failed, breaker untouched", async () => {
    // Baseline passes (e.g. a flaky upstream), then both images miss the probe.
    let probes = 0;
    t.on(has("curl -k"), () => (probes++ === 0 ? ok("200 2 0.01") : { stdout: "000 0 0.00", stderr: "", exitCode: 7 }));
    const r = await run({ probe: { url: "http://localhost:8989/ping" } });
    expect(r.outcome).toBe("rollback-ok-probe-failed");
    expect(r.health?.probeOnly).toBe(true);
    expect(r.rollbackHealth?.probeOnly).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/failed against both images.*probe URL may be wrong/);
    const rec = audit.readAll().at(-1)!;
    expect(rec.failed).toBeUndefined();
    expect(rec.note).toMatch(/rollback-ok-probe-failed/);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(0);
  });

  it("still reports rollback-failed when the old image fails the container gate itself", async () => {
    let probes = 0;
    t.on(has("curl -k"), () => (probes++ === 0 ? ok("200 2 0.01") : { stdout: "000 0 0.00", stderr: "", exitCode: 7 }));
    rollbackSamples = [sample("running", "unhealthy", 0, OLD)];
    const r = await run({ probe: { url: "http://localhost:8989/ping" } });
    expect(r.outcome).toBe("rollback-failed");
    expect(audit.readAll().at(-1)!.failed).toBe(true);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(1);
  });

  it("warns (without refusing) when a passing probe does not match a published binding", async () => {
    t.on(/docker ps -q --no-trunc \| xargs -r docker inspect/, ok(SEARX()));
    t.on(has("curl -k"), ok("200 2 0.01"));
    const r = await run({ probe: { url: "http://127.0.0.1:9999/ping" } });
    expect(r.outcome).toBe("updated");
    expect(r.warnings.join(" ")).toMatch(/does not match any port sonarr publishes \(published bindings: 10\.0\.0\.52:8888\)/);
  });

  // --- ADR-027: the project's --env-file (ops finding 2026-10-17, segmem) ---

  it("passes every environment_file entry as --env-file to config, pull and up — paths only", async () => {
    t.on(
      /docker ps -q --no-trunc \| xargs -r docker inspect/,
      ok(
        identityRow({
          name: "sonarr",
          ref: REF,
          imageId: OLD,
          composeProject: "1",
          composeService: "sonarr",
          composeConfigFiles: PATH,
          composeEnvFiles: "/data/segmem/.env, /data/segmem/extra.env,relative.env",
        })
      )
    );
    const r = await run();
    expect(r.outcome).toBe("updated");
    expect(r.envFiles).toEqual(["/data/segmem/.env", "/data/segmem/extra.env"]);
    expect(r.warnings.join(" ")).toMatch(/Ignored environment_file entry "relative.env"/);
    const flags = "--env-file '/data/segmem/.env' --env-file '/data/segmem/extra.env'";
    const cmds = t.commands.map(inner);
    for (const sub of ["config --format json", "pull sonarr", "up -d --no-deps sonarr"]) {
      const c = cmds.find((x) => x.includes(sub))!;
      expect(c).toContain(`-f '${PATH}' ${flags} ${sub}`);
    }
    // The env files are only ever compose arguments — never read, printed or copied by the server.
    for (const c of cmds.filter((x) => x.includes("/data/segmem/"))) {
      expect(c).toMatch(/docker compose -p 1 -f /);
      expect(c).not.toMatch(/\b(cat|head|tail|grep|cp|base64)\b[^|]*segmem/);
    }
    expect(JSON.stringify(audit.readAll())).not.toMatch(/TS_AUTHKEY=/);
  });

  it("a compose config failure on a missing variable refuses with no change", async () => {
    t.on(has("config --format json"), fail("required variable TS_AUTHKEY is missing a value"));
    await expect(run()).rejects.toThrow(/docker compose config failed.*TS_AUTHKEY is missing a value/);
    expect(t.commands.some((c) => inner(c).includes("docker tag"))).toBe(false);
  });

  it("§4 ref changed in the file → failed-needs-file-revert with the calls to issue, no re-tag", async () => {
    t.on(has("config --format json"), ok(composeJson({ sonarr: { image: "lscr.io/linuxserver/sonarr:4.0.21" } })));
    samples = [sample("running", "unhealthy")];
    const r = await run();
    expect(r.outcome).toBe("failed-needs-file-revert");
    expect(r.nextSteps!.join("\n")).toMatch(/revert_file/);
    expect(t.commands.some((c) => c.includes("--pull never"))).toBe(false);
    expect(breaker.peek("compose/101/sonarr", clock).recentCount).toBe(1);
  });

  describe("refusals (before anything changes)", () => {
    const noMutation = () => {
      const cmds = t.commands.map(inner);
      expect(cmds.some((c) => c.includes("docker tag") || c.includes(" pull ") || c.includes("up -d"))).toBe(false);
    };

    it("requires confirm", async () => {
      await expect(run({ confirm: false })).rejects.toThrow(/confirm: true/);
      expect(t.commands).toHaveLength(0);
    });

    it("rejects a bad service name or path", async () => {
      await expect(run({ service: "a;b" })).rejects.toThrow(/Invalid compose service name/);
      await expect(run({ composePath: "/proc/x.yml" })).rejects.toThrow(/Invalid compose file path/);
      await expect(run({ probe: { url: "file:///etc/passwd" } })).rejects.toThrow(/Invalid probe url/);
    });

    it("refuses a netns provider (ADR-012 deadlock)", async () => {
      await expect(run({ service: "tailscale" })).rejects.toThrow(/network namespace for sonarr/);
      noMutation();
    });

    it("refuses build: services and digest-pinned refs", async () => {
      t.on(/docker ps -q --no-trunc \| xargs/, ok(
        [
          identityRow({ name: "builder", composeProject: "1", composeService: "builder", composeConfigFiles: PATH }),
          identityRow({ name: "pinned", composeProject: "1", composeService: "pinned", composeConfigFiles: PATH }),
        ].join("\n")
      ));
      await expect(run({ service: "builder" })).rejects.toThrow(/build: section/);
      await expect(run({ service: "pinned" })).rejects.toThrow(/digest-pinned/);
      noMutation();
    });

    it("refuses a Watchtower-managed container unless allowWatchtowerManaged", async () => {
      await expect(run({ service: "dozzle" })).rejects.toThrow(/Watchtower \(watchtower\) also updates 'dozzle'.*CLEANUP/);
      noMutation();
      t.on(has("{{if .State.Health}}"), ok(sample("running", "healthy")));
      const r = await run({ service: "dozzle", allowWatchtowerManaged: true });
      expect(r.warnings.join(" ")).toMatch(/allowWatchtowerManaged/);
    });

    it("refuses when the container came from a different compose file", async () => {
      await expect(run({ composePath: "/opt/other/docker-compose.yml" })).rejects.toThrow(/Same service name found from other files/);
      noMutation();
    });

    it("breaker: refuses (audited) after `limit` auto-rollbacks; override proceeds and is flagged", async () => {
      breaker.check("compose/101/sonarr", 0);
      breaker.check("compose/101/sonarr", 0);
      await expect(run()).rejects.toThrow(/circuit breaker tripped for compose\/101\/sonarr/);
      expect(audit.readAll().at(-1)).toMatchObject({ refused: true, tool: "compose_update" });
      noMutation();
      const r = await run({ overrideCircuitBreaker: true });
      expect(r.outcome).toBe("updated");
      expect(audit.readAll().at(-1)!.circuitBreakerOverridden).toBe(true);
    });
  });
});
