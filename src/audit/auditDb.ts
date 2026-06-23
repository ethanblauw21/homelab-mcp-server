/**
 * `audit.db` — the derived, rebuildable projection of the JSONL audit log
 * (ADR-022 §1). The JSONL trail (`audit/log.ts`) stays the system of record;
 * this is a blow-away-safe *index* over it: structured columns for the fields
 * `query_audit` filters, an FTS5 external-content table over the searchable text
 * (`cmd` + redacted `diff` + `path` + `note`), and the redacted diff-on-write
 * output that would otherwise be discarded. Drop the file and replay the JSONL
 * (+ backup store) to rebuild.
 *
 * This is the thin I/O shell — all projection logic is the pure core in
 * `auditProjection.ts`. The schema mirrors `SqliteNodeStore` (ADR-009): an
 * injected `better-sqlite3` handle, WAL, idempotent DDL. `AuditDb` implements
 * `AuditProjector` so `AuditLog` can mirror each append into it best-effort,
 * fail-soft — a DB error NEVER fails an audit append (the JSONL already
 * succeeded), mirroring the ADR-006 `historyCommitted` doctrine.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { AuditRecord } from "./record.js";
import type { AuditProjector } from "./log.js";
import type { Config } from "../config.js";
import {
  projectDiff,
  recordToColumns,
  buildFtsMatch,
  type AuditColumns,
  type DiffProjectionOpts,
} from "./auditProjection.js";

/** Filters mirrored from `AuditFilters` (queryAudit.ts) that the index resolves. */
export interface AuditDbFilters {
  tool?: string;
  vmid?: number;
  pathContains?: string;
  since?: string;
  until?: string;
  largeOnly?: boolean;
  hashScopeContains?: string;
  unknownScopeOnly?: boolean;
  hashEquals?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  ts            TEXT NOT NULL,
  tool          TEXT NOT NULL,
  vmid          INTEGER,
  container     TEXT,
  path          TEXT,
  hash_scope    TEXT,
  before_hash   TEXT,
  after_hash    TEXT,
  exit_code     INTEGER,
  is_large      INTEGER NOT NULL DEFAULT 0,
  is_heavy      INTEGER NOT NULL DEFAULT 0,
  confirm_gated INTEGER NOT NULL DEFAULT 0,
  root_tier     INTEGER NOT NULL DEFAULT 0,
  history_committed INTEGER,
  cmd           TEXT,
  note          TEXT,
  diff          TEXT,
  diff_redacted INTEGER,
  diff_redaction_count INTEGER,
  diff_truncated INTEGER,
  raw           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_tool      ON audit(tool);
CREATE INDEX IF NOT EXISTS idx_audit_vmid      ON audit(vmid);
CREATE INDEX IF NOT EXISTS idx_audit_path      ON audit(path);
CREATE INDEX IF NOT EXISTS idx_audit_hashscope ON audit(hash_scope);
CREATE INDEX IF NOT EXISTS idx_audit_hashes    ON audit(before_hash, after_hash);

-- FTS5 external-content: the searchable text is NOT stored twice; the virtual
-- table references audit.rowid via content_rowid. A future vec0/embedding column
-- can join on the same rowid without reshaping anything (ADR-022 §1).
CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
  cmd, diff, path, note,
  content='audit', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS audit_ai AFTER INSERT ON audit BEGIN
  INSERT INTO audit_fts(rowid, cmd, diff, path, note)
  VALUES (new.rowid, new.cmd, new.diff, new.path, new.note);
END;
CREATE TRIGGER IF NOT EXISTS audit_ad AFTER DELETE ON audit BEGIN
  INSERT INTO audit_fts(audit_fts, rowid, cmd, diff, path, note)
  VALUES ('delete', old.rowid, old.cmd, old.diff, old.path, old.note);
END;
CREATE TRIGGER IF NOT EXISTS audit_au AFTER UPDATE ON audit BEGIN
  INSERT INTO audit_fts(audit_fts, rowid, cmd, diff, path, note)
  VALUES ('delete', old.rowid, old.cmd, old.diff, old.path, old.note);
  INSERT INTO audit_fts(rowid, cmd, diff, path, note)
  VALUES (new.rowid, new.cmd, new.diff, new.path, new.note);
END;
`;

const INSERT_SQL = `
INSERT INTO audit (
  id, ts, tool, vmid, container, path, hash_scope, before_hash, after_hash,
  exit_code, is_large, is_heavy, confirm_gated, root_tier, history_committed,
  cmd, note, diff, diff_redacted, diff_redaction_count, diff_truncated, raw
) VALUES (
  @id, @ts, @tool, @vmid, @container, @path, @hash_scope, @before_hash, @after_hash,
  @exit_code, @is_large, @is_heavy, @confirm_gated, @root_tier, @history_committed,
  @cmd, @note, @diff, @diff_redacted, @diff_redaction_count, @diff_truncated, @raw
)
ON CONFLICT(id) DO NOTHING
`;

export class AuditDb implements AuditProjector {
  private readonly diffOpts: DiffProjectionOpts;

  constructor(private readonly db: Database.Database, diffOpts: DiffProjectionOpts) {
    this.diffOpts = diffOpts;
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  private insertCols(cols: AuditColumns): void {
    this.db.prepare(INSERT_SQL).run(cols as unknown as Record<string, unknown>);
  }

  /** Mirror one record (+ optional diff) into the index. Idempotent on `id`. */
  insert(record: AuditRecord, diff?: string | null): void {
    const projected = projectDiff(diff, this.diffOpts);
    this.insertCols(recordToColumns(record, projected));
  }

  /** `AuditProjector` — called by `AuditLog.append`; best-effort, see log.ts. */
  project(record: AuditRecord, extras?: { diff?: string | null }): void {
    this.insert(record, extras?.diff);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
  }

  has(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM audit WHERE id = ?").get(id) !== undefined;
  }

  /**
   * The fast-path query: indexed structured filters + an optional FTS5 free-text
   * MATCH, returning full `AuditRecord`s (reconstructed from `raw`) newest-first.
   * Returns the ENTIRE filtered set — the handler does summary/paging/projection
   * identically to the JSONL fallback, so both paths are provably in parity.
   */
  queryRecords(filters: AuditDbFilters, textSearch?: string): AuditRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    const match = buildFtsMatch(textSearch);

    let from = "audit a";
    if (match !== null) {
      from = "audit a JOIN audit_fts f ON f.rowid = a.rowid";
      where.push("audit_fts MATCH @ftsMatch");
      params.ftsMatch = match;
    }
    if (filters.tool !== undefined) {
      where.push("a.tool = @tool");
      params.tool = filters.tool;
    }
    if (filters.vmid !== undefined) {
      where.push("a.vmid = @vmid");
      params.vmid = filters.vmid;
    }
    if (filters.pathContains !== undefined) {
      // instr() is case-sensitive (binary), matching the JSONL fallback's
      // String.includes() exactly — LIKE would fold ASCII case and break parity.
      where.push("instr(a.path, @pathSub) > 0");
      params.pathSub = filters.pathContains;
    }
    if (filters.since !== undefined) {
      where.push("a.ts >= @since");
      params.since = filters.since;
    }
    if (filters.until !== undefined) {
      where.push("a.ts <= @until");
      params.until = filters.until;
    }
    if (filters.largeOnly === true) {
      where.push("a.is_large = 1");
    }
    if (filters.hashScopeContains !== undefined) {
      where.push("instr(a.hash_scope, @hsSub) > 0");
      params.hsSub = filters.hashScopeContains;
    }
    if (filters.unknownScopeOnly === true) {
      where.push("a.hash_scope = 'unknown'");
    }
    if (filters.hashEquals !== undefined) {
      where.push("(a.before_hash = @hashEq OR a.after_hash = @hashEq)");
      params.hashEq = filters.hashEquals;
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT a.raw FROM ${from} ${clause} ORDER BY a.ts DESC`;
    const rows = this.db.prepare(sql).all(params) as { raw: string }[];
    return rows.map((r) => JSON.parse(r.raw) as AuditRecord);
  }

  /**
   * Rebuild the index from a full record set (the maintenance / schema-bump path,
   * ADR-022 implementation notes). `diffFor` recovers a record's diff where it can
   * (e.g. from the backup store); absent ⇒ no diff column for that row. Wrapped in
   * one transaction; idempotent per `id`.
   */
  rebuildFrom(records: AuditRecord[], diffFor?: (r: AuditRecord) => string | null): void {
    const tx = this.db.transaction((rs: AuditRecord[]) => {
      for (const r of rs) this.insert(r, diffFor ? diffFor(r) : null);
    });
    tx(records);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open the on-disk `audit.db` (the I/O entry point index.ts wires next to the
 * AuditLog). Mirrors `openIntegrityStore` (ADR-009): creates the parent dir,
 * constructs the native handle, hands it to the store. `":memory:"` is honored
 * for tests. Diff projection options are lifted from `config.audit`.
 */
export function openAuditDb(cfg: Config): AuditDb {
  if (cfg.audit.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(cfg.audit.dbPath), { recursive: true });
  }
  return new AuditDb(new Database(cfg.audit.dbPath), {
    storeDiffs: cfg.audit.storeDiffs,
    redactDiffs: cfg.audit.redactDiffs,
    diffMaxBytes: cfg.audit.diffMaxBytes,
  });
}
