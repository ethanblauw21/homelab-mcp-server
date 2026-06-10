# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground truth

`ADR-001-ssh-mcp-server.md` and `TESTING-STRATEGY-ssh-mcp-server.md` are the authoritative spec. Read both before writing code; keep them in sync if the design changes.

## What this is

A Node/TypeScript **stdio MCP server** (`@modelcontextprotocol/sdk`, `ssh2`, `zod`, `vitest`) that connects as `root` over SSH (key auth) to a Proxmox VE node on the LAN and exposes an operator toolkit grown across ADRs 001–005:

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
| `health_check` | Fixed-probe node health → ok/warn/crit, section-isolated | 005 |
| `tail_log` | Bounded, validated, **always-redacted** journal/file tail (host or LXC) | 005 |
| `query_audit` | Filter/summarize the local audit log (read-only, not audited) | 005 |
| `diff_config` | Preview a revert: current → backup diff (read-only, not audited) | 005 |

## VM parity & operator toolkit (ADR-005)

- **`qm_exec` runs through the QEMU guest agent** (`qm guest exec <vmid> --timeout <secs> -- sh -c '<cmd>'`), not SSH. It requires `qemu-guest-agent` installed and running in the guest; `qm_exec` prechecks with an agent ping and fails with a fix-naming error when absent. The inner command passes the **same two-tier denylist** as `execute`/`pct_exec` (`confirm?: boolean` gates CONFIRM-tier). **Honest limit (contrast ADR-004's host `timeout` wrapper):** the agent `--timeout` bounds how long the *server waits*, but cannot guarantee in-guest termination — `parseAgentExec` surfaces `timedOut`/`exitCode: null`/`pid` rather than faking a clean exit. The census `vms[].agent` slot (ADR-002 R6) is populated from `qm_agent_ping` + parsed guest config.
- **`health_check` is fixed-probe and read-only**, mirroring the census pattern: declarative probes per section (`node`, `storage`, `guests`, `units`, `updates`), **pure evaluators** (`healthEvaluators.ts`) score each against config thresholds, and a `rollupStatus` reports the worst. Per-section `try/catch` isolation — a failed section becomes a recorded error, never an abort. apt staleness is read with `apt-get -s` (simulate); the server **never** runs `apt update` (A5.1).
- **`tail_log` validates before it interpolates.** Unit names match a strict charset, `since` accepts only ISO or `<n> (min|hour|day) ago`, paths go through `validatePath`, lines clamp to `tools.tailLinesCap`, and `unit` XOR `path` is enforced — anything free-form throws. Output (and error text) **always** passes through the ADR-002 redaction module; over-redaction is the safe failure mode for logs.
- **`query_audit` + `diff_config` complete the preview/forensics triad:** `dryRun` (before a write) → `diff_config` (before a revert) → `query_audit` (after the fact). Both are pure/read-only and **not** themselves audited. `query_audit` filters `AuditLog.readAll()` (tool/vmid/path/time/large-only), returns a summary + newest-first records bounded by `tools.queryAuditMaxLimit`. `diff_config` reconstructs a backup (resolved by `backupPath` or latest-for-target) and diffs `current → backup` via the shared `computeUnifiedDiff`; metadata-only backups return a structured `revertible: false` instead of a diff.

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
    healthEvaluators.ts # Pure: threshold evaluators + parsers (load/mem/fs/units/onboot/updates)
    healthCheck.ts      # health_check handler — fixed probes, section-isolated rollup
    tailLog.ts          # tail_log handler + pure buildTailCommand (validate → redact)
    queryAudit.ts       # Pure filterAuditRecords/summarizeAuditRecords + query_audit handler
    diffConfig.ts       # diff_config handler — current→backup revert preview (read-only)
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
```

**Key invariant:** `guardrails/`, `backup/policy.ts`, `backup/eviction.ts`, and `audit/record.ts` are **pure functions with no I/O** — the only way unit tests stay fast and trustworthy.

**Dependency direction:** tool handlers → `SshTransport` interface (injected). Never import `ssh2Client.ts` from tool handlers directly.

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
