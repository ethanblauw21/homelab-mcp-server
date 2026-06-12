# Testing Strategy: SSH MCP Server (ADR-001)

**Status:** Proposed — part of the base spec, to be satisfied before/while building
**Date:** 2026-06-09
**Companion to:** ADR-001 (Custom Node/TypeScript SSH MCP Server)

This is a base requirement, not an afterthought. Because the server runs as `root` and all safety lives at the tool layer, the guardrail, backup, and cleanup code *is* the security and data-integrity boundary — it must be the most heavily tested part of the system.

## Testability requirements (feed these back into the build)

The design must be shaped so it can be tested without a live homelab:

1. **Abstract the SSH client behind an interface** (e.g. `SshTransport` with `exec`, `readFile`, `writeFile`, `list`). Handlers depend on the interface, so unit tests inject a fake; integration tests inject the real `ssh2` client.
2. **Keep guardrail and backup logic pure.** Command-denylist matching, path validation, "large change" detection, retention/eviction selection, and audit-record construction should be pure functions over inputs — no I/O — so they're trivially unit-testable.
3. **Make all thresholds and policies config-driven** (size thresholds, retention caps, allow/denylists), so tests can set tiny limits and exercise edge behavior fast.
4. **Atomic, append-only audit log** (write temp + rename, or `O_APPEND`) so a crash mid-write can't corrupt history — and so it can be asserted in tests.

## Test pyramid for this system

```
        /   E2E    \      Few — full flows against a disposable Proxmox VM
       / Integration \    Some — real SSH sandbox + MCP stdio client
      /   Unit Tests  \   Many — guardrails, backup policy, audit, parsing
```

Tooling: `vitest` or `node:test`; `testcontainers`/docker-compose for a throwaway SSH server (e.g. an OpenSSH container); the official MCP SDK client for protocol-level tests. CI runs unit + integration (dockerized SSH); E2E is run locally against the homelab on demand.

## What to test, by area

| Area | Test type | Why it matters |
|------|-----------|----------------|
| Command denylist / validation | Unit | Root shell — must reject `rm -rf /`, fork bombs, disk wipes, and obfuscated variants |
| Path validation (`read/write/list`) | Unit | Block traversal (`../`), enforce allowlist, handle spaces and POSIX quirks |
| "Large change" threshold detection | Unit | Drives both audit detail and the storage decision |
| Backup policy (dedup / diff / compress / evict) | Unit | Storage is at a premium — wrong eviction or missed dedup fills the disk |
| Audit record construction + hashing | Unit | Revert correctness depends on accurate hashes and backup pointers |
| `pct_exec` command construction | Unit | Correct `pct exec <vmid> -- <cmd>` quoting/escaping |
| `pct_list` output parsing | Unit | Tabular CLI output → structured data, including edge states |
| SSH exec / SFTP / reconnect | Integration | Real connection: exit codes, stderr, timeouts, dropped-connection recovery, large output streaming |
| `write_file` end-to-end on disk | Integration | Backup is actually created, audit entry appended, revert restores exact bytes |
| Cleanup / retention job | Integration | Seed over-cap backups → assert eviction order and final size ≤ cap |
| MCP protocol over stdio | Integration | Tools register, Zod rejects bad input, result shapes are correct |
| Full management flows | E2E | `pct_list` → read config → edit (backup) → restart service → `pct_exec` → revert |
| Storage soak | E2E | Many writes over time keep total backup size bounded |

## Coverage targets

- **Guardrails, backup policy, audit, cleanup:** ~90%+ line/branch, plus mutation testing — these are the critical core.
- **Tool handlers / SSH glue:** ~70%, exercised mainly through integration.
- **Skip:** SDK internals, `ssh2` internals, trivial config getters, one-off setup scripts.

## Storage & cleanup tests (your premium-storage concern, called out explicitly)

These are first-class, not edge cases:

- **Dedup by content hash:** writing identical bytes twice stores the backup once (second write is a no-op for storage). Assert no duplicate blobs.
- **Compression / diff:** text-file backups are gzipped (and/or stored as reverse diffs against the prior version); assert stored size is a fraction of raw. Binary/large files fall back to a policy (see below).
- **Retention caps — two limits, both tested:**
  - per-file version cap (keep last N versions), and
  - global total-size cap with LRU/oldest-first eviction.
  Seed beyond each cap, run cleanup, assert: total ≤ cap, oldest evicted first, and at least the latest version of any still-relevant file is retained.
- **Large-file policy:** for writes above the "large" threshold, assert the configured behavior — e.g. store a compressed diff if text, or skip full content and record metadata + hash only (logged as non-revertible) for huge binaries — so a single big write can't blow the budget.
- **Disk-pressure handling:** when the backup dir is at cap and a new backup is needed, assert cleanup runs first; if space still can't be made, assert the configured fail-safe (refuse the write, or proceed with a logged warning) — and that this is deterministic, not a crash.
- **Crash safety:** kill the process mid-write; assert the audit log is not corrupted and no partial/orphaned backup is counted against the cap (or is reclaimed on next run).
- **Idempotent cleanup:** running cleanup twice is safe and changes nothing the second time.

## Security & negative tests (root means negatives matter most)

- Traversal attempts on every path-taking tool are rejected.
- Denylisted and obfuscated dangerous commands are blocked before reaching SSH.
- Oversize writes trigger the large-file policy rather than silently consuming storage.
- Secrets (keys, tokens) are redacted in the audit log; assert known patterns never appear.
- Concurrent tool calls are serialized over the single SSH connection without interleaving or audit-log races.

## Example test cases

1. `denylist.matches("rm  -rf   /")` → true (normalizes whitespace); `denylist.matches("rm -rf ./build")` → false.
2. `write_file` to an existing config → a gzipped backup appears, audit JSONL gains one record with matching `prev_sha256`, and `revert(id)` restores byte-identical content.
3. Two successive `write_file` calls with identical content → exactly one backup blob stored (dedup).
4. Seed 50 backups with a total-size cap of 10 → after cleanup, total ≤ 10 and the 40 oldest are gone, newest retained.
5. `pct_list` parser given a sample table with a stopped and a running container → returns structured rows with correct vmid/status.
6. SSH connection dropped mid-session → next tool call transparently reconnects and succeeds.
7. `write_file` of a 2 GB file with large-file policy "metadata-only" → no full backup stored; audit record flags it non-revertible.

## Known gaps / accepted risks to track

- Arbitrary `execute`/`pct_exec` side effects are **logged but not auto-revertible** — revert guarantees apply to file writes only.
- E2E depends on a disposable Proxmox VM; if unavailable, E2E coverage drops to manual smoke testing against the live node (do this read-only first).
- Backups protect against *your own* mistaken edits, not against a compromised host — they are not a security backup of last resort.

## Action items (add to the build)

1. [ ] Add the testability requirements above to the server design (SSH interface, pure guardrail/backup functions, config-driven policies, atomic audit log).
2. [ ] Stand up the unit suite first: denylist, path validation, threshold detection, backup-policy/eviction, audit construction, `pct` parsing/quoting.
3. [ ] Add a dockerized SSH integration harness; cover exec/SFTP/reconnect, on-disk backup+audit, and the cleanup job.
4. [ ] Add MCP-stdio protocol tests with the SDK client.
5. [ ] Add the storage soak + disk-pressure tests and wire cleanup into CI.
6. [ ] Reserve E2E for local runs against a disposable Proxmox VM before pointing at production.
