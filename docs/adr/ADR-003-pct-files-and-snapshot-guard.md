# ADR-003: Container File Safety (`pct_read_file`/`pct_write_file`) + Snapshot Guard

**Status:** Proposed
**Date:** 2026-06-09
**Deciders:** Ethan
**Depends on:** ADR-001 (SSH MCP server), ADR-002 (census + redaction), TESTING-STRATEGY-ssh-mcp-server.md

## Context

ADR-001's safety story — backup before mutation, audit, one-step revert — currently covers **host file writes only**. Two gaps remain, and they are the two highest-risk paths in real use:

1. **Container files are unprotected.** The services this lab actually runs (Gluetun, Tailscale, Portainer-managed stacks, etc.) live *inside* LXC containers. Editing their configs today means `pct_exec 'echo … > /etc/…'`, which bypasses path validation, the backup pipeline, and revertibility entirely. The most-edited files in the lab are the least protected.
2. **Command side effects are unrevertible.** ADR-001 explicitly accepts that `execute`/`pct_exec` consequences are logged but not undoable. File-level backups can't fix a botched package upgrade or a service migration gone wrong. Proxmox already has the right primitive for outcome-level undo: **guest snapshots**.

This ADR closes both gaps as one coherent extension of the revert guarantee: file-level revert reaches into containers, and outcome-level revert exists for everything else.

**Coordination note (BackupStore meta schema).** Both changes touch backup metadata, and a known defect lives there: the dedup path maps content hashes to `.meta` sidecar paths and reports `revertible: true`, but `restore()` refuses `.meta` paths — so deduplicated backups cannot actually be reverted. Implementing this ADR's meta-schema change (below) MUST fix that defect in the same change set: meta records gain a `blobPath` field, dedup resolves hash → **blob**, and a round-trip test (write identical content twice → revert) guards the fix.

## Decision

### Part 1 — Container file tools through the existing pipeline

Two new tools that make container files first-class citizens of the backup/audit/revert system.

**`pct_read_file`** `{ vmid: number, path: string, encoding: "utf8" | "base64" = "utf8" }`

Flow (binary-safe, no `cat`-over-exec):
1. `validatePath(path)` with the global allow/denylists.
2. On the node: `mktemp` → `pct pull <vmid> <path> <tmp>` → SFTP-read `<tmp>` → delete `<tmp>` (in a `finally`).
3. Return content in the requested encoding.

**`pct_write_file`** `{ vmid: number, path: string, content: string, encoding: "utf8" | "base64" = "utf8" }`

Flow — deliberately the same skeleton as `writeFileHandler`, sharing its pipeline stages rather than reimplementing them:
1. `validatePath` → read previous content via the `pct_read_file` flow (absence ⇒ new file) → large-change detection → disk-pressure check.
2. Backup via the existing policy/store, with the **file key derived from a target descriptor** `pct:<vmid>:<path>` instead of the bare path, so host and container files never collide in the store.
3. Stat the existing file first (`pct exec <vmid> -- stat -c '%a %u %g' <path>`); SFTP-write content to a node temp file; `pct push <vmid> <tmp> <path> --perms <mode> --user <uid> --group <gid>` to preserve ownership/permissions (new files use configurable defaults, `0644 root:root`); delete temp in `finally`.
4. Audit record with `vmid` + `path` + hashes + backup pointer, exactly like host writes.

**Revert routing.** Backup `.meta` records gain a target descriptor: `{ target: { kind: "host" | "pct", vmid?, remotePath }, blobPath, hash, kind }`. `revert_file` resolves the descriptor **from the meta**, so the caller passes only `backupPath` as today, and the handler routes restoration through SFTP (host) or the push flow (container). The `path` input becomes optional and, when supplied, must match the meta — a mismatch is an error, not a reinterpretation. `list_backups` gains an optional `vmid` to scope queries.

**Temp-file hygiene on the node:** all temps created via `mktemp` under `/tmp`, deleted in `finally` even on failure; a leaked temp must never contain the only copy of anything (the local backup is written before the push).

### Part 2 — Snapshot guard (outcome-level revert)

Four tools wrapping Proxmox guest snapshots, with one hard rule: **the server only ever manages snapshots it created**, identified by a reserved name prefix `mcp-` (e.g. `mcp-20260609-213000`). User-created snapshots are invisible to retention and protected from deletion/rollback-cleanup by the server.

**`snapshot_create`** `{ vmid, note?: string }`
- Auto-detects guest type (vmid present in `pct list` ⇒ `pct snapshot`, else `qm snapshot`).
- Name is server-generated (`mcp-<compact-ts>`, sanitized to Proxmox's allowed charset); `note` goes into the snapshot description and the audit record.
- **Retention before creation:** count `mcp-*` snapshots for the guest; if at the per-guest cap (default **3**, configurable — snapshots consume *node* disk, which is premium), delete the oldest `mcp-*` snapshot first. Reuses the eviction-planning pattern (pure planner + thin executor).
- Surfaces storage-driver errors verbatim (snapshots require ZFS/LVM-thin/qcow2 etc.; directory storage will refuse — that's the node's answer, not the tool's).

**`snapshot_list`** `{ vmid }` — parses `pct listsnapshot` / `qm listsnapshot` into structured rows, flagging which are `mcp-`-managed.

**`snapshot_rollback`** `{ vmid, name, confirm: boolean, stopIfRunning?: boolean = false }`
- Rollback **discards all guest state since the snapshot** — this is the most destructive operation the server can perform, so:
  - `confirm: true` is required; absence is an error with an explanatory message (mirrors the deliberate-action escape hatch philosophy from ADR-001 follow-ups).
  - Only `mcp-*` snapshots may be targeted; rolling back to a user snapshot stays a manual Proxmox-UI decision.
  - If the guest is running and `stopIfRunning` is false ⇒ refuse with a clear error. If true ⇒ stop, roll back, and restart iff it was running before.
- Audited with `isLargeChange: true` and a note capturing prior run-state and the snapshot name.

**`snapshot_delete`** `{ vmid, name }` — `mcp-*` names only; audited.

**Intended workflow (convention, not automation):** before a risky `execute`/`pct_exec` sequence (package upgrades, service migrations), the model calls `snapshot_create`, performs the work, verifies, then either `snapshot_delete` (success) or `snapshot_rollback` (failure). Automatic snapshot-before-heavy-command is **deferred** (stretch): it couples two failure domains and would fire on the heavy-pattern false positives already known in `largeChange.ts`; revisit once those patterns are anchored.

## Options Considered

### Option A: Pipeline-integrated `pct pull/push` tools + prefix-scoped snapshot tools *(chosen)*
Pros: container files inherit the entire tested backup/audit/revert machinery; binary-safe transfers; outcome-level undo with a hard ownership boundary (`mcp-` prefix) protecting human-made snapshots; retention respects the premium-node-disk constraint. Cons: more moving parts per write (pull, temp, push); rollback semantics vary by storage driver and must be surfaced, not hidden.

### Option B: Reach container files over `pct exec` (`cat`/`tee` + base64)
Pros: no SFTP/temp choreography. Cons: shell-quoting and size limits, command-buffer ceilings for large files, exit-code ambiguity, and the content transits argv/heredocs where it can leak into shell history and audit `cmd` fields. Rejected.

### Option C: Vzdump/full-guest backups instead of snapshots for outcome revert
Pros: works on all storage types; survives node-disk loss if dumped to external storage. Cons: minutes-scale, heavy on premium disk, wrong granularity for "undo the last 10 minutes." Snapshots are the right tool; vzdump remains the human-managed disaster layer. Rejected for this purpose.

### Option D: Automatic snapshot before every heavy command
Deferred as above — false-positive coupling; revisit after denylist/heavy-pattern anchoring work.

## Security & Audit Model

- Both file tools sit behind the same `validatePath` lists as host tools; the backup store and disk-pressure fail-safe apply unchanged.
- `snapshot_rollback` joins a new (currently singleton) class of **confirm-gated destructive tools**: schema-level `confirm: true`, refusal text that explains the blast radius, and a mandatory audit record. Future deliberate-action tools (e.g. the planned `reboot` escape hatch) should reuse this gate pattern.
- The `mcp-` prefix is the ownership boundary: the server can never delete, roll back to, or count-against-retention any snapshot a human made.
- Nothing in this ADR adds caller-controlled shell strings: `pct pull/push/snapshot/rollback` invocations are built from validated `vmid` (integer), server-generated names, and `mktemp` outputs; the only free-form string is the file *content*, which travels via SFTP, never argv.

## Consequences

- **Easier:** the configs that matter most are now as protected as host files; risky operations get a checkpoint/rollback story; the audit log becomes a complete record of every mutation path the server offers.
- **Harder:** per-write latency on container files roughly doubles (pull + push); snapshot behavior varies by storage backend, so error surfacing and the E2E pass on the real node matter; the meta-schema migration must keep old backups readable (legacy meta without `target` is interpreted as `kind: "host"`).
- **Marketable:** combined with ADR-002, the pitch becomes: inventory, redaction, file-level revert *including inside containers*, and outcome-level rollback — a safety envelope no surveyed community server approaches.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Dedup → revert round-trip | Unit (critical) | Regression test for the meta/blob defect: identical content twice, revert via the dedup pointer restores exact bytes |
| Meta schema + legacy migration | Unit | Old meta (no `target`) reads as host; new meta round-trips `pct` descriptor; mismatch between caller `path` and meta is rejected |
| `pct_write_file` pipeline | Unit (FakeTransport) | Backup created with `pct:` file key, audit has `vmid`, perms-stat string parsed, temp cleanup on success *and* on push failure |
| `pct pull/push` command construction | Unit | Integer-validated vmid, mktemp path threading, `--perms/--user/--group` flags |
| Snapshot name generation/sanitization | Unit | Charset-safe, collision-resistant, always `mcp-` prefixed |
| Snapshot retention planner | Unit | Cap reached ⇒ oldest `mcp-*` selected; user snapshots never selected |
| `listsnapshot` parsers | Unit | Real captured output fixtures for `pct` and `qm`, incl. `current` marker and description fields |
| Rollback gating | Unit | Missing `confirm` ⇒ error; non-`mcp-` name ⇒ error; running guest without `stopIfRunning` ⇒ error; prior-run-state restored logic |
| Container file E2E | Integration | Docker harness with `pct` shim: write → backup exists → revert restores bytes inside "container" |
| Snapshot flow E2E | E2E (manual) | On a disposable guest: create → list → mutate → rollback → verify state; verify retention deletes oldest `mcp-*` only |

## Action Items

1. [x] **Meta schema change + dedup-revert fix first** (shared foundation): add `target` and `blobPath` to `.meta`, fix `buildExistingHashMap` to resolve blobs, add the round-trip regression test, handle legacy meta.
2. [x] Implement `pct_read_file` (pull → SFTP read → cleanup) with FakeTransport tests.
3. [x] Implement `pct_write_file` sharing the host pipeline stages; perms preservation; audit with `vmid`.
4. [x] Extend `revert_file` routing + `list_backups` vmid scoping.
5. [x] Implement snapshot name/retention pure functions + `listsnapshot` parsers with fixtures; tests green.
6. [x] Implement the four snapshot tools with the confirm gate and `mcp-` ownership boundary; add new tool names to the `AuditTool` union.
7. [x] Add config: per-guest snapshot cap, new-file default perms, pull/push temp dir. (Plus A3.2 `snapshotVmstate`.)
8. [ ] Docker-harness `pct` shim for integration coverage; wire into CI.
9. [ ] Manual E2E on a disposable guest before first use on real containers.
10. [ ] (Stretch) Auto-snapshot-before-heavy-command, gated on heavy-pattern anchoring; `diff_config` against last backup as a pre-revert preview.

## References

- ADR-001 — pipeline stages, eviction pattern, deliberate-action philosophy
- ADR-002 — census (snapshot-capability per storage could be recorded there later)
- Proxmox `pct`/`qm` man pages — `pull`, `push`, `snapshot`, `rollback`, `listsnapshot`