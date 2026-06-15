import { z } from "zod";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { AuditLog } from "../audit/log.js";
import { buildAuditRecord } from "../audit/record.js";
import { SqliteNodeStore, type NodeStore } from "../integrity/nodeStore.js";
import { IntegrityEngine } from "../integrity/integrityEngine.js";
import { SUPER_ROOT } from "../integrity/tree.js";

/**
 * ADR-009 tool surface — `compute_tree`, `verify_integrity`, `accept_truth`. Thin
 * wrappers over `IntegrityEngine`; the orchestration + policy live there. All three
 * are companion-tier (they read file content via SSH/`pct pull` or read the baseline).
 *
 * `scope` is a FOREST path (`""` whole forest, `host/etc`, `pct/101/etc`), never
 * interpolated into a shell command — it only indexes the local node store — but is
 * still charset-validated as defense in depth (§Security: the one new free-form input).
 */

const ScopeSchema = z
  .string()
  .regex(/^$|^[a-zA-Z0-9_./-]+$/, "scope must be a forest path (e.g. host/etc, pct/101/etc)")
  .optional();

export const ComputeTreeInputSchema = z.object({
  level: z.enum(["l1", "l2", "l3"]).optional().describe("Tracking depth; defaults to the configured level."),
  scope: ScopeSchema.describe("Reserved forest-path scope (v1 always refreshes the whole forest)."),
});
export const VerifyIntegrityInputSchema = z.object({
  level: z
    .enum(["l1", "l2", "l3", "smart"])
    .optional()
    .describe('Depth; "smart" runs L1-gated escalation. Defaults to the configured level.'),
  scope: ScopeSchema.describe("Forest path to limit the drift report to (default whole forest)."),
  autoAccept: z
    .boolean()
    .optional()
    .describe("Apply the audited auto-accept policy after the read-only report (default false)."),
});
export const AcceptTruthInputSchema = z.object({
  scope: ScopeSchema.describe("Forest path to fold into the baselines (default whole forest)."),
});

export type ComputeTreeInput = z.infer<typeof ComputeTreeInputSchema>;
export type VerifyIntegrityInput = z.infer<typeof VerifyIntegrityInputSchema>;
export type AcceptTruthInput = z.infer<typeof AcceptTruthInputSchema>;

/**
 * ADR-010 §2 — optional cached-state sink. When the server wires one, every
 * `verify_integrity` report is persisted so the UI drift view can render the last
 * drift with no live session. The report carries forest paths + content *hashes*
 * (never file content), so it is persisted as-is. Minimal interface so `tools/`
 * never imports `ui/` (structurally a `SnapshotStore<unknown>`).
 */
export interface DriftSnapshotSink {
  save(report: unknown): void;
}

/** Open the SQLite node store at the configured path (creating its directory). */
export function openIntegrityStore(cfg: Config): NodeStore {
  if (cfg.integrity.dbPath !== ":memory:") fs.mkdirSync(path.dirname(cfg.integrity.dbPath), { recursive: true });
  return new SqliteNodeStore(new Database(cfg.integrity.dbPath));
}

export async function computeTreeHandler(
  input: ComputeTreeInput,
  engine: IntegrityEngine,
  audit: AuditLog,
  cfg: Config
): Promise<{ level: string; rootHash: string | null; nodeCount: number; auditId: string }> {
  const level = input.level ?? cfg.integrity.level;
  const { rootHash, nodeCount } = await engine.computeTree(level, "baseline");
  const record = buildAuditRecord({
    tool: "compute_tree",
    host: cfg.ssh.host,
    hashScope: scopeLabel(input.scope),
    afterHash: rootHash ?? undefined,
    note: `compute_tree ${level}: ${nodeCount} nodes, root ${rootHash?.slice(0, 12) ?? "—"}`,
  });
  await audit.append(record);
  return { level, rootHash, nodeCount, auditId: record.id };
}

export async function verifyIntegrityHandler(
  input: VerifyIntegrityInput,
  engine: IntegrityEngine,
  cfg: Config,
  // ADR-010 — optional cached-state sink (persist each report for the UI panel).
  store: DriftSnapshotSink | null = null
): Promise<unknown> {
  const level = input.level ?? cfg.integrity.level;
  const scope = input.scope ?? SUPER_ROOT;
  // The report itself is read-only (like diff_config/query_audit) and not audited.
  const report = await engine.verify(level, scope);
  if (input.autoAccept && !report.baselineSeeded) {
    const accepted = await engine.autoAccept(level, scope); // each fold is audited internally
    const result = { ...report, autoAccepted: accepted.folded, stillFlagged: accepted.flagged };
    store?.save(result);
    return result;
  }
  store?.save(report);
  return report;
}

export async function acceptTruthHandler(
  input: AcceptTruthInput,
  engine: IntegrityEngine,
  _cfg: Config
): Promise<{ auditId: string; rootHash: string | null; levels: string[]; scope: string }> {
  const scope = input.scope ?? SUPER_ROOT;
  const res = await engine.acceptTruth(scope); // audited inside the engine
  return { ...res, scope: scopeLabel(input.scope) };
}

function scopeLabel(scope: string | undefined): string {
  return !scope || scope === SUPER_ROOT ? "/" : scope;
}
