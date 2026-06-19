import fs from "fs";
import path from "path";
import type { Config } from "../config.js";
import { CensusStore } from "../tools/censusStore.js";
import { SnapshotStore } from "./snapshotStore.js";
import { AuditLog } from "../audit/log.js";
import { queryAuditHandler, type QueryAuditInput } from "../tools/queryAudit.js";
import { GitEngine } from "../history/gitEngine.js";
import { BackupStore } from "../backup/store.js";
import { computeAuditStats, type AuditStats, type AuditBucket } from "../metrics/auditStats.js";
import { computeDriftTrend, type DriftTrend, type DriftSnapshotLike } from "../metrics/driftStats.js";
import { summarizeBackupStore, type BackupStoreStats } from "../metrics/backupStats.js";

/**
 * ADR-010 §2 — the RENDERER half: reads ONLY client-side artifacts and holds NO
 * credentials. This module must never import an SSH or API client (ssh2Client /
 * apiClient / ApiBackend / SshBackend) — a source-scan test enforces that. The
 * common path (looking at recent state) costs zero node access and is always
 * available, even with no Claude session and no executor running.
 *
 * Every tool-derived panel carries its snapshot timestamp + an age label so the
 * UI can never mislead the user into thinking a cached view is live (the honest-UI
 * rule, §2). A panel with no persisted snapshot reports `available: false` rather
 * than inventing data.
 */
export interface Panel<T> {
  available: boolean;
  snapshotTs: string | null;
  ageLabel: string;
  data: T | null;
  note?: string;
}

export interface ChangeFeedEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

// Unit-separator delimiter for the git-log pretty format (%x1f) and the JS split.
// 0x1F never appears in a commit subject, so it parses unambiguously.
const SEP = "\x1f";

/** Pure: a human age label for a snapshot timestamp (the §2 honest-UI rule). */
export function snapshotAgeLabel(ts: string | null, now: Date): string {
  if (!ts) return "No snapshot yet — run the source tool from an MCP session";
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return `Last snapshot (${ts})`;
  const deltaMs = Math.max(0, now.getTime() - then);
  return `Last updated ${humanizeDelta(deltaMs)} (${ts})`;
}

function humanizeDelta(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s <= 1 ? "just now" : `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

export class ArtifactReader {
  private readonly census: CensusStore;
  private readonly health: SnapshotStore<unknown>;
  private readonly drift: SnapshotStore<unknown>;
  private readonly audit: AuditLog;
  private readonly historyDir: string;
  private readonly git: GitEngine;

  constructor(
    private readonly cfg: Config,
    // Injectable clock so age labels are deterministic under test.
    private readonly now: () => Date = () => new Date()
  ) {
    this.census = new CensusStore(cfg.census.censusDir, cfg.census.snapshotRetentionCap);
    this.health = new SnapshotStore(cfg.ui.healthDir, cfg.ui.healthRetentionCap);
    this.drift = new SnapshotStore(cfg.ui.driftDir, cfg.ui.driftRetentionCap);
    this.audit = new AuditLog(cfg.audit.logPath);
    this.historyDir = cfg.history.configHistoryDir;
    this.git = new GitEngine(this.historyDir);
  }

  /** Census dashboard — the latest persisted, redacted inventory (ADR-002). */
  censusPanel(): Panel<unknown> {
    const snap = this.census.loadLatest();
    const ts = snap && typeof snap === "object" && "ts" in snap ? String((snap as { ts: unknown }).ts) : null;
    return this.wrap(ts, snap ?? null);
  }

  /** Health board — the latest persisted health_check (ADR-010 cached sink). */
  healthPanel(): Panel<unknown> {
    const snap = this.health.loadLatest();
    return this.wrap(snap?.savedAt ?? null, snap?.data ?? null);
  }

  /** Drift view — the latest persisted verify_integrity report (ADR-009/010). */
  driftPanel(): Panel<unknown> {
    const snap = this.drift.loadLatest();
    return this.wrap(snap?.savedAt ?? null, snap?.data ?? null);
  }

  /**
   * Audit timeline — the JSONL as a filterable feed. Reuses the pure
   * `query_audit` filter/summary core; this is a live read of a local file, not a
   * cached snapshot, so it has no age label (it is always current by construction).
   */
  auditPanel(filters: QueryAuditInput): { summary: unknown; records: unknown[] } {
    return queryAuditHandler(filters, this.audit, this.cfg);
  }

  /**
   * Change feed — the config-history git log (ADR-006). Reading the local mirror
   * via `git log` is a client-side operation (no node credentials). Degrades to an
   * empty feed with a note when git is absent or the repo was never initialized.
   */
  async changeFeedPanel(limit = 50): Promise<Panel<ChangeFeedEntry[]>> {
    if (!fs.existsSync(path.join(this.historyDir, ".git"))) {
      return { available: false, snapshotTs: null, ageLabel: "No config-history repo yet", data: null };
    }
    if (!(await this.git.detectVersion())) {
      return { available: false, snapshotTs: null, ageLabel: "git not installed — change feed unavailable", data: null };
    }
    const fmt = "--pretty=format:%H%x1f%an%x1f%aI%x1f%s";
    const r = await this.git.run(["log", fmt, "-n", String(Math.max(1, Math.min(limit, 500)))]);
    if (r.exitCode !== 0) {
      return { available: false, snapshotTs: null, ageLabel: "no commits yet", data: [] };
    }
    const entries: ChangeFeedEntry[] = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, subject] = line.split(SEP);
        return { hash: hash ?? "", author: author ?? "", date: date ?? "", subject: subject ?? "" };
      });
    const newest = entries[0]?.date ?? null;
    return { available: true, snapshotTs: newest, ageLabel: snapshotAgeLabel(newest, this.now()), data: entries };
  }

  /**
   * ADR-015 §1 — audit-derived statistics over a look-back window (default
   * `metrics.defaultWindowDays`). A LIVE read of the local audit log (always
   * current), so the age label tracks the newest audit event, not a cache.
   */
  auditStatsPanel(opts: { windowDays?: number; bucket?: AuditBucket } = {}): Panel<AuditStats> {
    const all = this.audit.readAll();
    const days = opts.windowDays ?? this.cfg.metrics.defaultWindowDays;
    const bucket = opts.bucket ?? this.cfg.metrics.defaultBucket;
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const stats = computeAuditStats(all, { window: { since }, bucket });
    const newest = all.reduce<string | null>((m, r) => (m === null || r.ts > m ? r.ts : m), null);
    return {
      available: all.length > 0,
      snapshotTs: newest,
      ageLabel: snapshotAgeLabel(newest, this.now()),
      data: stats,
      note: `Computed live from the local audit log over the last ${days} day(s).`,
    };
  }

  /**
   * ADR-015 §2 — drift-rate trend over the retained `verify_integrity` snapshots.
   * Genuinely a cache read (the series is only as deep as `driftRetentionCap` and
   * as frequent as verify runs), so it carries the newest run's age label.
   */
  driftStatsPanel(): Panel<DriftTrend> {
    const snaps = this.drift.loadAll() as DriftSnapshotLike[];
    const trend = computeDriftTrend(snaps, this.cfg.integrity.sensitiveGlobs);
    const newest = trend.runs.length ? trend.runs[trend.runs.length - 1].savedAt : null;
    return {
      available: trend.totalRuns > 0,
      snapshotTs: newest,
      ageLabel: snapshotAgeLabel(newest, this.now()),
      data: trend,
      note:
        "Per-verify-run series (not per-unit-time): bounded by driftRetentionCap and " +
        "how often verify_integrity runs from an MCP session.",
    };
  }

  /**
   * ADR-015 §3 — backup-store health from the local `.meta` sidecars. A live read
   * of the durability layer; does NOT compute live revertibility (that needs a node
   * read — list_backups/diff_config remain that path).
   */
  backupStatsPanel(): Panel<BackupStoreStats> {
    const store = new BackupStore(this.cfg.backup);
    const entries = store.storeStats();
    const stats = summarizeBackupStore(entries, {
      perFileVersionCap: this.cfg.backup.perFileVersionCap,
      globalSizeCapBytes: this.cfg.backup.globalSizeCapBytes,
    });
    return {
      available: entries.length > 0,
      snapshotTs: null,
      ageLabel: "Live — computed from the local backup store",
      data: stats,
      note: "Kind mix + re-anchor count from local metas only; not a live-revertibility check.",
    };
  }

  private wrap<T>(ts: string | null, data: T | null): Panel<T> {
    return {
      available: data !== null,
      snapshotTs: ts,
      ageLabel: snapshotAgeLabel(ts, this.now()),
      data,
    };
  }
}
