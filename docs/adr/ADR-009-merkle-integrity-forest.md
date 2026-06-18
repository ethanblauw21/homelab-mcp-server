# ADR-009: Merkle Integrity Forest — Structural Drift Tracking & Hash-Anchored Audit

**Status:** Accepted — implemented 2026-06-14 (v1 scope, items 1–10; #11 deferred)
**Date:** 2026-06-12
**Deciders:** Ethan
**Depends on:** ADR-003 (audit `prevSha256`/`newSha256`, running-guest precondition), ADR-006 (config history — complementary, see §9), ADR-007 (tiers; companion placement, protected-set instinct)

## Context

The audit log answers *what action happened*; it cannot answer *what is true now* or *did something change that the server did not do*. ADR-006's `config_sweep` catches out-of-band edits but only over its watched set, on demand, without a compact verifiable summary of whole-lab state. We want a structural integrity layer that:

- maintains a canonical "truth" of the homelab's file structure as a **Merkle forest** on the client (the Windows host — keeping compute and storage off the premium node disk);
- detects drift — content, renames, additions, deletions — and **classifies each change as explained (Claude/server, matched in the audit log) or unexplained (human/package/out-of-band)**, regardless of who made it;
- lets Claude pivot both directions: *structure → cause* (hash a subtree, find the audit records that touched it) and *cause → structure* (an audit record names the before/after hash of what it changed);
- does all of this without a daemon (the stdio server lives only while a Claude client runs — the constraint that has shaped every ADR).

Honest threat-model boundary, stated up front: the forest lives on the client and is rebuildable from the node. It is **drift-detection, change-attribution, and after-the-fact forensics against accidental and non-malicious out-of-band change** — not tamper-*proofing* against a root-level adversary, who could edit a file and recompute the tree. Off-box anchoring of the root (signing/push) is a noted future, not v1. This is the same tripwire-not-sandbox honesty as ADR-001's denylist.

## Decision

### 1. A Merkle forest, three escalating levels, deterministic structure

**Forest shape.** One synthetic **super-root** over subtrees:
- `host/` — the Proxmox host's watched config paths only (`/etc`, `/root`, …), read over SSH/SFTP.
- `pct/<vmid>/` — each container's watched set, read **exclusively** via `pct pull`.

The host and container watched sets are defined to **never overlap** — the host watcher must not point at container-backing storage (`/var/lib/vz`, LVM/ZFS backing), or the same content would be hashed twice via two paths and disagree (raw storage vs. `pct pull` view). This non-overlap is a config invariant, asserted at load.

**Deterministic folding.** A directory's hash = `SHA256(0x01 ‖ for each child in name-sorted order: child_name ‖ 0x00 ‖ child_hash)`. A file leaf = `SHA256(0x00 ‖ leaf_payload)`. The domain-separation bytes (`0x00` leaf, `0x01` node) prevent a file whose content equals a folder's serialized child-list from colliding. Children are sorted **byte-wise on the raw name** (not locale-aware) so the same tree yields the same hash on any machine/OS. Renames, additions, and deletions all change the parent's `(name, child_hash)` set and bubble to the root.

> **Implementation note (kept in sync, `integrity/folding.ts`):** a single `0x00` terminator is inserted between each (variable-length) `child_name` and its (fixed 32-byte) `child_hash`. NUL is the one byte a POSIX filename cannot contain, so it is an unambiguous, still fully-deterministic delimiter that closes a theoretical multi-child boundary ambiguity (`["ab"+h]` vs a crafted `["a"+…]`) the bare `name ‖ hash` concatenation left open. A third domain byte `0x02` gives `unreadable` leaves a constant sentinel hash distinct from both a real leaf and an `empty-dir` (`0x01 ‖ ∅`).

**Three levels** (same structure, different `leaf_payload`, escalating cost):
- **L1 — mtime.** `leaf_payload = mtime`. A `stat`, no file read. The fast tripwire and touch-detector. **Explicitly the weakest signal** — mtime is spoofable (`touch -r`, tar extraction) — so a clean L1 means "probably untouched," never "provably unchanged." L1 gates whether to bother with L2/L3; it does not anchor truth.
- **L2 — config content.** `leaf_payload = content hash`, over the **important config/yml set only**. "Did anything that matters change."
- **L3 — full content.** `leaf_payload = content hash` over the entire watched set. The complete, expensive truth.

The three are **separate stored trees that reference each other** (storage is cheap on the client; no premature unification). Smart escalation is the default: run L1, descend into L2/L3 only where L1 flags a touch. **A periodic full-depth L3 walk is what actually anchors truth** — "periodic" means operator- or external-cron-triggered (no server scheduler), same pattern as ADR-006's sweep.

**Node state enum** (must stay distinct — collapsing any two manufactures false drift): `present` · `empty-dir` (exists, no children) · `unavailable` (stopped guest — see §4) · `unreadable` (exists, permission denied).

### 2. Storage: SQLite node store on the client

A SQLite database (moving off structured-text persistence deliberately — the `doc_store.json` lesson). Schema is a node store keyed by `(level, path)` → `{ hash, state, mtime, parent_path, child_names }`, so:
- **Incremental update is truly surgical:** a known write updates one leaf + its path-to-root, not a whole-blob rewrite.
- **`tree_diff` and "audit records under this subtree" are queries,** not tree walks.
- **Writes are atomic** (temp/transaction + the SQLite WAL) — a crash mid-update cannot corrupt the baseline (the indexer's atomicity lesson applied).

Three stored **baselines** (one per level) plus a working area for freshly-computed trees during a verify.

### 3. Hash-anchored audit (before/after + scope)

Audit records gain:
- `beforeHash` / `afterHash` — for tools that **know their target**, the hash of the affected path's subtree before and after the operation. The write family (`write_file`, `pct_write_file`, `revert_file`, and ADR-008's `docker_write_file`) populate these from the leaf/subtree they touch.
- `hashScope` — the path the before/after hashes cover, **or the literal `"unknown"`** when a tool ran without a declared scope.

**`execute` and the unknown-scope pattern.** `execute` (and `pct_exec`/`qm_exec`/`docker_exec`) gain an **optional** `hashScope` path. If provided: hash that subtree before, run the command, re-hash after, record both. If absent: record `hashScope: "unknown"` and skip before/after hashing — the next `verify_integrity` catches any change as drift anyway. This keeps cost honest: an `apt upgrade` with no scope hint does **not** silently trigger a full-tree rehash inside one tool call; it just posts an honest "unknown scope" marker. The `"unknown"` flag is a queryable field, not prose, so "what tool calls had unknown scope near this drift" is answerable.

**The bidirectional pivot this enables:**
- *structure → cause:* given a drifted leaf's new hash, find audit records whose `afterHash` matches ⇒ the tool call that produced it.
- *cause → structure:* an audit record's `hashScope` + hashes say exactly what state it moved.

### 4. The forest across transports; stopped guests

Container subtrees are built by `pct pull` and therefore require a **running** guest (ADR-003 precondition). A stopped guest's subtree is **`unavailable`, never empty** — collapsing it to "no children" would read as *deleting every file in the container* and report catastrophic false drift on every power-off. So:
- When a guest is down, its subtree **freezes at its last-known hash** and is marked `unavailable`; it is excluded from drift comparison rather than diffed-to-nothing.
- When it comes back up, a fresh subtree is computed and compared against the frozen baseline (drift that happened while it was off surfaces then).

This is the census's `unavailableAtTier` lesson (ADR-007) applied to guest power state.

### 5. Drift detection & classification (`verify_integrity`)

`verify_integrity { level?: "l1"|"l2"|"l3"|"smart", scope?: path }`:
1. Compute a fresh tree (whole forest, or the `scope` subtree) at the requested level (`smart` = L1-gated escalation; default = the setup-configured level, §7).
2. `tree_diff(baseline, fresh)`: equal subtree hashes prune entirely, so the walk descends only into changed branches and lands on exactly the differing leaves.
3. **Classify each changed leaf** by joining against the audit log on hash:
   - `afterHash` match ⇒ **explained** (names the audit id / tool / timestamp).
   - no match ⇒ **unexplained** (human/package/out-of-band).
4. Return a per-level report: `[{ path, oldHash, newHash, level, mtime, status: "explained"|"unexplained", explainedBy?: auditId }]`, plus the fresh root(s). **Read-only — it never mutates the baseline.** Baseline changes happen only through accept-truth (§6).

### 6. Accept-truth: explicit human call + audited auto-accept policy

The baseline updates **only** through accept-truth, by two paths sharing one mechanism — so "truth changed" is **never silent**, automatic or not.

**`accept_truth { scope?: path }`** — the explicit human override: folds the current state (within `scope`, or whole-forest) into all three baselines at once (they describe one moment), audited.

**Automatic policy** (runs after `verify_integrity`, the friction-killer):
- **Explained changes auto-fold, always.** A leaf whose new hash matches an audit `afterHash` was caused and recorded by the server — the audit log is its authorization; no human blessing needed. This alone removes most friction (ten small Claude writes track automatically).
- **Unexplained changes are governed by a conservative, per-level policy:**
  - **L1-only** (mtime moved, content provably identical at L2/L3) ⇒ **auto-accept freely** even in conservative mode — zero content risk by definition; this is the common noise (`touch`, no-op re-save).
  - **L3-only-not-L2** (non-config content drifted, unexplained) ⇒ auto-accept up to `maxUnexplainedL3` count; over ⇒ flag for explicit accept.
  - **L2** (config/yml content drifted, unexplained) ⇒ **defaults to never auto-accept** — this is the headline feature; it must not be auto-silenced out of the box. Loosenable by config, but the user must choose to.
  - **Sensitive paths** (configurable glob; defaults include `/etc/pve`) ⇒ **never auto-accept** regardless of count — the ADR-007 protected-set instinct.
- **Every auto-accept is audited** — a record naming what was absorbed, at which level, under which threshold. Auto-acceptance was made safe *because* the explicit version was a deliberate, logged act; the automatic version must be equally logged, or it becomes the silent-mutation path the whole system exists to detect.

Whatever the policy declines stays flagged until an explicit `accept_truth`.

### 7. Setup integration: hash-tracking level as a logging-verbosity choice

After tier selection, `setup` offers a hash-tracking level, which sets the configured default depth + a matching auto-accept conservativeness:
- **`last-edited`** → L1 only (mtime touch-detection).
- **`coarse`** → L1 + L2.
- **`fine`** → L1 + L2 + L3.

`verify_integrity` can still override per call. Level controls **depth**; tier controls **access** — independent axes. All levels are offered at companion+ (reading content needs `pct pull`); an observe-tier L1-structure-only variant is a noted future, out of v1.

### 8. Tool surface & tier placement

Companion-tier (all read content or read the baseline):
- **`compute_tree { level?, scope? }`** — build/refresh a tree without diffing (first-run baseline seeding, explicit recompute).
- **`verify_integrity { level?, scope? }`** — §5, read-only drift report.
- **`accept_truth { scope? }`** — §6 explicit override.

`query_audit` (ADR-005) gains hash-aware filters: by `hashScope` path/subtree, by `"unknown"` scope, by explained/unexplained correlation.

## Options Considered

### Option A: SQLite Merkle forest, three levels, hash-anchored audit, policy accept-truth *(chosen)*
Pros: log(n) localization via subtree-hash pruning; explained/unexplained is a hard cryptographic discriminator, not a heuristic; auto-fold of explained changes kills friction safely; per-level conservativeness protects the config-drift headline feature; bidirectional audit↔structure pivot. Cons: three trees to maintain; forest assembly across transports adds guest-state handling; auto-accept is a deliberately relaxed safety boundary (mitigated by mandatory audit of every auto-fold + L2-never default).

### Option B: Single flat hash manifest (path → content hash), no tree
Rejected: no log(n) localization (every check is a full scan), no structural detection of renames/deletions as first-class, no compact root fingerprint. The tree's folding *is* the value over the manifest `config_sweep` already effectively keeps.

### Option C: Tree lives on / is computed by the node
Rejected: premium node disk and compute; the client already holds the bytes (it computes diffs/hashes for backups); and a node-side tree is even less of a tamper boundary against a node-level adversary.

### Option D: Auto-accept everything under a global count threshold (no explained/unexplained split, no per-level policy)
Rejected: silently re-baselines exactly the unexplained config drift the system exists to catch; the explained/unexplained discriminator makes most auto-accept *provably safe* without any threshold, and confines thresholds to the trivial unexplained tail.

### Option E: Merge with ADR-006's git mirror now (tree leaf hashes = git blob hashes)
Deferred (see §9): the tree must work when git is disabled (ADR-006 made git an optional soft dependency), so it cannot structurally depend on blob hashes in v1. Noted as the longer-term consolidation.

## Relationship to ADR-006 (§9)

Complementary, deliberately — the "blobs revert, git remembers" division extended: **the Merkle forest detects and localizes drift and attributes cause (fast, log(n), explained/unexplained); the git mirror holds full content history and restores old bytes.** Detection vs. history. For v1 they hash independently (the forest must function without git). The noted longer-term consolidation: the forest's L3 leaf hashes could *be* the git blob hashes (git already SHA-hashes every stored file), sharing computation — adopt once both are stable and only where git is enabled.

## Security Model

- **Honest boundary (restated):** detection/attribution/forensics against accidental and non-malicious out-of-band change; **not** tamper-proofing against root. The root hash is client-side and node-rebuildable. Off-box/signed anchoring is a future.
- **Auto-accept is the one deliberately relaxed safety surface** and is fenced: explained-only is cryptographically safe; unexplained is conservative per level with L2 never-by-default and sensitive paths never; **every** auto-fold is audited, preserving the "truth changes are always logged" property that made explicit accept-truth safe.
- **No new caller-controlled command strings:** hashing reads files (SFTP / `pct pull`); the only new free-form input is the optional `hashScope` *path*, which is path-validated.
- Companion-tier gated; reads only.

## Consequences

- **Easier:** "what is true now," "did anyone change X without the server," and "which tool call touched this subtree" all become answerable; small Claude edits track without nagging; config drift surfaces loudly and resists auto-silencing.
- **Harder:** three trees + forest assembly + guest-state handling to test; auto-accept policy is genuinely security-relevant and needs adversarial tests; mtime's weakness must be documented so L1 is never mistaken for proof.
- **Storage:** another SQLite DB on the client (cheap, by design).

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Deterministic folding | Unit (critical) | Same tree ⇒ same root regardless of enumeration order; byte-wise name sort; domain-byte separation prevents leaf/node collision; rename/add/delete all bubble |
| Three node states | Unit | `empty-dir` vs `unavailable` vs `unreadable` stay distinct; none reads as deletion |
| L1/L2/L3 leaf payloads | Unit | mtime vs config-content vs full-content; smart escalation descends only on L1-flagged touches |
| Forest assembly | Unit (FakeTransport) | host + pct subtrees; non-overlap invariant asserted; super-root combines children |
| Stopped-guest freeze | Unit + Integration | Down guest ⇒ subtree `unavailable`, frozen hash, excluded from diff (no false mass-deletion); on return, drift-while-off surfaces |
| `tree_diff` pruning | Unit | Equal subtree hashes prune; lands on exactly the changed leaves; log(n) descent |
| Explained/unexplained classification | Unit (critical) | afterHash match ⇒ explained w/ auditId; no match ⇒ unexplained; the human-vs-Claude discriminator |
| Hash-anchored audit | Unit | write family populates before/after + scope; `execute` with scope hashes subtree, without ⇒ `hashScope:"unknown"` queryable |
| Auto-accept policy | Unit (critical) | explained ⇒ always folded; L1-only unexplained ⇒ free; L2 unexplained ⇒ flagged by default; sensitive path ⇒ never; **every** auto-fold writes an audit record; over-threshold ⇒ flagged |
| SQLite store atomicity | Unit | Surgical leaf+path-to-root update; crash mid-update leaves baseline intact (WAL/transaction) |
| Setup level wiring | Manual + dry-run | last-edited/coarse/fine set configured depth + auto-accept conservativeness |

## Action Items

1. [x] SQLite node-store schema + atomic update layer (`(level,path)→node`, three baselines + working area). — `integrity/nodeStore.ts` (`SqliteNodeStore` over injected `better-sqlite3`; `MemoryNodeStore` fake).
2. [x] Deterministic folding core (pure: domain-separated SHA-256, byte-sorted children, node-state enum) — tests first. — `integrity/folding.ts` (17 tests).
3. [x] L1/L2/L3 leaf computation + smart escalation; configured-level default. — `integrity/tree.ts` + `integrityEngine.verify("smart")` (escalates to content only when L1 dirty).
4. [x] Forest assembly over host SFTP + `pct pull`; non-overlap invariant; stopped-guest freeze/`unavailable`. — `integrity/forest.ts` + `forestShape.ts` (`assertNonOverlap`, `freezeSubtree`).
5. [x] `compute_tree` + `verify_integrity` (tree_diff pruning + explained/unexplained join). — `integrity/diff.ts` + `tools/integrity.ts`; registered companion in `index.ts`/`tiers/registry.ts`.
6. [x] Hash-anchored audit: before/after + `hashScope` on the write family; optional `hashScope` on exec tools with `"unknown"` default; `query_audit` hash filters. — `integrity/leafHash.ts` bridge wired into write_file/pct/qm/docker/revert; exec family stamps `"unknown"`; `query_audit` gains `hashScopeContains`/`unknownScopeOnly`/`hashEquals`.
7. [x] `accept_truth` + the auto-accept policy engine (explained-always, per-level unexplained thresholds, sensitive-path denylist, **mandatory audit of every auto-fold**). — `integrity/acceptPolicy.ts` + `integrityEngine.acceptTruth/autoAccept`.
8. [x] Config: watched sets (shared with ADR-006 where they align), level, auto-accept thresholds per level, sensitive-path globs. — `integrity.*` in `config.ts` (reuses `history.*WatchPaths`/`excludePatterns`).
9. [x] Setup ceremony: hash-tracking level prompt → configured depth + conservativeness. — `setup.mjs` companion prompt → `INTEGRITY_LEVEL`; conservativeness at ADR defaults.
10. [x] Docs: the three-level model, mtime-is-not-proof caveat, the honest threat boundary, "forest detects, git remembers." — CLAUDE.md "Merkle integrity forest (ADR-009)" section + tool table + architecture tree.
11. [ ] (Future) off-box/signed root anchoring; observe-tier L1-structure-only variant; ADR-006 blob-hash consolidation. — deferred (out of v1 scope).

## References

- ADR-003 — audit hashes this extends; running-guest precondition
- ADR-006 — complementary drift/history division; shared watched sets; blob-hash consolidation (future)
- ADR-007 — companion placement; protected-set instinct for sensitive paths; `unavailableAtTier` precedent
- ADR-005 — `query_audit`, now hash-aware