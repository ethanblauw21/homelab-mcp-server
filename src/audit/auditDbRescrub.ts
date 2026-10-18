/**
 * ADR-027 — one-time re-redaction of `audit.db` rows written before ADR-026 (or
 * under any older rule set). ADR-026 made the boundary redactor catch more, but
 * rows already projected keep whatever the old rules missed in `cmd`, `note`,
 * `diff` and the `raw` record copy (and so in the FTS index). This applies the
 * current `redactString` to those columns. Redaction is idempotent, so running it
 * over every row is safe; only rows whose text actually changes are touched.
 *
 * The JSONL audit log is NOT rewritten: it is the append-only system of record
 * (ADR-004), and `query_audit` already re-redacts it on the way out.
 *
 * Pure planning (`planRescrub`) + a thin apply over an injected better-sqlite3
 * handle. Reports carry ids, timestamps, tools, column names and marker counts —
 * never the old or new text.
 */
import type Database from "better-sqlite3";
import { redactString } from "../guardrails/redaction.js";

export interface RescrubRow {
  rowid: number;
  id: string;
  ts: string;
  tool: string;
  cmd: string | null;
  note: string | null;
  diff: string | null;
  diff_redaction_count: number | null;
  raw: string;
}

export interface RescrubChange {
  rowid: number;
  id: string;
  ts: string;
  tool: string;
  /** Which columns change (raw is included whenever cmd/note do). */
  columns: Array<"cmd" | "note" | "diff" | "raw">;
  /** New redaction markers added across the row. */
  redactions: number;
  next: { cmd: string | null; note: string | null; diff: string | null; diff_redaction_count: number | null; raw: string };
}

function scrub(text: string | null): { value: string | null; count: number } {
  if (text === null) return { value: null, count: 0 };
  const r = redactString(text);
  return { value: r.value, count: r.value === text ? 0 : r.redactedCount };
}

/** Plan the re-redaction of a batch of rows (pure). Unchanged rows are omitted. */
export function planRescrub(rows: RescrubRow[]): RescrubChange[] {
  const out: RescrubChange[] = [];
  for (const row of rows) {
    const cmd = scrub(row.cmd);
    const note = scrub(row.note);
    const diff = scrub(row.diff);
    const columns: RescrubChange["columns"] = [];
    if (cmd.value !== row.cmd) columns.push("cmd");
    if (note.value !== row.note) columns.push("note");
    if (diff.value !== row.diff) columns.push("diff");

    // The raw record copy carries cmd/note too; scrub its string fields the same way
    // so a read through the index (which returns `raw`) is clean. An unparsable raw
    // is redacted as plain text rather than left alone.
    let raw = row.raw;
    let rawCount = 0;
    try {
      const rec = JSON.parse(row.raw) as Record<string, unknown>;
      for (const k of ["cmd", "note"] as const) {
        if (typeof rec[k] === "string") {
          const s = scrub(rec[k] as string);
          if (s.value !== rec[k]) {
            rec[k] = s.value;
            rawCount += s.count;
          }
        }
      }
      if (rawCount > 0) raw = JSON.stringify(rec);
    } catch {
      const s = scrub(row.raw);
      raw = s.value ?? row.raw;
      rawCount = s.count;
    }
    if (raw !== row.raw) columns.push("raw");
    if (columns.length === 0) continue;
    out.push({
      rowid: row.rowid,
      id: row.id,
      ts: row.ts,
      tool: row.tool,
      columns,
      redactions: cmd.count + note.count + diff.count,
      next: {
        cmd: cmd.value,
        note: note.value,
        diff: diff.value,
        diff_redaction_count: diff.value === null ? row.diff_redaction_count : (row.diff_redaction_count ?? 0) + diff.count,
        raw,
      },
    });
  }
  return out;
}

export interface RescrubReport {
  scanned: number;
  changed: number;
  redactions: number;
  byColumn: Record<string, number>;
  byTool: Record<string, number>;
  oldest?: string;
  newest?: string;
  rows: Array<{ id: string; ts: string; tool: string; columns: string[]; redactions: number }>;
  applied: boolean;
}

/**
 * Scan every row; with `apply`, write the changes in one transaction under
 * `secure_delete` (freed pages are zeroed), rebuild + optimize the FTS index so no
 * old tokens survive in its segments, then checkpoint the WAL. VACUUM is left to
 * the caller (it cannot run inside a transaction).
 */
export function rescrubAuditDb(db: Database.Database, opts: { apply: boolean }): RescrubReport {
  const rows = db
    .prepare("SELECT rowid, id, ts, tool, cmd, note, diff, diff_redaction_count, raw FROM audit ORDER BY rowid")
    .all() as RescrubRow[];
  const changes = planRescrub(rows);
  const byColumn: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  for (const c of changes) {
    for (const col of c.columns) byColumn[col] = (byColumn[col] ?? 0) + 1;
    byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  }
  if (opts.apply && changes.length > 0) {
    db.pragma("secure_delete = ON");
    const upd = db.prepare(
      "UPDATE audit SET cmd = @cmd, note = @note, diff = @diff, diff_redaction_count = @diff_redaction_count, " +
        "diff_redacted = CASE WHEN @diff IS NULL THEN diff_redacted ELSE 1 END, raw = @raw WHERE rowid = @rowid"
    );
    db.transaction(() => {
      for (const c of changes) upd.run({ ...c.next, rowid: c.rowid });
    })();
    db.exec("INSERT INTO audit_fts(audit_fts) VALUES('rebuild'); INSERT INTO audit_fts(audit_fts) VALUES('optimize');");
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
  const ts = changes.map((c) => c.ts).sort();
  return {
    scanned: rows.length,
    changed: changes.length,
    redactions: changes.reduce((n, c) => n + c.redactions, 0),
    byColumn,
    byTool,
    ...(ts.length > 0 && { oldest: ts[0], newest: ts[ts.length - 1] }),
    rows: changes.map((c) => ({ id: c.id, ts: c.ts, tool: c.tool, columns: c.columns, redactions: c.redactions })),
    applied: opts.apply && changes.length > 0,
  };
}
