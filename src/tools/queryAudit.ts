import { z } from "zod";
import type { AuditLog } from "../audit/log.js";
import type { AuditRecord, AuditTool } from "../audit/record.js";
import type { AuditDb } from "../audit/auditDb.js";
import type { Config } from "../config.js";

export const QueryAuditInputSchema = z.object({
  tool: z.string().optional().describe("Filter by audit tool name (e.g. write_file, qm_exec)"),
  vmid: z.number().int().optional().describe("Filter by guest VMID"),
  pathContains: z.string().optional().describe("Substring match on the record path"),
  since: z.string().optional().describe("ISO timestamp lower bound (inclusive)"),
  until: z.string().optional().describe("ISO timestamp upper bound (inclusive)"),
  largeOnly: z.boolean().optional().describe("Only records flagged isLargeChange"),
  // ADR-009 hash-anchored filters — bridge from a verify_integrity drift back to its
  // cause. `hashScopeContains` finds writes touching a path; `unknownScopeOnly` finds
  // exec-family calls (hashScope "unknown") that may have caused unexplained drift;
  // `hashEquals` finds the exact write that produced a given forest leaf hash.
  hashScopeContains: z.string().optional().describe("Substring match on the record hashScope"),
  unknownScopeOnly: z.boolean().optional().describe('Only records with hashScope "unknown" (exec-family)'),
  hashEquals: z.string().optional().describe("Exact match on the record's beforeHash or afterHash"),
  // ADR-022 — free-text search. With the audit.db projection present this runs the
  // FTS5 index over cmd + redacted diff + path + note (the diff that diff-on-write
  // computed and used to discard). Without the DB it degrades to a plain substring
  // scan over cmd/path/note (no diff text in the JSONL fallback). Combines with the
  // structured filters above (AND).
  textSearch: z
    .string()
    .optional()
    .describe("Full-text search over cmd/diff/path/note (FTS5 when audit.db is present)"),
  limit: z.number().int().positive().optional().describe("Max records returned (default 50, capped)"),
  // ADR-017 §1 — opt-in `cmd` projection. The exec-family records carry the full
  // command string; for a wide query that is the bulk of the payload. `cmdMaxChars`
  // truncates each `cmd` to a head window (with a `…(+N chars)` marker) so a scan
  // costs few tokens; `cmdFull` forces verbatim even if `cmdMaxChars` is set. Both
  // are OPT-IN — absent, every `cmd` is returned byte-for-byte as today (the
  // provably-additive invariant; truncation can hide a forensically-relevant flag,
  // so it must never be the default).
  cmdMaxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Truncate each record's cmd to this many chars (opt-in; default = full)"),
  cmdFull: z.boolean().optional().describe("Force full cmd even when cmdMaxChars is set"),
});

export type QueryAuditInput = z.infer<typeof QueryAuditInputSchema>;

export interface AuditSummary {
  total: number;
  byTool: Record<string, number>;
  byVmid: Record<string, number>;
  firstTs: string | null;
  lastTs: string | null;
}

export interface QueryAuditResult {
  summary: AuditSummary;
  records: AuditRecord[];
}

export interface AuditFilters {
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

/**
 * Pure filter over audit records. ISO timestamps compare lexicographically, so
 * `since`/`until` are plain string range checks. Each predicate is independent
 * and combinable.
 */
export function filterAuditRecords(records: AuditRecord[], f: AuditFilters): AuditRecord[] {
  return records.filter((r) => {
    if (f.tool !== undefined && r.tool !== (f.tool as AuditTool)) return false;
    if (f.vmid !== undefined && r.vmid !== f.vmid) return false;
    if (f.pathContains !== undefined && !(r.path ?? "").includes(f.pathContains)) return false;
    if (f.since !== undefined && r.ts < f.since) return false;
    if (f.until !== undefined && r.ts > f.until) return false;
    if (f.largeOnly === true && r.isLargeChange !== true) return false;
    if (f.hashScopeContains !== undefined && !(r.hashScope ?? "").includes(f.hashScopeContains)) return false;
    if (f.unknownScopeOnly === true && r.hashScope !== "unknown") return false;
    if (f.hashEquals !== undefined && r.beforeHash !== f.hashEquals && r.afterHash !== f.hashEquals) return false;
    return true;
  });
}

/** Pure summary over a (filtered) record set. firstTs/lastTs span the whole set. */
export function summarizeAuditRecords(records: AuditRecord[]): AuditSummary {
  const byTool: Record<string, number> = {};
  const byVmid: Record<string, number> = {};
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const r of records) {
    byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
    if (r.vmid !== undefined) {
      const k = String(r.vmid);
      byVmid[k] = (byVmid[k] ?? 0) + 1;
    }
    if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
    if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
  }
  return { total: records.length, byTool, byVmid, firstTs, lastTs };
}

/**
 * Pure `cmd`-projection (ADR-017 §1). Opt-in truncation: with no `cmdMaxChars`
 * (or `cmdFull: true`) every record is returned unchanged — today's behaviour,
 * byte-for-byte. When `cmdMaxChars` is set, a record whose `cmd` exceeds it is
 * shallow-copied with the `cmd` replaced by a head window + a `…(+N chars)`
 * marker (N = the number of dropped chars). Records with no `cmd` pass through.
 */
export function projectAuditCmd(
  records: AuditRecord[],
  opts: { cmdMaxChars?: number; cmdFull?: boolean }
): AuditRecord[] {
  if (opts.cmdFull === true || opts.cmdMaxChars === undefined) return records;
  const max = opts.cmdMaxChars;
  return records.map((r) => {
    if (r.cmd === undefined || r.cmd.length <= max) return r;
    const dropped = r.cmd.length - max;
    return { ...r, cmd: `${r.cmd.slice(0, max)}…(+${dropped} chars)` };
  });
}

/**
 * Plain-substring fallback for `textSearch` when the audit.db FTS index is absent
 * (ADR-022). Case-sensitive over the in-record text the JSONL carries — cmd, path,
 * note (the diff lives only in the projection, so it cannot be searched here). This
 * is the degraded-but-functional contract: the fast path is strictly richer.
 */
export function fallbackTextFilter(records: AuditRecord[], text: string): AuditRecord[] {
  if (text === "") return records;
  return records.filter(
    (r) =>
      (r.cmd ?? "").includes(text) ||
      (r.path ?? "").includes(text) ||
      (r.note ?? "").includes(text)
  );
}

/**
 * `query_audit` — the audit log's first read consumer beyond revert (ADR-005
 * §Part 2), upgraded in place (ADR-022 §1). FAST PATH: when the `audit.db`
 * projection is present, structured filters resolve as indexed lookups and
 * `textSearch` runs the FTS5 index. FALLBACK: when it is absent/disabled, the pure
 * `filterAuditRecords` JSONL scan answers exactly as before (with a substring
 * `textSearch`). Both paths feed the SAME summary/paging/projection below, so the
 * result shape is identical — the DB is a speed/recall upgrade, never a contract
 * change. Read-only, not audited.
 */
export function queryAuditHandler(
  input: QueryAuditInput,
  audit: AuditLog,
  cfg: Config,
  auditDb?: AuditDb
): QueryAuditResult {
  let filtered: AuditRecord[];
  if (auditDb) {
    filtered = auditDb.queryRecords(input, input.textSearch);
  } else {
    filtered = filterAuditRecords(audit.readAll(), input);
    if (input.textSearch !== undefined) filtered = fallbackTextFilter(filtered, input.textSearch);
  }
  const summary = summarizeAuditRecords(filtered);

  const limit = Math.min(
    input.limit ?? cfg.tools.queryAuditDefaultLimit,
    cfg.tools.queryAuditMaxLimit
  );
  const page = [...filtered].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
  // Project AFTER paging — only the returned records are shaped; the summary
  // (computed above over the full filtered set) is untouched.
  const records = projectAuditCmd(page, { cmdMaxChars: input.cmdMaxChars, cmdFull: input.cmdFull });

  return { summary, records };
}
