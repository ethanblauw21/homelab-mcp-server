# ADR-008: The Docker Layer — Container-in-Container Safety, Compose Rollback & Dogfooding Fixes

**Status:** Accepted — implemented 2026-06-14 (all 10 action items complete; snapshot-tier deviation resolved at companion)
**Date:** 2026-06-11
**Deciders:** Ethan
**Depends on:** ADR-003 (target descriptors, backup pipeline, `pct pull/push`, snapshot guard), ADR-004 (denylist v2, `computeUnifiedDiff`, size caps, confirm gate), ADR-005 (`tail_log` redaction precedent), ADR-006 (`config_sweep`), ADR-007 (tiers, NodeOps/API backend)
**Source:** First real-usage dogfooding report (2026-06-11): file-storage cleanup, Portainer stack fix, homepage config update performed through the server by a Claude session.

## Context

The dogfooding report surfaced one structural truth and several precise frictions. The structural truth: **ADR-003's founding argument recurses.** The lab's real topology is three layers — node → LXC → Docker — and the most-edited configs (Sonarr, Portainer stacks, homepage) now live one layer deeper than the safety envelope reaches. Reading one API key took four hops (`pct_exec docker inspect` → find volume → `pct_exec docker exec cat`); editing a compose file has the same unprotected status container files had before ADR-003: no path validation, no backup, no revert, content through argv.

The precise frictions: no diff visibility after writes (only two hashes); `curl` demanding `confirm: true` (a spec violation — see §4); no Docker log access without raw `pct_exec`; and a genuine rollback gap on **CT101 (dockerBoss)**, which cannot snapshot due to GPU passthrough — the lab's most important guest is the one without an outcome-level undo.

**Scope exclusion, recorded as a decision:** streaming / async-job output for long-running commands (e.g. `docker build`) is **deliberately deferred** (Option D). MCP tool calls are request/response; true mid-run streaming is not the server's to provide, and the operator has chosen to accept buffered output as a known limitation of the system rather than build job-handle machinery now. This is a revisitable decision, not an oversight.

## Decision

### 1. `docker` target descriptors — the pipeline extends one layer down

`BackupTarget` gains `kind: "docker"` with `{ vmid, container, remotePath }`; `targetKeyString` ⇒ `docker:<vmid>:<container>:<remotePath>`.

- **Identity is the container *name*** (validated against Docker's name charset `[a-zA-Z0-9][a-zA-Z0-9_.-]*`), not the id: names survive container recreation — which is precisely when you want revert to still resolve. The container id at time-of-write is recorded in the audit record for forensics.
- Tier rules follow ADR-007's target-kind pattern: `docker` targets are **companion**-grade (`targetMinTier("docker") = "companion"`); `revert_file`, `diff_config`, and `list_backups` accept the new kind via the existing meta-routing — no API change for callers.

### 2. The Docker tool family (companion tier)

All tools take `vmid` (the LXC hosting the daemon) + `container`, route through the existing `pct exec` plumbing with fixed command construction (validated name, validated path, content never via argv).

**`docker_ps`** `{ vmid }` — structured listing (`docker ps --format '{{json .}}'` per line, pure parser): name, image, status, ports, compose project label when present. Read-only.

**`docker_exec`** `{ vmid, container, command, timeoutMs?, confirm? }` — `docker exec <container> sh -c '<escaped>'` inside the LXC. The inner command passes denylist v2 (DENY + CONFIRM tiers) like every other exec path; ADR-004's timeout wrapper composes inside.

**`docker_read_file` / `docker_write_file`** `{ vmid, container, path, content?, encoding }` — full pipeline parity with `pct_*_file`:

- **Bind-mount fast path (the dogfooding lesson made into design):** the handler first resolves the path against the container's mounts (`docker inspect --format '{{json .Mounts}}'`, pure parser). If the path lives on a bind mount, the operation **becomes a `pct_read_file`/`pct_write_file` on the LXC-side source path** — one fewer copy hop, and exactly what the dogfooding session did by hand. The backup target remains the `docker:` descriptor the caller named (identity follows intent, not plumbing).
- **`docker cp` slow path** otherwise: read = `mktemp` in LXC → `docker cp <c>:<path> <tmp>` → existing `pct pull` flow; write = reverse, then ownership/mode restoration via `docker exec stat`-before / `chown`+`chmod`-after (best-effort with a documented note when the image lacks `stat`). Temps cleaned in `finally` at both layers; the local backup is written before any push, so a leaked temp is never the only copy.
- Backup, large-change detection, disk pressure, audit (with `vmid`, `container`, both hashes, backup pointer), ADR-004 size caps: all unchanged, all apply.

**`docker_logs`** `{ vmid, container, tail?, since? }` — `docker logs --tail N [--since X]`; `tail` capped (shared with `tail_log`'s cap), `since` uses `tail_log`'s validated grammar, and output **passes mandatory redaction** (the `tail_log` precedent: container logs leak API keys and tokens constantly). Read-only, not audited.

### 3. Diff visibility on every write

- `write_file`, `pct_write_file`, and `docker_write_file` responses now include `diff`: the truncated unified diff (`computeUnifiedDiff(prev, next)`, existing line cap) alongside the hashes — every write becomes its own review, at zero extra I/O (both contents are already in hand).
- New-file writes report `diff: null, newFile: true`. `dryRun` behavior is unchanged (it already returns the diff).
- `diff_config`'s tool description is amended to name its second job explicitly: *"use after a write to verify what changed (current vs. latest backup)."*

### 4. Heavy-pattern gate drift — bug fix, not feature

The dogfooding session was forced to pass `confirm: true` for a read-only `curl` health check. Per ADR-001/ADR-004, heavy-pattern detection (`curl`, `wget`, `tar`, `rsync`, …) is an **audit annotation only**; the CONFIRM gate is reserved for availability-class commands and the DENY tier for destruction. Gating on heavy patterns is implementation drift and is removed wherever it crept in (gate wiring or a `confirm:curl` config entry).

Regression suite (write first): `curl http://localhost:3000/health` ⇒ `allow` (audited `isHeavy: true` at most); same for `wget`, `tar`, `rsync` fixtures; `reboot` still ⇒ `confirm`; DENY fixtures unchanged.

### 5. Census: snapshot capability per guest (graduated from ADR-007 §6 notes to requirement)

The `containers`/`vms` sections gain `snapshotCapable: { capable: boolean, reason?: string }`, computed as a **best-effort heuristic** from data the census already collects: rootfs storage type (lvmthin/ZFS/qcow2 ⇒ capable; `dir` ⇒ not) AND absence of device-passthrough markers in the guest config (`devN:`, `lxc.cgroup2.devices.*`, `lxc.mount.entry` device lines ⇒ not capable, reason "device passthrough"). CT101's GPU passthrough becomes visible on the map, so no tool (or Claude) recommends a checkpoint the node will refuse. Drift treats the field as non-noise (a capability change is real drift).

### 6. Outcome-level rollback where snapshots can't go

Two complementary answers for snapshot-incapable guests, both honest about their weight:

**`guest_backup`** `{ vmid, mode?: "suspend" | "stop" | "snapshot", note?, confirm: true }` — wraps **vzdump**, which works with device passthrough (suspend/stop modes). ADR-003 rejected vzdump *as the snapshot mechanism* (minutes-scale, heavy); as the **fallback where snapshots are impossible**, it is exactly the right tool, and that distinction is now recorded. Confirm-gated (suspend/stop interrupts service); archives are note-tagged `mcp-`; per-guest retention cap on `mcp-`-tagged archives (default **1** — vzdump archives are large and node disk is premium); human-made archives are invisible to retention, per the snapshot ownership rule. vzdump *is* API-expressible (`POST /nodes/<n>/vzdump`, and the implementation rides the API backend when configured — "SSH-CLI + API both"), but **the tier floor is companion, not operate** (snapshot-tier resolution, see §"Decision" / Action Item 8): the `mcp-` archive-ownership boundary, per-guest retention, and confirm gate are MCP-server tripwires with no Proxmox-RBAC equivalent — placing a destructive whole-guest restore behind RBAC that is blind to the `mcp-` tag would split the guardrail story. Every service-affecting guest verb (`snapshot_*`, `guest_backup*`, `compose_redeploy`) lands on ONE companion/MCP enforcement story; only the *transport* follows the tool.

**`guest_backup_restore`** `{ vmid, archive, confirm: true, stopIfRunning?: boolean }` — the heaviest hammer in the server: replaces the entire guest from an archive. Gating mirrors `snapshot_rollback` exactly (confirm required; `mcp-`-tagged archives only; refuses a running guest without `stopIfRunning`; restarts iff it was running); audited `isLargeChange: true` with prior run-state.

**`compose_redeploy`** `{ vmid, composePath, confirm: true }` — the lighter, usually-better rollback for a Docker host: `docker compose -f <path> up -d` inside the LXC. Combined with the pipeline now protecting compose files (via `pct_write_file`/`docker_write_file` + `config_sweep`), **`revert_file` + `compose_redeploy` is the stack-level rollback story for CT101**: revert the compose file from backup, redeploy, done — seconds, not minutes, no vzdump required. Confirm-gated (service disruption); audited; companion tier. Image-tag pinning in compose files is documented as the operator practice that makes this rollback deterministic.

## Options Considered

### Option A: Pipeline-extended Docker descriptors + tool family + compose/vzdump rollback *(chosen)*
Pros: the safety envelope reaches where the configs actually live; one-hop access replaces four-hop archaeology; rollback hierarchy matches reality (snapshot where possible, compose-revert where it's a Docker host, vzdump where nothing else works); zero new credential or trust surface (everything rides existing pct plumbing / the API). Cons: the `docker cp` slow path is a three-filesystem relay (mitigated by the bind-mount fast path, which covers the common case); ownership restoration inside minimal images is best-effort.

### Option B: SSH/agents inside Docker containers
Rejected: per-container credentials and daemons multiply the exact burden ADR-001/ADR-007 centralized; containers are ephemeral, agents in them doubly so.

### Option C: Expose the Docker socket/API from the LXC to the server
Rejected: a reachable Docker socket is root-equivalent on that host and a standing attack surface; the `pct exec` relay keeps the daemon unreachable from anything but the node itself.

### Option D: Async job handles / streaming for long-running commands
**Deferred by operator decision.** The buffered request/response model is accepted as a known limitation; MCP cannot deliver true mid-run streaming to the model regardless, and the job-handle pattern (state in a deliberately stateless server) is not worth its cost today. Revisit if build/deploy workflows become routine.

## Security & Audit Model

- No new trust surface: Docker operations are command construction over the existing companion-tier SSH path (vzdump rides the companion-tier `NodeOps` — API-or-SSH transport, companion floor); the daemon socket is never exposed; container names and paths are charset/path-validated; file content travels SFTP + `docker cp`, never argv.
- `docker_exec` is the fourth consumer of denylist v2 + the confirm gate — every exec path in the server now shares one guardrail.
- `docker_logs` joins `tail_log` as a mandatory-redaction output; `docker_read_file` deliberately does **not** redact (fidelity is the point of a file read — reading a config to use its API key is the operator's legitimate choice), which is consistent with `pct_read_file`/`read_file`.
- `guest_backup_restore` adopts the confirm-gate + `mcp-` ownership boundary verbatim; the gate pattern now covers stop, rollback, restore, and redeploy — the complete set of service-affecting verbs.

## Consequences

- **Easier:** Sonarr's config is one tool call with a backup behind it; "what changed" is in every write response; CT101 finally has a rollback story (compose-revert for the common case, vzdump for the catastrophic one); the census map shows where snapshots work before anyone needs one.
- **Harder:** the mounts parser and ownership restoration add per-image variability to test; vzdump archives need their own retention discipline; three exec layers (host/pct/docker) now compose the timeout wrapper — the quoting helper earns its tests.
- **Recorded:** streaming stays out, deliberately.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Heavy-gate regression (§4) | Unit (critical, first) | `curl`/`wget`/`tar`/`rsync` ⇒ allow + `isHeavy` annotation; gate fixtures unchanged for CONFIRM/DENY |
| `docker` target descriptor | Unit | Key string, meta round-trip, legacy compatibility, `targetMinTier("docker")` |
| Mounts parser + fast-path resolution | Unit | Bind mount hit ⇒ LXC path rewrite; volume/no-mount ⇒ slow path; nested mount precedence (longest prefix wins) |
| `docker_write_file` pipeline | Unit (FakeTransport) | Backup with `docker:` key, diff in response, audit carries container name + id, temp cleanup both layers on success and failure |
| Ownership restoration | Unit | stat parse, chown/chmod command construction, stat-less image fallback note |
| `docker_logs` validation + redaction | Unit (critical) | tail cap, since grammar, name charset; seeded secret in log fixture never appears in output |
| Diff-on-write | Unit | All three write tools include truncated diff; `newFile: true` path; dryRun unchanged |
| `snapshotCapable` heuristic | Unit | lvmthin+no-devices ⇒ capable; `dir` storage ⇒ not; `dev0:` passthrough ⇒ not w/ reason; drift treats change as real |
| vzdump tools | Unit + fixture | API request construction, `mcp-` tagging, retention planner (human archives untouched), restore gating matrix (mirrors rollback tests) |
| `compose_redeploy` | Unit (FakeTransport) | Confirm gating, command construction, audit record; revert+redeploy composite documented in an integration scenario |
| Docker E2E | Integration | Docker harness gains a `docker` shim beside the `pct` shim: write → backup → revert → redeploy round-trip |

## Action Items

1. [x] **§4 first** (it's a bug): remove heavy-pattern gating, write the regression suite, ship independently of the rest.
2. [x] Extend `BackupTarget`/`targetKeyString`/meta routing/`targetMinTier` with the `docker` kind.
3. [x] Implement the mounts parser + path-resolution fast path (pure, fixtures from real `docker inspect` output).
4. [x] Implement `docker_read_file`/`docker_write_file` (fast + slow paths, ownership restoration, caps) sharing the pipeline stages.
5. [x] Implement `docker_ps`, `docker_exec` (denylist v2 + confirm), `docker_logs` (validation + mandatory redaction).
6. [x] Add diff-on-write to all three write handlers; amend `diff_config`'s description.
7. [x] Census `snapshotCapable` heuristic + drift handling; file as the ADR-002 amendment.
8. [x] Implement `guest_backup` + retention + `guest_backup_restore` (gated). **Resolved jointly with the snapshot-tier deviation: landed at companion, not operate** — vzdump rides API-or-SSH via `NodeOps`, but the `mcp-` ownership/retention/confirm guardrails are MCP-server tripwires with no RBAC equivalent, so every service-affecting guest verb shares ONE companion/MCP enforcement story (rationale inline in `tiers/registry.ts` + `tools/backupTools.ts`).
9. [x] Implement `compose_redeploy`; document the revert+redeploy rollback runbook and image-pinning practice.
10. [x] Update CLAUDE.md (tool table, fourth exec path, descriptor kinds, §6 + snapshot-tier unification) and the tier registry snapshots.

## References

- Dogfooding report (2026-06-11) — source of §§1–6 requirements and the deferral in Option D
- ADR-003 — the argument this ADR recurses; pipeline stages and ownership-boundary patterns reused
- ADR-004 §5 — heavy-vs-gate separation restored by §4
- ADR-007 — target-kind tier rule, API-native enforcement for vzdump
- Proxmox `vzdump`/API docs; Docker `cp`, `inspect` Mounts, `logs`, compose CLI