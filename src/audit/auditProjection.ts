/**
 * Pure projection core for the `audit.db` shadow store (ADR-022 §1).
 *
 * The `better-sqlite3` handle in `auditDb.ts` is the thin I/O shell; everything
 * that decides *what* goes into a row lives here so it is unit-tested without a
 * database (the ADR-009 "pure core, thin I/O shell" split). Three pure pieces:
 *
 *   - `projectDiff`  — redact (ADR-002) + size-cap the diff-on-write output that
 *                      the write pipeline already computed and otherwise discards.
 *   - `recordToColumns` — map an `AuditRecord` to the structured columns the index
 *                      filters on (booleans → 0/1, `exitCode: null` PRESERVED, the
 *                      full record kept verbatim in `raw` so a query round-trips an
 *                      identical `AuditRecord` — JSONL parity, no lossy columns).
 *   - `buildFtsMatch` — turn a free-text `query_audit { textSearch }` into a safe
 *                      FTS5 MATCH expression (each token quoted as a literal phrase
 *                      so FTS operators in user text can never be injected).
 */
import type { AuditRecord } from "./record.js";
import { redactString } from "../guardrails/redaction.js";

export interface DiffProjectionOpts {
  /** Persist diffs at all (audit.storeDiffs). */
  storeDiffs: boolean;
  /** Redact the diff before storage (audit.redactDiffs). */
  redactDiffs: boolean;
  /** Cap the stored (redacted) diff in bytes (audit.diffMaxBytes). */
  diffMaxBytes: number;
}

export interface DiffProjection {
  /** The diff text to store, or null when none/disabled. */
  text: string | null;
  /** Whether redaction ran AND changed something. */
  redacted: boolean;
  /** Number of redactions applied (0 when not redacted). */
  redactionCount: number;
  /** Whether the diff was truncated to the byte cap. */
  truncated: boolean;
}

const TRUNCATION_MARKER = "\n…(diff truncated by audit.db cap)";

/**
 * Redact + cap the diff for storage. A null/empty diff, or `storeDiffs: false`,
 * yields an empty projection (the exec family — `hashScope:"unknown"` — has no
 * diff; its redacted `cmd` is the searchable text instead). Truncation is by
 * UTF-8 byte budget so the cap is meaningful for multi-byte content.
 */
export function projectDiff(
  diff: string | null | undefined,
  opts: DiffProjectionOpts
): DiffProjection {
  if (!opts.storeDiffs || diff === null || diff === undefined || diff === "") {
    return { text: null, redacted: false, redactionCount: 0, truncated: false };
  }

  let text = diff;
  let redacted = false;
  let redactionCount = 0;
  if (opts.redactDiffs) {
    const r = redactString(text);
    text = r.value;
    redactionCount = r.redactedCount;
    redacted = r.redactedCount > 0;
  }

  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > opts.diffMaxBytes) {
    // Conservative char-wise trim until under budget, then append the marker.
    // (A byte-exact slice could split a multi-byte codepoint; chars are safe.)
    const budget = Math.max(0, opts.diffMaxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
    let end = Math.min(text.length, budget);
    while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > budget) end--;
    text = text.slice(0, end) + TRUNCATION_MARKER;
    truncated = true;
  }

  return { text, redacted, redactionCount, truncated };
}

/** The structured columns mirrored from an AuditRecord. Snake_case = DB column. */
export interface AuditColumns {
  id: string;
  ts: string;
  tool: string;
  vmid: number | null;
  container: string | null;
  path: string | null;
  hash_scope: string | null;
  before_hash: string | null;
  after_hash: string | null;
  // null PRESERVED — a signal-killed command must never read as exit 0 (ADR-004 §3).
  exit_code: number | null;
  is_large: number; // 0/1
  is_heavy: number; // 0/1
  confirm_gated: number; // 0/1
  root_tier: number; // 0/1
  history_committed: number | null; // 0/1/null (best-effort; null = not applicable)
  cmd: string | null;
  note: string | null;
  diff: string | null;
  diff_redacted: number | null; // 0/1/null
  diff_redaction_count: number | null;
  diff_truncated: number | null; // 0/1/null
  /** The full record verbatim — the source of truth a query reconstructs from. */
  raw: string;
}

function bool01(v: boolean | undefined): number {
  return v === true ? 1 : 0;
}

function nullable<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

/**
 * Map an `AuditRecord` (+ its projected diff) to the index columns. The diff
 * columns are null when there is no stored diff. `raw` carries the entire record
 * so a read returns a byte-identical `AuditRecord` (the JSONL path's contract),
 * keeping the SQLite fast path and the pure JSONL fallback provably in parity.
 */
export function recordToColumns(record: AuditRecord, diff: DiffProjection): AuditColumns {
  return {
    id: record.id,
    ts: record.ts,
    tool: record.tool,
    vmid: nullable(record.vmid),
    container: nullable(record.container),
    path: nullable(record.path),
    hash_scope: nullable(record.hashScope),
    before_hash: nullable(record.beforeHash),
    after_hash: nullable(record.afterHash),
    exit_code: record.exitCode === undefined ? null : record.exitCode,
    is_large: bool01(record.isLargeChange),
    is_heavy: bool01(record.isHeavy),
    confirm_gated: bool01(record.confirmGated),
    root_tier: bool01(record.rootTier),
    history_committed:
      record.historyCommitted === undefined ? null : bool01(record.historyCommitted),
    cmd: nullable(record.cmd),
    note: nullable(record.note),
    diff: diff.text,
    diff_redacted: diff.text === null ? null : bool01(diff.redacted),
    diff_redaction_count: diff.text === null ? null : diff.redactionCount,
    diff_truncated: diff.text === null ? null : bool01(diff.truncated),
    raw: JSON.stringify(record),
  };
}

/**
 * Turn free-text into a safe FTS5 MATCH expression. Each token is extracted as a
 * run of word characters and emitted as a quoted literal phrase, AND-joined. This
 * is deliberately conservative: quoting neutralizes FTS5 operators (AND/OR/NOT/
 * NEAR/`*`/`:`/`-`/`(`) that would otherwise let user text throw a syntax error or
 * change the query's meaning. Returns null when there is no usable token (the
 * caller then skips the FTS join entirely).
 */
export function buildFtsMatch(query: string | undefined): string | null {
  if (query === undefined) return null;
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}
