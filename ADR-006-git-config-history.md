# ADR-006: Git-Backed Config History (Mirror Repo + Sweeps)

**Status:** Proposed
**Date:** 2026-06-10
**Deciders:** Ethan
**Depends on:** ADR-001 (backup/audit pipeline), ADR-002 (census drift — conceptual counterpart), ADR-003 (target descriptors, pct pull, running-guest precondition per amendment A3.1), ADR-007 (tiers — this feature is companion+)

## Context

The backup store is an *operational* revert mechanism with deliberate caps (per-file version cap, global size cap, LRU eviction) — old history is designed to be deleted. The audit log records that changes happened but not, beyond the capped blobs, *what the configuration looked like over time*. And ADR-001 accepted that the entire trail's durability is coupled to the Windows machine. Three gaps, one classic tool: a **git repository mirroring the lab's configuration**, where delta compression makes complete history nearly free and `git log -p` makes it legible.

Two further motivations sharpen the design:
- Changes made **outside the MCP server** (hand edits over SSH, Proxmox UI, package upgrades rewriting configs) are invisible to the audit log and backups. A history layer that only records the server's own writes is mostly a second copy of the audit log.
- The census (ADR-002) detects drift at the *inventory* level (guests, storage, services). Its missing counterpart is drift at the **file level** — this ADR provides it.

Decisions confirmed in design discussion: hybrid capture (mutation-commits **and** an explicit sweep tool), push as tri-mode config defaulting to local-only, and shelling out to system git rather than embedding a library.

## Decision

### 1. One local mirror repo

- Location: `<configHistoryDir>` (default `%LOCALAPPDATA%\claude-mcp\config-history\`), a single git repository initialized on first use with a repo-local identity (`user.name "claude-mcp"`, no global config touched).
- Layout mirrors target descriptors (ADR-003):
  - `host/<absolute-path>` — node files
  - `pct/<vmid>/<absolute-path>` — container files
- Permissions fidelity: git stores content (and the execute bit) only, so each target keeps a **metadata manifest** (`manifests/<target-key>.json`, mapping path → `{ mode, uid, gid }`, captured via batched `stat -c '%a %u %g %n'`) committed alongside content — the etckeeper trick, keeping history restore-faithful.

### 2. Capture path A — mutation commits (automatic, companion+)

After every successful `write_file`, `pct_write_file`, or `revert_file`, the pipeline appends one history step: write the new content into the mirror path, update the manifest entry, `git add` + `commit`. Commit message format (greppable, audit-joinable):

```
<tool> <target>            e.g.  write_file pct:104:/etc/wireguard/wg0.conf

audit: <audit-record-uuid>
```

**Failure semantics (load-bearing):** the history commit is **best-effort and never fails the write**. The blob backup (the operational revert mechanism) has already succeeded by this stage; a git failure (locked index, disk issue, git absent) is logged, and the write's audit record carries `historyCommitted: false`. History is the archaeology layer, not a gate.

### 3. Capture path B — `config_sweep` (explicit tool, companion tier)

`config_sweep` `{ targets?: Array<"host" | { vmid: number }> }` — defaults to host + all *running* containers (stopped guests are skipped with a structured note, per A3.1's precondition; `pct pull` requires running).

Per target:
1. Enumerate files under the **watched set** (config: host default `/etc` including `/etc/pve`; per-container default `/etc`), applying exclude patterns (config; defaults for lockfiles, sockets, `mtab`-style runtime symlinks) and a per-file size cap (skipped files are noted in the manifest, not silently dropped).
2. **Hash-compare before fetching:** run a batched remote `sha256sum` over the enumerated list, compare against the mirror's recorded hashes, and fetch **only changed/new files** (SFTP for host, `pct pull` for containers). Deleted files are removed from the mirror.
3. Refresh manifest entries for touched paths.
4. **One commit per sweep**, message `config_sweep <targets summary>` + audit uuid; the sweep itself is audited (tool, targets, files changed/added/removed counts).

The sweep is the file-level counterpart of the census drift diff: census answers "what changed in the inventory," `git diff` between sweeps answers "what changed in the configs" — including everything done by hand or by packages, which no other subsystem sees. Scheduling is deliberately **not** built in (no daemons in a stdio server); a scheduled sweep is one line in a future headless-CC cron alongside the steward report.

### 4. Push: tri-mode config, local-only default

`GIT_HISTORY_PUSH_MODE`:

| Mode | Remote | Trade-off |
|---|---|---|
| `local-only` *(default)* | none | Zero secret exposure; durability still coupled to the Windows machine |
| `push-lan` | SSH/file remote on the NAS (`GIT_HISTORY_REMOTE`) | Durability decoupled; secrets travel inside LAN trust — documented plainly |
| `push-encrypted` | gcrypt-style encrypted remote | Off-site durability; requires `git-remote-gcrypt` + key management (documented prerequisite) |

Push runs after each commit, **best-effort**: a failed push is logged and retried on the next commit; the local repo remains the source of truth. Mode and remote are config-only — changing your mind later is one line, no redesign (per discussion: the decision is deferred into configuration, with the zero-exposure default shipping).

**Hard rejection recorded:** plain unencrypted cloud remotes (e.g. GitHub/GitLab over HTTPS without encryption) are not a supported mode and MUST NOT be added as a convenience — the repo necessarily contains unredacted secrets (§Security).

### 5. Git engine: system git, graceful absence

- Shell out to system `git` (full transport support — SSH remotes for the NAS path — and battle-tested storage), invoked with explicit `-C <repo>` and a controlled argv (no shell string interpolation; spawn with arg arrays).
- Detect `git --version` at startup. Absent ⇒ the entire feature is **disabled, not broken**: writes proceed (with `historyCommitted: false` and a once-per-session log line "install git to enable config history"), `config_sweep` is not registered.
- Git operations are serialized through an in-process queue (git's index lock + concurrent tool calls otherwise race).

### 6. Tier placement & revert interplay

- The feature exists at **companion and above** (nothing mutates files below companion; the sweep needs bulk file reads, which is companion-grade access). At observe/operate the subsystem is dormant and `config_sweep` unregistered.
- **Revert remains on the blob store** (v1): git is the archaeology layer; `revert_file`'s mechanism is unchanged. Revert-from-git (restoring any historical state, beyond the eviction caps, using the manifest for perms) is a recorded stretch item — valuable, but it must not compete with the tested revert path until it is equally tested.

## Options Considered

### Option A: Hybrid capture (mutation commits + explicit sweep), tri-mode push, system git *(chosen)*
Pros: complete config history including out-of-band changes; eviction-proof archive at delta-compressed cost; durability as a config choice with a zero-exposure default; full remote transport support. Cons: git becomes a (soft, optional) dependency; sweep adds read volume against the node (mitigated by hash-compare fetching).

### Option B: Mutation commits only
Rejected: records only what the server already records (audit + blobs); misses hand edits and package-driven config changes — most of the value evaporates.

### Option C: Repos on the node / etckeeper
Rejected for this feature (premium node disk; per-guest git installs; `/etc/pve` is pmxcfs and hostile to an in-place `.git`). etckeeper on the host remains a *complementary*, independently-worthwhile hardening step the docs may recommend — it is not this system.

### Option D: Embedded git library (isomorphic-git)
Rejected: HTTP(S)-only transports kill the most natural push target (SSH remote on the NAS); system git's ubiquity makes the dependency acceptable, and graceful absence handles the rest.

### Option E: Background sweep scheduler inside the server
Rejected: the server is a stdio process that lives only while a Claude client runs (ADR-001); daemonizing it reverses that design. Scheduling belongs to the operator's cron + headless CC.

## Security Model

- The mirror repo contains **unredacted** configuration — necessarily, for restore fidelity. Its trust level equals the backup blob store's, and it lives beside it on the Windows host. Redaction is *not* applied here (contrast: census, tail_log) because this data is never returned into model context — history *queries* that surface content (future `git log -p`-style tools) would be the point where redaction applies, and any such tool is out of scope for v1.
- `push-lan` and `push-encrypted` move that unredacted data; each mode's exposure is documented at the config site, and the default moves nothing.
- Sweep is read-only against the node; its writes are local. Command construction uses fixed strings + validated paths; git is spawned with argv arrays, never shell-interpolated strings.
- `/etc/pve` is **read** by sweeps (cluster config history is high-value) — protected-set rules (ADR-007) govern writes/destruction and are untouched by this ADR.

## Consequences

- **Easier:** complete, diffable, greppable config history that survives eviction; out-of-band drift becomes visible (`config_sweep` then `git diff`); audit ids join the log to the history; durability is one config line away when wanted.
- **Harder:** soft dependency on git; sweep duration scales with watched-set size on first run (subsequent runs are hash-gated); two history systems (blobs, git) to explain in docs — mitigated by the clean division: *blobs revert, git remembers*.
- **Interplay:** the audit log gains `historyCommitted`; sweep results give the census's drift report a file-level companion; ADR-005's `query_audit` can join on the uuid in commit messages.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Sweep planner (pure) | Unit (critical) | Hash-compare set math: changed/new/deleted/skipped-oversize/excluded; running-guest filtering |
| Manifest + stat parsing | Unit | `stat -c '%a %u %g %n'` batch parsing incl. spaces in paths; manifest round-trip |
| Commit message format | Unit | Tool/target line + audit uuid; greppable stability fixture |
| Mirror path mapping | Unit | host/pct descriptor → repo path, traversal-safe (mirror paths re-validated; `..` rejected even post-descriptor) |
| Mutation-commit step | Unit (FakeTransport + temp repo) | Real git in temp dir: write ⇒ commit exists with correct content/manifest; git failure ⇒ write still succeeds, `historyCommitted: false` |
| `config_sweep` end-to-end | Integration | Docker harness: seed files, sweep, mutate out-of-band, re-sweep ⇒ one commit, only changed files fetched (assert via fetch-count spy), deletions handled |
| Push modes | Integration | `file://` bare repo as NAS stand-in: push-lan pushes best-effort; push failure non-fatal + retried next commit; local-only never pushes |
| Git absence | Unit/Integration | PATH without git ⇒ feature disabled, writes unaffected, sweep unregistered, single log line |
| Serialization | Unit | Concurrent commit attempts queue; no index-lock failures |

## Action Items

1. [ ] Implement repo bootstrap (init, local identity, layout helpers, mirror-path mapping with re-validation) + git spawn wrapper (argv arrays, `-C`, serialized queue, version detection / graceful disable).
2. [ ] Implement the mutation-commit pipeline step with best-effort semantics + `historyCommitted` audit field; wire into `write_file`, `pct_write_file`, `revert_file`.
3. [ ] Implement manifest capture (stat batching + parser) for both capture paths.
4. [ ] Implement the sweep planner (pure: enumerate→hash-compare→fetch set) and `config_sweep` handler (host SFTP + `pct pull`, running-guest precondition, one commit per sweep, audited).
5. [ ] Config: `configHistoryDir`, watched sets (host/container), exclude patterns, size cap, `GIT_HISTORY_PUSH_MODE`, `GIT_HISTORY_REMOTE`.
6. [ ] Push step (best-effort, retry-next-commit) + the three modes; documentation of each mode's exposure at the config site.
7. [ ] Docker-harness integration suite incl. `file://` remote; CI wiring.
8. [ ] Docs: "blobs revert, git remembers" division; etckeeper as complementary hardening; first-sweep duration expectations.
9. [ ] (Stretch) Revert-from-git with manifest-based perms restore; history query tool with redaction at the context boundary.

## References

- ADR-001 — durability trade-off this ADR patches; no-daemon doctrine
- ADR-003 — target descriptors, `pct pull`, amendment A3.1 (running-guest precondition)
- ADR-007 — tier placement (companion+), protected set
- etckeeper — metadata-manifest prior art