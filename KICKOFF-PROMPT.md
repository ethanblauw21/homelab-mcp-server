# Claude Code kickoff prompt

Paste the block below into Claude Code from inside this folder to start the build.

---

We're building a custom SSH MCP server. Read ADR-001-ssh-mcp-server.md and
TESTING-STRATEGY-ssh-mcp-server.md in this folder first — they are the ground-truth
spec; follow them. CLAUDE.md summarizes the project.

Project: a Node/TypeScript stdio MCP server (@modelcontextprotocol/sdk, ssh2, zod,
vitest) that SSHes as root into my Proxmox node on the LAN and exposes six tools:
execute, read_file, write_file, list_directory, pct_exec, pct_list. Full root is a
deliberate choice — all real safety lives at the tool layer (guardrails, storage-aware
backups, audit log, tested cleanup). Backups AND the audit log are stored locally on this
Windows host (configurable, default under %LOCALAPPDATA%\claude-mcp), NOT on the Proxmox
node, to keep the node's disk free.

Start by running /init to refresh CLAUDE.md and initializing git. Then work in this
order, and do NOT connect to my real Proxmox until the guardrails and unit tests pass:

1. Scaffold the project + test runner.
2. Put the SSH client behind an injectable interface; keep guardrail/backup/eviction
   logic as pure, config-driven functions; make the audit log atomic + append-only.
3. Write unit tests FIRST and get them green: command denylist, path validation,
   large-change detection, storage-aware backup (dedup + gzipped reverse-diff +
   large-file policy), retention/eviction (per-file cap + global size cap, LRU),
   audit-record construction, pct parsing/quoting.
4. Implement the six tool handlers + StdioServerTransport.
5. Add a dockerized SSH integration harness (exec/SFTP/reconnect, on-disk backup+audit,
   cleanup job) and MCP-stdio protocol tests.
6. Only then register the server in my Claude Code MCP config and smoke-test against a
   disposable Proxmox VM (read-only first), then the real node.

Ask me before writing anything that touches the live host. Walk me through setup:
generating the SSH key and installing the public key on the node.
