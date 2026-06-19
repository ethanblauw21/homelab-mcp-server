# Implementation Flow — ADRs 016–019

**Status:** Active plan
**Date:** 2026-06-19
**Owner:** Ethan
**Covers:** ADR-016 (Docker introspection), ADR-017 (Tool output budgeting), ADR-018 (Integrity drift clarity & speed), ADR-019 (Opt-in read-family redaction)
**Companion docs:** `docs/adr/ADR-000-template.md` (reliance-marker convention), each ADR's own *Implementation notes* / *Action Items*.

---

## 0. Purpose

These four ADRs are **Proposed**, not yet built. This document is the bridge from *proposal* to *merged code* — the phased path each ADR walks, the comprehension gates ("understands") that must be true before moving forward, and — non-negotiably — a **pressure-test of every ADR *before* a line of implementation code is written.** The fix-branch cleanup that preceded this (two branches whose work had already been silently reimplemented on master under different names) is the cautionary tale this flow is built to prevent: **assume nothing about an ADR until it has been re-challenged against today's `master`.**

The flow is deliberately the same shape for all four, so the process is muscle-memory; the per-ADR specifics live in §7.

---

## 1. Scope & dependency recap

| ADR | One line | Depends on (all already on `master`) | Realizes a deferral? | Relative size |
|---|---|---|---|---|
| **016** | `docker_inspect` / `docker_stats` / `compose_discover` + named-volume `docker_read_file` fast path | 002, 004, 008 | No | **L** (new tools + parsers) |
| **017** | `query_audit` cmd projection · `health_check` pseudo-fs filter · census `status` depth · `describe_guest` | 002, 005, 011 | **Yes** — ADR-011 §1 output-side levers | **M** (additive flags + 1 new tool) |
| **018** | `verify_integrity` `mode: seeded\|compared` + batched `find` L1 enumeration | 006, 009 | No | **M** (subsystem-local) |
| **019** | opt-in `redact` on the four `*_read_file` tools | 002, 004 | No | **S** (one flag, four call sites) |

**None of 016–019 depend on each other** — they are independently mergeable. Their dependencies are all on *already-merged* ADRs, which is exactly what the pressure-test must re-verify (§4), because "merged" ≠ "shaped the way the ADR assumed."

---

## 2. Guiding invariants (these gate every ADR — pulled from CLAUDE.md)

Understand these before touching any code; an implementation that violates one is wrong even if it "works":

1. **Pure core, thin I/O shell.** Builders/parsers/policy are pure functions with **no I/O** (`dockerHelpers.ts`, `sweepPlanner.ts`, `acceptPolicy.ts`, … are the precedent). New logic lands in a pure module with its own unit tests; the handler is the thin shell. This is the only way the guardrail coverage bar (~90 %+ line/branch) is reachable.
2. **The tier registry is data.** Adding a tool = adding a `TOOL_MIN_TIER` row in `tiers/registry.ts` + registration in `index.ts`, nothing more. Tools above the active tier are **never registered** — there is no runtime refusal path.
3. **No runtime tier escalation, ever.** Raising a tier means re-running setup + restart.
4. **Dependency direction is one-way.** Tool handlers depend on the `SshTransport` / `NodeOps` interfaces (injected). Never import `ssh2Client.ts` / `apiClient.ts` from a handler. `ui/` depends on `tools/`, never the reverse.
5. **The CLAUDE.md tool table is not touched until the tool exists.** Doc-sync is the *last* step of each ADR (§Phase 5), never the first.
6. **Additive-only means provably additive.** ADR-017 and ADR-019 promise zero default-behavior change. That promise is a *test*, not a comment (§4 dimension D).
7. **Honest failure is mandatory.** A refusal/limit stated in an ADR (a not-found `oldString`, a binary read, an over-cap write, a frozen guest) must throw/skip honestly — never a faked success. Redaction over-redacts rather than leaks.
8. **The bidirectional markers stay live.** On merge, flip the ADR's own `Status:` and — if it `Realizes deferral:` — update the deferring ADR's note in place (ADR-017 ⇒ ADR-011 §1). Add any new `Required by:` edges the implementation reveals.

---

## 3. The flow at a glance

```
   ┌─ Phase 0 ─┐   ┌─ Phase 1 ─┐   ┌─ Phase 2 ─┐   ┌─ Phase 3 ─┐   ┌─ Phase 4 ─┐   ┌─ Phase 5 ─┐
   │ UNDERSTAND │→ │  PRESSURE  │→ │  SEQUENCE  │→ │ IMPLEMENT  │→ │  VERIFY &  │→ │ DOCS SYNC  │
   │ the batch  │   │ -TEST the  │   │  & plan    │   │  (TDD per  │   │ INTEGRATE  │   │  & PR      │
   │            │   │   ADRs     │   │            │   │   ADR)     │   │            │   │            │
   └────────────┘   └─────┬──────┘   └────────────┘   └────────────┘   └────────────┘   └────────────┘
                          │
                  ┌───────┴────────┐
                  │ GATE: an ADR    │  A pressure-test may send an ADR BACK to revision
                  │ that fails the  │  (amend the doc, re-pressure-test) instead of forward
                  │ test does NOT   │  to implementation. This gate is the whole point.
                  │ proceed to code │
                  └─────────────────┘
```

Phases 0–2 run **once for the batch**. Phases 3–5 run **per ADR** (the recommended order is §6).

---

## 4. Phase 1 — Pressure-test the ADRs (do this BEFORE any implementation)

> **This phase is the reason the document exists.** No ADR proceeds to Phase 3 until it has passed every dimension below, or been amended until it does. The output of this phase is a short written verdict per ADR: **proceed / amend-first / drop**.

Each ADR is challenged — adversarially, trying to *break* it, not confirm it — against these dimensions:

| # | Dimension | The question to answer (with evidence from `master`, not from the ADR) | Most at risk |
|---|---|---|---|
| **A** | **Already-solved / superseded** | Is any of this *already* on `master` under a different name? Grep for the *behaviour*, not the symbol the ADR proposes. (This is the fix-branch lesson — both were reimplemented under new names.) | 016, 018 |
| **B** | **Dependency truth** | Do the `Depends on:` modules still exist and have the **shape** the ADR assumes? Is `dockerFiles.ts`'s `.Mounts[]` parse still there for 016? Is `sweepPlanner.ts`'s `find -printf` parser reusable for 018? Is the ADR-002 redaction module callable from a read handler for 019? | 016, 018, 019 |
| **C** | **Honest-limits integrity** | Does each *Honest limits* clause actually bound the risk, and is there an **unstated** failure mode? (e.g. 016 env-redaction on `docker_inspect` — does the redactor see nested JSON? 019 — does `redact` on base64 silently imply a scan it didn't do?) | 016, 019 |
| **D** | **Default-behaviour invariance** | For the additive ADRs (017, 019): prove **no existing caller/test changes** when the new flag is absent. Enumerate the call sites and the round-trip consumers (`revert_file`, `diff_config`, backup bytes, integrity hashes) that MUST see true bytes. | 017, 019 |
| **E** | **Result-shape consumers** | Who downstream parses the changed output? 018's new `mode` field is read by `ui/artifacts.ts` *and* `metrics/driftStats.ts` — both must learn it or a seeding run falsely flattens the trend. 017's census `status` depth must not break `CensusStore` consumers. | 018, 017 |
| **F** | **Tier & security boundary** | Does it stay in its declared tier with **no new mutation surface**? 016/017 are read-only/not-audited — confirm nothing writes. 019 must touch **only the return boundary**, never the write/backup/hash/revert path. No secret-leak path widened. | 019, 016 |
| **G** | **Token economy (the actual win)** | Does the change measurably *reduce* tokens (017 is literally this) or at least not regress? Sanity-check the projected savings against a real artifact (e.g. a captured `query_audit` payload). | 017 |
| **H** | **Testability** | Can the new logic be exercised as a **pure function** without a live node? If a piece can't be, the design is wrong — refactor the split before coding. | all |
| **I** | **Scope discipline** | Does the plan stay inside the ADR's stated boundaries and **not** drag in a deferred item (016 ≠ ADR-008 Option D streaming; 018 ≠ ADR-009 §9/#11)? | 016, 018 |
| **J** | **Live-node blast radius** | Worst case if the new code misbehaves against `proxlab`? Read-only tools should be incapable of mutation by construction; confirm. | all |

**How to run it.** For each ADR, work the table top-to-bottom producing evidence (grep results, a fixture, a failing-on-purpose test sketch) — not opinions. A dimension that can't be answered with evidence is itself a finding. This is a good fit for an **adversarial multi-agent pass** (independent reviewers each told to *refute* the ADR on a subset of dimensions, majority-refute kills or amends), but a careful solo pass producing the written verdict is acceptable. Either way the artifact is the same: a per-ADR verdict + the evidence behind it, appended to this doc or the ADR.

**Exit criteria for Phase 1:** every ADR has a written **proceed / amend-first / drop** verdict; every `amend-first` has had its ADR edited (and its reliance markers re-checked) and been re-tested; no ADR carries an unanswered dimension.

---

## 5. The other phases

### Phase 0 — Understand the batch
- **Understand:** what each ADR delivers, why it came out of the dogfooding run, and the §2 invariants. Re-read all four ADRs + their parents' relevant sections.
- **Activities:** confirm the dependency table (§1); skim the parent ADRs' *Implementation notes* for the contracts the new work leans on.
- **Exit when:** you can state, per ADR, the user-visible behaviour change and the single sentence of *why* in your own words.

### Phase 2 — Sequence & plan
- **Understand:** the ADRs are independent, so order is chosen for **risk and learning**, not dependency (§6).
- **Activities:** pick the order; for each ADR, list the exact files to add/touch (§7), the pure module that holds the new logic, and the result-shape consumers to update. One branch per ADR (the project norm), one PR per ADR.
- **Exit when:** each ADR has a file-level checklist and a chosen branch name.

### Phase 3 — Implement (per ADR, TDD loop)
- **Understand:** pure-core-first. Tests for the pure builders/parsers/policy come **before** the handler.
- **Activities:** (1) write the pure module + its unit tests to green; (2) add the `TOOL_MIN_TIER` row / flag schema; (3) write the thin handler over the injected transport/NodeOps; (4) register in `index.ts`; (5) wire result-shape consumers (Phase-1 dimension E). Keep the diff inside the ADR's scope (dimension I).
- **Exit when:** `npm run typecheck` + `npm run lint` + `npm run test:unit` are green and the new pure module meets the guardrail coverage bar.

### Phase 4 — Verify & integrate
- **Understand:** unit-green is necessary, not sufficient; the integration harness (Docker) and a read-only live smoke are the real proof.
- **Activities:** add/extend integration tests where the ADR touches the transport (`docker_*`, `pct exec`, SFTP, the `find` enumeration); run `npm test`. Then a **read-only** smoke against `proxlab` (per the Safety rule — ask before anything that could touch the host; these four are read-mostly by design). Re-confirm default-behaviour invariance (dimension D) with the full suite.
- **Exit when:** full suite green; live read-only smoke matches expectations; no regression in existing tests.

### Phase 5 — Docs sync & PR
- **Understand:** docs-sync is the *last* step (invariant 5) and the **bidirectional markers** are part of "done" (invariant 8).
- **Activities:** update the CLAUDE.md tool table + the relevant subsystem section; flip the ADR `Status:` to Accepted on merge; if the ADR realized a deferral, update the deferring ADR's note in place (017 ⇒ ADR-011 §1) and add any newly-discovered `Required by:` edges; open the PR (body ends with the Claude Code trailer; commits with the Co-Authored-By trailer).
- **Exit when:** PR merged, CLAUDE.md reflects the new tool(s), reliance markers consistent in both directions.

---

## 6. Recommended implementation order

Independent ADRs, ordered by *ascending risk* so the flow itself is validated on the smallest surface first:

1. **ADR-019 (S)** — one flag, four call sites, reuses an existing module. Smallest blast radius; proves the per-ADR loop and the "additive = tested" discipline.
2. **ADR-017 (M)** — additive flags across a few tools + one new read-only tool (`describe_guest`). Exercises the new-tool registration path on safe ground.
3. **ADR-016 (L)** — the largest new surface (three tools + parsers + a file-path fast path); do it once the loop is warm.
4. **ADR-018 (M)** — subsystem-local but touches a result shape two consumers parse (UI + metrics); do it last so the result-shape-consumer discipline (dimension E) is practiced.

This order is a recommendation, not a constraint — because nothing here is a dependency, any of them can move if priorities shift.

---

## 7. Per-ADR implementation notes (file-level)

> Drawn from each ADR's *Implementation notes*; the pressure-test (§4) may revise these before coding.

**ADR-019 — read-family redaction**
- Touch: `tools/readFile.ts`, `tools/pctReadFile.ts`, `tools/qmReadFile.ts`, `tools/dockerFiles.ts` (the read path) — add `redact?: boolean` to each zod schema; on `true` + `encoding === "utf8"`, pass the decoded text through the **ADR-002 redaction module** at the **return boundary only**; set `redacted` / `redactionCount` in the result.
- **Must NOT touch (assert with a regression test):** backup bytes, diff-on-write bytes, integrity content-leaf hashes, `revert_file` restore — all use true bytes.
- Tier: unchanged (no new `TOOL_MIN_TIER` row). Doctrine: amend ADR-004's "reads never redact" → "fidelity by default, opt-in redaction".

**ADR-017 — tool output budgeting**
- `tools/queryAudit.ts`: `cmdMaxChars` (~120 default) / `cmdFull` flags — projection in the **pure** `filter/summarize` core, not the handler.
- `tools/healthEvaluators.ts` + `tools/healthCheck.ts`: pseudo-fs filter + `includePseudoFs`; **rollup computed pre-filter** so status is unaffected.
- `tools/describeHomelab.ts`: new `depth: "status"` between `summary` and `full`.
- New `describe_guest(vmid)` tool: companion, read-only, reuses census parsers; `TOOL_MIN_TIER` row + `index.ts` registration.
- `config.ts`: the new caps/defaults.

**ADR-016 — Docker introspection**
- `tools/dockerHelpers.ts` (pure): builders + parsers for `docker_inspect` (structured, **env-value-redacted**), `docker_stats` (`--no-stream`), `compose_discover` (read-only project map feeding `compose_redeploy`/`compose_preflight`'s `composePath`).
- New handlers: `docker_inspect`, `docker_stats`, `compose_discover` — all companion, read-only, **not audited**, over the existing `pct exec docker …` plumbing.
- `tools/dockerFiles.ts`: named-volume fast path for `docker_read_file` (`.Mounts[]` `Type == "volume"` resolution).
- `tiers/registry.ts`: companion rows; `index.ts`: registration. **Out of scope:** ADR-008 Option D streaming.

**ADR-018 — integrity drift clarity & speed**
- `integrity/forest.ts`: L1 mtime read via **one `find <root> -printf '%T@\t%p\n'` per subtree** (host SSH exec / `pct exec`), with a **pure** builder/parser pair alongside `forestShape.ts` mirroring `sweepPlanner.ts`. Frozen-guest short-circuit preserved; L2/L3 content reads unchanged.
- `integrity/integrityEngine.ts`: compute `mode` (`seeded`|`compared`) + `seededReason` + `note`; keep `baselineSeeded` for back-compat.
- **Result-shape consumers (dimension E):** `ui/artifacts.ts` drift panel and `metrics/driftStats.ts` must special-case `mode: "seeded"` so a seeding run is not a zero-unexplained trend point.

---

## 8. Definition of Done (merge gate, every ADR)

- [ ] Phase-1 pressure-test verdict was **proceed** (or amend-first → amended → re-tested).
- [ ] Pure logic in its own module with unit tests at the guardrail coverage bar.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all green.
- [ ] Additive ADRs: a test proves **no default-behaviour change** when the new flag/param is absent.
- [ ] Result-shape consumers updated (UI / metrics / stores) where the output changed.
- [ ] Read-only live smoke against `proxlab` matches expectations (asked first; read-only by design).
- [ ] CLAUDE.md tool table + subsystem section updated.
- [ ] ADR `Status:` flipped; bidirectional reliance markers consistent both directions (incl. 017 ⇒ ADR-011 §1 deferral note).
- [ ] One branch, one PR, trailers present.

---

## 9. Risks & open questions

- **Redaction coverage (019, 016).** Both lean on the ADR-002 redactor; its best-effort nature is an inherited limit. The pressure-test must confirm it sees the shapes these tools feed it (nested `docker inspect` JSON env, utf8 config text) and that over-redaction — not leakage — is the failure mode.
- **`find -printf` portability (018).** Assumes `find` on host + every LXC (true today — `config_sweep` relies on it). The per-leaf fallback must remain for any guest without it.
- **Result-shape drift (018, 017).** The flagship risk: a changed payload that a consumer silently mis-parses. Dimension E plus a fixture per consumer is the guard.
- **Scope creep into deferred work (016, 018).** The ADRs explicitly fence off ADR-008 Option D and ADR-009 §9/#11; the diff must stay out of them.

---

## 10. Phase-1 pressure-test verdict (2026-06-19)

Run as a four-way parallel evidence sweep against `master`, synthesized solo. Each verdict is backed by file:line evidence from today's tree, not the ADR's own claims.

| ADR | Verdict | Decisive evidence (from `master`) |
|---|---|---|
| **019** | **PROCEED** | `redactString` (`guardrails/redaction.ts:63`) is pure, returns `{value, redactedCount}`, already consumed by `tail_log`/`docker_logs`. All four read handlers share an identical return boundary — `buf.toString(input.encoding)` at `readFile.ts:62`, `pctReadFile.ts:80`, `qmReadFile.ts:79`, `dockerReadFile.ts:102` — and each already carries an `encoding` enum. Dimension D/F: write/backup/integrity-hash (`leafHash.ts`)/`revert_file` all derive bytes from `transport.readFile`/user input, **never** from the read handlers, so a return-boundary redact cannot touch any persisted artifact. No tier change. |
| **017** | **PROCEED** | All four surfaces greenfield (grep: no `cmdMaxChars`/`cmdFull`/`includePseudoFs`/`depth:"status"`/`describe_guest`). `query_audit` has a pure projection slot between `filterAuditRecords`/`summarizeAuditRecords` (`queryAudit.ts:100`). `health_check` rollup (`rollupStatus`, `healthEvaluators.ts:125`) is computed post-collection → a display filter is safe pre-rollup. `describe_homelab` `config`/`docker` already gate on `depth==="full"` (`describeHomelab.ts:307/341`); the `depth` field is stored but never inspected by `CensusStore`/`artifacts.ts` consumers (dimension E clear). `parseGuestConfig` (`censusParsers.ts:143`) is pure/scopable for `describe_guest`. **Decision:** `describe_guest` lands at **companion** (per ADR §4) because its docker-roster/failed-units probes are exec-bound. |
| **016** | **PROCEED** (with directive) | `dockerHelpers.ts` pure builders/parsers + `[a-zA-Z0-9][a-zA-Z0-9_.-]*` charset guard exist; `.Mounts[]` parse (`parseDockerMounts`, `resolveBindMount`) confirmed; all three tools greenfield; no streaming infra (dimension I clear). **Dimension C directive (load-bearing):** `docker_inspect` env redaction must run on the **parsed** env map via `redactRecord(Record<string,unknown>)`, **never** by feeding JSON-escaped `["KEY=val"]` text to `redactString` (the regex won't match through JSON escaping). Named-volume fast path = extend the resolver to accept `m.type==="volume"` whose `Source` is under `/var/lib/docker/volumes/<name>/_data`, same longest-prefix logic, `docker cp` stays the fallback. |
| **018** | **AMEND-FIRST → amended → PROCEED (reduced)** | **Part 2 (batched `find -printf '%T@\t%p'` L1 enumeration) is ALREADY on `master`.** `buildForestEnumCommand` (`forest.ts:111`) emits `find <paths> -printf '%y\t%T@\t%p\n'` for **both** host (SSH exec) and container (`pct exec`); `parseForestEnumeration` (`forest.ts:118`) is the pure parser mirroring `sweepPlanner.ts`; the frozen-guest short-circuit is preserved (`forest.ts:57`); and the mtime encoding aligns (`Math.trunc(Number(...))` → `mtimePayload` UTF-8 seconds, `folding.ts`). This is the dimension-A "already-solved under a different name" trap. **ADR-018 amended** to record part 2 as realized-on-master and rescope implementation to **part 1 only**: the `mode`/`seededReason`/`note` signal on `VerifyReport` (`integrityEngine.ts:142/220`) + the two consumers (`metrics/driftStats.ts` already reads `baselineSeeded`; `ui/artifacts.ts` drift panel passes data through). Size drops **M → S**. |

**Exit criteria met:** every ADR has a written verdict; the single `amend-first` (018) has been amended in place (see ADR-018 *Implementation status* note) and its reliance markers re-checked; no dimension is left unanswered.

**Net effect on §6 order:** unchanged (019 → 017 → 016 → 018), but 018 is now the smallest of the four, not an M.
