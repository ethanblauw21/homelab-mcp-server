# ADR-011: Token Economy as a Design Axis — Find-and-Replace Edit Tools

**Status:** Accepted (base function — multi-edit batching + regex deferred per §5)
**Date:** 2026-06-16
**Deciders:** Ethan
**Depends on:** ADR-001 (write_file pipeline), ADR-003 (pct file I/O, backup/audit pipeline), ADR-004 (dryRun preview, read caps, path validation), ADR-005 (qm file I/O), ADR-006 (config-history capture path A), ADR-008 (docker file I/O, §3 diff-on-write), ADR-009 (hash-anchored audit records — beforeHash/afterHash)
**Required by:** ADR-017 (output budgeting — extends the §1 token-economy doctrine from the *input/write* surface to the *output/read* surface)

## Context

Every tool call this server makes spends two scarce budgets: the node's resources (CPU, disk, service uptime — guarded since ADR-001) and the **model's context window**. The second has never been treated as a first-class design axis, and the most expensive single pattern in the toolkit is the **whole-file write**.

Consider the canonical operation: change one line in a 600-line config. Today an operator using this server pays for it **twice in tokens**:

1. **To know what to change**, the model reads the file — `read_file` returns up to `tools.readFileMaxBytes` (2 MB) of content into context. For a 600-line file that is ~600 lines of input tokens.
2. **To make the change**, `write_file` requires the *entire new file* in the `content` field — the model re-emits all 600 lines, 599 of them byte-identical to what it just read, as output tokens.

So a one-line edit costs ~1200 lines of token traffic to move ~1 line of actual change. The node round-trips are cheap; the **context is the bottleneck**, and it scales with file size, not edit size. This is pure waste, and it compounds: longer files, more edits per session, and the re-emitted content also crowds out the conversation history that makes the model effective.

This ADR does two things, deliberately coupled (the user framing: "one general, one a specific implementation of the first"):

- **§1 — a doctrine.** Name token economy as an explicit design axis with a lever taxonomy and a roadmap, so future tools are measured against it the way they are already measured against the node-safety guardrails. — The **output-side levers** of this roadmap (projection/depth/scope on the read surface) are realized by ADR-017.
- **§2–§7 — the first lever.** A **find-and-replace edit tool** across all four write surfaces (`edit_file`, `pct_edit_file`, `qm_edit_file`, `docker_edit_file`) that lets the model send only the bytes that change — `oldString` → `newString` — while the **entire existing safety pipeline (backup → audit → diff → config-history → integrity-anchor) runs unchanged** behind it.

## Decision

### 1. Doctrine: token economy is a design axis, not an afterthought

We adopt one principle and one taxonomy.

**Principle — pay tokens proportional to the change, not the artifact.** A tool's token cost should scale with the *size of the operation the operator is expressing*, not with the size of the object it touches. A one-line edit should cost roughly one line. A status check should cost a status, not a data dump. Where a tool cannot avoid a large payload, the large direction should be **opt-in** (a flag, a window, a depth) rather than the default.

**This is a doctrine, not a single feature.** It joins the existing design axes (least privilege, fail-closed, tripwire-not-sandbox, pure-core/thin-shell) as something every new tool is reviewed against. The lever taxonomy below is the menu; this ADR spends the first item and records the rest as a roadmap, not a commitment.

**Lever taxonomy** (input-side and output-side, with what is already banked):

| # | Lever | Direction | Status |
|---|-------|-----------|--------|
| L-1 | **Find-and-replace edits** — send only changed bytes, not the whole file | input | **This ADR** |
| L-2 | Diff-only write returns — a write returns a truncated diff, never the full new content | output | **Banked** (ADR-008 §3) |
| L-3 | Read windowing — `offset`/`maxBytes` on reads instead of whole-file | input | **Banked** (ADR-004 / ADR-003) |
| L-4 | Mandatory output bounding — `tail_log`, `query_audit`, dryRun-diff line caps | output | **Banked** (ADR-004/005) |
| L-5 | Summary-first list/census returns — depth/verbosity is opt-in, terse by default | output | **Banked** (ADR-017 — `describe_homelab depth:"status"`, `query_audit cmdMaxChars`, `health_check` pseudo-fs filter, `describe_guest`) |
| L-6 | Result pagination / continuation tokens for unbounded enumerations | output | Roadmap |
| L-7 | Structured-not-prose tool results where the model parses anyway | output | Roadmap |

The point of the table is honesty: much of the *output* side was already bounded by earlier ADRs for safety reasons (a redacted, capped log is both safer and cheaper). The **input** side — the model having to *emit* a whole file to change a line — was the untouched, highest-leverage gap. That is L-1, below.

> **Measurement (non-blocking).** The win is structural and obvious (re-emitting 1 line vs 600), so v1 does not gate on a benchmark. A follow-up may add a dev-only counter that logs `inputBytes` vs `fileBytes` per edit to quantify the realized savings across a session. Recorded as roadmap, not v1 scope.

### 2. The edit tool: semantics

Four new tools — `edit_file` (host), `pct_edit_file`, `qm_edit_file`, `docker_edit_file` — one per existing write surface. Each takes, in place of `content`:

- `oldString` (string, required) — the exact text to find.
- `newString` (string, required) — the text to replace it with. May be empty (a deletion).
- `replaceAll` (boolean, default `false`) — replace every occurrence instead of requiring a unique match.

Plus the surface's existing addressing (`path`; `vmid` for pct/qm; `vmid`+`container` for docker) and the **same `dryRun` flag** the write tools already carry.

**Match semantics (mirrors the Claude Code `Edit` tool the model already knows):**

- The server reads the current file, then locates `oldString` as a **literal substring** (no regex — a literal find is predictable, and regex in an operator tool is a footgun and an injection surface).
- **Unique-match requirement.** With `replaceAll: false`, `oldString` must occur **exactly once**. Zero occurrences → structured `not_found` error. Two or more → structured `not_unique` error reporting the count, instructing the caller to add surrounding context or pass `replaceAll`. This is what makes a 20-byte `oldString` a *safe* address into a large file — ambiguity is refused, never guessed.
- **`replaceAll: true`** replaces every occurrence; the result reports `replacements: n`.
- **No-op guard.** `oldString === newString`, or a replacement that yields byte-identical content, is refused as `no_change` (don't burn a backup/audit slot on a write that changes nothing — consistent with the dedup instinct in `backup/policy.ts`).

**Hard preconditions (the honest limits):**

- **The file must already exist.** An edit addresses existing content; there is no `oldString` in a file that isn't there. Creating a new file stays the job of `write_file` (the model has to emit the new content anyway — there is no token win to capture). A missing file → `not_found` on the file, distinct from `oldString` not found.
- **Text-only.** A literal string find/replace over UTF-8 is meaningless on binary content. The handler refuses when the existing file is non-text (`isTextContent`, the same predicate the backup-kind selector uses). Binary edits stay with `write_file`/base64. This mirrors the text-orientation limit ADR-005 already states for `qm` files.
- **`oldString`/`newString` travel as normal tool arguments** (they are small by construction — that is the whole point), unlike file *content* in the docker path which ADR-008 routes via `docker cp`/SFTP and never argv. The **resulting full file** is what gets written, and it flows through the existing surface-appropriate write transport (SFTP / `pct push` / agent / docker relay) exactly as a `write_file` would — so the ADR-008 "content never via argv" invariant is preserved by construction (the edit handler produces bytes, the write core moves them).

### 3. The edit tool: the pipeline is the write pipeline (no new safety surface)

**This is the load-bearing decision.** An edit is *not* a new way to mutate a file — it is a **token-cheaper front door to the exact write pipeline that already exists**. The handler's only novel work is computing `newContent` from `prevContent + (oldString → newString)`; everything after that byte buffer is unchanged:

```
edit_<surface>(path, oldString, newString, replaceAll, dryRun):
  1. validatePath                                    ── unchanged (ADR-004)
  2. read prevContent via the surface's read path    ── the ONE read (SFTP / pct pull / agent / docker)
  3. refuse if file missing / binary                 ── new, edit-specific preconditions
  4. newContent = applyStringEdit(prevContent, …)    ── new, PURE (the only real logic)
       └─ refuse not_found / not_unique / no_change
  5. ───────── from here, the existing write core, byte-for-byte ─────────
     detectLargeFileWrite · dryRun preview · disk-pressure · selectBackupKind ·
     storeBackup · <surface write> · buildAuditRecord (+ ADR-009 before/afterHash) ·
     ADR-006 recordMutation (host/pct) · audit.append
```

Two consequences that make this safe by construction:

- **Guardrail parity is free, not re-implemented.** Backups, the audit record (including ADR-009's `beforeHash`/`afterHash` content anchors so an edit-caused drift is still *explained*), the diff-on-write return (ADR-008 §3 — an edit naturally returns a tiny diff, the best case for that feature), config-history capture (ADR-006 path A, host/pct only), large-change detection, disk-pressure fail-safe, and `dryRun` all behave **identically** to the corresponding `write_file`, because they are literally the same code path operating on the same final bytes. An audit reviewer cannot tell whether a given mutation arrived via `write_file` or `edit_file` — and that is the goal.
- **`revert_file` already covers it.** An edit produces an ordinary backup keyed on the same descriptor (`host` / `pct:<vmid>` / `qm:<vmid>` / `docker:<vmid>:<container>`), so undo is the existing `revert_file` with zero new wiring.

**Implementation shape — extract a shared write core (recommended).** To honor the *single-read* property in step 2/5 (and avoid a read-edit-then-reread-to-back-up TOCTOU gap), each surface's write handler is refactored into:
- `read<Surface>Prev(...)` → `{ prevContent, prevHash, isNewFile }` (the surface I/O), and
- `writeResolved<Surface>(ctx, prevContent, isNewFile, newContent, …)` → the post-read pipeline (steps 5).

`*_write_file` then = read-prev → `newContent = Buffer.from(input.content)` → `writeResolved`. `*_edit_file` = read-prev → `applyStringEdit` → `writeResolved`. The pipeline lives in exactly one place per surface; both doors call it; `prevContent` is read **once** and the bytes that get hashed/backed-up are provably the bytes the edit was applied to. (The cheaper alternative — `edit_file` internally calls the unmodified `writeFileHandler` — was rejected: it re-reads `prev` a second time inside the write handler, opening a small TOCTOU window between "what the edit was computed against" and "what got backed up," which is exactly the kind of dishonest-audit gap ADR-004's exit-semantics work went out of its way to close.)

**`applyStringEdit` is a pure function** (`tools/editString.ts`), no I/O, in the same family as `guardrails/denylist.ts` and `backup/policy.ts`:

```
applyStringEdit({ prev, oldString, newString, replaceAll })
  → { ok: true,  next: string, replacements: number }
  | { ok: false, reason: "not_found" | "not_unique" | "no_change", count?: number }
```

It gets the ~90%+ line/branch coverage the key-invariant modules require (count-occurrences, unique vs replaceAll, empty `newString` deletion, `oldString` containing regex-special and multi-byte UTF-8 characters treated literally, no-change detection).

### 4. Tiers, transport, and size caps — inherited, not redefined

- **Tiers follow the write surface exactly** (`tiers/registry.ts`): `pct_edit_file`/`qm_edit_file`/`docker_edit_file` at **companion**, `edit_file` at **root** — the same rows as their `*_write_file` counterparts, because an edit's blast radius is identical to a write's (it produces a full new file). Four new `TOOL_MIN_TIER` rows; nothing else gates them. Above-tier tools stay unregistered, so the model never sees an edit tool it can't run.
- **Transport follows the tool, not the tier** (the ADR-007 rule) — each edit handler reuses its surface's existing read+write transport untouched.
- **The `qm_write_file` size cap still applies.** The guest-agent write endpoint's `tools.qmWriteMaxBytes` (60 KB) bounds the *resulting* file, not the edit payload — so `qm_edit_file` enforces the same cap on `newContent` and refuses (never truncates in-guest) over it, identical to `qm_write_file`. The read side is bounded by `tools.readFileMaxBytes` as today (the edit must read the whole file to find `oldString`; a file over the read cap is refused with the existing windowed-read guidance — point the operator at `qm_exec`/`execute` for very large files).
- **No new config.** v1 adds **zero** `config.ts` knobs — the edit tools ride entirely on existing caps (`readFileMaxBytes`, `qmWriteMaxBytes`, `dryRunDiffMaxLines`, the backup retention caps). The lever taxonomy's measurement counter (§1) is the only deferred config-ish item, and it is roadmap.

### 5. What this deliberately does NOT do (v1 scope fence)

- **No multi-edit batching.** One `oldString`→`newString` per call. A sequence of independent edits is a sequence of calls. (Batching is a plausible L-1 extension — atomic multi-hunk apply — but it complicates the unique-match and backup-per-call story; deferred, not designed here.)
- **No regex / no fuzzy match.** Literal substring only, by §2's reasoning.
- **No new-file creation, no binary edits.** §2 preconditions — those stay with `write_file`.
- **No change to the write tools.** `*_write_file` keep their `content` field and full semantics; the refactor in §3 is internal (extract a core) and behavior-preserving, pinned by the existing write-handler tests staying green.
- **Output-side levers L-5/L-6/L-7 are not touched.** This ADR is the input-side lever only; the doctrine records the rest as roadmap.

### 6. Consequences

**Positive.**
- The headline win: a one-line edit costs ~one line of tokens instead of the whole file, on every write surface. Token cost becomes proportional to change size, the §1 principle made real.
- Zero new safety surface: every guardrail, audit anchor, backup, and revert path is inherited byte-for-byte from the write pipeline (§3). The audit trail cannot tell edit from write — parity by construction.
- A latent code-quality win: extracting the per-surface write core (§3) removes the read-prev/pipeline duplication currently copy-pasted across all four `*_write_file` handlers, behind the safety net of their existing tests.
- The diff-on-write feature (ADR-008 §3) and the integrity classifier (ADR-009) are at their *best* on edits — small diffs, cleanly explained drift.

**Negative / honest costs.**
- **A second front door per surface to keep in sync.** Mitigated by the shared write core: the doors differ only in how they produce `newContent`; the dangerous part is single-sourced.
- **An extra node read on the edit path** relative to a blind `write_file` (the edit *must* read to find `oldString`). This is a node round-trip, not model tokens — and the operator was almost always going to read the file anyway to know what to change, so net context spend still drops sharply. The single-read core (§3) keeps it to exactly one read.
- **`not_unique` round-trips.** A too-short `oldString` costs a refusal + retry with more context. This is the correct, safe failure (guessing which match to edit would be far worse) and the error message tells the model exactly how to fix it.
- **Refactor risk.** Extracting the write core touches all four write handlers. Bounded by the existing write tests (unit + the `writeFile.int`/`dryRun` suites) gating the refactor as behavior-preserving before any edit logic lands.

### 7. Build order

1. **Pure core first, green:** `tools/editString.ts` (`applyStringEdit`) + exhaustive unit tests (the key-invariant ~90%+ bar).
2. **Behavior-preserving refactor:** extract `writeResolved<Surface>` + `read<Surface>Prev` from each of the four `*_write_file` handlers; existing write tests stay green (no behavior change).
3. **Four edit handlers** (`editFile.ts`, `pctEditFile.ts`, `qmEditFile.ts`, `dockerEditFile.ts`) — read-prev → `applyStringEdit` → `writeResolved`; preconditions (missing/binary/no-change); `dryRun` parity.
4. **Registry + registration:** four `TOOL_MIN_TIER` rows (companion×3, root×1); register in `index.ts` behind the same tier filter; the audit `tool` enum gains four names.
5. **Handler tests** per surface: not_found / not_unique / replaceAll / empty-newString deletion / no-change refusal / binary refusal / dryRun-diff parity / audit-record-and-backup parity with the matching `*_write_file`.
6. **Docs:** CLAUDE.md tool table + a token-economy note; this ADR to **Accepted** on implementation.

## Alternatives considered

- **`edit_file` delegates to the unmodified `writeFileHandler`.** Simplest (no refactor), but double-reads `prev` and opens a TOCTOU gap between the bytes the edit was computed against and the bytes backed up — rejected for the same honest-audit reasons ADR-004 closed the exit-semantics gap. The shared-core refactor (§3) costs more but is correct.
- **Line-range edits (`startLine`/`endLine` + replacement)** instead of string match. Rejected: line numbers are brittle (any prior edit shifts them, and the model would need an up-to-date numbered read to compute them — re-introducing the read it was trying to avoid), and a content-addressed `oldString` is self-validating via the unique-match rule. String match is what the model is already trained on (Claude Code `Edit`).
- **Regex find/replace.** More powerful, but a predictability and injection footgun in a root-capable operator tool; literal-only is the safe default. Could be a future opt-in flag if a real need appears.
- **A general "patch"/unified-diff apply tool.** Maximal token efficiency (send only hunks), but diff-apply is fragile against context drift and far harder to make fail-closed; the unique-match string edit captures most of the win at a fraction of the risk. Recorded as a possible L-1 successor.
- **Do nothing / rely on output-side levers.** The output side was already largely bounded by earlier ADRs; the untouched, highest-leverage waste was input-side whole-file emission. Declining it leaves the single biggest token sink in place.
