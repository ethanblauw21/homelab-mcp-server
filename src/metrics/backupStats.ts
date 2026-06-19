/**
 * ADR-015 §3 — backup-store health (pure). Reports the health of the local
 * durability layer (ADR-003/014) against its configured caps: capacity vs.
 * `globalSizeCapBytes`, per-target version pressure, the delta-vs-snapshot kind
 * mix, and — the headline signal — **re-anchor frequency** (ADR-014 §2). A spike in
 * re-anchors means something is editing managed files behind the server's back
 * (the exact failure mode ADR-014 exists for), now trended rather than discovered
 * one file at a time.
 *
 * Pure over a small `BackupStatEntry[]`; the thin I/O shell is `BackupStore.storeStats()`,
 * which projects the `.meta` sidecars into these entries.
 *
 * Honest limit: this does NOT compute live revertibility — whether a given delta is
 * *currently* applicable depends on the live file hash (ADR-014 §1), which needs a
 * node read, out of bounds for the credential-free renderer. The kind mix and
 * re-anchor count come from local metas only; `list_backups`/`diff_config` remain
 * the live-revertibility path.
 */
export interface BackupStatEntry {
  fileKey: string;
  /** "gzip-diff" | "gzip-full" | "metadata-only". */
  kind: string;
  /** On-disk bytes for this version (blob + meta), matching what eviction sums. */
  sizeBytes: number;
  reanchored: boolean;
  /** ADR-014 §1 — null ⇒ self-contained; absent ⇒ legacy meta. */
  requiresBaseHash?: string | null;
  timestamp: string;
}

export interface BackupCaps {
  perFileVersionCap: number;
  globalSizeCapBytes: number;
}

export interface BackupStoreStats {
  totalBytes: number;
  globalSizeCapBytes: number;
  headroomBytes: number;
  /** totalBytes / cap (may exceed 1 — the over-cap signal). */
  usedFraction: number;
  overCap: boolean;
  totalVersions: number;
  targetCount: number;
  perFileVersionCap: number;
  /** Targets whose version count is at or above the cap (actively shedding history). */
  targetsAtCap: number;
  /** Targets at or above 80% of the cap (approaching eviction). */
  targetsNearCap: number;
  kindMix: { delta: number; selfContained: number; metadataOnly: number };
  reanchorCount: number;
  /** reanchorCount / totalVersions (0 when the store is empty). */
  reanchorFraction: number;
}

/** Classify a version into the delta / self-contained / metadata-only mix (ADR-015 §3). */
export function classifyKind(entry: BackupStatEntry): "delta" | "selfContained" | "metadataOnly" {
  if (entry.kind === "metadata-only") return "metadataOnly";
  if (entry.kind === "gzip-full") return "selfContained";
  // gzip-diff: a reverse delta UNLESS requiresBaseHash is null (the large-file raw
  // fallback, which is self-contained prevContent — ADR-014 §1 / policy.ts).
  if (entry.kind === "gzip-diff") {
    return entry.requiresBaseHash === null ? "selfContained" : "delta";
  }
  return "selfContained";
}

export function summarizeBackupStore(entries: BackupStatEntry[], caps: BackupCaps): BackupStoreStats {
  const kindMix = { delta: 0, selfContained: 0, metadataOnly: 0 };
  const versionsByTarget = new Map<string, number>();
  let totalBytes = 0;
  let reanchorCount = 0;

  for (const e of entries) {
    totalBytes += e.sizeBytes;
    if (e.reanchored) reanchorCount += 1;
    kindMix[classifyKind(e)] += 1;
    versionsByTarget.set(e.fileKey, (versionsByTarget.get(e.fileKey) ?? 0) + 1);
  }

  const nearThreshold = Math.max(1, Math.ceil(caps.perFileVersionCap * 0.8));
  let targetsAtCap = 0;
  let targetsNearCap = 0;
  for (const count of versionsByTarget.values()) {
    if (count >= caps.perFileVersionCap) targetsAtCap += 1;
    if (count >= nearThreshold) targetsNearCap += 1;
  }

  const totalVersions = entries.length;
  return {
    totalBytes,
    globalSizeCapBytes: caps.globalSizeCapBytes,
    headroomBytes: caps.globalSizeCapBytes - totalBytes,
    usedFraction: caps.globalSizeCapBytes === 0 ? 0 : totalBytes / caps.globalSizeCapBytes,
    overCap: totalBytes > caps.globalSizeCapBytes,
    totalVersions,
    targetCount: versionsByTarget.size,
    perFileVersionCap: caps.perFileVersionCap,
    targetsAtCap,
    targetsNearCap,
    kindMix,
    reanchorCount,
    reanchorFraction: totalVersions === 0 ? 0 : reanchorCount / totalVersions,
  };
}
