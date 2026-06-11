import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import type { ConfigHistory } from "../history/configHistory.js";
import { buildAuditRecord } from "../audit/record.js";
import { shQuote, parsePctStatus, buildPctStatusCommand, pullContainerFile } from "./pctFiles.js";
import { parsePctList } from "./pctHelpers.js";
import {
  classifyEnumeration,
  diffAgainstMirror,
  parseFindEnumeration,
  parseSha256Sum,
} from "../history/sweepPlanner.js";
import {
  manifestKeyForSweepTarget,
  repoPrefixForSweepTarget,
  mirrorRelPathForSweepFile,
} from "../history/paths.js";
import { buildStatBatchCommand, parseStatBatch, type Manifest } from "../history/manifest.js";
import { sweepCommitMessage, sweepTargetsSummary } from "../history/commitMessage.js";

/**
 * `config_sweep` (ADR-006 §3) — capture path B. The file-level counterpart of the
 * census drift diff: enumerate a watched set, **hash-compare before fetching** so
 * only changed/new files move, refresh the perms manifest, and make **one commit
 * per sweep**. It sees everything done out-of-band (hand edits, package upgrades)
 * that the audit log and blob backups never witness.
 *
 * Per-target work is error-isolated (a failed target becomes a recorded error,
 * never an abort) mirroring the census/health_check pattern. Stopped containers
 * are skipped with a structured note (A3.1 — `pct pull` needs a running guest).
 */

export const SweepTargetSchema = z.union([
  z.literal("host"),
  z.object({ vmid: z.number().int().positive() }),
]);

export const ConfigSweepInputSchema = z.object({
  targets: z
    .array(SweepTargetSchema)
    .optional()
    .describe(
      'Targets to sweep. Defaults to "host" + all running containers. ' +
        'Each entry is "host" or { vmid }. Stopped containers are skipped with a note.'
    ),
});

export type ConfigSweepInput = z.infer<typeof ConfigSweepInputSchema>;
export type SweepTarget = "host" | { vmid: number };

export interface SweepTargetResult {
  target: string;
  added: number;
  changed: number;
  deleted: number;
  unchanged: number;
  excluded: number;
  skippedOversize: number;
  skipped?: string; // set when the whole target was skipped (e.g. not running)
  error?: string;
}

export interface ConfigSweepResult {
  auditId: string;
  historyCommitted: boolean;
  targets: SweepTargetResult[];
}

// ---------------------------------------------------------------------------
// Remote command builders (plain shell strings; the transport adds the timeout
// + bash -c wrapper, as for every other tool).
// ---------------------------------------------------------------------------

/** `find <paths> -type f -printf '%s\t%p\n'` — tab-separated size/path. */
export function buildFindEnumCommand(watchPaths: string[], vmid?: number): string {
  const paths = watchPaths.map(shQuote).join(" ");
  const inner = `find ${paths} -type f -printf '%s\\t%p\\n' 2>/dev/null`;
  return vmid === undefined ? inner : `pct exec ${vmid} -- sh -c ${shQuote(inner)}`;
}

/** `sha256sum -- <paths>` over the candidate set. Null when there is nothing to hash. */
export function buildSha256Command(paths: string[], vmid?: number): string | null {
  if (paths.length === 0) return null;
  const quoted = paths.map(shQuote).join(" ");
  const inner = `sha256sum -- ${quoted}`;
  return vmid === undefined ? inner : `pct exec ${vmid} -- sh -c ${shQuote(inner)}`;
}

// ---------------------------------------------------------------------------

function targetLabel(t: SweepTarget): string {
  return t === "host" ? "host" : `pct:${t.vmid}`;
}

async function resolveTargets(
  input: ConfigSweepInput,
  transport: SshTransport,
  timeoutMs: number
): Promise<SweepTarget[]> {
  if (input.targets && input.targets.length > 0) return input.targets as SweepTarget[];
  // Default: host + every RUNNING container (stopped guests can't be pct pull'd).
  const targets: SweepTarget[] = ["host"];
  const res = await transport.exec("pct list", timeoutMs);
  if (res.exitCode === 0) {
    for (const c of parsePctList(res.stdout)) {
      if (c.status === "running") targets.push({ vmid: c.vmid });
    }
  }
  return targets;
}

async function sweepOneTarget(
  target: SweepTarget,
  transport: SshTransport,
  history: ConfigHistory,
  cfg: Config
): Promise<SweepTargetResult> {
  const label = targetLabel(target);
  const base: SweepTargetResult = {
    target: label,
    added: 0,
    changed: 0,
    deleted: 0,
    unchanged: 0,
    excluded: 0,
    skippedOversize: 0,
  };
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const vmid = target === "host" ? undefined : target.vmid;
  const watchPaths = target === "host" ? cfg.history.hostWatchPaths : cfg.history.containerWatchPaths;

  // A3.1: a stopped container is skipped with a structured note, never an abort.
  if (vmid !== undefined) {
    const st = await transport.exec(buildPctStatusCommand(vmid), timeoutMs);
    if (st.exitCode !== 0 || parsePctStatus(st.stdout) !== "running") {
      return { ...base, skipped: "container not running" };
    }
  }

  // 1. Enumerate (size + path) under the watched set.
  const enumRes = await transport.exec(buildFindEnumCommand(watchPaths, vmid), timeoutMs);
  if (enumRes.exitCode !== 0) {
    return { ...base, error: `enumerate failed: ${enumRes.stderr.trim() || "exit " + enumRes.exitCode}` };
  }
  const enumerated = parseFindEnumeration(enumRes.stdout);
  const allRemotePaths = enumerated.map((e) => e.path);

  // 2. Apply exclude patterns + size cap (pure), then hash-compare.
  const { candidates, excluded, skippedOversize } = classifyEnumeration({
    enumerated,
    excludePatterns: cfg.history.excludePatterns,
    sizeCapBytes: cfg.history.sweepFileSizeCapBytes,
  });

  let remoteHashes = new Map<string, string>();
  const hashCmd = buildSha256Command(candidates, vmid);
  if (hashCmd) {
    const hashRes = await transport.exec(hashCmd, timeoutMs);
    if (hashRes.exitCode !== 0 && hashRes.stdout.trim() === "") {
      return { ...base, error: `hash failed: ${hashRes.stderr.trim() || "exit " + hashRes.exitCode}` };
    }
    // sha256sum may exit non-zero if a single file vanished mid-sweep; keep the
    // hashes it did produce.
    remoteHashes = parseSha256Sum(hashRes.stdout);
  }

  // 3. Compare against the mirror's recorded content.
  const prefix = repoPrefixForSweepTarget(target);
  const mirrorRel = history.listMirrorFiles(prefix);
  const mirrorPaths: string[] = [];
  const relByAbs = new Map<string, string>();
  for (const rel of mirrorRel) {
    // rel = "<prefix>/<abs-without-leading-slash>" → recover the absolute path.
    const abs = "/" + rel.slice(prefix.length + 1);
    mirrorPaths.push(abs);
    relByAbs.set(abs, rel);
  }
  const mirrorHashes = new Map<string, string>();
  for (const abs of mirrorPaths) {
    const h = history.hashMirrorFile(relByAbs.get(abs) as string);
    if (h) mirrorHashes.set(abs, h);
  }

  const { toFetch, unchanged, toDelete } = diffAgainstMirror({
    candidates,
    remoteHashes,
    mirrorHashes,
    mirrorPaths,
    allRemotePaths,
  });

  // 4. Fetch changed/new into the mirror.
  for (const abs of toFetch) {
    let content: Buffer | null;
    if (vmid === undefined) {
      try {
        content = await transport.readFile(abs);
      } catch {
        content = null; // vanished mid-sweep — skip
      }
    } else {
      content = (await pullContainerFile(transport, vmid, abs, cfg.container.nodeTempDir, timeoutMs)).content;
    }
    if (content === null) continue;
    history.writeMirrorContent(mirrorRelPathForSweepFile(target, abs), content);
    if (mirrorHashes.has(abs)) base.changed++;
    else base.added++;
  }

  // 5. Remove deletions from the mirror.
  for (const abs of toDelete) {
    history.removeMirrorContent(mirrorRelPathForSweepFile(target, abs));
  }

  // 6. Refresh the perms manifest for touched paths (+ note oversize skips).
  const manifestKey = manifestKeyForSweepTarget(target);
  const manifest = history.readManifest(manifestKey);
  if (toFetch.length > 0) {
    const statCmd = buildStatBatchCommand(toFetch, vmid);
    if (statCmd) {
      const statRes = await transport.exec(statCmd, timeoutMs);
      if (statRes.exitCode === 0 || statRes.stdout.trim() !== "") {
        const perms = parseStatBatch(statRes.stdout);
        for (const [p, meta] of Object.entries(perms)) manifest.files[p] = meta;
      }
    }
  }
  for (const abs of toDelete) delete manifest.files[abs];
  applyOversizeSkips(manifest, skippedOversize);
  history.writeManifest(manifestKey, manifest);

  base.unchanged = unchanged.length;
  base.deleted = toDelete.length;
  base.excluded = excluded.length;
  base.skippedOversize = skippedOversize.length;
  return base;
}

function applyOversizeSkips(
  manifest: Manifest,
  skipped: Array<{ path: string; sizeBytes: number }>
): void {
  if (skipped.length === 0) return;
  manifest.skipped = manifest.skipped ?? {};
  for (const s of skipped) manifest.skipped[s.path] = `oversize (${s.sizeBytes} bytes)`;
}

export async function configSweepHandler(
  input: ConfigSweepInput,
  transport: SshTransport,
  history: ConfigHistory,
  audit: AuditLog,
  cfg: Config
): Promise<ConfigSweepResult> {
  if (!history.enabled) {
    throw new Error("config history is disabled (git not available); config_sweep is unavailable");
  }

  const targets = await resolveTargets(input, transport, cfg.ssh.commandTimeoutMs);
  const results: SweepTargetResult[] = [];
  for (const t of targets) {
    try {
      results.push(await sweepOneTarget(t, transport, history, cfg));
    } catch (err) {
      results.push({
        target: targetLabel(t),
        added: 0,
        changed: 0,
        deleted: 0,
        unchanged: 0,
        excluded: 0,
        skippedOversize: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      added: acc.added + r.added,
      changed: acc.changed + r.changed,
      deleted: acc.deleted + r.deleted,
    }),
    { added: 0, changed: 0, deleted: 0 }
  );

  // One commit per sweep, then audit (the sweep itself is audited — §3.4). Build
  // the record first so its uuid can join the commit message.
  const summary = sweepTargetsSummary(targets);
  const record = buildAuditRecord({
    tool: "config_sweep",
    host: cfg.ssh.host,
    note: `sweep ${summary}: +${totals.added} ~${totals.changed} -${totals.deleted}`,
  });
  const historyCommitted = await history.commit(sweepCommitMessage(summary, record.id));
  record.historyCommitted = historyCommitted;
  await audit.append(record);

  return { auditId: record.id, historyCommitted, targets: results };
}
