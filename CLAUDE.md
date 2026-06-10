# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground truth

`ADR-001-ssh-mcp-server.md` and `TESTING-STRATEGY-ssh-mcp-server.md` are the authoritative spec. Read both before writing code; keep them in sync if the design changes.

## What this is

A Node/TypeScript **stdio MCP server** (`@modelcontextprotocol/sdk`, `ssh2`, `zod`, `vitest`) that connects as `root` over SSH (key auth) to a Proxmox VE node on the LAN and exposes six tools: `execute`, `read_file`, `write_file`, `list_directory`, `pct_exec`, `pct_list`.

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
