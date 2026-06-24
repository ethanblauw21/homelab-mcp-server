/**
 * Rollback circuit breaker (ADR-021) — the one *cross-call* guardrail.
 *
 * Every other guardrail reasons about a single call (`checkCommand` one command,
 * `validatePath` one path, `detectLargeFileWrite` one write). The failure mode
 * none of them can see is a **thrash loop**: a confused agent reverts, re-runs the
 * same faulty command, fails the same way, reverts again — burning tokens and
 * churning the node. The rollback verbs (`revert_file`, `snapshot_rollback`,
 * `guest_backup_restore`) are exactly the ones a panicked caller reaches for and
 * exactly the heaviest, so a loop on them is the worst-cost way to fail.
 *
 * The breaker refuses a rollback verb once it has fired `limit` times against the
 * **same target** inside a sliding `windowMs`. Keyed on the target (not a global
 * counter) so a legitimate revert of file A never trips the breaker for an
 * unrelated restore of guest 105 — the loop hammers one key; honest reverts
 * spread across keys. Self-healing: the window forgives over time, so no reset
 * ceremony is needed (and a process restart — session == process for a stdio MCP
 * server, ADR-021 — is the strongest reset).
 *
 * Pure core (`evaluateRollbackBreaker`, `rollbackTargetKey`, `breakerRefusal`) +
 * a thin stateful shell (`RollbackBreaker`, a `Map<key, number[]>`, the first
 * guardrail that carries state). `now` is injected so the core stays deterministic.
 * A tripwire, not a sandbox: a caller that sets `overrideCircuitBreaker` on every
 * call, or that varies its target each call, defeats it — the value is the forced
 * pause, the broken identical-retry loop, and the loud audit trail.
 */

/** Settings for the breaker (mirrors `config.guardrails.rollbackBreaker`). */
export interface RollbackBreakerConfig {
  enabled: boolean;
  limit: number;
  windowMs: number;
}

/** The breaker's verdict for one attempt, plus the params (for the audit row). */
export interface BreakerVerdict {
  tripped: boolean;
  recentCount: number;
  limit: number;
  windowMs: number;
}

/**
 * Pure sliding-window evaluator. `history` is the timestamps of rollback attempts
 * against one target (including the current attempt); `recentCount` is how many
 * fall within `[now - windowMs, now]`. Trips when `recentCount >= limit`.
 */
export function evaluateRollbackBreaker(
  history: number[],
  now: number,
  windowMs: number,
  limit: number
): { tripped: boolean; recentCount: number } {
  const cutoff = now - windowMs;
  const recentCount = history.reduce((n, t) => (t >= cutoff ? n + 1 : n), 0);
  return { tripped: recentCount >= limit, recentCount };
}

/**
 * The target key the breaker counts against. Reuses the backup target-descriptor
 * grammar for file reverts (so the key reads like the descriptors elsewhere) and
 * `guest/<vmid>` for the whole-guest verbs. Accepts a `BackupTarget`-shaped object
 * (revert_file) or `{ kind: "guest", vmid }` (snapshot_rollback/guest_backup_restore).
 */
export function rollbackTargetKey(t: {
  kind: string;
  remotePath?: string;
  vmid?: number;
  container?: string;
}): string {
  switch (t.kind) {
    case "host":
      return `host/${t.remotePath}`;
    case "pct":
      return `pct/${t.vmid}/${t.remotePath}`;
    case "qm":
      return `qm:${t.vmid}:${t.remotePath}`;
    case "docker":
      return `docker:${t.vmid}:${t.container}:${t.remotePath}`;
    case "guest":
      return `guest/${t.vmid}`;
    default:
      return `${t.kind}/${t.remotePath ?? t.vmid ?? ""}`;
  }
}

/** Build the structured refusal message + the `circuitBreaker` audit sub-object. */
export function breakerRefusal(
  key: string,
  verdict: BreakerVerdict
): { message: string; circuitBreaker: { recentCount: number; limit: number; windowMs: number } } {
  const mins = Math.max(1, Math.round(verdict.windowMs / 60_000));
  const message =
    `Rollback circuit breaker tripped for ${key}: ${verdict.recentCount} rollbacks within ` +
    `${mins} min (limit ${verdict.limit}). Stop and hand back to a human, wait for the window ` +
    `to clear, or re-issue with overrideCircuitBreaker: true.`;
  return {
    message,
    circuitBreaker: { recentCount: verdict.recentCount, limit: verdict.limit, windowMs: verdict.windowMs },
  };
}

/**
 * The thin stateful shell: a per-target `Map<key, number[]>` for the process
 * lifetime. `check` records this attempt's timestamp, prunes anything older than
 * the window, and asks the pure core whether the attempt trips. Constructed once
 * in `index.ts` (a process singleton beside `audit`/`backupStore`) and injected
 * into the three rollback handlers.
 */
export class RollbackBreaker {
  private readonly history = new Map<string, number[]>();

  constructor(private readonly cfg: RollbackBreakerConfig) {}

  /**
   * Record an attempt against `key` at `now` and return the verdict. Disabled ⇒
   * a pass-through `{ tripped: false }` that records nothing (true no-op). Prunes
   * out-of-window timestamps so the map cannot grow without bound for a hot key.
   */
  check(key: string, now: number): BreakerVerdict {
    if (!this.cfg.enabled) {
      return { tripped: false, recentCount: 0, limit: this.cfg.limit, windowMs: this.cfg.windowMs };
    }
    const cutoff = now - this.cfg.windowMs;
    const pruned = (this.history.get(key) ?? []).filter((t) => t >= cutoff);
    pruned.push(now); // this attempt counts toward the window
    this.history.set(key, pruned);
    const { tripped, recentCount } = evaluateRollbackBreaker(pruned, now, this.cfg.windowMs, this.cfg.limit);
    return { tripped, recentCount, limit: this.cfg.limit, windowMs: this.cfg.windowMs };
  }
}
