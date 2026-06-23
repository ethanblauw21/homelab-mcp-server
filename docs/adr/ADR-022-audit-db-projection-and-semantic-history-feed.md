# ADR-022: The Audit-DB Projection and the Semantic Change-History Feed

**Status:** Proposed
**Date:** 2026-06-22
**Deciders:** Ethan
**Depends on:** ADR-004 (the JSONL audit log + atomic `O_APPEND` durability, the ADR-002 redaction module, and the diff-on-write `computeUnifiedDiff` whose output is currently *discarded*), ADR-006 (the git mirror as the pull-feed content corpus + the load-bearing "git is never on the write's critical path" invariant this feed must not break), ADR-009 (the `better-sqlite3`/WAL precedent, the "pure core, thin I/O shell" split, and the hash-anchored audit fields `beforeHash`/`afterHash`/`hashScope` this projection indexes), ADR-010 (the "no standing network-reachable surface fronting the server" property — the reason the feed is *pull*, not push-from-this-server), ADR-015 (the "derive from the artifacts, don't add a sensor" doctrine + the pure `filterAuditRecords` core reused here as the fallback path), ADR-017 (`query_audit` output budgeting / `cmd` projection — the surface being upgraded), ADR-019 (redaction is best-effort, "not a security control" — the caveat now guarding a *feed/exfil* boundary, not just at-rest)
**Required by:** rust-file-system-indexer#ADR-001 (the push/streamed-ingestion ingress that consumes this change-history feed — the first concrete consumer of the `index_records` push path)
**Realizes deferral:** ADR-020 §"Scope boundaries" backlog items **9 (semantic history)** and **10 (`index_path`)** — both were excluded there because they "require an embedding dependency and conflict with ADR-006's write-path invariant" (9) and "depend on two indexer subsystems that do not exist in this repo" (10). This ADR resolves both: the indexers now exist as separate processes, and the feed runs entirely *off* the write's critical path.
**Source:** A `/discuss` design session, grounded against three real systems — this repo's audit log + git mirror; the Python **`codebase-indexer`** (FAISS + Jina code embeddings, code-specialized); and the Rust **`rust-file-system-indexer`** (LanceDB + SQLite FTS5 hybrid, general-file embeddings via local `nomic-embed-text-v1.5`). `docs/tool-ideas.md` items 9–10.

## Context

The system records *that* a change happened in rich, hash-anchored detail, and stores the *content* of the change durably — but in two places that never meet, and it throws away the one artifact that is the change itself:

1. **The diff is computed and discarded.** Every write-family tool (`write_file`/`*_edit_file`/`revert_file`) already computes a `computeUnifiedDiff` on the real-write path (ADR-008 §3, bytes in hand from the backup pipeline) and **returns it to the caller, then drops it.** It is never persisted.
2. **"Before" lives in the backup store, keyed by a different hash.** The pre-write bytes are durable as a gzipped reverse-delta (ADR-003/014), addressed by `targetKeyString`, recoverable via `BackupStore.restore()` — but not co-located with the audit record that caused them, and only for write-family tools.
3. **The audit log is a linear-scan JSONL.** `query_audit` loads the whole file and filters in memory (`filterAuditRecords`, pure). It carries the anchors (`prevSha256`/`newSha256`, `beforeHash`/`afterHash`, `hashScope`, `cmd`) but no diff, no full-text index, and no way to ask "*when did we change the Docker security settings*" — a concept query, not a substring.

Separately, the operator runs two **external** indexer subsystems (semantic/full-text search over files). ADR-020 deferred wiring them in (items 9–10) for two concrete reasons that have since evaporated: the indexers now exist, and — critically — the naïve version (embed on write) would have put an embedding dependency on the mutation path, violating ADR-006's "git never on the write's critical path." A *pull/derive* design avoids that entirely.

The opportunity is therefore two cleanly separable things, not one overhaul: **(a)** stop discarding the diff and give the audit log a real queryable backing; **(b)** expose the resulting artifacts so an *existing* semantic indexer can consume them. (b) is cheap precisely because the hard parts — chunking, embeddings, a vector store, a metadata slot — already live in the indexer.

## Decision

Build the deterministic record now; design the semantic feed as a pull-first seam onto the existing indexer. Two halves, with a hard durability boundary between them.

### 1. `audit.db` — a derived, rebuildable projection (the half we build)

A `better-sqlite3`/WAL store (the ADR-009 stack — **zero new dependencies**; FTS5 is compiled into its bundled SQLite) that **shadows** the JSONL audit log. The JSONL stays the **system of record**: ADR-004's atomic-append, plain-text, independently-verifiable, gracefully-degrading trail is the one property an *audit* artifact least wants to trade. `audit.db` is a **blow-away-safe index** — drop it and replay the JSONL (+ backup store) to rebuild.

- **Structured columns** mirror `AuditRecord` (`id`, `ts`, `tool`, `vmid`, `container`, `path`, `hashScope`, `beforeHash`, `afterHash`, `exitCode`, flags…) with indexes on the fields `query_audit` filters. This alone turns the linear scan into an indexed lookup.
- **A redacted diff blob** per write-family record: the unified diff that diff-on-write *already computed*, run through the ADR-002 redaction module first (recording `redacted`/`redactionCount`). Near-zero added cost — the bytes are in hand. Exec-family records (`hashScope:"unknown"`) carry no diff; their (already-redacted) `cmd` is the searchable text.
- **An FTS5 external-content table** (`content='audit'`) over `cmd` + redacted diff + `path` + `note` — so the searchable text is **not stored twice**, and a future `vec0`/embedding column can join on the same rowid without reshaping anything.
- **`query_audit` is upgraded in place** (it "replaces the audit tool" without a new surface): SQLite is the **fast path** (indexed filter + FTS5 free-text); the existing **pure `filterAuditRecords` JSONL scan is the fallback** when the DB is absent, stale, or being rebuilt. The pure core stays the tested fallback — no doctrine broken, and basic "what changed" never depends on anything new.

**Content stays reconstructed, not duplicated.** `audit.db` stores the *diff*, not full before/after bytes. Full before/after is recovered on demand from the backup store (`BackupStore.restore()`, the path `revert_file`/`diff_config` already use). Rationale: the backup store is *already* the deduplicated content system-of-record; duplicating full files into a searchable DB would (i) re-store content the backup pipeline holds far more efficiently, (ii) turn `audit.db` into a second full-fidelity secret pile that is now *grep-able* via FTS, and (iii) couple a forever-retention audit store to a high-churn content stream that needs eviction. The diff is the only artifact not already stored anywhere; it is what we add.

### 2. The semantic feed — a pull-first seam onto the `rust-file-system-indexer`

The change-history is exposed for the **general-file** indexer to consume. The Rust indexer is the correct home (not the code-specialized `codebase-indexer`): it is MIME-dispatched and text-type-agnostic (`.conf`/yaml/no-extension all chunk as text), uses a **general** local embedding model (`nomic-embed-text-v1.5`, ONNX, on-box), runs **hybrid** search (SQLite FTS5 BM25 + LanceDB dense, RRF-fused), and — decisively — carries an **opaque `meta: serde_json::Value`** on every chunk that round-trips unchanged to query results (`ChunkInput.meta` → `chunks.meta` → `ChunkRow.meta`). That `meta` slot is the clean pivot the code indexer lacked: a semantic hit hands back `{tool, pre_hash, post_hash, vmid, path, ts}` → the exact `audit.db` row.

| Feed | Mechanism | Unit | Status |
|------|-----------|------|--------|
| **Content** | **PULL** — point `file_indexer index` at `history.configHistoryDir` (the git mirror) | config files at every revision | **Available today.** Zero indexer changes; the mirror is already a git repo of files on disk, and the indexer is already git-aware |
| **Change-events** | **PUSH** — stream `{uri, content, mime, meta}` records to the indexer's streamed-ingestion tool | one redacted diff + its metadata | **Gated only on that push tool landing** (~200–300 lines of Rust the indexer owner is already building). Homelab side is then a thin best-effort emitter |

- **Pull is the doctrine-correct default** (ADR-010/015): the indexer reads durable local artifacts on its own cadence; it being down, slow, or re-embedding never touches a write. It is also the *only* interface that exists today. Push, when it lands, is for change-event metadata that lives in `audit.db`, not on disk — and is **best-effort, fire-and-forget, never on the write's critical path** (honoring ADR-006). If pull latency ever matters, the clean escalation is a *payload-free* "source changed, re-scan" poke, never a data-bearing stream.
- **Change-events get synthetic, addressable URIs** (`change://<vmid>/<path>@<ts>`) and a `source:"homelab-change"` discriminator in `meta`, so they are re-pushable and never collide with pulled mirror files (the indexer does not dedup across sources — that is the feeder's job).
- **`audit.db` FTS5 and the indexer are complementary, not redundant.** `audit.db` = deterministic, hash-anchored, *always-available* exact/structured queries (`query_audit`). The indexer = best-effort, cross-corpus *semantic* recall. The forensic surface must never depend on the fuzzy one.

### 3. The redaction asymmetry and its precondition

The two feeds carry different redaction status, on purpose, and the ADR pins the boundary:

- **Content feed (mirror) is unredacted** — it *must* be, for ADR-006 byte-faithful restore. Feeding it means the indexer's store inherits the mirror's existing **"private, never-sync-to-cloud"** constraint.
- **Change-event feed (diffs) is redacted** before it leaves this server.

This is acceptable because the Rust indexer is **fully local** (ONNX + on-disk LanceDB/SQLite) and lives in the same trust zone — nothing crosses the LAN. **Precondition, recorded so it is not re-litigated:** if that indexer's store ever becomes reachable off-host, the content feed must switch from the raw mirror to a *redacted mirror export*, and ADR-019's best-effort caveat then guards a real exfiltration boundary. A config tripwire should refuse a non-loopback indexer target for the content feed.

## Scope boundaries

- **No embeddings, no vector store, no LLM in this repo.** The semantic half is *consumed*, not built. `audit.db` uses only the `better-sqlite3` already shipped (ADR-009). No FAISS/LanceDB/`sqlite-vec`/ONNX dependency lands here.
- **The diff is captured, not regenerated.** We persist the diff-on-write output already computed; no new node reads, no new diff algorithm. Full before/after is reconstructed from the backup store, not duplicated.
- **JSONL remains the system of record.** `audit.db` is derived and rebuildable; the append path's ADR-004 guarantees are untouched. No write becomes contingent on SQLite.
- **The feed is off the write's critical path.** Pull is the default; push is best-effort fire-and-forget. ADR-006's "never on the write's critical path" invariant — the exact thing that blocked this in ADR-020 — is preserved.
- **`query_audit` is upgraded, not replaced by a new tool.** No new `TOOL_MIN_TIER` row for search; the fast/fallback split is internal. (Whether a thin push-emitter is exposed as a tool or a background sink is an implementation choice deferred to the build.)
- **The code indexer is explicitly *not* the home.** `codebase-indexer` is code-specialized (`.py/.ts` allowlist, Jina *code* embeddings, no opaque metadata slot — it would need schema hacks). Config/diff content goes to the general-file indexer only.
- **No LLM-generated summaries on write.** The original pitch (wrap each diff in an LLM NL summary) is rejected: it needs an LLM in the loop that is *absent for the out-of-band changes `config_sweep`/the forest exist to catch*, and the consumer (Claude) can summarize a retrieved row in-context for free. The diff text + metadata is what gets embedded.

## Consequences

**Positive.** The diff stops being thrown away and becomes a co-located, searchable, redacted artifact joined to the tool call that caused it. `query_audit` goes from whole-file linear scan to indexed + full-text, while keeping its pure JSONL filter as a zero-dependency fallback. The "*when did we change X*" concept query becomes answerable by pointing an already-built, already-local hybrid indexer at artifacts that already exist — the content half working **today** via pull, the change-event half a thin emitter once the push tool lands. ADR-020's deferred backlog items 9–10 are realized without violating the write-path invariant that blocked them.

**Negative / cost.** A second store (`audit.db`) to open, migrate-version, and keep rebuildable — plus a documented rebuild path (replay JSONL + backups). The redaction module now runs on diffs at write time (small cost; new code path). Two ingestion seams to the indexer, each with its own redaction status and a dedup-at-the-feeder obligation. A cross-system contract: the change-event push depends on an external tool's shape (`{uri, content, mime, meta}`) that is still being written, and on the indexer staying local for the trust-zone assumption to hold.

**Honest limits.**
- **Redaction is best-effort, and FTS makes a miss *searchable*.** A secret the redactor misses in a diff is now indexed at rest in `audit.db` and, if pushed, in the indexer. This is a strictly larger exposure than today's content-free log. Mitigations are real (redaction + the blow-away rebuild + local-only + the no-duplicate-full-content choice) but do not eliminate it. The trade is stated, not hidden.
- **The semantic layer is advisory, not authoritative.** Vector/RRF recall is fuzzy and depends on the indexer being up and current; it never gates and never substitutes for the deterministic `audit.db`/`query_audit` answer. A drift's *cause* is still established by the hash join (ADR-009), not by a semantic hit.
- **The content feed indexes unredacted config.** Sound only while the indexer is same-trust-zone and local; the precondition above is the guard, and it is a human responsibility, not an enforced sandbox.
- **`audit.db` is rebuildable but its *diffs* are not free to regenerate.** A rebuild reconstructs diffs from backup blobs + hashes; where a backup was metadata-only or evicted, that record's diff is unrecoverable (the anchors and `cmd` survive). The DB is a faithful index of what is still reconstructable, not a second copy of everything.

## Implementation notes

- **Pure core, thin shell (ADR-009 pattern).** Schema + row mapping + the redacted-diff projection + the FTS query builder are pure/unit-tested; the `better-sqlite3` handle is the I/O shell. The `audit.db` writer is a sink wired in `index.ts` next to the existing append — mirroring how `healthSink`/`driftSink` (ADR-010) persist alongside the agent path — so handlers never import the DB layer directly.
- **`query_audit` fast/fallback.** Detect `audit.db` presence/health; on miss, fall through to today's `AuditLog.readAll()` + `filterAuditRecords`. The pure filter is the contract both paths satisfy; an integration test asserts identical results from both for a fixture log.
- **Rebuild command.** A maintenance path replays JSONL into `audit.db` (and recomputes redacted diffs from the backup store where present) — the same routine that runs on a schema-version bump.
- **Config (`audit.*` / `feed.*` in `config.ts`).** `dbPath` (default beside `audit.jsonl`), redaction on/off for stored diffs (default on), diff size cap; feed: `indexerContentEnabled` (pull, default off), `indexerPushEndpoint` (default none), and the **loopback-only guard** on any push/content target. Env mirrors per the existing convention.
- **Bidirectional reliance markers (per ADR-000).** On accept, add `Required by: ADR-022 (…)` to ADR-004/006/009/010/015/017/019, and amend ADR-020's §"Scope boundaries" backlog items 9–10 in place with `— Realized by ADR-022.`; tick the matching `docs/tool-ideas.md` ranks. The `Depends on:`/`Required by:` pair is one fact written twice — fix both in the same commit.
