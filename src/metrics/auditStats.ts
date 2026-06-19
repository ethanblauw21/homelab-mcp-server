/**
 * ADR-015 §1 — audit-derived statistics (pure). Aggregates `AuditLog.readAll()`
 * over a time window into the rates and counts the flat `summarizeAuditRecords`
 * (ADR-005) does not produce: a throughput time series, change-weight rates, gate
 * activity, and the *silent-failure* signals the audit record already carries but
 * nothing surfaces in aggregate (`historyCommitted === false`, `timedOut`, signal
 * kills) plus the `hashScope === "unknown"` exec rate (the ADR-009 drift bridge).
 *
 * Pure over `AuditRecord[]`: no I/O, no `Date.now()` — ISO timestamps compare and
 * bucket lexicographically (the same trick `filterAuditRecords` relies on), so the
 * caller supplies the window and the function is deterministic under test.
 */
import type { AuditRecord, AuditTool } from "../audit/record.js";
import { filterAuditRecords } from "../tools/queryAudit.js";

export type AuditBucket = "hour" | "day";

export interface AuditStatsOptions {
  /** ISO bounds, inclusive; either may be omitted (reuses `filterAuditRecords`). */
  window?: { since?: string; until?: string };
  /** Time-series granularity. Day buckets on the first 10 ISO chars, hour on 13. */
  bucket?: AuditBucket;
}

export type ToolFamily = "write" | "exec" | "read" | "other";

export interface ThroughputPoint {
  /** "YYYY-MM-DD" (day) or "YYYY-MM-DDTHH" (hour). */
  bucket: string;
  total: number;
  write: number;
  exec: number;
  read: number;
  other: number;
}

export interface AuditStats {
  total: number;
  windowSince: string | null;
  windowUntil: string | null;
  bucket: AuditBucket;
  /** Chronological (oldest bucket first). */
  throughput: ThroughputPoint[];
  byTool: Record<string, number>;
  family: Record<ToolFamily, number>;
  largeChangeCount: number;
  heavyCount: number;
  confirmGatedCount: number;
  rootTierCount: number;
  // Silent-failure signals (ADR-006 / ADR-004 §3).
  historyMissCount: number;
  /** Records where `historyCommitted` is a boolean (the rate's denominator). */
  historyEligibleCount: number;
  historyMissRate: number;
  timedOutCount: number;
  /** ADR-004 §3 — `exitCode === null` (signal kill, never coerced to 0). */
  signalKillCount: number;
  // ADR-009 unexplained-drift bridge.
  unknownScopeCount: number;
  execTotal: number;
  unknownScopeRate: number;
}

const WRITE_FAMILY: ReadonlySet<AuditTool> = new Set<AuditTool>([
  "write_file",
  "edit_file",
  "pct_write_file",
  "pct_edit_file",
  "qm_write_file",
  "qm_edit_file",
  "docker_write_file",
  "docker_edit_file",
  "revert_file",
]);

const EXEC_FAMILY: ReadonlySet<AuditTool> = new Set<AuditTool>([
  "execute",
  "pct_exec",
  "qm_exec",
  "docker_exec",
]);

const READ_FAMILY: ReadonlySet<AuditTool> = new Set<AuditTool>([
  "read_file",
  "pct_read_file",
  "qm_read_file",
  "docker_read_file",
  "list_directory",
]);

/** Classify a tool into the throughput families. Everything else is "other". */
export function toolFamily(tool: AuditTool): ToolFamily {
  if (WRITE_FAMILY.has(tool)) return "write";
  if (EXEC_FAMILY.has(tool)) return "exec";
  if (READ_FAMILY.has(tool)) return "read";
  return "other";
}

function bucketKey(ts: string, bucket: AuditBucket): string {
  // ISO 8601 is fixed-width through the hour, so a prefix slice IS the bucket.
  return bucket === "hour" ? ts.slice(0, 13) : ts.slice(0, 10);
}

export function computeAuditStats(records: AuditRecord[], opts: AuditStatsOptions = {}): AuditStats {
  const bucket: AuditBucket = opts.bucket ?? "day";
  const filtered = filterAuditRecords(records, {
    since: opts.window?.since,
    until: opts.window?.until,
  });

  const byTool: Record<string, number> = {};
  const family: Record<ToolFamily, number> = { write: 0, exec: 0, read: 0, other: 0 };
  const buckets = new Map<string, ThroughputPoint>();

  let largeChangeCount = 0;
  let heavyCount = 0;
  let confirmGatedCount = 0;
  let rootTierCount = 0;
  let historyMissCount = 0;
  let historyEligibleCount = 0;
  let timedOutCount = 0;
  let signalKillCount = 0;
  let unknownScopeCount = 0;
  let execTotal = 0;

  for (const r of filtered) {
    byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
    const fam = toolFamily(r.tool);
    family[fam] += 1;

    const key = bucketKey(r.ts, bucket);
    let point = buckets.get(key);
    if (!point) {
      point = { bucket: key, total: 0, write: 0, exec: 0, read: 0, other: 0 };
      buckets.set(key, point);
    }
    point.total += 1;
    point[fam] += 1;

    if (r.isLargeChange === true) largeChangeCount += 1;
    if (r.isHeavy === true) heavyCount += 1;
    if (r.confirmGated === true) confirmGatedCount += 1;
    if (r.rootTier === true) rootTierCount += 1;
    if (r.historyCommitted !== undefined) {
      historyEligibleCount += 1;
      if (r.historyCommitted === false) historyMissCount += 1;
    }
    if (r.timedOut === true) timedOutCount += 1;
    if (r.exitCode === null) signalKillCount += 1;
    if (fam === "exec") {
      execTotal += 1;
      if (r.hashScope === "unknown") unknownScopeCount += 1;
    }
  }

  const throughput = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    total: filtered.length,
    windowSince: opts.window?.since ?? null,
    windowUntil: opts.window?.until ?? null,
    bucket,
    throughput,
    byTool,
    family,
    largeChangeCount,
    heavyCount,
    confirmGatedCount,
    rootTierCount,
    historyMissCount,
    historyEligibleCount,
    historyMissRate: historyEligibleCount === 0 ? 0 : historyMissCount / historyEligibleCount,
    timedOutCount,
    signalKillCount,
    unknownScopeCount,
    execTotal,
    unknownScopeRate: execTotal === 0 ? 0 : unknownScopeCount / execTotal,
  };
}
