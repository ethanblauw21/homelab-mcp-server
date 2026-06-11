# Architecture

## Core invariant: pure functions with injected I/O

The entire safety and correctness story depends on one principle: **the decision-making code has no I/O.**

Guardrails, backup policy, eviction, audit record construction, tier registry, and trust decisions are pure functions — they take inputs and return outputs, nothing else. Tool handlers call these functions and then call injected interfaces to perform I/O. This separation is what makes the unit tests fast and deterministic, and what makes mutation testing feasible: the pure layer is what gets mutated, and the tests can verify the mutations are caught without spinning up a server or SSH connection.

**Dependency direction:** tool handlers → `SshTransport` / `NodeOps` interfaces → concrete implementations. Never the reverse. The concrete SSH client (`ssh2Client.ts`) and HTTP client (`apiClient.ts`) are never imported from tool handlers directly.

## Hybrid transport

Two backends implement the `NodeOps` interface:

| Backend | Transport | Active at |
|---------|-----------|-----------|
| `ApiBackend` | PVE REST API over HTTPS, token auth, pinned TLS | All tiers |
| `SshBackend` | Root SSH, key auth, pinned host key | companion+ |

`index.ts` selects `ApiBackend` when the four `PVE_API_*` env vars are set, otherwise falls back to `SshBackend`. The transport follows the tool, not the tier — both backends expose the same `NodeOps` interface and tool handlers have no visibility into which one is active.

## Tier model

Registration is data, not code. `tiers/registry.ts` holds a `TOOL_MIN_TIER` map of tool → minimum tier. At startup, `index.ts` calls `isToolEnabled(name, activeTier)` for every tool — anything above the active tier is never registered. The model never sees tools it cannot use; there is nothing to refuse at runtime.

`diff_config` and `revert_file` are special cases: their minimum tier depends on the *target kind* at call time (`host` → root, `guest` → companion), resolved via `assertTargetTier` rather than a fixed registry row.

**No runtime escalation.** Changing tier requires re-running setup and restarting the server. There is no API, prompt, or env var that raises the tier of a running process.

## Trust model

Both transport channels share a single `pinnedTrust` module (`trust/pinnedTrust.ts`) for pin/TOFU decisions. The two consumers are:

- **SSH host key** (`ssh/hostKey.ts`) — SHA-256 fingerprint stored as `SHA256:<base64>`. First connect without a pin writes a TOFU entry to `known_hosts.json` and warns on stderr. Mismatch refuses the connection.
- **API TLS certificate** (`trust/tlsPin.ts`) — same `SHA256:<base64>` format, produces a pinned `https.Agent` used for every API request. Mismatch refuses the connection.

Both are fail-closed: a missing or mismatched pin is a hard stop, never a silent accept.

## Guardrails

Three pure modules gate every command execution:

**Denylist** (`guardrails/denylist.ts`): two tiers of matching, both segment-anchored with whitespace and obfuscation normalization.
- DENY — unconditional block: `rm -rf /`, `mkfs`, `dd` to block devices, fork bomb, `chmod -R 777 /`
- CONFIRM — requires `confirm: true` in the tool call: `shutdown`, `reboot`, `halt`, `poweroff`, `systemctl reboot/poweroff/halt`, `init 0/6`

**Path validation** (`guardrails/pathValidation.ts`): traversal prevention and allowlist enforcement for host file operations.

**Large change detection** (`guardrails/largeChange.ts`): flags writes that are disproportionately large relative to the existing file.

**Protected set** (absolute DENY at every tier, no bypass): destructive operations against `/etc/pve` and cluster membership commands (`pvecm add/addnode/delnode/qdevice`). These cannot be overridden by `confirm: true`, root tier, or any configuration. Recovering a node's cluster identity is always a human action.

**Known limit:** the denylist is a tripwire, not a sandbox. `bash -c "reboot"` hides the inner command in an argument and is not caught. This is documented honestly rather than papered over with false confidence.

## Backup pipeline

Every write (`write_file`, `pct_write_file`, `qm_write_file`) runs the full pipeline *before* the write:

1. **Content-hash dedup** — if the content hasn't changed, skip the backup
2. **Gzipped reverse-diff** — for text files, store only what's needed to reconstruct the previous version
3. **Large-file policy** — for large or binary writes, store a full copy with adjusted retention

Two retention caps run before each backup:
- Per-file version count cap
- Global total-size cap with oldest-first/LRU eviction

Backups live on the **Windows host**, not the Proxmox node. The node's disk is never touched by the backup system. `dryRun: true` on any write tool runs the full pipeline read-only and returns a unified diff preview — no write, no backup, no audit entry.

## Audit log

Append-only JSONL at `%LOCALAPPDATA%\claude-mcp\audit.jsonl`, written with temp-file + rename for atomicity. Every mutating tool call records:

- Tool name, target, inputs, outcome
- SHA-256 hash of written content (writes)
- `confirmGated: true` when a CONFIRM-tier denylist match was explicitly overridden
- `rootTier: true` when root is enabled

`query_audit` reads and filters the log. `query_audit` calls are not themselves audited.

## Config history

An optional local git mirror (`%LOCALAPPDATA%\claude-mcp\config-history\`) that tracks file mutations and captures out-of-band edits. Two capture paths:

**Mutation commits** (`configHistory.ts`): after a successful write, `recordMutation` mirrors the new bytes, refreshes a permission manifest (mode/uid/gid), and commits. Runs best-effort — a git failure is logged and recorded in the audit entry as `historyCommitted: false`, but never fails the write.

**Config sweep** (`config_sweep` tool): enumerates watched paths, SHA-256 hash-compares against the mirror, fetches only changed or new files, commits one entry per sweep. This is the only path that sees out-of-band edits — hand changes, package upgrades, anything the audit log never witnessed.

The mirror is a separate archaeology layer. `revert_file` reads from the blob backup store, not git.

All git operations run through a serialized `GitEngine` that shells to `git` via `child_process.spawn` with argv arrays — never shell strings. Git is an optional dependency: if it is absent at startup, `config_sweep` is never registered and `historyCommitted` is always `false`.

## Source layout

```
src/
  index.ts              # Server wiring, tier-filtered tool registration
  config.ts             # All thresholds and caps — no hardcoded values in handlers
  ssh/
    transport.ts        # SshTransport interface
    ssh2Client.ts       # Concrete ssh2 implementation
    hostKey.ts          # SSH host key pin consumer
  node/
    nodeOps.ts          # NodeOps interface + domain types
    apiBackend.ts       # NodeOps over PVE REST API
    apiClient.ts        # Pinned HTTPS client
    sshBackend.ts       # NodeOps over SSH
  tools/                # One file per tool handler
  guardrails/           # Pure: denylist, path validation, large change detection
  backup/               # Pure: policy, eviction — I/O in store.ts only
  audit/                # Pure: record construction — I/O in log.ts only
  history/              # Pure: paths, commit messages, manifest, sweep planner
  tiers/                # Pure: TOOL_MIN_TIER registry, root flag
  trust/                # Pure: pinnedTrust decision core, TLS pin consumer
```
