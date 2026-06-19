# ADR-014: Re-anchor the Backup Chain on Out-of-Band Drift; Tell the Truth About Revertibility

**Status:** Accepted
**Date:** 2026-06-18
**Deciders:** Ethan
**Depends on:** ADR-003 (backup pipeline / reverse-diff chain), ADR-004 (`dryRun`, exit semantics), ADR-005 (`diff_config` / revert-preview triad), ADR-008 (diff-on-write, docker file targets)

## Context

This is issue #20. The delta-backup chain (ADR-003) silently becomes unusable once a file is edited **outside** the managed write path — e.g. a `sed -i` run through `pct_exec`, or a package upgrade rewriting a config.

The mechanism: a `gzip-diff` backup stores a **reverse diff** whose envelope carries `baseHash = sha256(newContent)` — the content the managing write produced. To reconstruct the backed-up (previous) content you apply that diff to the current file, and `applyReverseDiff` **refuses unless the current file still hashes to `baseHash`**. That guard is correct — applying a reverse diff to the wrong base would corrupt the file — but it means a delta backup is only revertible while the on-disk file is *exactly* the version that write left behind.

Two failures fall out of this:

1. **Overstated durability.** `list_backups` reports `revertible: true` for **every** non-metadata version, unconditionally. After an out-of-band edit, *none* of the deltas can actually be applied, yet the listing still claims they can. `diff_config` and `revert_file` then fail with `Cannot apply delta backup: the current file has changed since this backup was created (base …, current …)` — for every version in the chain. The guarantee the listing advertised was a lie.

2. **A silently broken chain.** Once the file drifts, the managed chain has no anchor that matches reality. The out-of-band content itself was never captured (the audit log and blob backups never witnessed it — `config_sweep` is the only thing that does, and it lives in a separate subsystem). The next managed write stores *another* delta against the drifted content, extending a chain whose older links are already unreachable.

Observed in the wild: `/var/lib/docker/volumes/portainer_data/_data/compose/1/docker-compose.yml` on CT 101, edited via `sed`; `diff_config` failed for both the latest backup and an explicit older `backupPath`; `config_sweep` separately reported `pct:101 deleted: 8` — out-of-band churn nothing in the backup/audit path ever saw.

## Decision

Two coordinated fixes — one makes the system *honest* about what it can do, the other makes the chain *survive* drift.

### 1. Honest revertibility — classify against the current file, never assume

Revertibility is no longer a static `true`. It is decided by a pure classifier (`classifyRevertibility`, `backup/policy.ts`) over three inputs: the backup's `kind`, whether it is **self-contained**, and the **current file hash**:

- **metadata-only** → not revertible (no content stored). Unchanged.
- **self-contained** (a `gzip-full`, the large-file raw fallback, or a re-anchor snapshot — §2) → **always revertible**, regardless of current content. These carry the full prior bytes; no base match is required.
- **delta** (`mcp-rdiff-v1`) → revertible **iff** `currentHash === requiresBaseHash`. If the current file drifted (or can't be read / was deleted), the version is reported `revertible: false` with a `revertReason` naming the base/current mismatch.

To support this without reading every blob, each backup's `.meta` now records `requiresBaseHash: string | null` (the hash a delta needs the current file to be; `null` ⇒ self-contained). `list_backups` reads the **current file once** (best-effort, tolerant of a missing file / stopped guest) and classifies every version against that single hash; `diff_config` classifies the chosen version **before** attempting `restore`, returning a structured `revertible: false` + reason instead of surfacing the raw delta-mismatch throw.

Legacy backups (no `requiresBaseHash` in the meta) degrade **conservatively**: a legacy `gzip-diff` is assumed to require its recorded `hash` as the base (so a drifted file marks it non-revertible) — understating, never overstating, is the safe direction.

### 2. Re-anchor on drift — capture the drifted content as a self-contained snapshot

Every managed write already reads the current on-disk content (`prevContent`/`prevHash`) before writing. The store now also exposes `latestBaseHash(target)` — the `hash` of the most recent managed backup, i.e. *what the file should be if nothing touched it since our last write*. When

```
chainBaseHash !== null  &&  prevHash !== null  &&  prevHash !== chainBaseHash
```

the file drifted out-of-band since the last managed write. In that case `selectBackupKind` stores a **`gzip-full` snapshot of `prevContent`** (the drifted, soon-to-be-overwritten bytes) instead of a delta — marked `reanchored: true`, `requiresBaseHash: null`. The result:

- The out-of-band state becomes a **durable, always-revertible restore point** — it survives future writes (no base-match dependency), so you can always get back to "what the file was just before the server overwrote it."
- The chain re-anchors: the drift discontinuity is sealed behind a self-contained snapshot rather than an unreachable delta.

Re-anchor snapshots are **excluded from the dedup hash map** (`buildExistingHashMap` skips `reanchored` metas): their blob holds `prevContent` while `meta.hash` records `newContent` (kept so the chain's drift detection stays continuous), so they must never be reused as a dedup target for `newContent`. Dedup still wins when it legitimately applies — the drift check sits on the delta-producing branches, after the dedup short-circuit, so a genuinely-identical re-write still dedups.

### Scope boundaries

- **The chain is still operationally a delta chain.** Re-anchoring is a *targeted* full snapshot at the moment drift is detected, not a switch to full snapshots everywhere — deltas remain the common, space-efficient case. The honest classifier means a non-re-anchored delta is correctly reported revertible only while the file sits at its base.
- **This does not retroactively repair existing broken chains.** A chain already drifted before this change stays drifted; the classifier now *reports* that truthfully instead of failing at revert time. The re-anchor protects the chain from the *next* drift onward.
- **`qm` and `docker` targets** inherit the same meta field and classifier. `qm`/`docker` are still excluded from the git mirror (ADR-006) and the forest (ADR-009) — unchanged.
- **The deeper fix is a first-class in-audit edit tool (#16)** so edits stop bypassing the chain entirely; that is out of scope here. This ADR makes the bypass *visible and survivable*, not impossible.

## Consequences

**Positive.** `list_backups` no longer lies — `revertible` reflects what can actually be applied right now, with a reason when it can't. `diff_config` degrades to a structured, explanatory response instead of a raw stale-base error. An out-of-band edit is now *captured* the next time the server writes, as a self-contained snapshot you can always revert to. The three states (self-contained / applicable delta / stale delta) are distinguishable.

**Negative / cost.** `list_backups` now does **one** best-effort node read (to hash the current file) where before it did none — bounded, tolerant of failure (a missing file / stopped guest just yields "unverifiable ⇒ deltas non-revertible"). A re-anchor stores a full snapshot (larger than a delta) on the write that detects drift — paid once per drift event, and only then.

**Honest limits.** Re-anchor detection compares the previous on-disk hash to the last *managed* backup's base; it cannot see drift that happened and was *reverted* back to the same bytes between writes (the hash matches, so no drift is inferred — correctly, since the content is identical). The legacy-meta conservative degradation can understate revertibility for pre-ADR-014 large-file raw fallbacks (rare, > 2000-line files); new backups record `requiresBaseHash` explicitly and are exact.

## Implementation notes

- **Pure core (`backup/policy.ts`):** `computeReverseDiff` returns `{ buf, baseHash }` (`baseHash: null` for the large-file raw fallback); `BackupKind` `gzip-diff` gains `requiresBaseHash`, `gzip-full` gains optional `reanchored`; `selectBackupKind` takes `chainBaseHash` and emits a re-anchor `gzip-full` on drift; new pure `classifyRevertibility(view, currentHash)`.
- **Store (`backup/store.ts`):** `storeBackup` persists `requiresBaseHash` (+ `reanchored`) into the `.meta`; `buildExistingHashMap` skips re-anchored metas; new `latestBaseHash(target)`; `listBackupsForPath` surfaces `requiresBaseHash`/`reanchored`/`selfContained`.
- **Shared read (`tools/targetContent.ts`):** `readCurrentForTarget(transport, target, cfg)` — the per-kind current-content read (host SFTP / `pct pull` / `docker` relay) reused by `diff_config` and `list_backups`.
- **Handlers:** `list_backups` takes the transport and classifies honestly; `diff_config` classifies before `restore`; the four `*_write_file` surfaces fetch `latestBaseHash` and pass `chainBaseHash` into `selectBackupKind` (real-write and `dryRun` paths).
- **No new tool, no new tier row, no new mutation surface.** A re-anchor write is an ordinary backup; revertibility classification is read-only.
