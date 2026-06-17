# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground truth

`docs/adr/ADR-001-ssh-mcp-server.md` and `docs/adr/TESTING-STRATEGY-ssh-mcp-server.md` are the authoritative spec. Read both before writing code; keep them in sync if the design changes. `docs/adr/ADR-007-permissions-tiers.md` governs the permission-tier model and partially supersedes ADR-001's root-by-default.

## What this is

A Node/TypeScript **stdio MCP server** (`@modelcontextprotocol/sdk`, `ssh2`, `zod`, `vitest`) that connects to a Proxmox VE node on the LAN — over the **REST API** (token auth, all tiers) and/or **root SSH** (key auth, companion+) — and exposes a tier-gated operator toolkit grown across ADRs 001–007:

| Tool | Purpose | ADR |
|------|---------|-----|
| `execute` | Run a shell command on the host (root) | 001 |
| `read_file` | Read a host file (stat-gated, windowed) | 001 / 004 |
| `write_file` | Write a host file (backup + audit; `dryRun` preview) | 001 / 004 |
| `list_directory` | List a host directory | 001 |
| `pct_exec` | Run a command inside an LXC container | 001 |
| `pct_list` | List LXC containers + status | 001 |
| `pct_read_file` / `pct_write_file` | Container file I/O via `pct pull`/`pct push` (`dryRun`) | 003 |
| `revert_file` / `list_backups` | Restore a file from a local backup; list versions | 003 |
| `snapshot_create` / `_list` / `_rollback` / `_delete` | Server-managed (`mcp-`) guest snapshots | 003 |
| `describe_homelab` | Read-only secret-redacted census + drift | 002 |
| `qm_list` | List QEMU/KVM VMs + status | 005 |
| `qm_agent_ping` | Check a VM's QEMU guest agent responsiveness | 005 |
| `qm_exec` | Run a command in a VM via the guest agent (denylist + confirm gate) | 005 |
| `qm_read_file` / `qm_write_file` | VM file I/O via the guest agent (`agent/file-read`/`file-write`; `dryRun`) | 005 |
| `health_check` | Fixed-probe node health → ok/warn/crit, section-isolated | 005 |
| `tail_log` | Bounded, validated, **always-redacted** journal/file tail (host or LXC) | 005 |
| `query_audit` | Filter/summarize the local audit log (read-only, not audited) | 005 |
| `diff_config` | Preview a revert: current → backup diff (read-only, not audited) | 005 |
| `config_sweep` | Hash-compare-before-fetch sweep of watched paths into the git mirror; captures out-of-band edits (one commit per sweep) | 006 |
| `guest_start` / `guest_stop` / `guest_restart` | API-native guest lifecycle (operate tier; `guest_stop` confirm-gated) | 007 |
| `docker_ps` | List Docker containers inside an LXC (name/image/status) | 008 |
| `docker_exec` | Run a command in a Docker container via `pct exec … docker exec` (denylist + confirm gate) | 008 |
| `docker_logs` | Bounded, **always-redacted** Docker container logs | 008 |
| `docker_read_file` / `docker_write_file` | Docker container file I/O (bind-mount fast path / `docker cp` relay; `dryRun`) | 008 |
| `guest_backup` | vzdump archive of a guest — the rollback path for snapshot-incapable guests (confirm-gated; `mcp-` tagged; per-guest retention) | 008 |
| `guest_backup_restore` | Restore a guest from a server-managed (`mcp-`) vzdump archive (confirm + mcp-only + run-state gated) | 008 |
| `compose_redeploy` | `docker compose -f <path> up -d` inside an LXC (confirm-gated; pairs with `revert_file` for stack rollback) | 008 |
| `compute_tree` | Build/refresh the Merkle integrity baseline at L1/L2/L3 (mutates only the local node store) | 009 |
| `verify_integrity` | Read-only drift report: diff forest vs baseline, classify each leaf explained/unexplained; `smart` escalation; optional audited auto-accept | 009 |
| `accept_truth` | Explicit human override: fold current state into all three Merkle baselines (audited) | 009 |
| `edit_file` / `pct_edit_file` / `qm_edit_file` / `docker_edit_file` | Find-and-replace front door to the matching `*_write_file` — send `oldString`→`newString`, not the whole file (token-cheaper); reuses the exact write pipeline (`dryRun` preview) | 011 |

> The four `*_edit_file` tools are **not a new mutation surface** — each reads the target once, applies a literal substring replacement (`applyStringEdit`), and funnels the result through the *same* `writeResolved<Surface>` core as its `*_write_file` sibling, so a button-identical backup/audit/diff/history record results. They inherit the write surface's tier (`edit_file` ⇒ root, the guest three ⇒ companion), path validation, caps, and limits (`qm_edit_file` re-checks `qmWriteMaxBytes` on the resolved bytes). Refusals are honest: a missing file, binary content, a not-found `oldString`, an ambiguous match (without `replaceAll`), or a no-op all throw with **no write**. Multi-edit batching + regex are deliberately out of scope for v1 (ADR-011 §5).

> `config_sweep` is registered **only when git is on PATH**. With git absent the whole config-history subsystem is disabled (writes still succeed, `historyCommitted: false`) and `config_sweep` is unregistered.

> **Tiers gate registration (ADR-007).** Tools above the configured tier are **not registered at all** (`index.ts` filters via `isToolEnabled(name, activeTier)`), so the model never sees them — there is nothing to refuse at runtime. The tool table above is the *root-tier* superset.

> **The localhost UI sidecar (ADR-010) is NOT in this table — it is not an MCP tool.** It is a separate standing process (`npm run ui`) that renders the artifacts the tools above already emit and can run only a tiny **human-principal** subset (`accept_truth`/`verify_integrity`/`compute_tree`/`config_sweep`) when explicitly enabled. The open-ended agent-principal tools above stay reachable **only through an MCP session**. See "Localhost UI sidecar (ADR-010)" below.

## Permission tiers & hybrid transport (ADR-007)

**Least privilege by default; capability by explicit ceremony.** Four tiers, each a strict superset of the one below, with two enforcement grades:

| Tier | Credentials | Enforced by | Adds |
|------|-------------|-------------|------|
| **observe** *(default)* | API token (PVEAuditor) | **Proxmox RBAC** | read-only tools |
| **operate** | API token (custom `MCPOperate` role) | **Proxmox RBAC** | `guest_start/stop/restart` |
| **companion** | + root SSH key | **MCP server** | everything *inside guests* + snapshots, `pct_*`/`qm_*`/`docker_*`, `guest_backup`/`guest_backup_restore`/`compose_redeploy`, `tail_log`, `config_sweep`, guest-target `diff_config`/`revert_file` |
| **root** | + acknowledgment flag | **MCP server** | host `execute`/`read_file`/`write_file`/`list_directory`, host-target `diff_config`/`revert_file` |

- **The distinction is doctrine, not a footnote.** Below companion a server bug or injected prompt **cannot exceed the token's privileges** (the node refuses — Proxmox-enforced). At companion and above the credential *could* do more and the software chooses not to (registration filtering + ADR-004 denylist/confirm + the protected set — **tripwires, not a sandbox**).
- **Tier model is data (`tiers/registry.ts`).** `TOOL_MIN_TIER` maps tool→minTier; `isToolEnabled`/`toolsForTier` derive the rest. `diff_config`/`revert_file` follow their **target kind** (`targetMinTier`: guest⇒companion, host⇒root) via `assertTargetTier`, not a fixed row. **Implementation deltas from the ADR's first draft (kept in sync there):** snapshot tools land at **companion** (still SSH-routed — the `mcp-` protection + eviction + stop/rollback/start orchestration live in the SSH handlers; the ApiBackend snapshot endpoints exist + are fixture-tested for a future operate-tier move); the operate tier's API-native capability is the three lifecycle tools.
- **Hybrid transport (`node/nodeOps.ts`): the transport follows the tool, not the tier.** Structured node ops depend on the `NodeOps` interface; `ApiBackend` (Node `https` — *not* `fetch`, which isn't resolvable here — against `:8006/api2/json`, token header, pinned-TLS agent, 401/403/5xx error mapping; transport injected as `ApiHttp` so tests use fixtures) rides every tier; `SshBackend` (wraps the existing exec + parsers) serves companion+ and anything API-less. `index.ts` picks `ApiBackend` when the four `PVE_API_*` envs are set, else `SshBackend`.
- **Root flag (`tiers/rootFlag.ts`):** `MCP_HOST_ROOT_ENABLED` must equal **exactly** `I-understand-Claude-gets-root-and-can-break-this-node` — any other value (incl. `true`) is disabled. Restart-only; **no runtime escalation path ever** (a hard design exclusion — escalation prompts are a social-engineering surface). While enabled: stderr banner each start; root-tier audit records carry `rootTier: true`.
- **Protected set (absolute, ADR-007 §4):** destructive ops against `/etc/pve` and cluster membership (`pvecm` add/addnode/delnode/qdevice) are **DENY at every tier including root**, no confirm bypass — recovering a node's identity is always a human action.
- **Shared `pinnedTrust` (`trust/pinnedTrust.ts`):** one fail-closed pin/TOFU decision (`SHA256:<base64>` form), two consumers — SSH host key (`ssh/hostKey.ts`) and API TLS cert (`trust/tlsPin.ts`).
- **Tier-aware census/health (§6):** below companion `describe_homelab`/`health_check` route metadata sections through `NodeOps` (API-complete: node/storage/containers/vms; health node/storage/updates). Exec-bound sections report a structured `{ unavailableAtTier: "companion" }` — census `network`/`services`/`tailscale`, health `units`/`guests` (network + onboot are deferred-to-API follow-ups, documented in ADR §6). The drift differ treats `unavailableAtTier` as **not observed** (suppresses the sub-diff), never "removed".
- **Setup (`scripts/setup.ps1`, supersedes `generate-ssh-key.ps1` + `install-proxmox-key.sh`):** one ceremony — tier-conditional `pveum` provisioning (auto `ssh root@node` or paste-blob), dual fingerprint capture, a **403 negative test** (proving privsep is enforcing, not just configured), companion key gen/install (removed on downgrade), and the `claude mcp add` emit. It never sets the root flag.

## VM parity & operator toolkit (ADR-005)

- **`qm_exec` runs through the QEMU guest agent** (`qm guest exec <vmid> --timeout <secs> -- sh -c '<cmd>'`), not SSH. It requires `qemu-guest-agent` installed and running in the guest; `qm_exec` prechecks with an agent ping and fails with a fix-naming error when absent. The inner command passes the **same two-tier denylist** as `execute`/`pct_exec` (`confirm?: boolean` gates CONFIRM-tier). **Honest limit (contrast ADR-004's host `timeout` wrapper):** the agent `--timeout` bounds how long the *server waits*, but cannot guarantee in-guest termination — `parseAgentExec` surfaces `timedOut`/`exitCode: null`/`pid` rather than faking a clean exit. The census `vms[].agent` slot (ADR-002 R6) is populated from `qm_agent_ping` + parsed guest config.
- **`health_check` is fixed-probe and read-only**, mirroring the census pattern: declarative probes per section (`node`, `storage`, `guests`, `units`, `updates`), **pure evaluators** (`healthEvaluators.ts`) score each against config thresholds, and a `rollupStatus` reports the worst. Per-section `try/catch` isolation — a failed section becomes a recorded error, never an abort. apt staleness is read with `apt-get -s` (simulate); the server **never** runs `apt update` (A5.1).
- **`tail_log` validates before it interpolates.** Unit names match a strict charset, `since` accepts only ISO or `<n> (min|hour|day) ago`, paths go through `validatePath`, lines clamp to `tools.tailLinesCap`, and `unit` XOR `path` is enforced — anything free-form throws. Output (and error text) **always** passes through the ADR-002 redaction module; over-redaction is the safe failure mode for logs.
- **`qm_read_file` / `qm_write_file` move VM files through the guest agent** (`pvesh .../agent/file-read|file-write`), not SSH — a VM exposes no hypervisor-level filesystem the way `pct` does for a container. They mirror the `pct_*` file tools (validated path, agent precheck, ADR-004 read cap + `offset`/`maxBytes` window on read; full ADR-003 backup + audit pipeline and `dryRun` preview on write) with two honest agent-imposed limits made explicit in `qmFiles.ts`: the endpoints are **text-oriented** (binary is lossy/refused — use for config files, not blobs), and the write endpoint takes **no mode/owner so perms are not preserved** (the file lands with the guest's default umask; contrast `pct push`). Writes are bounded by `tools.qmWriteMaxBytes` (a payload over the cap is refused, never truncated in the guest — use `qm_exec` for larger edits). Backups key on a `qm:<vmid>:<path>` descriptor (no host/`pct` collision), and `revert_file` routes `kind === "qm"` back through `writeVmFile`. The PVE node name for `pvesh` paths is resolved from `hostname` (Proxmox pins it) and charset-validated before interpolation.
- **`query_audit` + `diff_config` complete the preview/forensics triad:** `dryRun` (before a write) → `diff_config` (before a revert) → `query_audit` (after the fact). Both are pure/read-only and **not** themselves audited. `query_audit` filters `AuditLog.readAll()` (tool/vmid/path/time/large-only), returns a summary + newest-first records bounded by `tools.queryAuditMaxLimit`. `diff_config` reconstructs a backup (resolved by `backupPath` or latest-for-target) and diffs `current → backup` via the shared `computeUnifiedDiff`; metadata-only backups return a structured `revertible: false` instead of a diff.

## Git-backed config history (ADR-006)

**"Blobs revert, git remembers."** The local backup store (ADR-003) is still the **operational revert mechanism** — `revert_file` reads a blob, not git. The mirror repo under `src/history/` is a separate **archaeology layer**: a single local git repo that mirrors target descriptors (`host/<path>`, `pct/<vmid>/<path>`) plus etckeeper-style permission manifests (`manifests/<key>.json` mapping path→`{mode,uid,gid}`). Two independent capture paths feed it; git is never on the write's critical path.

- **Capture path A — mutation commits (`configHistory.ts` → `recordMutation`).** After a successful `write_file` / `pct_write_file` / `revert_file`, the handler appends one best-effort history step (mirror the bytes it already holds → refresh the manifest via a batched `stat` → commit → push). It **never throws and never fails the write**: the blob backup already succeeded, so a git error is logged and reported only as the audit record's `historyCommitted: false`. `qm` targets have **no mirror layout** (a VM exposes no descriptor-stable filesystem) and are skipped — `isHistoryTarget` returns false, `recordMutation` returns false.
- **Capture path B — `config_sweep` (`configSweep.ts`).** The file-level counterpart of the census drift diff: enumerate a watched set (`find -printf '%s\t%p'`), apply excludes + a size cap (`sweepPlanner.ts`, pure), **hash-compare (`sha256sum`) before fetching** so only changed/new files move, then **one commit per sweep**. This is the only thing that sees out-of-band changes (hand edits, package upgrades) the audit log and blob backups never witness. Per-target work is **error-isolated** (a failed target → recorded error, never an abort) and **stopped containers are skipped with a structured note** (A3.1 — `pct pull` needs a running guest). The sweep itself is audited (`tool: "config_sweep"`); the audit uuid is built *first* so it can join the commit message.
- **All git work is shelled out through one serialized `GitEngine`** (`child_process.spawn`, argv arrays — never shell strings — `-C <repo>`, a promise-chain queue). Graceful absence is a first-class state: `init()` runs `git --version`; if git is missing it logs one stderr line, leaves `enabled = false`, and `index.ts` never registers `config_sweep`. Repo bootstrap sets **repo-local** identity/config only (never the user's global git), `commit.gpgsign false`, and — for byte-faithful storage on Windows — `core.autocrlf false` + a `.gitattributes` of `* -text`.
- **Push is tri-mode and fail-soft (`push()`):** `local-only` (default, never pushes), `push-lan`, `push-encrypted`. The repo holds **unredacted secrets**, so a plain unencrypted cloud remote MUST NOT be configured — the two push modes differ only in the remote URL's transport (git handles it). A push failure is logged and retried on the next commit; the local repo stays the source of truth.
- **Config:** `history.*` in `config.ts` — `configHistoryDir` (default `%LOCALAPPDATA%\claude-mcp\config-history`), `pushMode`, `remote`, `hostWatchPaths`/`containerWatchPaths` (default `/etc`), `excludePatterns`, `sweepFileSizeCapBytes`.

## Docker layer + diff-on-write (ADR-008)

**Three-layer topology — node → LXC → Docker — and the daemon socket is never exposed.** All five `docker_*` tools (`docker_ps`/`docker_exec`/`docker_logs`/`docker_read_file`/`docker_write_file`) ride the **companion-tier `pct exec` plumbing** — they shell `docker …` *inside* a named LXC, so they inherit the SSH host-key/timeout/denylist boundary and never speak to `/var/run/docker.sock` directly. `TOOL_MIN_TIER` puts all five at **companion**; the backup-target kind `docker` resolves via `targetMinTier("docker") = "companion"`. Container names are charset-validated (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`) before interpolation (`dockerHelpers.ts`, pure builders + parsers).

- **`docker_exec` is the 4th exec path** (after host `execute`, `pct_exec`, `qm_exec`): `pct exec <vmid> -- docker exec <container> sh -c '<cmd>'`. The inner command passes the **same two-tier denylist** (`confirm?: boolean` gates CONFIRM-tier). `docker_ps` parses tab-delimited `docker ps` rows (also reused by the census `services[].docker` slot, ADR-002). `docker_logs` is bounded and **always passes mandatory redaction** (mirrors `tail_log`); by deliberate contrast `docker_read_file` does **not** redact (it returns file bytes, like `read_file`).
- **File I/O is two-path (`dockerFiles.ts`).** A **bind-mount fast path** resolves the container's host-visible source path via `docker inspect` and degrades to the LXC `pct pull`/`pct push` flow; the **`docker cp` slow path** is a three-filesystem relay (Docker→LXC→Windows) for non-bind paths. **File content NEVER travels via argv** — only SFTP / `docker cp`. `docker_write_file` runs the full ADR-003 backup + audit pipeline and `dryRun` preview; backups key on a `docker:<vmid>:<container>:<path>` descriptor (no host/`pct`/`qm` collision), and `revert_file` routes `kind === "docker"` back through the bind-mount write flow. Docker targets are **excluded from the ADR-006 git mirror** (no descriptor-stable host filesystem) — `isHistoryTarget` returns false, like `qm`. `list_backups`/`diff_config` accept a `container` param (requires `vmid`) to address a docker target.
- **§3 diff-on-write — every write returns a diff at zero extra I/O.** `write_file`/`pct_write_file`/`qm_write_file`/`docker_write_file` now return a truncated `computeUnifiedDiff` on the **real-write** path (not just `dryRun`), bounded by `tools.dryRunDiffMaxLines`: a new file diffs against empty (`newFile: true`); a binary write returns `diff: null`. The bytes are already in hand from the backup pipeline, so no extra read.
- **§5 census `snapshotCapable` heuristic (`censusParsers.ts`, pure).** At depth `full`, each guest entry carries a best-effort `snapshotCapable: { capable, reason? }` computed from the redacted config: **device passthrough** (`devN`/`lxc.cgroup2.devices.*`/`hostpciN`/`lxc.mount.entry … /dev/…`) ⇒ not capable (checked first); else a **dir-typed rootfs storage** (resolved against the `storage` section's type map, when observed) ⇒ not capable. The drift differ treats a capability transition as **real drift** (`field: "snapshotCapable"`) but an undefined-on-one-side value as **not observed**, never a change (mirrors the `unavailableAtTier` rule).
- **§6 outcome-level rollback — vzdump for the guests that can't snapshot.** `guest_backup` / `guest_backup_restore` (`backupTools.ts`) are the fallback where `snapshotCapable` is false (GPU passthrough / dir storage). They ride `NodeOps`, so vzdump runs over the **API where configured, SSH (`vzdump`/`pvesh`/`pct restore`/`qmrestore`/`pvesm free`) otherwise** — "SSH-CLI + API both." The guard mirrors the snapshot guard one layer up: the server only ever manages archives **it** created, identified by a reserved `mcp-` prefix in the archive **notes** (vzdump `--notes-template`). `guest_backup` is confirm-gated (vzdump is heavy; suspend/stop modes interrupt service), runs **retention before create** (`planArchiveEviction` evicts the oldest `mcp-` archives down to `backup.guestArchivePerGuestCap`, default 1 — human-made archives are never touched), and audits `isLargeChange`. `guest_backup_restore` is the heaviest hammer: confirm **plus** `mcp-`-only **plus** run-state gated — a running guest is refused unless `stopIfRunning: true` (then stop → restore → restart). All pure guards (`mcp-` detection, note generation, eviction planning, content parsing, CLI builders + charset guards on storage/volid) live in `tools/backups.ts`; both backends are the thin I/O shell over them.
- **`compose_redeploy` (`composeRedeploy.ts`) — the lighter, usually-better Docker rollback.** `docker compose -f <composePath> up -d` inside the LXC (via `pct exec`), companion, confirm-gated, path-validated. Paired with `revert_file` on the compose file it is the **seconds-scale stack rollback** (revert the file → redeploy), versus the minutes a vzdump restore costs — image-tag pinning in compose files is what makes it deterministic.
- **Snapshot-tier unification (the §6 tier resolution).** Every service-affecting guest verb — `snapshot_*`, `guest_backup`, `guest_backup_restore`, `compose_redeploy` — lands at **companion / MCP-enforced**, ONE enforcement story. vzdump is API-expressible and ADR §6's first draft floated `guest_backup` at operate, but the guardrails that make these safe (the `mcp-` archive-ownership boundary, per-guest retention, the confirm gate) are **MCP-server tripwires with no Proxmox-RBAC equivalent** — RBAC is blind to the `mcp-` tag, so a destructive whole-guest restore must not sit behind it. The transport still follows the tool (API where it can, SSH otherwise); only the tier *floor* is fixed at companion. Rationale is recorded inline in `tiers/registry.ts` and `tools/backupTools.ts`.

## Merkle integrity forest (ADR-009)

**"The forest detects, git remembers."** A SQLite-backed Merkle forest on the Windows host (`%LOCALAPPDATA%\claude-mcp\integrity.db`, `better-sqlite3`, WAL) that answers one question the audit log and git mirror cannot: *did anything change that the server did not do?* The audit log records what the server changed; `config_sweep` mirrors what the files look like now; the forest **continuously cross-checks live reality against a cryptographic baseline** and tells you whether each drift is **explained** (an audit `afterHash` matches — the server caused it) or **unexplained** (a human, a package upgrade, or a tamper). All three tools are **companion-tier, read-mostly** (they read file content via the same SSH/SFTP + `pct pull` path as the other companion tools; the only state they mutate is the *local* node store — never the node).

- **Three tracking levels, weakest to strongest (§1).** **L1 = mtime** (cheap, *spoofable* — `touch -r` resets it, so an mtime match is **not proof of identity**, only a hint nothing changed); **L2 = config-file content** (the `integrity.configFileGlobs` subset — real edits, ignores binary churn); **L3 = full content** (every file's SHA-256). A file leaf folds as `foldLeaf(payload)` with domain byte `0x00`; the payload is the mtime bytes (L1) or the content-hash hex (L2/L3). **Honest threat boundary:** the forest is a *tripwire on the client*, not an in-node IDS — it detects drift between scans, cannot prove *who*, and a root attacker on the node who also forges a matching audit record could mark their own change "explained." It raises the cost of silent tampering; it does not eliminate it.
- **The forest is one tree over two namespaces (`forest.ts`, `forestShape.ts`, `tree.ts` — pure shape; thin I/O shell).** A synthetic **super-root** (path `""`) folds the `host/…` subtree (SFTP) and each `pct/<vmid>/…` subtree (`pct pull`), namespaced so they **can never overlap** — `assertNonOverlap(hostWatchPaths, containerBackingPaths)` fails fast at startup if a host watch path reaches into container-backing storage (else the same bytes hash twice). Folding is deterministic and OS-independent: byte-sorted child names, a `0x00` name/hash terminator, domain bytes `0x00`/`0x01`/`0x02` for leaf/node/unreadable. A **stopped guest is frozen** (`available() === false` ⇒ reuse its last baseline, mark the prefix `unavailable`), never read as a mass deletion.
- **Smart escalation (§3).** `verify_integrity` with `level: "smart"` computes **L1 first and descends to L2/L3 only where L1 flags a touch** — a clean L1 reads **zero file content**. A single explicit level (`l1`/`l2`/`l3`) reports just that level. `verify` is **read-only and not audited** (like `diff_config`/`query_audit`); it seeds the baseline on first run and reports no drift.
- **Explained vs unexplained is a hash join, not a heuristic (`classify.ts`, `leafHash.ts`).** Every write-family tool (`write_file`, `pct_write_file`, `qm_write_file`, `docker_write_file`, `revert_file`) now stamps a **hash-anchored audit record**: `beforeHash`/`afterHash` are the **L2/L3 forest content-leaf hashes** of the old/new bytes (`contentLeafHash` reproduces exactly what the forest will fold), and `hashScope` is the path. A drifted leaf whose new forest hash equals some audit `afterHash` is **explained, by that tool at that audit id**. `qm`/`docker` files are **not in the forest** (no descriptor-stable fs, like the git mirror), so their anchors are content fingerprints for `query_audit`, not drift explainers. The **exec family** (`execute`/`pct_exec`/`qm_exec`/`docker_exec`) anchors `hashScope: "unknown"` — an exec can mutate anything, so `query_audit { unknownScopeOnly: true }` over a time window surfaces the candidate causes of an unexplained drift. New `query_audit` filters: `hashScopeContains`, `unknownScopeOnly`, `hashEquals` (matches `before`/`afterHash`).
- **Acceptance is the human-in-the-loop, and every fold is audited (`acceptPolicy.ts`, `integrityEngine.ts`).** `accept_truth` is the **explicit override** — fold current state (a scope, or the whole forest) into **all three baselines at once** (they describe one moment), audited with before/after super-root hashes. `verify_integrity { autoAccept: true }` applies the **audited auto-accept policy**: **explained always folds**; an **L1-only mtime touch** folds (content unchanged); an **L3-tail** unexplained change folds up to `maxUnexplainedL3` (default 20) then flags the rest; an **L2 config-content change never folds by default** (`allowL2AutoAccept`, default false); a **sensitive path never folds** (`sensitiveGlobs`, default `/etc/pve` — the protected set). Auto-accept is the one deliberately-relaxed surface and is fenced: explained-only is cryptographically safe, sensitive/`/etc/pve` is excluded, and **every fold writes an `accept_truth` audit record**.
- **Config (`integrity.*` in `config.ts`):** `dbPath`, `level` (default `l2`), `configFileGlobs`, `maxUnexplainedL3`, `allowL2AutoAccept`, `sensitiveGlobs`, `containerBackingPaths`; the watched sets reuse `history.hostWatchPaths`/`containerWatchPaths`/`excludePatterns`. Env: `INTEGRITY_DB_PATH`, `INTEGRITY_LEVEL`, `INTEGRITY_CONFIG_GLOBS`, `INTEGRITY_MAX_UNEXPLAINED_L3`, `INTEGRITY_ALLOW_L2_AUTO_ACCEPT`, `INTEGRITY_SENSITIVE_GLOBS`, `INTEGRITY_CONTAINER_BACKING_PATHS`. Setup (`setup.mjs`, companion only) prompts the tracking depth (last-edited → L1 / coarse → L2 / fine → L3) and emits `INTEGRITY_LEVEL`; conservativeness stays at the ADR defaults. The store opens (native dep) only when the tier actually registers an integrity tool.

## Localhost UI sidecar (ADR-010)

**"The forest detects, git remembers — and now a person can *look*, without an agent."** A SECOND standing process (`npm run ui`, `src/ui/server.ts`), entirely separate from the stdio MCP server, that serves a localhost-only dashboard over the artifacts the system already emits. It is **not an MCP tool** — it never appears in `TOOL_MIN_TIER`/`toolsForTier`; the model cannot see or call it. Two cleanly separated halves.

- **The §1 reframe — principal, not mutation, is the axis.** ADR-001's "no server without Claude" property is **formally superseded** here: it was always a *proxy* for "no standing, network-reachable surface fronting open-ended node actuation," and that proxy broke when ADR-009 introduced **human-principal** tools (`accept_truth` — "a person reviewed this drift and blesses it"). The reformulated property: a standing human-facing process may execute **only the bounded, enumerated human-principal set** it was wired with — never the open-ended **agent-principal** tools (`execute`/`read_file`/`write_file`/`list_directory`/`*_exec`/`*_write_file`/guest lifecycle/snapshot rollback/restore), which stay reachable **exclusively through an MCP session**. The old property is the **empty-set special case** of the new one ("only while Claude runs" ≡ "the standing human set is empty"). Enforced by the **same registration-filtering ADR-007 uses for tiers** — the executor doesn't *refuse* `execute`, it doesn't *have* it wired in.
- **The renderer half (`artifacts.ts`, zero credentials).** `ArtifactReader` reads ONLY client-side artifacts and **must never import an SSH/API client** (`ssh2Client`/`apiClient`/`ApiBackend`/`SshBackend`) — a **source-scan test** (`artifacts.test.ts`, scans import specifiers, not the doc comment) enforces it. Panels: census (latest redacted `inventory.json` via `CensusStore`), **drift** (the flagship — ADR-009 Merkle report, each leaf explained/unexplained, inline scoped `accept_truth`), audit timeline (reuses the pure `query_audit` core), health board, change feed (config-history `git log`, degrades when git absent). Every tool-derived panel carries a `snapshotTs` + `ageLabel` (`snapshotAgeLabel`, pure) — **the honest-UI rule: a cached panel must never imply liveness**; no snapshot ⇒ `available: false`, never invented data.
- **The cached-state model (`snapshotStore.ts`).** Generic `SnapshotStore<T>` (a timestamped-JSON store mirroring `CensusStore`, retention via the backup `planEviction`). `health_check` + `verify_integrity` are otherwise computed live and never persisted; **`index.ts` wires a `healthSink`/`driftSink` into both handlers** so the stdio (agent) path persists each result to the dirs the renderer reads. The common case — looking at recent state — costs **zero node access, zero credentials**, works with no Claude session and no executor. Payloads carry no secret-bearing fields (metrics/statuses; forest paths + hashes, never file content), so unlike the census they persist as-is.
- **The executor half (`executor.ts`, `humanTools.ts`).** `UiExecutor` is **inert by construction in strict renderer-only mode** (`enableActions: false`, the default): the runner map is empty, NO node-touching dep is constructed (`server.ts` doesn't even open SSH / the native store), `run()` always refuses. With actions on, it wires **only `humanToolsForTier(tier)`** and delegates to the **exact same handlers** the MCP path uses (so a button-press writes the identical audit record — parity). **The §5 registry (`humanTools.ts`) is THE safety-critical list:** `HUMAN_TOOLS = {accept_truth, verify_integrity, compute_tree, config_sweep}` (all companion-tier, all read-mostly — they mutate only the LOCAL baseline/git mirror, never the node). Adding a tool is an **ADR-level decision** with a head-comment warning + a recorded justification; `humanTools.test.ts` pins the exact set and asserts an **empty intersection with `EXCLUDED_AGENT_TOOLS`**. `guest_*` and census-refresh are deliberately **held out of v1**. Below companion the executor's set is empty (the tier floor) — renderer-only in practice.
- **Localhost-bound, fail-closed (`server.ts`, `router.ts`).** Deliberately boring stack: a built-in Node `http` server + JSON endpoints, the frontend is ONE self-contained HTML string (`page.ts`) — no bundler, no frontend `node_modules`. `routeUiRequest` is pure-ish (`(method, path, query, body, deps) → {status, contentType, body}`, unit-tested without a socket): `GET /` → the page, `GET /api/{status,census,health,drift,audit,changes}` → renderer panels, `POST /action/<tool>` → executor. **Strict mode 403s every `/action/*`; an unknown/agent tool 404s.** The **`isLoopbackAddress` guard (pure, in `router.ts`) refuses any non-loopback bind at startup** (127.0.0.0/8, `::1`, `localhost` only) — this surface must never be off-host. `UI_ENABLE_ACTIONS=true` opts into the executor; `UI_PORT` (default 7311), `UI_BIND_ADDRESS` (default `127.0.0.1`), `UI_HEALTH_DIR`/`UI_DRIFT_DIR`, retention caps. Setup (`setup.mjs`) prompts the optional live-actions opt-in and prints the launch command (the UI is a separate process, not `claude mcp add`'d).

## Commands

```bash
npm run build          # tsc compile
npm run dev            # tsx watch (for local iteration)
npm test               # vitest run (all unit + integration tests)
npm run test:unit      # vitest run --project unit
npm run test:int       # vitest run --project integration (requires Docker)
npm run test:watch     # vitest --watch
npm run lint           # eslint src
npm run typecheck      # tsc --noEmit
```

Run a single test file:
```bash
npx vitest run src/guardrails/denylist.test.ts
```

Run integration tests (requires Docker — not available on the Windows dev machine; intended for CI or a Linux environment):
```bash
npm run test:int   # auto-starts/stops the Docker SSH container; skips gracefully if Docker is absent
```

## Architecture

```
src/
  index.ts              # McpServer + StdioServerTransport wiring
  config.ts             # All thresholds, caps, allow/denylists — config-driven, no hardcoding
  ssh/
    transport.ts        # SshTransport interface (exec, readFile, writeFile, list)
    ssh2Client.ts       # Real ssh2 implementation (keepalive, reconnect, SFTP)
    fakeTransport.ts    # In-memory fake for unit tests
  tools/
    execute.ts          # execute tool handler
    readFile.ts         # read_file tool handler
    writeFile.ts        # write_file handler — calls backup pipeline before write
    listDirectory.ts    # list_directory tool handler
    pctExec.ts          # pct_exec tool handler
    pctList.ts          # pct_list handler + output parser
    qmHelpers.ts        # Pure: qm command builders + parseQmList / parseAgentExec (ADR-005)
    qmList.ts           # qm_list handler
    qmAgentPing.ts      # qm_agent_ping handler + pingAgent
    qmExec.ts           # qm_exec handler (denylist + confirm gate, agent-exec)
    qmFiles.ts          # Pure agent file-read/write builders+parsers + I/O (node resolve, read/write VM file)
    qmReadFile.ts       # qm_read_file handler (agent precheck, read cap + window)
    qmWriteFile.ts      # qm_write_file handler (backup pipeline, dryRun, qmWriteMaxBytes cap, no perm preserve)
    healthEvaluators.ts # Pure: threshold evaluators + parsers (load/mem/fs/units/onboot/updates)
    healthCheck.ts      # health_check handler — fixed probes, section-isolated rollup
    tailLog.ts          # tail_log handler + pure buildTailCommand (validate → redact)
    queryAudit.ts       # Pure filterAuditRecords/summarizeAuditRecords + query_audit handler
    diffConfig.ts       # diff_config handler — current→backup revert preview (read-only)
    configSweep.ts      # config_sweep handler + pure find/sha256 builders (ADR-006 path B)
    integrity.ts        # compute_tree/verify_integrity/accept_truth handlers + zod schemas + SQLite store factory (ADR-009)
  integrity/            # ADR-009 Merkle integrity forest (companion; pure core + thin I/O shell)
    folding.ts          # Pure: deterministic Merkle fold (foldLeaf/foldNode, domain bytes, states)
    tree.ts             # Pure: one subtree assembly (level membership, super-root, parent/leaf paths)
    forestShape.ts      # Pure: forest-path synthesis, group-dir/super-root folding, assertNonOverlap
    diff.ts             # Pure: treeDiff (baseline vs working), escalation targets, store views
    classify.ts         # Pure: explained/unexplained hash join over the audit log
    leafHash.ts         # Pure: contentLeafHash — the write-family↔forest content-leaf bridge
    acceptPolicy.ts     # Pure: auto-accept policy (explained/L1/L2/L3-tail/sensitive precedence)
    nodeStore.ts        # NodeStore interface + SqliteNodeStore (injected DB) + MemoryNodeStore fake
    forest.ts           # I/O: SubtreeSource (host SFTP / pct pull), enum builder/parser, freeze
    integrityEngine.ts  # Orchestrator: computeTree, verify (smart escalation), acceptTruth, autoAccept
  history/              # ADR-006 git-backed config mirror (optional, fail-soft)
    paths.ts            # Pure: target→mirror path mapping (host/<p>, pct/<vmid>/<p>; qm excluded)
    commitMessage.ts    # Pure: mutation/sweep commit message + target descriptors
    manifest.ts         # Pure: stat-batch builder/parser, manifest (de)serialize
    sweepPlanner.ts     # Pure: glob match, classifyEnumeration, diffAgainstMirror, parsers
    gitEngine.ts        # Serialized git spawn wrapper (argv arrays, -C repo, version detect)
    configHistory.ts    # Orchestrator: init, recordMutation, mirror primitives, commit, push
  guardrails/
    denylist.ts         # Pure fn: command denylist matching (normalizes whitespace/obfuscation)
    pathValidation.ts   # Pure fn: traversal checks, allowlist enforcement
    largeChange.ts      # Pure fn: threshold detection for size/new-file/heavy-cmd
  backup/
    policy.ts           # Pure fns: dedup, gzipped reverse-diff, large-file policy selection
    eviction.ts         # Pure fns: per-file version cap + global size cap, LRU eviction
    store.ts            # I/O: write backup blobs, read for revert
  audit/
    log.ts              # Atomic append-only JSONL writer (temp+rename / O_APPEND)
    record.ts           # Pure fn: audit record construction + SHA-256 hashing
  tiers/                # ADR-007 permission tiers
    registry.ts         # Pure: TOOL_MIN_TIER, isToolEnabled/toolsForTier, target-kind tier rule
    rootFlag.ts         # Pure: acknowledgment-string parse, resolveTier, root banner
  trust/                # ADR-007 shared pinned-trust (+ ADR-004 SSH consumer)
    pinnedTrust.ts      # Pure decidePin + thin PinStore (one core, two consumers)
    tlsPin.ts           # API TLS consumer: cert fingerprint + pinned https.Agent (fail-closed)
  node/                 # ADR-007 hybrid transport (NodeOps)
    nodeOps.ts          # NodeOps interface + domain types (Guest/Snapshot/TaskRef/...)
    apiBackend.ts       # NodeOps over the PVE REST API (ApiHttp injected; 401/403/5xx mapping)
    apiClient.ts        # makeApiHttp: https.request + pinned agent + token header (form-encoded)
    sshBackend.ts       # NodeOps over the existing exec + parsers (companion+; API-less ops)
  tools/
    lifecycle.ts        # guest_start/stop/restart handlers (NodeOps; confirm-gated stop)
  ui/                   # ADR-010 localhost UI sidecar (a SECOND process; NOT an MCP tool)
    humanTools.ts       # Pure: the safety-critical §5 human-tool registry (ADR-gated additions)
    snapshotStore.ts    # Generic SnapshotStore<T> — cached health/drift snapshots (mirrors CensusStore)
    artifacts.ts        # ArtifactReader — credential-free renderer (census/drift/audit/health/changes)
    executor.ts         # UiExecutor — bounded human-tool runner; inert in strict mode; audit-parity
    router.ts           # Pure-ish routeUiRequest + isLoopbackAddress guard (testable without a socket)
    server.ts           # Built-in http entry point; loopback-only bind; strict-by-default wiring
    page.ts             # INDEX_HTML — one self-contained no-build dashboard (HTML/CSS/vanilla JS)
```
(`ssh/hostKey.ts` is the SSH consumer of `trust/pinnedTrust.ts`. `src/ui/` is the only `src/` subtree that is NOT MCP-registered — it is the ADR-010 sidecar, run as a separate process.)

**Key invariant:** `guardrails/`, `backup/policy.ts`, `backup/eviction.ts`, `audit/record.ts`, `history/{paths,commitMessage,manifest,sweepPlanner}.ts`, `integrity/{folding,tree,forestShape,diff,classify,leafHash,acceptPolicy}.ts`, `tiers/{registry,rootFlag}.ts`, `ui/humanTools.ts` + the pure cores of `ui/{router,artifacts}.ts` (`isLoopbackAddress`/`routeUiRequest`, `snapshotAgeLabel`), and the decision core of `trust/pinnedTrust.ts` are **pure functions with no I/O** — the only way unit tests stay fast and trustworthy. (The git layer + the real-repo tests, the integrity `forest.ts`/`integrityEngine.ts` over a `MemoryNodeStore` + fake transport, and `ApiBackend` via an injected `ApiHttp` fixture, follow the same "pure core, thin I/O shell" split.)

**Dependency direction:** tool handlers → `SshTransport` and/or `NodeOps` interfaces (injected). Never import `ssh2Client.ts` or `apiClient.ts` from tool handlers directly. The tier registry (`tiers/registry.ts`) is **data**; adding a tool means adding a `TOOL_MIN_TIER` row, nothing else. **No runtime tier escalation, ever** — raising the tier means re-running setup (or editing config) + restart. **`ui/` depends on `tools/`, never the reverse** — the cached-state sinks (`HealthSnapshotSink`/`DriftSnapshotSink`) are minimal structural interfaces in `tools/` that `ui/SnapshotStore<T>` happens to satisfy, so the handlers never import `ui/`.

## Core principle: root SSH + tool-layer guardrails

Root is granted at the SSH layer on purpose — Proxmox's tooling assumes root. Every real guardrail lives at the **tool layer**: the guardrail/backup/cleanup code is the security and data-integrity boundary and must have ~90%+ line/branch coverage (plus mutation testing per the testing strategy).

## Transport & guardrail trust model (ADR-004)

- **Host-key verification is fail-closed.** `Ssh2Transport` always supplies a `hostVerifier`; the SHA-256 fingerprint must match an explicit pin (`SSH_HOST_KEY_FINGERPRINT`) or a TOFU entry in `known_hosts.json` (first connect pins + warns). A mismatch refuses the connection — never auto-re-pins. `skipHostVerification: true` (Docker harness only) warns on every connect. All host-key diagnostics go to **stderr** (stdout is the MCP channel).
- **Timeouts are enforced on the node**, not by client timers: `Ssh2Transport.exec` wraps every command with `timeout --signal=TERM --kill-after=5 <secs> bash -c '<cmd>'` (shared helper `ssh/command.ts`; `bash` not `sh` per A4.1 — Debian `sh` is dash and drops bashisms). A client backstop (`commandTimeoutGraceMs`) only fires for a wedged connection and forces reconnect. `pct_exec` composes the same wrapper inside the container.
- **Exit semantics are honest.** `ExecResult` is `{ stdout; stderr; exitCode: number | null; signal?; timedOut? }`. `null` (signal kill) is **never** coerced to `0`; coreutils `timeout` exit 124 → `timedOut: true`. Handlers and audit records propagate all three; the audit log can no longer record a false success.
- **Denylist is two-tier and segment-anchored** (`guardrails/denylist.ts` → `checkCommand`): **DENY** (unconditional: `rm -rf /`, `mkfs`, `dd` to block devices, fork bomb, `chmod -R 777 /`) and **CONFIRM** (command-position only: `shutdown`/`reboot`/`halt`/`poweroff`/`init 0|6`/`systemctl reboot|poweroff|halt`). `execute`/`pct_exec` take `confirm?: boolean`; a CONFIRM match without it is refused, with it the audit notes `confirmGated`. Configured entries are segment-prefix matched and may carry a `confirm:` tier prefix. Known limit: a tripwire, not a sandbox — `bash -c "reboot"` hides the command in an argument and is not caught.
- **`read_file` is stat-gated** at `tools.readFileMaxBytes` (2 MB default); use `offset`/`maxBytes` for windowed reads, or `execute` with `head`/`tail`/`grep`/`wc`. `pct_read_file` enforces the same cap + `offset`/`maxBytes` window on the pulled bytes (the `pct pull` copies the whole file first, so the cap bounds the returned payload; point users at `pct_exec` + `head`/`tail`/`grep`/`wc`).
- **`dryRun` on `write_file`** runs the full pipeline read-only and returns a `computeUnifiedDiff` preview (`util/diff.ts`, shared with ADR-005) plus would-be metadata — **no write, no backup, no audit**. `pct_write_file` takes the same `dryRun` flag with identical no-side-effect semantics.

## Storage: backups are not naive copies

Backup pipeline (in order): dedup by content hash → gzipped reverse-diff for text files → large-file policy for big/binary writes. Two retention caps: **per-file version count** + **global total-size cap** with oldest-first/LRU eviction. Cleanup runs before each backup and under disk pressure, with a deterministic fail-safe (refuse or warn, configurable). The storage soak and disk-pressure tests are first-class, not edge cases.

**Backups and the audit log are stored locally on the Windows host where the server runs — NOT on the Proxmox node** (the node's disk is premium). The server already holds file bytes from computing the diff/hash, so local backup costs the node zero disk. Both locations are configurable; defaults:
- Backups: `%LOCALAPPDATA%\claude-mcp\backups\<path-hash>\<ISO-timestamp>`
- Audit log: `%LOCALAPPDATA%\claude-mcp\audit.jsonl`

Trade-off: the trail is coupled to the Windows machine (lose it → lose the trail; the node's live files are unaffected). This decouples backup durability from node health; point the dir at a synced folder/NAS for extra safety. Retention/cleanup still applies — now against the Windows disk.

## Build order

1. Scaffold project + test runner; `git init`.
2. Injectable SSH interface; pure guardrail/backup/eviction functions; atomic audit log.
3. **Unit tests first, green**: denylist, path validation, large-change detection, backup/dedup/diff, retention/eviction, audit construction, `pct` parsing/quoting.
4. Six tool handlers + `StdioServerTransport`.
5. Dockerized SSH integration harness + MCP-stdio protocol tests.
6. Register in Claude Code MCP config; smoke-test against a disposable Proxmox VM (read-only first), then the real node.

## Safety rule

Do **not** connect to the live Proxmox node until guardrails + unit tests pass. Ask before any action that touches the real host. Generate the SSH key and walk through public-key installation on the node as part of setup.

## Environment

- Host: Windows machine on the same LAN as the Proxmox node.
- Proxmox: latest release; only `root` SSH exists today (a key will be added as part of setup).
- MCP server is registered in Claude Code's config as a `command`+`args` stdio server.
