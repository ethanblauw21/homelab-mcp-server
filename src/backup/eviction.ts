export interface BackupEntry {
  path: string;       // on-disk path of the blob
  fileKey: string;    // stable key for the source file (e.g. sha256 of the remote path)
  timestamp: string;  // ISO-8601, used for LRU ordering
  sizeBytes: number;
}

export interface EvictionPlan {
  toDelete: BackupEntry[];
  toKeep: BackupEntry[];
}

/**
 * Pure function: given the current set of backups and the two caps, returns
 * which entries to delete (oldest first / LRU) so that:
 *   - no single file has more than perFileCap versions
 *   - total size of toKeep ≤ globalSizeCapBytes
 */
export function planEviction(
  entries: BackupEntry[],
  perFileCap: number,
  globalSizeCapBytes: number
): EvictionPlan {
  // Sort oldest first
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Group by fileKey
  const byFile = new Map<string, BackupEntry[]>();
  for (const e of sorted) {
    const list = byFile.get(e.fileKey) ?? [];
    list.push(e);
    byFile.set(e.fileKey, list);
  }

  const toDelete: BackupEntry[] = [];

  // Per-file cap: evict oldest versions over the cap
  for (const [, versions] of byFile) {
    // versions are already oldest-first
    const excess = versions.length - perFileCap;
    if (excess > 0) {
      toDelete.push(...versions.slice(0, excess));
    }
  }

  const deleteSet = new Set(toDelete.map((e) => e.path));
  let toKeep = sorted.filter((e) => !deleteSet.has(e.path));

  // Global size cap: evict oldest until total ≤ cap
  let total = toKeep.reduce((sum, e) => sum + e.sizeBytes, 0);
  while (total > globalSizeCapBytes && toKeep.length > 0) {
    const evict = toKeep.shift()!;
    toDelete.push(evict);
    total -= evict.sizeBytes;
  }

  return { toDelete, toKeep };
}

/**
 * Returns true if the planned state still exceeds the global cap
 * (i.e. even after evicting everything we can, we're still over budget).
 */
export function isOverCap(kept: BackupEntry[], globalSizeCapBytes: number): boolean {
  return kept.reduce((sum, e) => sum + e.sizeBytes, 0) > globalSizeCapBytes;
}
