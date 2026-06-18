import { z } from "zod";
import type { AuditLog } from "../audit/log.js";
import type { AuditRecord, AuditTool } from "../audit/record.js";
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
  limit: z.number().int().positive().optional().describe("Max records returned (default 50, capped)"),
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
 * `query_audit` — the audit log's first read consumer beyond revert (ADR-005
 * §Part 2). Entirely local: pure filter + summary over `readAll()`. Records are
 * newest-first and bounded by `limit`; the summary describes the FULL filtered
 * set, not just the returned page. Read-only, not audited.
 */
export function queryAuditHandler(
  input: QueryAuditInput,
  audit: AuditLog,
  cfg: Config
): QueryAuditResult {
  const all = audit.readAll();
  const filtered = filterAuditRecords(all, input);
  const summary = summarizeAuditRecords(filtered);

  const limit = Math.min(
    input.limit ?? cfg.tools.queryAuditDefaultLimit,
    cfg.tools.queryAuditMaxLimit
  );
  const records = [...filtered].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);

  return { summary, records };
}
