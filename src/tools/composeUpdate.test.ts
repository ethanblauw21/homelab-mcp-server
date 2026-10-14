import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { ExecResult } from "../ssh/transport.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { RollbackBreaker } from "../guardrails/rollbackBreaker.js";
import { composeUpdateHandler, ComposeUpdateInputSchema } from "./composeUpdate.js";
import { ScriptTransport, identityRow, makeConfig } from "./dockerUpdateTestkit.js";

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
            inner(cmd).includes(OLD) ? `${OLD}\t["lscr.io/linuxserver/sonarr@${OLD}"]\t4.0.19\t` : "",
            inner(cmd).includes(NEW) ? `${NEW}\t["lscr.io/linuxserver/sonarr@${NEW}"]\t4.0.20\t` : "",
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

  it("updates: hold → pull → recreate → healthy, audited and revertible", async () => {
    const r = await run();
    expect(r.outcome).toBe("updated");
    expect(stepNames(r)).toEqual(["hold", "pull", "resolve", "recreate"]);
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

  it("already-current: same image after pull → no recreate", async () => {
    t.on(has("docker image inspect --format '{{.Id}}'"), ok(OLD));
    const r = await run();
    expect(r.outcome).toBe("already-current");
    expect(t.commands.some((c) => c.includes("up -d"))).toBe(false);
  });

  it("unhealthy → re-tags the held image and recreates with --pull never → rolled-back", async () => {
    samples = [sample("running", "unhealthy")];
    const r = await run();
    expect(r.outcome).toBe("rolled-back");
    expect(stepNames(r)).toEqual(["hold", "pull", "resolve", "recreate", "rollback-retag", "rollback-recreate"]);
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

  it("a failed probe fails the gate even when the container is healthy", async () => {
    // The probe gates the rollback too: the new image answers 503, the old one 200.
    t.on(has("curl -k"), () => ok(rolledBack ? "200 2 0.01" : "503 0 0.01"));
    const r = await run({ probe: { url: "http://localhost:8989/ping" } });
    expect(r.health).toMatchObject({ status: "fail", detail: expect.stringMatching(/503/) });
    expect(r.outcome).toBe("rolled-back");
    expect(r.rollbackHealth?.detail).toMatch(/probe 200/);
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
