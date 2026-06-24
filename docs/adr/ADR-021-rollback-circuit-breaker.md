# ADR-021: The Rollback Circuit Breaker — a Cross-Call Guardrail Against Thrash Loops

**Status:** Accepted (implemented 2026-06-23)
**Date:** 2026-06-22
**Deciders:** Ethan
**Depends on:** ADR-003 (the rollback verbs `revert_file`/`snapshot_rollback`; backup/target-descriptor model), ADR-004 (the denylist/confirm **tripwire doctrine** + the pure-guardrail-function pattern this matches), ADR-008 (`guest_backup_restore` — the third rollback verb), ADR-015 (auditStats silent-failure signals — the refusal row becomes one), ADR-020 (which deferred this exact item, naming the session-state open question)
**Required by:** — none yet —
**Realizes deferral:** ADR-020 "Scope boundaries → Deliberately excluded backlog" item 8 ("circuit breaker — needs session-state semantics")
**Source:** `docs/tool-ideas.md` item 8 ("rollback circuit breaker — the 'panicked agent' guard"), the last small-lift item of the live dogfooding backlog. Items 9 (semantic history) and 10 (`index_path`) remain deferred large lifts (embedding dependency + ADR-006 write-path invariant; two non-existent indexer subsystems) and stay ranked in `tool-ideas.md`.

## Context

Every other guardrail in this system reasons about **one call**: the denylist inspects one command, `validatePath` one path, `detectLargeFileWrite` one write. The one failure mode none of them can see is a **loop across calls**: an agent hits an error, blindly `revert_file`/`snapshot_rollback`/`guest_backup_restore`s, re-runs the same faulty command, fails the same way, rolls back again — burning tokens and churning the node with no backstop. The rollback verbs are precisely the ones a confused agent reaches for, and precisely the ones that are heavy (a `snapshot_rollback` stops/rolls/starts a guest; a `guest_backup_restore` is the heaviest hammer in the toolkit). A thrash loop on them is the worst-cost, highest-churn way an automated caller can fail.

ADR-020 ranked this item (`tool-ideas.md` 8) cheap and "squarely in the guardrail-doctrine wheelhouse" but **excluded it for one reason**: it is a *cross-call* policy, and the stdio server "keeps little per-session state today" — "session" and "reset" were undefined. That is the only open question, and it has a clean answer this ADR records.

**The session-state answer (the thing ADR-020 was missing).** The MCP stdio transport is **one client over one long-lived process** — `index.ts` constructs the transport/audit/backup singletons once and serves every tool call from them (the agent's investigation confirmed: no request-scoped state, `activeTier` resolved once at startup, the process *is* the session). So for this server "session" needs no new identity plumbing: **session = process lifetime**. A per-process in-memory counter is exactly per-session, and a process restart — a deliberate human action — is the natural, strongest "reset." That single observation collapses ADR-020's blocker.

This is **not a new tool and not a new subsystem.** It is one more pure guardrail function plus a thin in-memory counter, wired into the three handlers that already exist. No new transport, store, dependency, or `TOOL_MIN_TIER` row.

## Decision

Add a **rollback circuit breaker**: a cross-call guardrail that refuses a rollback-family verb once it has fired too many times against the **same target** within a sliding time window, audits the refusal, and self-heals.

### 1. What it guards — the rollback family, keyed by target

The breaker wraps exactly the three rollback verbs, each at its existing tier (no tier change):

| Verb | ADR | Target key (`rollbackTargetKey`) |
|------|-----|----------------------------------|
| `revert_file` | 003 | the backup target descriptor (`host/<path>`, `pct/<vmid>/<path>`, `qm:<vmid>:<path>`, `docker:<vmid>:<container>:<path>`) |
| `snapshot_rollback` | 003 | the guest VMID |
| `guest_backup_restore` | 008 | the guest VMID |

Keying on the **target** (not a global counter) is deliberate: the failure mode is "revert *the same thing* in a loop." A legitimate revert of file A must not trip the breaker for an unrelated restore of guest 105. The thrash loop hammers one key; an honest operator's reverts spread across keys.

### 2. The decision — a pure sliding-window evaluator

The core is a pure function, matching the `checkCommand`/`validatePath`/`detectLargeFileWrite` pattern (`guardrails/rollbackBreaker.ts`):

```
evaluateRollbackBreaker(history: number[], now: number, windowMs, limit)
  → { tripped: boolean, recentCount: number }
```

`history` is the timestamps of prior rollback calls against this target; `recentCount` counts those within `[now - windowMs, now]`. **`tripped` when `recentCount >= limit`.** A sliding window — rather than an absolute monotonic counter — is chosen because the failure mode is a *rapid* loop: the window precisely targets "K rollbacks of one target in N minutes" and **auto-forgives** spread-out legitimate reverts, so a long session never accrues false strikes and no mandatory reset ceremony is needed.

The thin stateful shell is a `RollbackBreaker` holding `Map<targetKey, number[]>`, constructed once in `index.ts` (a process singleton beside `audit`/`backupStore`) and injected into the three handlers. It records a timestamp on each *attempt* and asks the pure core whether this attempt trips. `now` is injected (`Date.now()` in the shell, a fixture in tests) so the core stays pure and deterministic.

### 3. The refusal — audited, structured, recoverable

On a trip the handler **refuses before executing** and **writes an audit record for the refusal** — a small new capability: refusals (denylist DENY, missing `confirm`) are *not* audited today (they throw before `audit.append`). A tripped breaker is a forensically valuable event ("an automated caller was looping on guest 105") and an ADR-015 silent-failure signal, so it gets a row: the rollback tool's name, the target, `refused: true`, `circuitBreaker: { recentCount, limit, windowMs }`. The thrown error is structured and names the recovery path: *"Rollback circuit breaker tripped for `<target>` (`N` reverts in `M`min). Stop and hand back to a human, wait for the window to clear, or re-issue with `overrideCircuitBreaker: true`."*

**The override is loud, not free.** Each rollback verb gains an optional `overrideCircuitBreaker?: boolean`. Set, it bypasses the breaker for that one call and audits the bypass with a distinct flag (`circuitBreakerOverridden: true`) — a deliberate, flagged, recorded act, kept separate from `confirm` (which already means "yes, this is destructive") so the two intents never blur. This is consistent with the project's standing doctrine: **a tripwire that forces a pause and a visible decision, not an unbypassable lock.** It breaks the *blind identical-retry* loop (a panicked agent re-issuing the exact same call is stopped and must take a new, audited action) without trapping a human-directed deliberate retry.

### 4. Config

`guardrails.rollbackBreaker` in `config.ts`, env-overridable like every other cap:

- `enabled` (default `true`) — a kill switch; off ⇒ the breaker is a no-op pass-through.
- `limit` (default `3`) — refuse on the 3rd rollback of one target inside the window (matches `tool-ideas.md`'s "K=3").
- `windowMs` (default `600_000` — 10 min) — the sliding window.

## Scope boundaries

- **A guardrail, not a tool.** No new `TOOL_MIN_TIER` row, no new MCP surface, no new transport/store/dependency. The breaker is wired into the three existing handlers exactly like `checkCommand` is wired into `execute`/`pct_exec`. This is *why* it is the one small-lift item left in the backlog.
- **Target-keyed, process-scoped, self-healing.** State is per-target, in-memory, for the process lifetime; the sliding window forgives over time. No persistence, no cross-process coordination, no new "session id" plumbing — a restart is the strongest reset and is a human act.
- **Refusal-auditing is the one genuinely new behaviour.** It is small and contained (a record on the refusal path) and is justified by the forensic/metrics value; it does not change any success path.
- **Tier-neutral.** The breaker never grants or removes a capability — it only *delays/refuses* a verb the caller's tier already allowed. It applies at whatever tier the wrapped verb already sits (`revert_file` by target kind, the other two at companion).
- **Excluded backlog (unchanged from ADR-020).** Item 9 (semantic history — embedding dependency + ADR-006's "git never on the write's critical path" invariant) and item 10 (`index_path` — two indexer subsystems that do not exist in this repo) remain large lifts, out of scope, ranked in `tool-ideas.md`.

## Consequences

**Positive.** The one cross-call failure mode the per-call guardrails are blind to — a rollback thrash loop — gets a backstop, on the three heaviest/most-tempting verbs, at the cheapest possible cost (one pure function + one in-memory map). The refusal is structured and audited, so the ADR-010 UI and ADR-015 metrics gain a "the agent was looping" signal that today is invisible. ADR-020's lone deferral reason is resolved and recorded: for a stdio server, session = process, so no new state plumbing was ever needed.

**Negative / cost.** A new (small) stateful object in `index.ts` — the first guardrail that *carries state* rather than being a pure verdict over its inputs (the pure core preserves testability, but the shell is genuinely stateful, a first for `guardrails/`). One new optional param (`overrideCircuitBreaker`) on three tool schemas. A new audit shape (the refusal row) that downstream readers must tolerate. Three config knobs to maintain.

**Honest limits.**
- **A tripwire, not a sandbox** (the recurring project truth). A determined caller can set `overrideCircuitBreaker: true` on every call and defeat the breaker; the value is the forced pause, the broken identical-retry loop, and the loud audit trail — not containment. A caller that *varies* its target each call also never trips it.
- **Per-process only.** Two concurrent MCP processes (unusual for stdio, but possible) keep independent counters; the breaker bounds a loop within one client/process, not across the fleet. Persisting strikes was deliberately rejected — it would resurrect the "what is a session / how to reset" complexity ADR-020 flagged, for a failure mode that is inherently within one runaway process.
- **Window, not semantics.** The breaker counts calls; it cannot tell a *productive* rapid revert (operator iterating deliberately) from a *blind* one. It mitigates the blind case and forgives the productive one via the window + the audited override — it does not understand intent.
- **Heuristic K/window.** `limit=3`/`windowMs=10min` are defaults, not proofs; they are config so a noisy real workload can tune them. Too-tight values annoy; too-loose values let a loop run longer. The honest answer is "tunable, observed via the new audit signal," not "correct."

## Implementation notes

- **`guardrails/rollbackBreaker.ts`** — pure `evaluateRollbackBreaker(history, now, windowMs, limit) → { tripped, recentCount }` and `rollbackTargetKey(...)` (the descriptor/VMID key builder). Unit-tested without I/O, like the other guardrails (target the ~90%+ guardrail-coverage bar in CLAUDE.md). The stateful `RollbackBreaker` shell (the `Map<key, number[]>` + `record`/`check` methods over the pure core) lives here too, tested with an injected `now`.
- **`index.ts`** — construct one `RollbackBreaker` singleton beside `audit`/`backupStore`; inject it into `revertFileHandler`, `snapshotRollbackHandler`, `guestBackupRestoreHandler`. Registration is otherwise unchanged (still `register(...)` gated by `isToolEnabled`).
- **The three handlers** (`tools/revertFile.ts`, `tools/snapshotTools.ts`, `tools/backupTools.ts`) — before executing: compute the target key, call `breaker.check(key, now)`, and on a trip write the refusal audit row and throw the structured error (unless `overrideCircuitBreaker` is set, which records the bypass flag and proceeds). On the success path, nothing changes except the existing audit record may carry `circuitBreakerOverridden: true` when the override was used.
- **`audit/record.ts`** — extend the record/`AuditTool` shape to carry the refusal (`refused: true`, `circuitBreaker {…}`) and the override flag. This is the only schema touch; the metrics layer (ADR-015 `auditStats`) can then count breaker trips as a silent-failure/refusal signal.
- **`config.ts`** — add `guardrails.rollbackBreaker { enabled, limit, windowMs }` with env overrides (`ROLLBACK_BREAKER_ENABLED`/`_LIMIT`/`_WINDOW_MS`), matching the existing `tools.*`/`guardrails.*` pattern.
- **Docs:** on implementation, note the breaker in CLAUDE.md (the "Transport & guardrail trust model" / guardrails section, not the tool table — it is not a tool) and tick `tool-ideas.md` item 8 with the ADR-021 forward pointer (mirroring the item 1–7 → ADR-016/017/020 convention).

## As-built (2026-06-23)

Implemented exactly as specified above; no design deltas. Files: new `guardrails/rollbackBreaker.ts` (pure `evaluateRollbackBreaker`/`rollbackTargetKey`/`breakerRefusal` + the stateful `RollbackBreaker` shell with an injected `now`) and `guardrails/rollbackBreaker.test.ts` (14 cases over the pure core + shell); `audit/record.ts` extended with `refused`/`circuitBreaker`/`circuitBreakerOverridden`; `config.ts` `guardrails.rollbackBreaker` + the three env overrides; one `RollbackBreaker` singleton in `index.ts` injected into all three handlers; the breaker check + refusal-audit + override-flag wired into `revertFile.ts`, `snapshotTools.ts`, `backupTools.ts`. Handler-level integration coverage lives in `revertFile.test.ts` (refusal row, override bypass, distinct-target independence). Two implementation choices worth recording: (1) the breaker param is **optional** on each handler (`breaker?`), matching the existing `history?` precedent — `index.ts` always injects it, but a handler unit test may omit it; absent ⇒ the check is skipped (no silent enforcement gap, since the live wiring always passes it). (2) An **overridden** call deliberately does **not** record a timestamp (the override skips `check` entirely), so a subsequent non-override call sees the still-hot window and re-trips — each override is its own loud, audited decision rather than a quiet reset of the counter. Full unit suite green (1284 tests).
