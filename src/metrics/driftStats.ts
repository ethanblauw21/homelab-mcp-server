/**
 * ADR-015 §2 — drift-rate trend (pure). The single most security-meaningful number
 * this system produces: *unexplained leaves per verify run* — "how often is
 * something changing that the server did not do." Each `verify_integrity` already
 * persists its report to `SnapshotStore<drift>` (retained `driftRetentionCap`
 * deep); this walks that retained window and turns it into a per-run series plus a
 * headline trend, with zero node access and zero credentials.
 *
 * Pure: works over a structural view of the persisted snapshots (no import of the
 * integrity engine's I/O graph). `isSensitivePath` is reused so the sensitive-path
 * drift count matches the auto-accept policy's notion of "sensitive" exactly.
 *
 * Honest limit (stated in the panel note, not hidden): the series is *per-run*, not
 * per-unit-time — a report is persisted only when verify runs from an MCP session,
 * so gaps between verifies are invisible and the window is bounded by retention.
 */
import { isSensitivePath } from "../integrity/acceptPolicy.js";

/** The drifted-leaf fields this aggregator needs (a structural subset of `VerifyDriftLeaf`). */
export interface DriftLeafLike {
  path: string;
  nodePath: string;
  status: "explained" | "unexplained";
  l1: boolean;
  l2: boolean;
  l3: boolean;
}

/** Structural subset of the persisted `VerifyReport`. */
export interface DriftReportLike {
  level: string;
  scope: string;
  /** ADR-018 §1: the field that authoritatively says whether detection ran. */
  mode?: "seeded" | "compared";
  /** ADR-009 back-compat flag (pre-ADR-018 snapshots have only this). */
  baselineSeeded?: boolean;
  drift: DriftLeafLike[];
}

/** A persisted `StoredSnapshot<VerifyReport>` as seen on disk. */
export interface DriftSnapshotLike {
  savedAt: string;
  data: DriftReportLike;
}

export interface DriftRunPoint {
  savedAt: string;
  level: string;
  scope: string;
  /** A freshly-seeded baseline reports no drift by definition (not a clean run). */
  seeded: boolean;
  total: number;
  explained: number;
  unexplained: number;
  /** L1-only mtime touches (content identical at L2/L3) — zero-risk drift. */
  l1OnlyTouches: number;
  /** Drifted leaves under a sensitive path (`/etc/pve` & friends) — should be 0. */
  sensitive: number;
}

export type TrendDirection = "up" | "down" | "flat" | "insufficient-data";

export interface DriftTrend {
  /** Oldest → newest. */
  runs: DriftRunPoint[];
  totalRuns: number;
  /** Newest run's unexplained count (null when there are no runs). */
  latestUnexplained: number | null;
  /** The run before the newest (null when fewer than two runs). */
  previousUnexplained: number | null;
  trend: TrendDirection;
  maxUnexplained: number;
  /** Alarm flag: any retained run had drift under a sensitive path. */
  sensitiveEverNonZero: boolean;
}

function summarizeRun(snap: DriftSnapshotLike, sensitiveGlobs: string[]): DriftRunPoint {
  const rep = snap.data;
  const leaves = rep.drift ?? [];
  let explained = 0;
  let unexplained = 0;
  let l1OnlyTouches = 0;
  let sensitive = 0;
  for (const l of leaves) {
    if (l.status === "explained") explained += 1;
    else unexplained += 1;
    if (l.l1 && !l.l2 && !l.l3) l1OnlyTouches += 1;
    if (isSensitivePath(l.nodePath, sensitiveGlobs)) sensitive += 1;
  }
  return {
    savedAt: snap.savedAt,
    level: rep.level,
    scope: rep.scope,
    // ADR-018 §1: `mode` is authoritative; fall back to the pre-018 `baselineSeeded` flag.
    seeded: rep.mode === "seeded" || (rep.mode === undefined && rep.baselineSeeded === true),
    total: leaves.length,
    explained,
    unexplained,
    l1OnlyTouches,
    sensitive,
  };
}

/**
 * Build the per-run series + headline trend. `snapshots` may arrive in any order
 * (the store yields newest-first); they are sorted oldest→newest here so the curve
 * reads left-to-right. `trend` compares the two most recent runs.
 */
export function computeDriftTrend(
  snapshots: DriftSnapshotLike[],
  sensitiveGlobs: string[] = ["/etc/pve"]
): DriftTrend {
  const runs = [...snapshots]
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
    .map((s) => summarizeRun(s, sensitiveGlobs));

  // ADR-018 §1: a seeded run reports `unexplained: 0` because NO detection occurred —
  // it must not become a clean data point that falsely flattens the trend. The headline
  // numbers (latest/previous/max/trend) derive from the runs that actually *compared*;
  // the full `runs` series is still returned so the chart can mark the seeding points.
  const compared = runs.filter((r) => !r.seeded);
  const latest = compared.length ? compared[compared.length - 1].unexplained : null;
  const previous = compared.length >= 2 ? compared[compared.length - 2].unexplained : null;

  let trend: TrendDirection;
  if (latest === null || previous === null) {
    trend = "insufficient-data";
  } else if (latest > previous) {
    trend = "up";
  } else if (latest < previous) {
    trend = "down";
  } else {
    trend = "flat";
  }

  return {
    runs,
    totalRuns: runs.length,
    latestUnexplained: latest,
    previousUnexplained: previous,
    trend,
    maxUnexplained: compared.reduce((m, r) => Math.max(m, r.unexplained), 0),
    sensitiveEverNonZero: runs.some((r) => r.sensitive > 0),
  };
}
