/**
 * Auto-accept policy engine (ADR-009 §6) — the one deliberately-relaxed safety
 * surface, kept pure and fenced. Given a batch of drifted leaves (each annotated
 * with which levels drifted + the explained/unexplained verdict from the audit
 * join), decide per leaf whether the baseline auto-folds or stays flagged for an
 * explicit `accept_truth`. **Every fold this returns is audited by the caller** —
 * that mandatory log is what keeps auto-accept honest (§6, Security Model).
 *
 * The fence, in precedence order:
 *   1. explained (new hash matched an audit `afterHash`) ⇒ always fold — caused and
 *      recorded by the server; the audit log is its authorization.
 *   2. sensitive path (e.g. `/etc/pve`) ⇒ never fold, regardless of count or level —
 *      the ADR-007 protected-set instinct.
 *   3. L2 config/yml content drift, unexplained ⇒ flag by default (the headline
 *      feature; loosenable only by explicit `allowL2AutoAccept`).
 *   4. L3-only (content drifted but not config), unexplained ⇒ fold up to
 *      `maxUnexplainedL3` across the batch; the tail over budget is flagged.
 *   5. L1-only (mtime moved, content identical at L2/L3), unexplained ⇒ fold freely —
 *      zero content risk by definition (`touch`, no-op re-save).
 */
import { globToRegExp } from "../history/sweepPlanner.js";

export interface AcceptPolicyConfig {
  /** Budget of unexplained L3-only (non-config) folds per batch; tail over it is flagged. */
  maxUnexplainedL3: number;
  /** Off by default — the L2 config-drift headline must not be auto-silenced out of the box. */
  allowL2AutoAccept: boolean;
  /** Node-path globs that never auto-accept; defaults include `/etc/pve`. */
  sensitiveGlobs: string[];
}

export interface LeafDrift {
  /** Forest path (e.g. `host/etc/pve/storage.cfg`). */
  path: string;
  /** Real node path for sensitive matching (e.g. `/etc/pve/storage.cfg`). */
  nodePath: string;
  explained: boolean;
  explainedBy?: string;
  /** Did this leaf's hash differ from baseline at each level? */
  l1: boolean;
  l2: boolean;
  l3: boolean;
}

export type Decision = "fold" | "flag";
export type Reason =
  | "explained"
  | "sensitive"
  | "l2-config"
  | "l3-tail"
  | "l3-over-threshold"
  | "l1-only"
  | "no-drift";

export interface PolicyOutcome {
  path: string;
  decision: Decision;
  reason: Reason;
  explainedBy?: string;
}

/** True if `nodePath` is the sensitive path itself, lives under it, or matches a sensitive glob. */
export function isSensitivePath(nodePath: string, globs: string[]): boolean {
  for (const g of globs) {
    if (g.includes("*") || g.includes("?")) {
      if (globToRegExp(g).test(nodePath)) return true;
    } else {
      // wildcard-free entry ⇒ subtree prefix on a `/` boundary (so /etc/pve ⊃ /etc/pve/x,
      // but /etc/pvexyz is NOT caught).
      const base = g.replace(/\/+$/, "");
      if (nodePath === base || nodePath.startsWith(base + "/")) return true;
    }
  }
  return false;
}

/**
 * Decide each leaf. `maxUnexplainedL3` is a batch budget consumed in input order;
 * callers wanting deterministic prioritization should pre-sort `drifts` by path.
 */
export function applyAcceptPolicy(drifts: LeafDrift[], cfg: AcceptPolicyConfig): PolicyOutcome[] {
  let l3Budget = cfg.maxUnexplainedL3;
  const out: PolicyOutcome[] = [];

  for (const d of drifts) {
    out.push(decide(d, cfg, () => (l3Budget > 0 ? (l3Budget--, true) : false)));
  }
  return out;
}

function decide(d: LeafDrift, cfg: AcceptPolicyConfig, takeL3Budget: () => boolean): PolicyOutcome {
  const base = { path: d.path };

  if (!d.l1 && !d.l2 && !d.l3) return { ...base, decision: "flag", reason: "no-drift" };

  // 1. explained — always fold, no further gates.
  if (d.explained) return { ...base, decision: "fold", reason: "explained", explainedBy: d.explainedBy };

  // 2. sensitive — never fold.
  if (isSensitivePath(d.nodePath, cfg.sensitiveGlobs)) {
    return { ...base, decision: "flag", reason: "sensitive" };
  }

  // 3. L2 config content drifted, unexplained — flag unless explicitly loosened.
  if (d.l2) {
    return cfg.allowL2AutoAccept
      ? { ...base, decision: "fold", reason: "l2-config" }
      : { ...base, decision: "flag", reason: "l2-config" };
  }

  // 4. L3-only (content, non-config) — fold up to the batch budget.
  if (d.l3) {
    return takeL3Budget()
      ? { ...base, decision: "fold", reason: "l3-tail" }
      : { ...base, decision: "flag", reason: "l3-over-threshold" };
  }

  // 5. L1-only (mtime moved, content identical) — fold freely.
  return { ...base, decision: "fold", reason: "l1-only" };
}
