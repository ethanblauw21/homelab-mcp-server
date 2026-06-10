import fs from "fs";
import path from "path";
import { planEviction, type BackupEntry } from "../backup/eviction.js";
import type { CensusSnapshot } from "./censusTypes.js";
import type { RedactedCensusSnapshot } from "./censusInventory.js";

/**
 * Local, timestamped census snapshot storage (ADR-002). Snapshots are written
 * post-redaction only. Retention is count-based (keep last N), reusing the
 * backup eviction planner: all snapshots share one synthetic fileKey and the
 * global size cap is disabled (Infinity), so the per-"file" cap acts as the
 * snapshot count cap.
 */
export class CensusStore {
  constructor(
    private readonly censusDir: string,
    private readonly retentionCap: number
  ) {}

  private ensureDir(): void {
    fs.mkdirSync(this.censusDir, { recursive: true });
  }

  /** Snapshot file paths, newest first. */
  listSnapshots(): string[] {
    if (!fs.existsSync(this.censusDir)) return [];
    return fs
      .readdirSync(this.censusDir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a))
      .map((f) => path.join(this.censusDir, f));
  }

  /** Load and parse the most recent snapshot, or null if none / unreadable. */
  loadLatest(): CensusSnapshot | null {
    const [latest] = this.listSnapshots();
    if (!latest) return null;
    try {
      return JSON.parse(fs.readFileSync(latest, "utf8")) as CensusSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Persist a snapshot (filename derived from its ts) and run retention.
   * Accepts ONLY the branded `RedactedCensusSnapshot` (R2): a snapshot that has
   * not been through `finalizeInventory` is a compile error here.
   */
  save(snapshot: RedactedCensusSnapshot): string {
    this.ensureDir();
    const fname = `${snapshot.ts.replace(/[:.]/g, "-")}.json`;
    const fullPath = path.join(this.censusDir, fname);
    fs.writeFileSync(fullPath, JSON.stringify(snapshot, null, 2));
    this.runRetention();
    return fullPath;
  }

  private runRetention(): void {
    if (!fs.existsSync(this.censusDir)) return;
    const entries: BackupEntry[] = fs
      .readdirSync(this.censusDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = path.join(this.censusDir, f);
        return {
          path: p,
          fileKey: "census",
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
