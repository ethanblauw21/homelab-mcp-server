# ADR-001: Custom Node/TypeScript SSH MCP Server for Homelab Access

**Status:** Accepted — implemented 2026-06-09 (foundational server; root-by-default partially superseded by ADR-007 permission tiers)
**Date:** 2026-06-09
**Deciders:** Ethan

## Context

Claude Code runs on a Windows machine that shares a LAN with a Proxmox VE node (latest release). The homelab hosts services managed inside LXC containers and VMs — Proxmox itself, Gluetun, Tailscale, Portainer, and others. The goal is to let Claude Code assist with managing these services directly: crawling filesystems, reading and editing config files, running commands on the node, and running commands inside containers.

Cowork's cloud sandbox cannot reach the LAN, so a bridge is required that runs on the LAN side. The natural bridge is a Model Context Protocol (MCP) server that Claude Code launches locally and that opens an SSH connection into the Proxmox node.

Forces and constraints at play:

- **Environment:** Windows host running Claude Code; single Proxmox node reachable over the LAN.
- **Auth reality:** No dedicated SSH user exists yet — only `root`. SSH key authentication is available/preferred.
- **Privilege decision (global):** The SSH session authenticates as `root`. This is a deliberate choice: rather than fight Proxmox's root-oriented tooling (`pct`, `qm`, `/etc/pve`), full privilege is granted at the connection layer and **all real guardrails are enforced at the tool layer** inside the MCP server.
- **Auditability requirement:** Large or destructive operations — large file writes, creation of new files, and heavy command runs — must be logged in a way that lets Ethan find and revert changes after the fact.
- **Runtime/transport (decided):** Node/TypeScript, delivered as a stdio MCP server spawned by Claude Code.

## Decision

Build a custom **Node/TypeScript MCP server** using `@modelcontextprotocol/sdk` (with `McpServer`, `registerTool`, and `StdioServerTransport`) that maintains a single SSH connection to the Proxmox node via the `ssh2` library, authenticating as `root` with an SSH key.

The server exposes six tools:

| Tool | Purpose |
|------|---------|
| `execute` | Run a shell command on the Proxmox host, return stdout/stderr/exit code |
| `read_file` | Read a file from the host filesystem |
| `write_file` | Write/overwrite a file on the host, with automatic backup of the prior version |
| `list_directory` | List directory contents (crawl filesystems) |
| `pct_exec` | Run a command inside an LXC container via `pct exec <vmid> -- <cmd>` |
| `pct_list` | List LXC containers and their status via `pct list` |

Because the SSH identity is `root`, safety is implemented as a **tool-layer guardrail stack**: input validation, a write-backup-and-audit pipeline, and a structured audit log that supports reverting file changes.

## Options Considered

### Option A: Custom Node/TypeScript stdio SSH MCP server  *(chosen)*

A purpose-built server using the official MCP TypeScript SDK and `ssh2`, launched by Claude Code over stdio.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — ~1 file of SSH plumbing + 6 thin tool handlers |
| Cost | None beyond time; all open-source |
| Scalability | Fine for one node; multi-node would need a host parameter |
| Team familiarity | High — Ethan programs daily; TypeScript chosen deliberately |

**Pros:** Exactly the six tools wanted, no extra surface area. Full control over the security and audit logic, which is where the real requirements live. stdio means no listening port, no inbound network exposure — Claude Code owns the process lifecycle. Official SDK is well-maintained.
**Cons:** You own the code and its security. Root SSH means a bug in the guardrails has real blast radius. Single long-lived SSH connection needs reconnect handling.

### Option B: Adopt an existing open-source SSH MCP server

Install a community SSH/remote-exec MCP server and point it at the node.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to stand up |
| Cost | None |
| Scalability | Varies by project |
| Team familiarity | Low — someone else's abstractions |

**Pros:** Fastest path to "it works." Maintenance is shared.
**Cons:** Almost none expose Proxmox-native `pct` tools, so container management would fall back to raw `execute`. The custom audit/backup-and-revert requirement is unlikely to be supported and would have to be bolted on or forked. Trusting third-party code with root on the homelab is a larger supply-chain risk than ~200 lines you wrote.

### Option C: Proxmox API MCP server (no SSH)

Talk to the Proxmox REST API (`/api2/json`) with an API token instead of SSH.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | None |
| Scalability | Good (native multi-node, RBAC) |
| Team familiarity | Medium |

**Pros:** Token-scoped permissions and roles instead of all-or-nothing root; first-class for VM/container lifecycle; no shell at all.
**Cons:** The API does not give arbitrary filesystem read/write or free-form shell on the host — the core asks here (`read_file`, `write_file`, `execute`, editing Gluetun/Tailscale/Portainer config). Would still need SSH for those, defeating the simplification. Better as a *future complement* for VM/container lifecycle, not a replacement.

## Trade-off Analysis

The central tension is **privilege vs. blast radius.** Choosing root SSH (Option A) trades a clean least-privilege story for operational simplicity — Proxmox's own tools assume root, and a limited user plus `sudo` allowlist is fragile against the open-ended "manage whatever service" goal. The decision accepts that trade *only because* the guardrails move to the tool layer, where they can be precise (per-tool validation, backups, audit log) rather than coarse (Unix permissions).

Option B optimizes for speed but loses the two things that actually motivated a custom build: native `pct` tools and the backup/revert audit trail. Option C has the best security model but cannot satisfy filesystem and shell requirements alone.

stdio over a network transport is the right call: the server has no inbound port, runs only while Claude Code runs, and the single trust boundary is the SSH key on the Windows host. The residual risk is concentrated there — protect that key.

## Security & Audit Model (tool layer)

Since the global privilege is root, these controls are the real security boundary:

- **Storage-aware backups before mutation.** `write_file` preserves the prior version before overwriting, but storage is at a premium, so backups are *not* naive full-file copies. The policy, in order: (1) **dedup by content hash** — identical content is stored once; (2) for text files, store a **gzipped reverse diff** against the previous version rather than the whole file; (3) for files above the "large" threshold, apply the configured **large-file policy** — compressed diff if text, or metadata-and-hash only (logged as non-revertible) for huge binaries — so one big write can't blow the budget. **Backups live on the Windows host where the server runs** (default e.g. `%LOCALAPPDATA%\claude-mcp\backups\<path-hash>\<ISO-timestamp>`, configurable), not on the node — the server already holds the file bytes from computing the diff/hash, so writing the backup locally costs the Proxmox node zero disk.
- **Rigorous, tested cleanup (non-negotiable).** Retention is enforced by two caps: a **per-file version cap** (keep last N) and a **global total-size cap** with oldest-first/LRU eviction. Cleanup runs before each new backup and on a schedule; under disk pressure it evicts first, and if space still can't be freed it applies a deterministic fail-safe (refuse the write or proceed with a logged warning — configurable). This cleanup logic is treated as critical code and is covered by the storage tests in the testing strategy.
- **Structured audit log (stored locally on Windows).** Append a JSON-lines record for every mutating or heavy operation: `{ id, ts, tool, host_or_vmid, path, prev_backup, prev_sha256, new_sha256, bytes, cmd, exit_code }`. The log lives on the Windows host alongside the backups (default e.g. `%LOCALAPPDATA%\claude-mcp\audit.jsonl`, configurable), keeping the node's disk untouched. Writes are atomic (temp + rename / `O_APPEND`) so a crash can't corrupt history. The `id` is the handle for reverting.
- **Where the trail lives — and the trade-off.** Both the audit log and backups default to the Windows host because the server runs there; the Proxmox node stays clean (the user's premium-storage constraint). The trade-off: the trail is coupled to the Windows machine — if it's lost, the trail is lost (the node's live files are unaffected). This also *decouples* backup durability from node health, which is a net positive; for extra safety, point the backup/audit dir at a synced folder or NAS.
- **"Large change" thresholds (configurable).** Flag and fully capture: file writes above N KB, any new-file creation, and any `execute`/`pct_exec` whose command matches heavy patterns or exceeds a duration/output threshold. The same threshold drives the storage decision above.
- **Revert path.** Because each file mutation has a backup (or diff) + audit id, reverting is "restore backup for id X." A future `revert_change` tool (or a small companion script) reads the JSONL and undoes a specific change. New files are deleted; overwritten files are restored from their backup/diff. Command side effects are logged but not auto-revertible.
- **Optional hardening (recommended follow-ups):** input validation/Zod schemas per tool; a denylist for catastrophic commands (`rm -rf /`, fork bombs, disk wipes); a path allowlist for `write_file`; command timeouts; redaction of secrets in logs; and optionally `git init` in frequently-edited config directories with an auto-commit before edits for a second, diffable revert layer (git's delta packing is also storage-efficient).

## Consequences

- **Easier:** Claude Code can read, edit, and run things across the node and inside containers from Windows, with a real paper trail and one-step file revert. Adding a seventh tool later is trivial.
- **Harder:** You carry the security weight. Root + a guardrail bug is dangerous, so the audit/backup code deserves the same care as the SSH plumbing. Logs and backups still need a retention/cleanup story so they don't fill the Windows host's disk, and the trail's durability is now tied to that machine.
- **To revisit:** If a second node appears, add a host parameter (or per-host config). If least-privilege becomes a priority, layer in the Proxmox API token model (Option C) for lifecycle operations while keeping SSH for filesystem/shell. Consider a dedicated non-root user with a tight `sudoers` scope once the tool surface stabilizes.

## Action Items

1. [ ] Scaffold a Node/TypeScript project (`tsx`/`tsup`), add `@modelcontextprotocol/sdk`, `ssh2`, `zod`, and a test runner (`vitest` or `node:test`).
2. [ ] **Design for testability (base requirement):** put the SSH client behind an injectable interface; keep guardrail/backup/eviction logic as pure, config-driven functions; make the audit log atomic and append-only. (See testing strategy.)
3. [ ] Implement an SSH connection module (`ssh2` `Client`, key-based root auth, keepalive + reconnect; SFTP for file ops).
4. [ ] Implement the six tools with `registerTool` + Zod input schemas; wire `StdioServerTransport`.
5. [ ] Build the guardrail layer: storage-aware backup (dedup + diff/compress + large-file policy), tested cleanup/retention, JSONL audit log, large-change thresholds, command denylist, optional path allowlist.
6. [ ] Add config (env or JSON): host, port, key path, backup/log dirs, thresholds, retention caps, allow/denylists.
7. [ ] **Write the test suite per the testing strategy** — unit (guardrails, backup/eviction, audit, `pct` parsing) first, then dockerized SSH integration, MCP-stdio protocol tests, and the storage soak + disk-pressure tests in CI.
8. [ ] Register the server in Claude Code's MCP config (`command` + `args`) and smoke-test `pct_list` → `read_file` → `write_file` (verify backup + audit entry) → `execute` → `pct_exec` → revert.
9. [ ] (Stretch) Add `revert_change` and/or git-backed config dirs for diffable history.
10. [ ] Document setup: generating the SSH key, installing the public key on the Proxmox node, and the revert procedure.

**Companion document:** see `TESTING-STRATEGY-ssh-mcp-server.md` for the full test plan — it is part of this base spec.

## References

- [MCP TypeScript SDK (official repo)](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP TypeScript SDK — server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [Node/TypeScript MCP server implementation guide (anthropics/skills)](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md)
