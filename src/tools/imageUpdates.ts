/**
 * `image_updates` (ADR-025 §2) — read-only pending-update report for the Docker
 * containers in an LXC, so finding updates needs no shell. Not audited (like
 * docker_inspect / docker_stats).
 *
 * Two sources with different jobs:
 *   - **Registry** (`docker buildx imagetools inspect` in the LXC): the VERDICT.
 *     Compares the running image's index digest (RepoDigests) with the registry's
 *     index digest for the same ref — live, per-ref error-isolated.
 *   - **Diun** (its CLI against its local gRPC API, inside the Diun container):
 *     METADATA. Which version an update would install (OCI version labels) and,
 *     when watch_repo is on, the other tags that exist (for choosing a version).
 *     Diun runs on its own schedule with no "last checked" time, so it never
 *     decides freshness on its own in `auto` mode, and a disagreement with the
 *     registry is flagged (`diunStale`), never hidden.
 * Each container also reports `managedBy: "watchtower"` when a running Watchtower
 * would update it — compose_update refuses those by default (two updaters fight).
 */
import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { assertDockerName } from "./dockerHelpers.js";
import {
  assertImageRef,
  buildContainerIdentityCommand,
  buildDiunInspectCommand,
  buildDiunListCommand,
  buildEnvArgsCommand,
  buildImageInfoCommand,
  buildRemoteDigestCommand,
  classifyImageUpdate,
  DiunParseError,
  isDiunImage,
  isDigestPinned,
  isWatchtowerImage,
  localDigestFor,
  parseContainerIdentities,
  parseDiunImageInspect,
  parseDiunImageList,
  parseImageInfo,
  parseImageRef,
  parseRemoteDigests,
  parseWatchtowerConfig,
  pickEnv,
  rankCandidateTags,
  splitDiunInspectOutput,
  splitDiunListOutput,
  watchtowerManages,
  WATCHTOWER_ENV_KEYS,
  type ContainerIdentity,
  type DiunImage,
  type RemoteDigestResult,
  type TagCandidate,
  type UpdateStatus,
  type WatchtowerInfo,
} from "./dockerUpdate.js";

const DEFAULT_CANDIDATES = 10;

export const ImageUpdatesInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).optional().describe("Limit the report to one container (name)"),
  source: z
    .enum(["auto", "registry", "diun"])
    .default("auto")
    .describe(
      "auto (default): registry digest check decides, Diun adds version info + tag candidates. " +
        "registry: skip Diun. diun: Diun only, no registry traffic (verdicts can be up to one Diun schedule old)."
    ),
  candidates: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(`Max tag candidates per container from Diun (default ${DEFAULT_CANDIDATES}; needs Diun watch_repo)`),
});

export type ImageUpdatesInput = z.infer<typeof ImageUpdatesInputSchema>;

export interface ImageUpdateEntry {
  name: string;
  project?: string;
  service?: string;
  ref: string;
  imageId: string;
  localDigest: string | null;
  remoteDigest: string | null;
  status: UpdateStatus;
  reason?: string;
  verdictSource: "registry" | "diun" | "none";
  currentVersion: string | null;
  availableVersion: string | null;
  /** true: Diun's digest for this tag differs from the registry's (its version info is old). */
  diunStale?: boolean;
  diun: { tracked: boolean; watchRepo: boolean; reason?: string } | null;
  candidates?: TagCandidate[];
  managedBy: "watchtower" | null;
}

export interface ImageUpdatesResult {
  vmid: number;
  containers: ImageUpdateEntry[];
  summary: Record<UpdateStatus, number>;
  sources: {
    registry: { checked: boolean; refs: number };
    diun: {
      available: boolean;
      container?: string;
      vmid?: number;
      version?: string | null;
      schedule?: string | null;
      reason?: string;
      watchRepoEnabled?: boolean;
    };
  };
  watchtower: WatchtowerInfo | null;
  checkedAt: string;
  notes: string[];
}

/** Locate + read Watchtower's update-ownership settings (by env NAME only). Shared with compose_update. */
export async function loadWatchtower(
  transport: SshTransport,
  vmid: number,
  running: ContainerIdentity[],
  timeoutMs: number
): Promise<WatchtowerInfo | null> {
  const wt = running.find((c) => isWatchtowerImage(c.ref) && c.state === "running");
  if (!wt) return null;
  const r = await transport.exec(buildPctExecCommand(vmid, buildEnvArgsCommand(wt.name)), timeoutMs);
  if (r.exitCode !== 0) {
    // Fail toward caution: an unreadable Watchtower is treated as managing everything.
    return { container: wt.name, schedule: null, labelEnable: false, cleanup: true };
  }
  const { env, args } = pickEnv(r.stdout, WATCHTOWER_ENV_KEYS);
  return parseWatchtowerConfig(wt.name, env, args);
}

/** Diun location: `docker.diunContainer` ("<vmid>:<name>"), else a crazymax/diun container in the target LXC. */
export function resolveDiunLocation(
  configured: string | undefined,
  vmid: number,
  running: ContainerIdentity[]
): { vmid: number; container: string } | { error: string } {
  if (configured) {
    const m = configured.match(/^(\d+):(.+)$/);
    if (!m) return { error: `DOCKER_DIUN_CONTAINER must be "<vmid>:<name>", got ${JSON.stringify(configured)}` };
    return { vmid: parseInt(m[1]!, 10), container: m[2]! };
  }
  const d = running.find((c) => isDiunImage(c.ref) && c.state === "running");
  return d ? { vmid, container: d.name } : { error: "no running Diun container found in this LXC" };
}

export async function imageUpdatesHandler(
  input: ImageUpdatesInput,
  transport: SshTransport,
  cfg: Config,
  now: () => Date = () => new Date()
): Promise<ImageUpdatesResult> {
  if (input.container !== undefined) assertDockerName(input.container);
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const maxCandidates = cfg.docker?.imageUpdatesMaxCandidates ?? 25;
  const wantCandidates = Math.min(input.candidates ?? DEFAULT_CANDIDATES, maxCandidates);
  const notes: string[] = [];
  const pct = (cmd: string): string => buildPctExecCommand(input.vmid, cmd);

  // 1. Identity of every running container (Watchtower/Diun detection needs all of them).
  const scan = await transport.exec(pct(buildContainerIdentityCommand()), timeoutMs);
  if (scan.exitCode !== 0) {
    throw new Error(
      `docker inspect failed on CT${input.vmid} (exit ${scan.exitCode}): ` +
        `${scan.stderr.trim() || "is Docker installed and running in this container?"}`
    );
  }
  const running = parseContainerIdentities(scan.stdout);
  const inScope = input.container ? running.filter((c) => c.name === input.container) : running;
  if (input.container && inScope.length === 0) {
    throw new Error(`No running container named '${input.container}' in CT${input.vmid}.`);
  }

  // 2. RepoDigests + version labels of the images in scope (one batched round trip).
  const imageIds = [...new Set(inScope.map((c) => c.imageId))];
  const imgRes = await transport.exec(pct(buildImageInfoCommand(imageIds)), timeoutMs);
  // Degrade per image: a failing image must not blank the ones that inspected fine,
  // so stdout is parsed whatever the exit code and only the missing ids go unknown.
  const images = parseImageInfo(imgRes.stdout);
  let inspectError: string | null = null;
  if (imgRes.exitCode !== 0) {
    const missing = imageIds.filter((id) => !images.has(id));
    inspectError = imgRes.stderr.trim().split("\n")[0] || `exit ${imgRes.exitCode}`;
    notes.push(
      `docker image inspect failed (exit ${imgRes.exitCode}) for ${missing.length} of ${imageIds.length} image(s); ` +
        `those report unknown: ${inspectError}`
    );
  }

  // 3. Watchtower ownership.
  const watchtower = await loadWatchtower(transport, input.vmid, running, timeoutMs);

  // 4. Registry digests (the verdict), deduplicated per ref.
  const remote = new Map<string, RemoteDigestResult>();
  const checkable = new Set<string>();
  if (input.source !== "diun") {
    for (const c of inScope) {
      const local = localDigestFor(c.ref, images.get(c.imageId)?.repoDigests ?? []);
      if (!local || isDigestPinned(c.ref)) continue;
      try {
        assertImageRef(c.ref);
        checkable.add(c.ref);
      } catch {
        remote.set(c.ref, { ref: c.ref, digest: null, error: "ref failed the charset check; not queried" });
      }
    }
    if (checkable.size > 0) {
      const rr = await transport.exec(
        pct(buildRemoteDigestCommand([...checkable])),
        cfg.docker?.registryCheckTimeoutMs ?? 120_000
      );
      for (const [k, v] of parseRemoteDigests(rr.stdout)) remote.set(k, v);
      if (rr.timedOut) notes.push("Registry check timed out; unchecked refs report status unknown.");
    }
  }

  // 5. Diun metadata.
  const diunSource: ImageUpdatesResult["sources"]["diun"] = { available: false };
  let diunImages = new Map<string, DiunImage>();
  const diunInspect = new Map<string, ReturnType<typeof parseDiunImageInspect>>();
  if (input.source !== "registry") {
    const loc = resolveDiunLocation(cfg.docker?.diunContainer, input.vmid, running);
    if ("error" in loc) {
      diunSource.reason = loc.error;
    } else {
      try {
        assertDockerName(loc.container);
        const dpct = (cmd: string): string => buildPctExecCommand(loc.vmid, cmd);
        const lr = await transport.exec(dpct(buildDiunListCommand(loc.container)), timeoutMs);
        const { version, body } = splitDiunListOutput(lr.stdout);
        const list = parseDiunImageList(body);
        diunImages = new Map(list.map((i) => [i.name, i]));
        const er = await transport.exec(dpct(buildEnvArgsCommand(loc.container)), timeoutMs);
        const schedule = er.exitCode === 0 ? pickEnv(er.stdout, ["DIUN_WATCH_SCHEDULE"]).env.DIUN_WATCH_SCHEDULE : undefined;
        Object.assign(diunSource, {
          available: true,
          container: loc.container,
          vmid: loc.vmid,
          version,
          schedule: schedule ?? null,
          watchRepoEnabled: list.some((i) => i.manifestsCount > 1),
        });
        // Tag lists only exist where Diun tracks more than one manifest (watch_repo).
        if (wantCandidates > 0) {
          const multi = [
            ...new Set(
              inScope
                .map((c) => diunImages.get(parseImageRef(c.ref).name))
                .filter((i): i is DiunImage => !!i && i.manifestsCount > 1)
                .map((i) => i.name)
            ),
          ];
          if (multi.length > 0) {
            const ir = await transport.exec(dpct(buildDiunInspectCommand(loc.container, multi)), timeoutMs);
            for (const [name, text] of splitDiunInspectOutput(ir.stdout)) {
              try {
                diunInspect.set(name, parseDiunImageInspect(text));
              } catch {
                diunInspect.set(name, null);
              }
            }
          }
        }
      } catch (err) {
        diunImages = new Map();
        diunSource.available = false;
        diunSource.reason =
          err instanceof DiunParseError
            ? `unrecognized Diun output (${err.message}); parser is pinned to Diun v4.33.0`
            : (err as Error).message;
      }
    }
    if (diunSource.available && diunSource.watchRepoEnabled === false) {
      notes.push(
        "Diun tracks one tag per repo here (watch_repo off), so no tag candidates. To list versions to choose " +
          "from, add labels diun.watch_repo=true (+ diun.include_tags / diun.max_tags to bound it) to a service."
      );
    }
  }

  // 6. Assemble.
  const containers: ImageUpdateEntry[] = inScope.map((c) => {
    const img = images.get(c.imageId);
    const inspectFailed = !img && inspectError !== null;
    const parsed = parseImageRef(c.ref);
    const localDigest = localDigestFor(c.ref, img?.repoDigests ?? []);
    const r = remote.get(c.ref);
    const regVerdict = input.source === "diun" ? null : classifyImageUpdate({ ref: c.ref, localDigest, remote: r });

    const optedOut = c.diunLabel.toLowerCase() === "false";
    const d = optedOut ? undefined : diunImages.get(parsed.name);
    const tag = parsed.tag ?? "latest";
    const diunForTag = d?.latest && d.latest.tag === tag ? d.latest : null;
    const diunInfo: ImageUpdateEntry["diun"] = !diunSource.available
      ? null
      : {
          tracked: !!d,
          watchRepo: (d?.manifestsCount ?? 0) > 1 || c.diunWatchRepoLabel.toLowerCase() === "true",
          ...(!d && { reason: optedOut ? "opted out (diun.enable=false)" : "not tracked by Diun" }),
        };

    let status: UpdateStatus;
    let reason: string | undefined;
    let verdictSource: ImageUpdateEntry["verdictSource"];
    const diunVerdict = (): { status: UpdateStatus; reason?: string } | null => {
      if (isDigestPinned(c.ref)) return { status: "pinned" };
      if (!diunForTag || !localDigest) return null;
      return diunForTag.digest === localDigest ? { status: "up-to-date" } : { status: "update-available" };
    };
    const registryFailed = !!regVerdict && regVerdict.status === "unknown" && !!r && !r.digest;
    if (inspectFailed && !isDigestPinned(c.ref)) {
      status = "unknown";
      reason = `docker image inspect failed for this image: ${inspectError}`;
      verdictSource = "none";
    } else if (regVerdict && !(registryFailed && diunVerdict())) {
      ({ status, reason } = regVerdict);
      verdictSource = regVerdict.status === "unknown" ? "none" : "registry";
    } else {
      const dv = diunVerdict();
      if (dv) {
        ({ status, reason } = dv);
        verdictSource = "diun";
        reason = `from Diun (schedule ${diunSource.schedule ?? "unknown"}; may be stale)${registryFailed ? " — registry check failed" : ""}`;
      } else {
        status = isDigestPinned(c.ref) ? "pinned" : "unknown";
        reason = localDigest ? "Diun does not track this tag" : "local-image (no registry digest)";
        verdictSource = "none";
      }
    }

    const remoteDigest = r?.digest ?? null;
    const diunStale = diunForTag && remoteDigest ? diunForTag.digest !== remoteDigest : undefined;
    let candidates: TagCandidate[] | undefined;
    const inspected = d ? diunInspect.get(d.name) : undefined;
    if (inspected && wantCandidates > 0) {
      candidates = rankCandidateTags(parsed.tag, localDigest, inspected, wantCandidates);
    }

    return {
      name: c.name,
      ...(c.composeProject && { project: c.composeProject }),
      ...(c.composeService && { service: c.composeService }),
      ref: c.ref,
      imageId: c.imageId,
      localDigest,
      remoteDigest,
      status,
      ...(reason !== undefined && { reason }),
      verdictSource,
      currentVersion: img?.version ?? null,
      availableVersion: diunForTag?.version ?? null,
      ...(diunStale !== undefined && { diunStale }),
      diun: diunInfo,
      ...(candidates && { candidates }),
      managedBy: watchtowerManages(watchtower, c) ? "watchtower" : null,
    };
  });

  const summary: Record<UpdateStatus, number> = { "up-to-date": 0, "update-available": 0, pinned: 0, unknown: 0 };
  for (const e of containers) summary[e.status]++;
  if (watchtower) {
    notes.push(
      `Watchtower (${watchtower.container}) updates ${containers.filter((e) => e.managedBy).length} of these` +
        `${watchtower.cleanup ? " and deletes replaced images (CLEANUP)" : ""}; compose_update refuses those by default.`
    );
  }

  return {
    vmid: input.vmid,
    containers,
    summary,
    sources: { registry: { checked: input.source !== "diun", refs: checkable.size }, diun: diunSource },
    watchtower,
    checkedAt: now().toISOString(),
    notes,
  };
}
