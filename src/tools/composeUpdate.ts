/**
 * `compose_update` (ADR-025 §3) — update ONE compose service: record what runs →
 * hold the old image under a server-owned tag → pull → `up -d --no-deps <svc>` →
 * health gate → on failure, re-tag the held image back under the ref and recreate
 * with `--pull never`. The compose file is never written.
 *
 * Refusals happen before anything changes: missing confirm, invalid path/service,
 * a `build:` service, a digest-pinned ref, a netns provider with dependents
 * (ADR-012's recreate deadlock), a Watchtower-managed container (two updaters
 * fight; Watchtower CLEANUP deletes the image a rollback needs), and a tripped
 * rollback circuit breaker (ADR-021, keyed `compose/<vmid>/<service>`).
 *
 * Honest limits (stated in results): the health gate is a heuristic; rollback
 * restores the IMAGE, not volume data a new version may have migrated; and a
 * ref changed in the compose file since the container was created (§4) cannot be
 * re-tagged back — that path reports `failed-needs-file-revert` with the calls to
 * issue instead.
 */
import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { RollbackBreaker, rollbackTargetKey, breakerRefusal } from "../guardrails/rollbackBreaker.js";
import { timeoutMsToSecs } from "../ssh/command.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { parseCompose, groupByNetns, ComposeParseError } from "./composePreflight.js";
import { buildCurlProbeCommand, evaluateHttpOk, parseCurlProbeOutput, parseProbeUrl } from "./probes.js";
import { loadWatchtower } from "./imageUpdates.js";
import {
  assertComposeProject,
  assertComposeService,
  assertImageRef,
  buildComposeCommand,
  buildContainerIdentityCommand,
  buildHealthSampleCommand,
  buildImageInfoCommand,
  configFilesInclude,
  envFilesFor,
  evaluateHealthPoll,
  holdTagFor,
  isDigestPinned,
  localDigestFor,
  parseContainerIdentities,
  parseHealthSample,
  parseImageInfo,
  parseImageRef,
  probeBindingWarning,
  watchtowerManages,
  type ContainerIdentity,
  type HealthSample,
} from "./dockerUpdate.js";

export const ComposeUpdateInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  composePath: z
    .string()
    .min(1)
    .describe("Absolute path (inside the LXC) of the compose file that created the service — compose_discover gives it"),
  service: z.string().min(1).describe("The ONE compose service to update"),
  healthTimeoutSec: z.number().int().positive().optional().describe("Health-gate deadline in seconds (default 120)"),
  stableSec: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Without a HEALTHCHECK: seconds the container must stay running with no restarts (default 20)"),
  probe: z
    .object({
      url: z.string().min(1).describe("http(s) URL curled from inside the LXC after the container is healthy"),
      expectStatus: z.number().int().optional().describe("Exact status required; default any 2xx/3xx"),
    })
    .optional()
    .describe("Optional extra health condition: an HTTP check from inside the LXC"),
  allowWatchtowerManaged: z
    .boolean()
    .default(false)
    .describe("Proceed even though a running Watchtower also manages this container (it may undo a rollback)"),
  confirm: z.boolean().default(false).describe("Must be true. The service's container is recreated."),
  overrideCircuitBreaker: z
    .boolean()
    .optional()
    .describe("ADR-021: bypass the rollback circuit breaker for this one call (deliberate, audited)."),
});

export type ComposeUpdateInput = z.infer<typeof ComposeUpdateInputSchema>;

export type ComposeUpdateOutcome =
  | "already-current"
  | "updated"
  | "rolled-back"
  | "rollback-ok-probe-failed"
  | "rollback-failed"
  | "failed-needs-file-revert"
  | "pull-failed";

export interface HealthReport {
  mode: "healthcheck" | "stability";
  status: "pass" | "fail";
  elapsedMs: number;
  detail: string;
  /** ADR-027: the container gate passed and only the caller's HTTP probe failed. */
  probeOnly?: boolean;
}

export interface ComposeUpdateResult {
  vmid: number;
  service: string;
  project: string;
  container: string;
  outcome: ComposeUpdateOutcome;
  ref: string;
  oldImageId: string;
  newImageId: string | null;
  oldRepoDigest: string | null;
  currentVersion: string | null;
  newVersion: string | null;
  holdTag: string;
  health?: HealthReport;
  rollbackHealth?: HealthReport;
  steps: Array<{ step: string; exitCode: number | null; stderr?: string }>;
  /** ADR-027: --env-file paths passed to compose (from the environment_file label); never their contents. */
  envFiles: string[];
  warnings: string[];
  nextSteps?: string[];
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function composeUpdateHandler(
  input: ComposeUpdateInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config,
  breaker?: RollbackBreaker,
  sleep: Sleep = defaultSleep,
  now: () => number = Date.now
): Promise<ComposeUpdateResult> {
  // ---- Preconditions: nothing changes until all of these pass. ----
  if (!input.confirm) {
    throw new Error(
      `Refusing compose_update of '${input.service}' in ${input.vmid} without confirm: true. The service's ` +
        "container is recreated (brief outage). Re-issue with confirm: true."
    );
  }
  const pathCheck = validatePath(input.composePath, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathCheck.valid) throw new Error(`Invalid compose file path: ${pathCheck.reason}`);
  assertComposeService(input.service);
  if (input.probe) {
    const u = parseProbeUrl(input.probe.url);
    if (!u.ok) throw new Error(`Invalid probe url: ${u.error}`);
  }

  const d = cfg.docker;
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const healthTimeoutMs =
    Math.min(input.healthTimeoutSec ?? d?.updateHealthTimeoutSec ?? 120, d?.updateHealthTimeoutMaxSec ?? 600) * 1000;
  const stableMs = (input.stableSec ?? d?.updateStableSec ?? 20) * 1000;
  const pollMs = d?.updatePollIntervalMs ?? 2_000;
  const pct = (cmd: string): string => buildPctExecCommand(input.vmid, cmd);
  const steps: ComposeUpdateResult["steps"] = [];
  const warnings: string[] = [];
  const run = async (step: string, cmd: string, ms = timeoutMs): Promise<ExecResult> => {
    const r = await transport.exec(pct(cmd), ms);
    steps.push({ step, exitCode: r.exitCode, ...(r.exitCode !== 0 && { stderr: r.stderr.trim().slice(0, 500) }) });
    return r;
  };

  // ADR-021 — refuse a service that has already auto-rolled-back `limit` times in
  // the window (keep-pulling-the-same-broken-image loop). Peek: a call that never
  // rolls back must not consume a slot.
  const breakerKey = rollbackTargetKey({ kind: "compose", vmid: input.vmid, remotePath: input.service });
  if (breaker && !input.overrideCircuitBreaker) {
    const verdict = breaker.peek(breakerKey, now());
    if (verdict.tripped) {
      const { message, circuitBreaker } = breakerRefusal(breakerKey, verdict);
      await audit.append(
        buildAuditRecord({
          tool: "compose_update",
          host: cfg.ssh.host,
          vmid: input.vmid,
          path: input.composePath,
          refused: true,
          circuitBreaker,
          note: message,
        })
      );
      throw new Error(message);
    }
  }

  // The service's running container, created from THIS compose file.
  const scan = await transport.exec(pct(buildContainerIdentityCommand()), timeoutMs);
  if (scan.exitCode !== 0) {
    throw new Error(`docker inspect failed on CT${input.vmid} (exit ${scan.exitCode}): ${scan.stderr.trim()}`);
  }
  const running = parseContainerIdentities(scan.stdout);
  const forService = running.filter((c) => c.composeService === input.service);
  const matches = forService.filter((c) => configFilesInclude(c.composeConfigFiles, input.composePath));
  if (matches.length === 0) {
    const elsewhere = forService.map((c) => `${c.name} (${c.composeConfigFiles || "no config_files label"})`);
    throw new Error(
      `No running container for service '${input.service}' was created from ${input.composePath}.` +
        (elsewhere.length > 0 ? ` Same service name found from other files: ${elsewhere.join(", ")}.` : "") +
        " compose_update needs a running container to roll back to; use compose_discover for the right path, " +
        "or compose_redeploy for a first deploy."
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Service '${input.service}' has ${matches.length} running containers (${matches.map((c) => c.name).join(", ")}); ` +
        "scaled services are out of scope for compose_update v1."
    );
  }
  const target = matches[0]!;
  const project = target.composeProject;
  assertComposeProject(project);

  // ADR-027 — the project's recorded --env-file paths (environment_file label).
  // Without them compose only sees a sibling .env, and a project started with
  // `--env-file elsewhere` fails `config` on missing variables. Paths only: the
  // files are read by compose on the node, never by the server.
  const env = envFilesFor(target);
  for (const r of env.rejected) {
    warnings.push(`Ignored environment_file entry ${JSON.stringify(r)} (not a plain absolute path).`);
  }
  const envFiles = env.files;

  // Resolved compose model (interpolation + the env files applied, as compose sees it).
  const compose = (args: string): string => buildComposeCommand(input.composePath, project, args, envFiles);
  const cfgRes = await transport.exec(pct(compose("config --format json")), timeoutMs);
  if (cfgRes.exitCode !== 0) {
    throw new Error(`docker compose config failed (exit ${cfgRes.exitCode}): ${cfgRes.stderr.trim().slice(0, 500)}`);
  }
  let model;
  try {
    model = parseCompose(cfgRes.stdout);
  } catch (err) {
    if (err instanceof ComposeParseError) throw new Error(`Could not read the resolved compose model: ${err.message}`);
    throw err;
  }
  const svc = model.services.find((s) => s.name === input.service);
  if (!svc) throw new Error(`Service '${input.service}' is not defined in ${input.composePath}.`);
  if (svc.rawKeys.includes("build")) {
    throw new Error(`Refusing compose_update of '${input.service}': it has a build: section (built locally, nothing to pull).`);
  }
  if (!svc.image) throw new Error(`Refusing compose_update of '${input.service}': no image: in the compose file.`);
  const fileRef = svc.image;
  assertImageRef(fileRef);
  if (isDigestPinned(fileRef)) {
    throw new Error(
      `Refusing compose_update of '${input.service}': ${fileRef} is digest-pinned, so there is nothing to pull. ` +
        "Change the pin by editing the compose file (pct_edit_file / docker_edit_file), then compose_redeploy."
    );
  }
  const provider = groupByNetns(model).find((g) => g.provider === input.service && g.dependents.length > 0);
  if (provider) {
    throw new Error(
      `Refusing compose_update of '${input.service}': it provides the network namespace for ` +
        `${provider.dependents.join(", ")}. Recreating a netns provider in place deadlocks (ADR-012); ` +
        "do a full down/up of the stack instead (compose_redeploy after stopping the dependents)."
    );
  }

  const watchtower = await loadWatchtower(transport, input.vmid, running, timeoutMs);
  if (watchtowerManages(watchtower, target)) {
    const why =
      `Watchtower (${watchtower!.container}) also updates '${target.name}'` +
      (watchtower!.cleanup ? " and deletes replaced images (CLEANUP)" : "") +
      "; it can re-pull over a rollback.";
    if (!input.allowWatchtowerManaged) {
      throw new Error(
        `Refusing compose_update of '${input.service}': ${why} Remove the com.centurylinklabs.watchtower.enable ` +
          "label from the service to hand it to compose_update, or re-issue with allowWatchtowerManaged: true."
      );
    }
    warnings.push(why + " Proceeding because allowWatchtowerManaged: true.");
  }

  // ADR-027 — sanity-check the caller's probe against the RUNNING image before
  // anything changes. A probe that already fails here cannot tell a bad update
  // from a bad URL (ops finding 2026-10-17: searxng's port was published on
  // 10.0.0.52 only, the probe targeted 127.0.0.1, and a healthy service was rolled
  // back and reported rollback-failed). The binding check explains the likely cause.
  if (input.probe) {
    const holder = netnsHolder(target, running);
    const bindingWarning = probeBindingWarning(input.probe.url, holder);
    const baseline = await runProbe(input.probe.url);
    if (!baseline.ok) {
      throw new Error(
        `Refusing compose_update of '${input.service}': the probe ${input.probe.url} already fails against the ` +
          `running image (${baseline.detail}), so it cannot judge the update. ` +
          (bindingWarning ? `Likely cause: ${bindingWarning} ` : "") +
          "Fix the probe URL, or drop probe to rely on the HEALTHCHECK/stability gate. Nothing was changed."
      );
    }
    if (bindingWarning) warnings.push(bindingWarning);
  }

  // §4 — has the compose file's ref moved away from what the container was created from?
  const runRef = parseImageRef(target.ref);
  const newRef = parseImageRef(fileRef);
  const refMismatch = runRef.name !== newRef.name || (runRef.tag ?? "latest") !== (newRef.tag ?? "latest");

  // ---- Record. ----
  const oldImageId = target.imageId;
  if (!/^sha256:[0-9a-f]{64}$/.test(oldImageId)) {
    throw new Error(`Unexpected image id for ${target.name}: ${JSON.stringify(oldImageId)}; refusing to continue.`);
  }
  const infoRes = await transport.exec(pct(buildImageInfoCommand([oldImageId])), timeoutMs);
  const oldInfo = parseImageInfo(infoRes.stdout).get(oldImageId);
  const oldRepoDigest = localDigestFor(target.ref, oldInfo?.repoDigests ?? []);
  const holdTag = holdTagFor(/^sha256:/.test(target.ref) ? fileRef : target.ref, input.service);
  assertImageRef(holdTag);

  const base = {
    vmid: input.vmid,
    service: input.service,
    project,
    container: target.name,
    ref: fileRef,
    oldImageId,
    oldRepoDigest,
    currentVersion: oldInfo?.version ?? null,
    holdTag,
    steps,
    envFiles,
    warnings,
  };

  const finish = async (
    result: ComposeUpdateResult,
    extra: { failed?: boolean; isRevertible?: boolean } = {}
  ): Promise<ComposeUpdateResult> => {
    await audit.append(
      buildAuditRecord({
        tool: "compose_update",
        host: cfg.ssh.host,
        vmid: input.vmid,
        container: target.name,
        containerId: target.id,
        path: input.composePath,
        cmd: `docker compose -p ${project} pull ${input.service} && up -d --no-deps ${input.service}`,
        hashScope: "unknown",
        exitCode: steps.length > 0 ? steps[steps.length - 1]!.exitCode : 0,
        confirmGated: true,
        isLargeChange: true,
        ...extra,
        ...(input.overrideCircuitBreaker && { circuitBreakerOverridden: true }),
        note:
          `compose_update ${input.service} (CT${input.vmid}, project ${project}): ${result.outcome}; ` +
          `${fileRef} ${oldImageId} -> ${result.newImageId ?? "none"}` +
          (result.currentVersion || result.newVersion
            ? ` (version ${result.currentVersion ?? "?"} -> ${result.newVersion ?? "?"})`
            : "") +
          `; hold ${holdTag}`,
      })
    );
    return result;
  };

  // ---- Hold the old image under the server-owned tag (moves any previous hold: retention 1/service). ----
  const holdRes = await run("hold", `docker tag ${oldImageId} ${holdTag}`);
  if (holdRes.exitCode !== 0) {
    throw new Error(
      `Could not pin the running image under ${holdTag} (exit ${holdRes.exitCode}): ${holdRes.stderr.trim()}. ` +
        "Nothing was pulled or recreated."
    );
  }

  // ---- Pull. ----
  const pullRes = await run("pull", compose(`pull ${input.service}`), d?.updatePullTimeoutMs ?? 600_000);
  if (pullRes.exitCode !== 0) {
    return finish({ ...base, outcome: "pull-failed", newImageId: null, newVersion: null }, { failed: true });
  }
  const idRes = await run("resolve", `docker image inspect --format '{{.Id}}' ${fileRef}`);
  const newImageId = idRes.exitCode === 0 ? idRes.stdout.trim() : null;
  if (!newImageId) {
    return finish({ ...base, outcome: "pull-failed", newImageId: null, newVersion: null }, { failed: true });
  }
  const newInfoRes = await transport.exec(pct(buildImageInfoCommand([newImageId])), timeoutMs);
  const newVersion = parseImageInfo(newInfoRes.stdout).get(newImageId)?.version ?? null;
  if (newImageId === oldImageId && !refMismatch) {
    return finish({ ...base, outcome: "already-current", newImageId, newVersion });
  }

  // ---- Recreate + health gate. ----
  const recreateMs = d?.updateRecreateTimeoutMs ?? 180_000;
  const upRes = await run("recreate", compose(`up -d --no-deps ${input.service}`), recreateMs);
  const health =
    upRes.exitCode === 0
      ? await healthGate(target.name, newImageId)
      : { mode: "stability" as const, status: "fail" as const, elapsedMs: 0, detail: "up -d failed" };
  if (health.status === "pass") {
    return finish({ ...base, outcome: "updated", newImageId, newVersion, health }, { isRevertible: true });
  }

  // ---- Failure paths. Each counts toward the breaker except a probe-only miss on both images. ----
  if (refMismatch) {
    breaker?.check(breakerKey, now());
    return finish(
      {
        ...base,
        outcome: "failed-needs-file-revert",
        newImageId,
        newVersion,
        health,
        nextSteps: [
          `The compose file names ${fileRef} but the container was created from ${target.ref}, so the old image ` +
            "cannot be re-tagged under the new ref. Restore the file and redeploy:",
          `revert_file { vmid: ${input.vmid}, path: "${input.composePath}" } (or the docker target for this file)`,
          `compose_update { vmid: ${input.vmid}, composePath: "${input.composePath}", service: "${input.service}", confirm: true }`,
          `The previous image is held as ${holdTag}.`,
        ],
      },
      { failed: true }
    );
  }
  const retag = await run("rollback-retag", `docker tag ${holdTag} ${fileRef}`);
  let rollbackHealth: HealthReport;
  if (retag.exitCode !== 0) {
    rollbackHealth = { mode: "stability", status: "fail", elapsedMs: 0, detail: `hold tag ${holdTag} unusable: ${retag.stderr.trim()}` };
  } else {
    const reUp = await run("rollback-recreate", compose(`up -d --no-deps --pull never ${input.service}`), recreateMs);
    rollbackHealth =
      reUp.exitCode === 0
        ? await healthGate(target.name, oldImageId)
        : { mode: "stability", status: "fail", elapsedMs: 0, detail: "rollback up -d failed" };
  }
  const rolledBack = rollbackHealth.status === "pass";
  // ADR-027 — both images passed the container gate and failed only the caller's
  // probe: the previous image is running and healthy by every measure the server
  // owns, so this is a rollback that worked plus a probe that is probably wrong,
  // not a rollback failure — and not a thrash loop for the breaker to count.
  const probeOnlyBoth = health.probeOnly === true && rollbackHealth.probeOnly === true;
  if (!probeOnlyBoth) breaker?.check(breakerKey, now());
  if (rolledBack || probeOnlyBoth) {
    warnings.push(
      `Local tag ${fileRef} now points at the previous image again (it disagrees with the registry until the ` +
        "next deliberate update). Rollback restores the image, not volume data a new version may have migrated."
    );
  }
  if (probeOnlyBoth) {
    warnings.push(
      `The probe ${input.probe!.url} failed against both images while both passed the ${health.mode} gate, so the ` +
        "probe URL may be wrong. The previous image is running. The new image may have been fine: fix the probe and re-run."
    );
  }
  const outcome: ComposeUpdateOutcome = rolledBack ? "rolled-back" : probeOnlyBoth ? "rollback-ok-probe-failed" : "rollback-failed";
  return finish(
    { ...base, outcome, newImageId, newVersion, health, rollbackHealth },
    outcome === "rollback-failed" ? { failed: true } : {}
  );

  async function runProbe(url: string): Promise<{ ok: boolean; status: number; detail: string }> {
    const secs = Math.max(1, Math.min(30, timeoutMsToSecs(timeoutMs)));
    const pr = await transport.exec(pct(buildCurlProbeCommand(url, secs)), timeoutMs);
    const out = parseCurlProbeOutput(pr.stdout);
    const ok = pr.exitCode === 0 && evaluateHttpOk(out.status, input.probe?.expectStatus);
    return { ok, status: out.status, detail: out.status ? `HTTP ${out.status}` : `curl exit ${pr.exitCode}` };
  }

  async function healthGate(container: string, expectImageId: string): Promise<HealthReport> {
    const start = now();
    const samples: HealthSample[] = [];
    let verdict = evaluateHealthPoll(samples, stableMs);
    for (;;) {
      const r = await transport.exec(pct(buildHealthSampleCommand(container)), timeoutMs);
      const s = r.exitCode === 0 ? parseHealthSample(r.stdout, now() - start) : null;
      if (s) {
        if (samples.length === 0 && s.imageId !== expectImageId) {
          warnings.push(`${container} is running image ${s.imageId}, expected ${expectImageId}.`);
        }
        samples.push(s);
        verdict = evaluateHealthPoll(samples, stableMs);
      }
      if (verdict.state !== "pending") break;
      if (now() - start >= healthTimeoutMs) {
        return { mode: verdict.mode, status: "fail", elapsedMs: now() - start, detail: `timed out: ${verdict.detail}` };
      }
      await sleep(pollMs);
    }
    if (verdict.state === "pass" && input.probe) {
      const pr = await runProbe(input.probe.url);
      if (!pr.ok) {
        return {
          mode: verdict.mode,
          status: "fail",
          elapsedMs: now() - start,
          detail: `${verdict.detail}, but probe ${input.probe.url} returned ${pr.status || pr.detail}`,
          probeOnly: true,
        };
      }
      return { mode: verdict.mode, status: "pass", elapsedMs: now() - start, detail: `${verdict.detail}; probe ${pr.status}` };
    }
    return { mode: verdict.mode, status: verdict.state === "pass" ? "pass" : "fail", elapsedMs: now() - start, detail: verdict.detail };
  }
}

/**
 * The container whose published bindings a probe would hit: the target itself, or
 * — when it joins another container's network namespace (`container:<id>`) — that
 * provider. An unresolvable provider falls back to the target (the binding check
 * then declines to judge, see `probeBindingWarning`).
 */
function netnsHolder(target: ContainerIdentity, running: ContainerIdentity[]): ContainerIdentity {
  const m = /^container:(.+)$/.exec(target.networkMode);
  if (!m) return target;
  const ref = m[1]!;
  return running.find((c) => c.id === ref || c.name === ref || (ref.length >= 12 && c.id.startsWith(ref))) ?? target;
}
