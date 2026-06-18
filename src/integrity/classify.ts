/**
 * Explained/unexplained classification (ADR-009 §5.3) — the human-vs-Claude
 * discriminator, and a hard cryptographic one, not a heuristic. A drifted leaf whose
 * new hash matches some audit record's `afterHash` was *caused and recorded by the
 * server* ⇒ explained (named by audit id/tool/timestamp). No match ⇒ unexplained
 * (human/package/out-of-band). Pure: it joins a hash against an index built from the
 * audit log.
 */
import type { AuditRecord } from "../audit/record.js";

export interface Explainer {
  auditId: string;
  tool: string;
  ts: string;
}

/**
 * Index audit records by their `afterHash`. Newest wins (later append overwrites),
 * so the most recent tool call that produced a given state is the explainer.
 */
export function buildExplainIndex(records: AuditRecord[]): Map<string, Explainer> {
  const idx = new Map<string, Explainer>();
  for (const r of records) {
    if (r.afterHash) idx.set(r.afterHash, { auditId: r.id, tool: r.tool, ts: r.ts });
  }
  return idx;
}

export type DriftStatus = "explained" | "unexplained";

export function classifyHash(
  newHash: string | undefined,
  index: Map<string, Explainer>
): { status: DriftStatus; explainedBy?: Explainer } {
  if (newHash !== undefined) {
    const hit = index.get(newHash);
    if (hit) return { status: "explained", explainedBy: hit };
  }
  return { status: "unexplained" };
}
