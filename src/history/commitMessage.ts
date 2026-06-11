import type { BackupTarget } from "../backup/store.js";

/**
 * Commit-message format for the config-history repo (ADR-006 §2/§3).
 *
 * Messages are deliberately greppable and audit-joinable: the subject line names
 * the tool + target, and a trailing `audit: <uuid>` line lets ADR-005's
 * `query_audit` (and a human with `git log --grep`) join the history to the
 * audit log. Pure string construction — no I/O, fixture-stable.
 */

/** Render a target descriptor the same way the audit/backup layers key it. */
export function targetDescriptor(target: BackupTarget): string {
  if (target.kind === "pct") return `pct:${target.vmid}:${target.remotePath}`;
  if (target.kind === "qm") return `qm:${target.vmid}:${target.remotePath}`;
  return `host:${target.remotePath}`;
}

/**
 * Mutation-commit message, e.g.:
 *
 *   write_file pct:104:/etc/wireguard/wg0.conf
 *
 *   audit: 5e2f...-uuid
 */
export function mutationCommitMessage(
  tool: string,
  target: BackupTarget,
  auditId: string
): string {
  return `${tool} ${targetDescriptor(target)}\n\naudit: ${auditId}`;
}

/**
 * Sweep-commit message, e.g.:
 *
 *   config_sweep host, pct:104, pct:107
 *
 *   audit: 5e2f...-uuid
 */
export function sweepCommitMessage(targetsSummary: string, auditId: string): string {
  return `config_sweep ${targetsSummary}\n\naudit: ${auditId}`;
}

/** Human/grep-friendly one-line summary of the targets a sweep touched. */
export function sweepTargetsSummary(targets: Array<"host" | { vmid: number }>): string {
  if (targets.length === 0) return "(no targets)";
  return targets.map((t) => (t === "host" ? "host" : `pct:${t.vmid}`)).join(", ");
}
