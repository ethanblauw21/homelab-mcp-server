# ADR-018: Integrity Drift Clarity & Speed — Honest Seeding Signal + Batched L1 Enumeration

**Status:** Accepted (implemented 2026-06-19)
**Date:** 2026-06-19
**Implementation status (2026-06-19, post pressure-test):** Decision §2 (batched L1 `find` enumeration) was **already realized on `master`** and is therefore **descoped from this ADR's implementation** — `buildForestEnumCommand`/`parseForestEnumeration` in `integrity/forest.ts` already emit and parse `find <paths> -printf '%y\t%T@\t%p\n'` for both the host (SSH exec) and each container (`pct exec`), with the pure parser mirroring `sweepPlanner.ts`, the frozen-guest short-circuit preserved, and the L1 mtime encoding aligned (`Math.trunc` epoch seconds → `mtimePayload`). The §4 pressure-test (dimension A) caught this. **Only Decision §1 (the `mode`/`seededReason`/`note` seeded-vs-compared signal + its two result-shape consumers) was built.** This dropped the ADR from size M to S. The §2 text below is retained as the rationale record for the enumeration technique that now lives on `master`.

**Decision §1 — implemented (2026-06-19).** `VerifyReport` (`integrity/integrityEngine.ts`) gained `mode: "seeded" | "compared"` (the field consumers read), `seededReason?` (`no-baseline` | `level-changed` | `scope-new`), and a human-readable `note?` (both present only when `mode === "seeded"`). `baselineSeeded` is kept for back-compat. The reason classifier (`seededReasonFor`) and the note builder (`seededNote`) are **pure, exported, and unit-tested** (invariant 1): all seed-levels empty ⇒ `no-baseline`; a partial subset empty ⇒ `level-changed` (the silent, dangerous re-seed a tracking-level/config change causes — verified by seeding L1 only, then `verify("smart")`). `scope-new` is reserved in the type (the current whole-tree `baselineEmpty("/")` trigger never emits it; documented at the type). **Result-shape consumers (dimension E), both updated:** `metrics/driftStats.ts` now derives the headline trend (`latest`/`previous`/`max`/`trend`) from the **compared** runs only — a seeded run reports `unexplained: 0` because *no detection occurred*, so counting it would falsely flatten the trend; the full `runs` series still carries the seed marker for the chart, and `mode` is preferred over the legacy `baselineSeeded` with a fallback for pre-018 snapshots. `ui/page.ts`'s drift tab reads `mode` (falling back to `baselineSeeded`) and renders a `status-warn` "Baseline RE-SEEDED — detection was NOT running" card for the `level-changed` case, so a re-seed can never read as "all clear." +8 unit tests, full suite green (1177), typecheck + lint clean.
**Deciders:** Ethan
**Depends on:** ADR-006 (`config_sweep`'s single `find -printf '%s\t%p'` batched enumeration — the technique reused here), ADR-009 (the Merkle integrity forest, `verify_integrity`, the L1/L2/L3 levels, `forest.ts` `SubtreeSource`)
**Required by:** — none yet —
**Source:** Dogfooding run 2026-06-19 — the first companion `verify_integrity smart` returned `drift:[], baselineSeeded:true`: a clean-looking result that was actually a no-op (it *established* the baseline), and an L1 pass that stats every watched leaf over SFTP one round-trip at a time.

## Context

ADR-009 built the Merkle integrity forest and `verify_integrity` — the tool that answers "did anything change that the server did not do." Dogfooding it against the live node surfaced two issues, one of honesty and one of speed, both in `verify_integrity` itself.

**1. The seeding run looks identical to a clean run.** The first `verify_integrity` against a fresh (or reconfigured) baseline returns `{ drift: [], baselineSeeded: true }`. ADR-009 §3 is explicit that verify "seeds the baseline on first run and reports no drift" — correct behavior — but the *result shape* makes a seeding run (which detected nothing because there was nothing to compare against) visually indistinguishable from a genuine clean comparison (which detected nothing because nothing changed). `baselineSeeded: true` is present but easy to miss next to an empty `drift` array. For the flagship tamper-detection tool, "no drift" must never be ambiguous about whether detection was actually *running*. This matters most across the exact multi-session, tier-switching workflow this project just exercised: a baseline can get seeded in one session and silently re-seeded in another if config changed, and the operator would read both as "all clear."

**2. The L1 pass is serial SFTP stats.** Smart escalation (ADR-009 §3) is the right design — L1 first, descend to L2/L3 only where L1 flags a touch, so a clean L1 reads zero file content. But the L1 pass itself stats every watched leaf to read its mtime, and `forest.ts`'s `SubtreeSource` does that one SFTP `stat` per file, serially. On a real `/etc` tree that is hundreds of round-trips for the cheapest level — the very level meant to be the fast pre-filter. ADR-006's `config_sweep` already solved this exact problem on the host side: **one `find -printf '%s\t%p'` enumeration** returns size+path for a whole subtree in a single exec, and the sweep planner parses it purely. The forest's L1 mtime read should borrow that technique (`find -printf '%T@\t%p'` for mtime) instead of per-leaf SFTP stats.

Neither is a redesign. Both are refinements to `verify_integrity` that make the tool honest about *when it is actually comparing* and fast at *the level that is supposed to be fast*.

## Decision

Two changes to `verify_integrity` / the forest I/O shell, both confined to ADR-009's subsystem. No change to the fold math (`folding.ts`), the classify join (`classify.ts`), or the accept policy (`acceptPolicy.ts`).

### 1. An unambiguous seeded-vs-compared signal

`verify_integrity`'s result gains an explicit, prominent **`mode`** discriminator: `"seeded"` (this run established or re-established a baseline; **no detection occurred**) vs `"compared"` (this run diffed against an existing baseline). When `mode === "seeded"`, the result carries a human-readable `note` ("Baseline established for <scope>; drift detection begins on the next run") and, critically, **why** it seeded — `seededReason: "no-baseline" | "level-changed" | "scope-new"` — so a *re-seed* caused by a config/level change (the dangerous, silent case) is called out rather than blending into first-run-ever. The existing `baselineSeeded` boolean is kept for back-compat but `mode` is the field the UI and the operator read. The ADR-010 drift renderer and the ADR-015 drift-trend aggregator both special-case `mode: "seeded"` so a seeding run is **not** counted as a zero-unexplained data point (it would falsely flatten the trend).

### 2. Batched L1 enumeration via `find`

`forest.ts`'s L1 mtime read switches from per-leaf SFTP `stat` to **one `find <root> -printf '%T@\t%p\n'` exec per subtree** (host over SSH exec; `pct exec … find` inside a container — the same dual path `config_sweep` uses), parsed by a pure builder/parser pair mirroring `sweepPlanner.ts`. The excludes and the watched-set membership are applied to the enumeration exactly as the forest already applies them. L2/L3 (content hashing) are unchanged — they still read content where smart escalation flags a touch, and that read stays on the existing `pct pull`/SFTP path (content needs the bytes, not just a timestamp). A **stopped guest is still frozen** (ADR-009): `available() === false` short-circuits before the `find`, reusing the last baseline, never read as mass deletion.

## Scope boundaries

- **Confined to `verify_integrity` + the forest I/O shell.** No change to fold determinism, the explained/unexplained classify join, the auto-accept policy, or `accept_truth`. The baselines, DB schema, and super-root semantics are untouched.
- **L1 only for the batched read.** L2/L3 content hashing keeps its per-file content read (it fundamentally needs the bytes); the `find` batching is purely the mtime-enumeration speedup for the L1 pre-filter.
- **Does not realize ADR-009 §9/#11 deferrals.** Off-box/signed root anchoring, the observe-tier L1-structure-only variant, and the ADR-006 blob-hash consolidation remain deferred — *this ADR does not touch them.* It is a clarity+speed refinement, not the deferred-feature backlog.
- **No new tool, no new tier row.** Both changes are to the existing companion-tier `verify_integrity`.

## Consequences

**Positive.** "No drift" stops being ambiguous — `mode: "seeded"` vs `"compared"` tells the operator (and the trend aggregator) whether detection actually ran, and `seededReason` flags the silent re-seed that config/level changes cause. The L1 pre-filter — the level designed to be cheap — becomes genuinely cheap: one `find` per subtree instead of hundreds of serial SFTP stats, so a clean smart-verify is fast as well as content-free.

**Negative / cost.** A small result-shape addition (`mode`/`seededReason`/`note`) that the UI renderer and ADR-015 drift aggregator must learn (both already branch on report contents). A new pure `find`-enumeration parser in the forest I/O shell, held to the guardrail coverage bar. The `find -printf` mtime format (`%T@` = epoch seconds) must be parsed consistently with how the fold encodes L1 mtime bytes — a one-time alignment, tested.

**Honest limits.**
- **`mode` reports the baseline's existence, not its trustworthiness.** A seeded baseline blesses whatever state the node is in *now*; if the node was already tampered at seed time, "seeded" honestly says "I am now treating this as truth" — it cannot retroactively know the pre-seed state. This is the same client-side, node-rebuildable boundary ADR-009 stated up front.
- **`find`-based mtime is as spoofable as the SFTP stat it replaces.** L1 was always the weakest, `touch -r`-spoofable level (ADR-009 §1); batching the read changes its *speed*, not its *strength*. L2/L3 content hashing remains the real integrity signal.
- **Batched enumeration assumes `find` on the target.** Present on the Proxmox host and every Debian LXC here (it is what `config_sweep` already relies on); a guest without `find` falls back to the existing per-leaf path.

## Implementation notes

- **Forest I/O (`integrity/forest.ts`):** add a `find -printf '%T@\t%p\n'` enumeration for the L1 mtime read (host SSH exec / `pct exec` per subtree), with a pure builder/parser pair alongside `forestShape.ts` mirroring `sweepPlanner.ts`'s `find` parsing. Excludes + watched-set membership applied as today; frozen-guest short-circuit preserved.
- **Engine (`integrity/integrityEngine.ts`):** compute `mode`/`seededReason`/`note` in the verify path; keep `baselineSeeded` for back-compat.
- **Renderer + metrics:** `ui/artifacts.ts` drift panel and `metrics/driftStats.ts` (ADR-015) special-case `mode: "seeded"` so a seeding run is not a zero-unexplained trend point.
- **Tests:** seeding-vs-compared discrimination (incl. the re-seed-on-level-change case); `find`-enumeration parser vs the existing per-leaf path producing the same L1 fold; frozen-guest path unchanged.
- **CLAUDE.md:** update the ADR-009 section's `verify_integrity` description with the `mode` signal **once implemented**.
