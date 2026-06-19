# ADR-017: Tool Output Budgeting — Projection, Depth & Scope Flags for the Read Surface

**Status:** Accepted (implemented 2026-06-19)
**Date:** 2026-06-19
**Deciders:** Ethan
**Depends on:** ADR-002 (`describe_homelab` shape, `VOLATILE_FIELDS`, census parsers), ADR-005 (`query_audit`/`summarizeAuditRecords`, `health_check` fixed-probe evaluators), ADR-011 (token economy as an explicit design axis — the lever taxonomy and roadmap)
**Required by:** — none yet —
**Realizes deferral:** ADR-011 §1 "future tools measured against [token economy]" — extends the doctrine from the *write* surface (edit tools) to the *read* surface (output shaping)
**Source:** Dogfooding run 2026-06-19 — `query_audit limit:15` cost ~6 KB almost entirely from verbatim `cmd` strings; `health_check`'s storage section was ~50% pseudo-/tmpfs noise; `describe_homelab full` shipped ~3.5 KB even when one guest was the subject.

## Context

ADR-011 named **token economy** an explicit design axis and built the *input* side of it — find-and-replace edit tools that send a 1-line diff instead of re-emitting a 600-line file. It framed §1 as a doctrine with a lever taxonomy and a roadmap, so "future tools are measured against it the way they are already measured against the node-safety guardrails." This ADR is the **output** side of that same doctrine: the read tools return more than the operator asked for, and there is no lever to narrow them.

Three concrete offenders, measured during the 2026-06-19 dogfooding run:

1. **`query_audit` dumps full `cmd` strings.** The dominant cost. 15 records ≈ 6 KB, almost all of it verbatim command text — some records carry 500+ chars of bash (the `pct_exec` diagnostic loops ADR-016 is about). An operator scanning "what happened lately" rarely needs the full command; they need tool, target, time, outcome.
2. **`health_check` storage section is padded with pseudo-filesystems.** ~9 of the storage findings are `/dev`, `/run/lock`, `/run/credentials/*`, `efivars`, `/run/user/0` — all 0.0% used and operationally meaningless. Half the section is noise.
3. **`describe_homelab full` is all-or-nothing per node.** Working a single container still re-runs every probe across every guest and ships `containers[].config` + the full `services[].docker` image roster. There is `summary` and `full`, nothing between, and no way to scope to one guest.

These are not bugs — every field is correct. They are **un-budgeted output**: the tools have no projection/depth/scope lever, so the caller pays for the maximal payload every time. ADR-011's doctrine says a tool should be measurable against token cost; these three currently fail that test on the read side.

## Decision

Additive output-shaping flags on three existing read tools, plus one new scoped census tool. **No default-behavior change** — every flag defaults to today's output, so existing callers and tests are unaffected; the savings are opt-in. All four changes are pure output-shaping/scoping over data the tools already compute.

### 1. `query_audit` — `cmd` projection

Add `cmdMaxChars?` (default ~120) that truncates each record's `cmd` to a head window with an explicit `…(+N chars)` marker, and `cmdFull?: boolean` to restore today's verbatim behavior. The summary block (counts by tool/vmid, time span) is unchanged. This is the single biggest read-side win — the `cmd` string is the bulk of every `pct_exec`/`execute` record. Truncation is display-only; the audit log on disk is untouched (it remains the forensic source of truth, readable in full with `cmdFull: true` or by `hashEquals`/`pathContains` filtering to the exact record).

### 2. `health_check` — pseudo-filesystem filtering

The storage evaluator gains a default filter that drops mounts that are tmpfs/pseudo or zero-capacity-by-design (`/dev`, `/run/*`, `/sys/*`, `efivars`, `/run/user/*`), keeping the real ones (`/`, `/boot/efi`, the named storages, data mounts like `/mnt/media`). An `includePseudoFs?: boolean` restores the full list. The rollup status is computed **before** the filter, so a (hypothetical) full `/run` still escalates the rollup even though it is hidden from the default findings list — the filter trims the *display*, never the *evaluation*.

### 3. `describe_homelab` — a `status` depth between `summary` and `full`

Add `depth: "status"` returning identity + run-state + `snapshotCapable` **without** the heavy `containers[].config` LXC blob and **without** the per-guest `services[].docker` roster — the "what exists and is it up" view, which is the common case. `summary` and `full` keep their exact current meaning. (`sections` already lets a caller exclude whole sections; this adds a depth tier *within* the included sections.)

### 4. `describe_guest(vmid, sections?)` — single-guest focused census

A new **read-only, companion-tier** tool that runs the census probes scoped to **one** guest: its redacted config, `snapshotCapable`, docker roster (if a Docker host), failed units, and recent drift for *its* paths. Reuses the ADR-002 census parsers and the redaction module wholesale — it is the node census narrowed to a vmid, not new probe logic. This is the scoping lever for "tell me about 101" that `describe_homelab` (whole-node) cannot provide without shipping everything.

## Scope boundaries

- **Additive only; zero default-behavior change.** Every flag defaults to current output. No existing test or caller changes behavior unless it opts in. This is deliberate — output budgeting must never silently drop a field someone relied on.
- **Display-side, not storage-side.** `query_audit` truncation shapes the *returned* records; `audit.jsonl` on disk is never trimmed (ADR-004/009 forensic integrity is untouched). `health_check` filtering trims the *findings list*, never the rollup evaluation.
- **No new census probe logic.** `describe_guest` and `depth:"status"` reuse the ADR-002 parsers/redaction; they reshape and scope existing output, they do not read anything new from the node.
- **Not a pager.** This is projection/depth/scope, not pagination. `query_audit` already has `limit` + time/path filters for narrowing the record *set*; this ADR narrows each record's *width*.

## Consequences

**Positive.** The three measured offenders get an opt-in diet: `query_audit` reads drop ~60% (the `cmd` bulk), `health_check` storage halves, `describe_homelab status` and `describe_guest` let an operator pay for exactly the scope they are working in. The token-economy doctrine (ADR-011 §1) now covers both directions — input (edit tools) and output (read shaping). Existing behavior is byte-for-byte preserved at the defaults.

**Negative / cost.** Four small surfaces touched: two flags on `query_audit`, one filter + flag on `health_check`, one depth value on `describe_homelab`, one new tool (`describe_guest`, one `TOOL_MIN_TIER` row at companion). The pseudo-fs filter list is a small maintained allowlist of mount patterns.

**Honest limits.**
- **Truncated `cmd` can hide the operative detail.** A denylist-relevant flag or a path buried past char 120 won't show in the default view; `cmdFull: true` (or filtering to the record) is the escape hatch, and the on-disk log is always complete. The default trades completeness for scan-ability, deliberately.
- **The pseudo-fs filter is heuristic.** A genuinely interesting tmpfs (an over-full `/run`) is hidden by default — mitigated by computing the rollup pre-filter (status still escalates) and by `includePseudoFs: true`.
- **`describe_guest` is a convenience, not a new capability.** Everything it returns is reachable via `describe_homelab` + `sections`; it trades one focused call for a whole-node payload. No new node access.

## Implementation notes

- **`query_audit` (`tools/queryAudit.ts`):** add `cmdMaxChars`/`cmdFull` to the zod schema; truncate in the record projection (pure, in `summarizeAuditRecords`'s neighbor or a small `projectRecord` helper). The filter/summary core is unchanged.
- **`health_check` (`tools/healthEvaluators.ts`):** add a pure `isPseudoMount(path)` predicate + an `includePseudoFs` flag threaded through the storage probe; rollup computed before filtering.
- **`describe_homelab` (`tools/describeHomelab.ts`):** add `"status"` to the depth enum; gate the `config`/`docker` sub-object assembly on `depth === "full"`.
- **`describe_guest` (`tools/describeGuest.ts`):** new handler reusing census parsers + redaction, scoped to one vmid; one `TOOL_MIN_TIER` row at `companion`.
- **Token-economy doctrine:** record in ADR-011 §1's roadmap that the output-side levers are realized here (the reverse marker), and add `describe_guest` to the CLAUDE.md tool table **once implemented**.

## Implementation status (2026-06-19)

Implemented on branch `adr-017-output-budgeting`; +19 unit tests, full suite green (1140), typecheck + lint clean.

- **Default-behaviour reconciliation (the one judgement call).** The Decision/Scope sections promise "every flag defaults to today's output; the savings are opt-in," but §1 and §2's detail prose read as default-ON (`cmdMaxChars` "default ~120"; the storage filter "default" drops pseudo mounts). That is an internal tension. It was resolved **per-surface by risk profile**, both choices provably non-breaking for existing callers/tests:
  - **§1 `query_audit` — opt-in (default = full `cmd`).** Truncation can hide a forensically-relevant flag past the window (the ADR's own "Honest limit"), so defaulting it on is unsafe. `cmdMaxChars` engages truncation; `cmdFull` forces verbatim even when `cmdMaxChars` is set. The "~120" is the *suggested window when you opt in*, not an auto-applied default. Pure `projectAuditCmd` applied to the returned page only — the summary is untouched.
  - **§2 `health_check` — default-ON filter (verdict-safe).** Pseudo mounts are 0.0%-used noise and the **rollup status is computed pre-filter** (`filterDisplayFindings` shapes only the returned list), so hiding them never changes ok/warn/crit. Confirmed zero existing-test churn — no current health test feeds a pseudo mount through a successful `df`. `includePseudoFs: true` restores the full list. Pure `isPseudoMount` + `filterDisplayFindings` in `healthEvaluators.ts`.
- **§3 `describe_homelab depth:"status"`.** `summary`/`full` are byte-for-byte unchanged (verified: the previously-ungated `services[].docker` is dropped **only** at `status`, never at `summary`). `status` runs the config probe to compute `snapshotCapable` but withholds the `config` blob and the docker roster. `CensusSnapshot.depth` widened to `"summary" | "status" | "full"`.
- **§4 `describe_guest`.** New companion handler (`tools/describeGuest.ts`) + pure `resolveGuestKind`; reuses `parsePctList`/`parseQmList`/`parseGuestConfig`/`evaluateSnapshotCapable`/`parsePvesmStatus`/`parseDockerPs`/`parseFailedUnits`/`redactRecord`. `docker`/`units` are LXC-only and require a running guest; QEMU yields config only. One `TOOL_MIN_TIER` row at `companion`; registered in `index.ts`. Read-only, not audited.
- **Live smoke:** read-only `describe_guest`/`query_audit cmdMaxChars`/`health_check` calls against `proxlab` are available on request (not gated on the merge, per the Safety rule).
