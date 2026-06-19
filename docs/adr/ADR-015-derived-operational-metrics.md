# ADR-015: Derived Operational Metrics — Audit Stats, Drift-Rate Trend, Backup-Store Health

**Status:** Proposed
**Date:** 2026-06-19
**Deciders:** Ethan
**Depends on:** ADR-002 (census/redaction), ADR-003 (backup pipeline / retention), ADR-005 (`query_audit`, the read-only forensics surface), ADR-006 (config-history `historyCommitted`), ADR-009 (Merkle forest, explained/unexplained drift), ADR-010 (localhost UI sidecar — the renderer/executor split, the honest-UI rule), ADR-014 (re-anchor snapshots, honest revertibility)

## Context

The system already emits the raw material for operational metrics in three places — the audit log (`audit.jsonl`), the retained `verify_integrity` drift snapshots (`SnapshotStore<drift>`), and the backup store's `.meta` sidecars — but it never *aggregates* any of them into trends. The introspection tools answer point questions: `query_audit` filters and counts a record set, `verify_integrity` reports one drift moment, `list_backups` lists one file's versions. None answers a question over *time*: how often is the server writing, how often does a write silently fail to reach the git mirror, is unexplained drift rising, is the backup store filling toward its cap, are out-of-band edits (re-anchor events) becoming common?

A metric is only worth adding if it tells the operator something the existing tools don't, and only worth building the way the rest of this system is built. Two non-negotiable constraints fall out of the prior ADRs:

1. **No new network surface.** ADR-010's defining property is that there is no standing, network-reachable surface fronting node actuation — the UI sidecar is loopback-only, fail-closed, and renderer-only by default. A Prometheus/OpenTelemetry `/metrics` scrape endpoint would reintroduce exactly the always-on listener that posture exists to avoid, for a single-user stdio server with one human watching it. **This ADR adds no scrape endpoint and no exporter.** Metrics are pull-rendered inside the same localhost dashboard.

2. **No new mutation surface, no new credentials.** All three metrics are *derived from artifacts the client already holds on the Windows host* — the audit JSONL, the persisted drift snapshots, the local backup `.meta` files. None requires a node read. They therefore belong in the ADR-010 **renderer half** (`ArtifactReader`, credential-free, forbidden by a source-scan test from importing any SSH/API client), as read-only panels. They are not MCP tools; the model never sees them, and there is no new `TOOL_MIN_TIER` row.

This is the ADR-009 framing made quantitative: *the audit log records what the server did; the forest records what changed regardless of who; metrics turn both into trends a person can read at a glance.*

## Decision

Three pure aggregators in a new `src/metrics/` directory, each fed by an existing client-side artifact, each surfaced as one read-only panel in the ADR-010 sidecar. Pure core, thin I/O shell — identical to the rest of the codebase.

### 1. Audit-derived statistics (`metrics/auditStats.ts`, pure)

`computeAuditStats(records, opts)` aggregates `AuditLog.readAll()` over a time window into rates and counts that the flat `summarizeAuditRecords` (ADR-005) does not produce:

- **Throughput** — total ops, and a per-bucket time series (default bucket: day) of write-family vs. exec-family vs. read-family counts, so "writes/day" is a curve, not a single number.
- **Change weight** — `isLargeChange` rate and `isHeavy` (heavy-command) rate.
- **Gate activity** — `confirmGated` count (CONFIRM-tier ops that actually ran) and `rootTier` count (ops attributable to the root acknowledgment flag, ADR-007 §4).
- **Silent-failure signals** — the honest ones the audit record already carries but nothing surfaces in aggregate: `historyCommitted === false` rate (the git mirror silently didn't capture a write — ADR-006), `timedOut` count, and signal-kill count (`exitCode === null` — ADR-004 §3 never coerces these to success, so they are real and countable).
- **Unexplained-drift bridge** — count of exec-family records with `hashScope === "unknown"` (ADR-009): the candidate causes of any drift the forest later flags. A rising unknown-scope rate is a rising blind spot.
- **Per-tool histogram** — reuses the `byTool` shape from `summarizeAuditRecords` so the existing audit panel and the stats panel agree.

The function is pure over `AuditRecord[]`; it takes `{ window?: {since, until}, bucket?: "hour" | "day" }` and an injected "now" only via the caller (no `Date.now()` inside — ISO strings compare lexicographically, the same trick `filterAuditRecords` uses). It reuses `filterAuditRecords` for the window, then buckets and tallies.

### 2. Drift-rate trend (`metrics/driftStats.ts`, pure)

The single most security-meaningful number this system can produce is *unexplained leaves per verify run* — "how often is something changing that the server did not do." Each `verify_integrity` already persists its report to `SnapshotStore<drift>` (the `driftSink` ADR-010 wires into the stdio handler), and that store **retains the last `driftRetentionCap` reports (default 30)**. The full series is already on disk; we just never read past the latest.

`computeDriftTrend(snapshots)` walks the retained drift snapshots (oldest→newest) and extracts a per-run series: `savedAt`, total leaves, explained, unexplained, unavailable (frozen/stopped-guest prefixes), L1-only mtime touches, and sensitive-path drift count (`/etc/pve` and friends — these should be flat at zero). The output is a time series plus a headline: the most recent unexplained count and whether it is trending up versus the prior runs. This is **tamper-pressure over time**, computed with zero node access and zero credentials.

The one I/O addition this needs: `SnapshotStore<T>` currently exposes only `loadLatest()`. Add `loadAll(): StoredSnapshot<T>[]` (newest-first, tolerant of unreadable files, mirroring `loadLatest`'s try/catch) so the aggregator can see the whole retained window.

### 3. Backup-store health (`metrics/backupStats.ts`, pure + one store-introspection method)

`summarizeBackupStore(entries, caps)` reports the health of the local durability layer (ADR-003/014) against its configured caps:

- **Capacity** — total bytes stored vs. `globalSizeCapBytes` (default 100 MB), with headroom and an over-cap flag (the same `isOverCap` predicate the eviction planner uses).
- **Per-target version pressure** — how many targets are at or near `perFileVersionCap`, i.e. actively shedding history to eviction.
- **Kind mix** — counts of `gzip-diff` (delta) vs. self-contained (`gzip-full` / large-file raw) vs. `metadata-only`, so the delta-vs-snapshot ratio is visible.
- **Re-anchor frequency (ADR-014 §2)** — count of metas with `reanchored: true`. This is the headline backup-health signal: a re-anchor is created **only** when a managed write detects the file drifted out-of-band since the last managed write. A spike in re-anchors means something (a `sed -i` through `pct_exec`, a package upgrade) is editing managed files behind the server's back — the exact failure mode ADR-014 was written for, now trended instead of discovered one-file-at-a-time.

The math is pure over a small `BackupStatEntry[]` (`{ fileKey, kind, sizeBytes, reanchored, requiresBaseHash, timestamp }`). The thin I/O shell is a new `BackupStore.storeStats(): BackupStatEntry[]` that enumerates the `.meta` sidecars under `baseDir` — reusing the existing directory walk from `buildExistingHashMap` — and projects each into a stat entry. Both `BackupStore` and the planner already import only `fs`/`path`/pure policy modules (never an SSH/API client), so `ArtifactReader` importing `BackupStore` does **not** violate the renderer's credential-free source-scan test.

### Surface — three renderer panels, no executor, no MCP tool

- `ArtifactReader` gains `auditStatsPanel(window?)`, `driftStatsPanel()`, `backupStatsPanel()`, each returning the standard `Panel<T>` with a `snapshotTs` + `ageLabel` (the honest-UI rule — a cached stat must never imply liveness).
- `routeUiRequest` gains three GET routes: `/api/stats/audit`, `/api/stats/drift`, `/api/stats/backups`. All are renderer reads; none touch the executor, so they are unaffected by strict renderer-only mode (a metrics dashboard is the *whole point* of renderer-only).
- `page.ts` gains one "Metrics" board beside the existing census/drift/audit/health/changes panels.

## Scope boundaries

- **Renderer-only in v1; no metrics MCP tool.** Looking at trends is a human-principal activity (ADR-010 §1) — the renderer's job. An agent mid-session already has `query_audit` and `verify_integrity` for point questions. A read-only `metrics` MCP tool is a plausible follow-up but is deliberately **held out of v1** to avoid surface creep; adding one would be a `TOOL_MIN_TIER` row (companion, read-only) and nothing else, but it is not part of this ADR.
- **No scrape endpoint, no exporter, no time-series database, ever.** This is a hard exclusion, not a deferral — it would violate ADR-010's no-standing-network-surface property. The dashboard renders on pull.
- **No per-tool latency / request-rate instrumentation.** This is a single-user LAN tool, not a high-throughput service; instrumenting it like one is noise. Metrics describe *what was done and what changed*, not server performance.
- **`query_audit` is unchanged.** The new audit stats live in `metrics/auditStats.ts`; the existing `summarizeAuditRecords` keeps its current shape and consumers.

## Consequences

**Positive.** The operator gets three trends that no existing tool produces, at zero node cost and zero credentials: write/failure throughput, tamper-pressure (unexplained drift over time — the flagship), and durability-layer health (capacity + the re-anchor early-warning for out-of-band churn). All three reuse artifacts already on disk; the only new node-touching cost is *none*. The metrics live in the one place that is already loopback-only and fail-closed, so the security posture is unchanged.

**Negative / cost.** Three new pure modules + one `SnapshotStore.loadAll()` + one `BackupStore.storeStats()` + three router routes + one UI board. `loadAll()` and `storeStats()` do bounded local-disk reads (retention-capped snapshot count; backup metas only, not blobs).

**Honest limits.**
- **Audit stats see only what the server did.** Out-of-band changes never appear there — that is precisely what the drift trend is for; the two are complementary, by the ADR-009 design.
- **Drift-trend resolution is bounded by retention and by verify cadence.** The series is the last `driftRetentionCap` reports (default 30), and a report is persisted only when `verify_integrity` runs from an MCP session — so the trend is *per-run*, not *per-unit-time*. Gaps between verifies are invisible; a regular verify cadence (and/or a larger `driftRetentionCap`) is what makes the trend meaningful. This is stated in the panel note, not hidden.
- **Backup stats do not compute live revertibility.** Whether a given delta is *currently* applicable depends on the live file hash (ADR-014 §1), which needs a node read — out of bounds for the credential-free renderer. The kind mix and re-anchor count are computed from local metas only; `list_backups`/`diff_config` remain the live-revertibility path.

## Implementation notes

- **New pure core (`src/metrics/`):** `auditStats.ts` (`computeAuditStats(records, opts)`), `driftStats.ts` (`computeDriftTrend(snapshots)`), `backupStats.ts` (`summarizeBackupStore(entries, caps)`). No I/O, no `Date.now()`/`Math.random()` inside — add them to the CLAUDE.md "Key invariant" pure-function list and hold them to the ~90% line/branch bar with the rest of the guardrail/policy core.
- **Thin I/O additions:** `SnapshotStore.loadAll(): StoredSnapshot<T>[]` (newest-first, try/catch per file); `BackupStore.storeStats(): BackupStatEntry[]` (enumerate `.meta` under `baseDir`, reuse the `buildExistingHashMap` walk pattern).
- **Renderer (`ui/artifacts.ts`):** three `Panel<T>` methods; `backupStatsPanel` constructs a `BackupStore` (allowed — no SSH/API import); the `artifacts.test.ts` source-scan stays green.
- **Router (`ui/router.ts`):** three `GET /api/stats/*` routes, pure-dispatch like the existing ones; covered by `router.test.ts` without a socket.
- **Page (`ui/page.ts`):** one self-contained Metrics board in the existing no-build HTML string.
- **Config (`config.ts`):** a small `metrics.*` block — `defaultWindowDays` (default 30), `defaultBucket` (`"day"`) — env `METRICS_DEFAULT_WINDOW_DAYS` / `METRICS_DEFAULT_BUCKET`, both optional. Drift-trend depth reuses `ui.driftRetentionCap`; no new retention knob.
- **No new tool, no new tier row, no new credential, no new network surface.** Everything is read-only aggregation over artifacts already on the Windows host.
