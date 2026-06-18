import fs from "fs";
import path from "path";
import { planEviction, type BackupEntry } from "../backup/eviction.js";

/**
 * ADR-010 §2 — generic timestamped JSON snapshot store for the cached-state model.
 *
 * The renderer shows the *last persisted snapshot* of anything tool-derived, each
 * labelled with its age. `CensusStore` already does this for the census; this is
 * the same trick generalized for the two panels whose source tools (`health_check`,
 * `verify_integrity`) are otherwise computed live and never written to disk.
 *
 * Retention is count-based, reusing the backup eviction planner exactly like
 * `CensusStore`: all snapshots share one synthetic fileKey and the global size cap
 * is disabled (Infinity), so the per-"file" cap acts as the snapshot count cap.
 *
 * The stored shape wraps the payload with the time it was saved, which is the
 * single source of truth for the UI's "Last X — <time>" age label (the honest-UI
 * rule that a cached panel must never imply liveness).
 *
 * Payloads here carry no secret-bearing fields by construction — a health result
 * is metrics + statuses + unit/store names; a drift report is forest paths +
 * content *hashes* (never file content) — so unlike the census (which redacts at
 * the object level before reaching its store) these are persisted as-is.
 */
export interface StoredSnapshot<T> {
  savedAt: string;
  data: T;
}

export class SnapshotStore<T> {
  constructor(
    private readonly dir: string,
    private readonly retentionCap: number,
    // Injectable clock so retention/labelling is deterministic under test.
    private readonly now: () => Date = () => new Date()
  ) {}

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Snapshot file paths, newest first. */
  listSnapshots(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a))
      .map((f) => path.join(this.dir, f));
  }

  /** Load and parse the most recent snapshot, or null if none / unreadable. */
  loadLatest(): StoredSnapshot<T> | null {
    const [latest] = this.listSnapshots();
    if (!latest) return null;
    try {
      return JSON.parse(fs.readFileSync(latest, "utf8")) as StoredSnapshot<T>;
    } catch {
      return null;
    }
  }

  /** Persist a snapshot (filename derived from the save time) and run retention. */
  save(data: T): string {
    this.ensureDir();
    const savedAt = this.now().toISOString();
    const fname = `${savedAt.replace(/[:.]/g, "-")}.json`;
    const fullPath = path.join(this.dir, fname);
    fs.writeFileSync(fullPath, JSON.stringify({ savedAt, data } satisfies StoredSnapshot<T>, null, 2));
    this.runRetention();
    return fullPath;
  }

  private runRetention(): void {
    if (!fs.existsSync(this.dir)) return;
    const entries: BackupEntry[] = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = path.join(this.dir, f);
        return {
          path: p,
          fileKey: "snapshot",
          timestamp: f.replace(/\.json$/, ""),
          sizeBytes: fs.statSync(p).size,
        };
      });

    const { toDelete } = planEviction(entries, this.retentionCap, Number.MAX_SAFE_INTEGER);
    for (const e of toDelete) {
      try {
        fs.unlinkSync(e.path);
      } catch {
        /* already gone */
      }
    }
  }
}
