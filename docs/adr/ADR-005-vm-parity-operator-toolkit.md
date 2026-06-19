# ADR-005: VM Parity (`qm` tools) + Operator Toolkit

**Status:** Proposed
**Date:** 2026-06-09
**Deciders:** Ethan
**Depends on:** ADR-002 (redaction, census), ADR-003 (target descriptors, backup meta), ADR-004 (`ExecResult` shape, `computeUnifiedDiff`, size caps, confirm gate)
**Required by:** ADR-017 (output budgeting — `query_audit` `cmd` projection + `health_check` pseudo-fs filtering)

## Context

Two gaps remain after ADR-002–004:

1. **VMs are second-class.** Every guest-aware tool (`pct_*`, ADR-003's file tools) covers LXC only; the `qm` half of the lab is reachable solely through raw `execute`. Unlike containers, VMs have no hypervisor-level exec — command execution requires the **QEMU guest agent** installed and enabled per guest, which makes "is the agent available?" a first-class concern rather than an error case.
2. **The server can mutate safely but can't *operate* comfortably.** Daily-driver questions — "anything wrong?", "what does that service's log say?", "what changed last week?", "what would I be reverting?" — each currently require ad-hoc `execute` calls with unbounded output and no structure.

This ADR adds VM parity plus four small operator tools. Each tool is individually thin because it stands on infrastructure the prior ADRs built: fixed-probe pattern and redaction (ADR-002), target descriptors in backup meta (ADR-003), honest exec results, size caps, and the unified-diff function (ADR-004).

## Decision

### Part 1 — VM parity

**`qm_list`** `{}` — parses `qm list` (columns: VMID, NAME, STATUS, MEM(MB), BOOTDISK(GB), PID) into structured rows. Pure parser with real-output fixtures, same pattern as `parsePctList`.

**`qm_agent_ping`** `{ vmid }` — wraps `qm agent <vmid> ping`; returns `{ available: boolean, error? }`. Used internally as the precheck for `qm_exec` and exposed as a tool so availability can be queried directly.

**`qm_exec`** `{ vmid: number, command: string, timeoutMs?: number, confirm?: boolean }`
- Precheck: agent ping; unavailable ⇒ structured error naming the fix ("install/enable qemu-guest-agent; the census reports agent status per VM").
- Denylist v2 (ADR-004) applies to the inner command, including the CONFIRM tier and `confirm` flag — a `reboot` inside a VM is availability-affecting too.
- Execution: `qm guest exec <vmid> --timeout <secs> -- sh -c '<escaped>'` (shared quoting helper). The agent returns JSON (`exited`, `exitcode`, `out-data`, `err-data`, `out-truncated`); a pure parser maps this onto the ADR-004 `ExecResult` shape: not-exited-within-timeout ⇒ `timedOut: true` with the guest PID recorded in the audit note (the process may still be running in the guest — unlike §ADR-004's host wrapper, the agent cannot guarantee termination; this is stated honestly in the tool description). `out-truncated` surfaces as a result field.
- Audited like `pct_exec`, with `vmid`.

**Census integration (amends ADR-002):** the `vms` section carries `agent: { enabled: boolean (from config), responsive: boolean (from ping) }` per VM, so `qm_exec` coverage is visible on the map before it's needed. *(As shipped, this populates the existing ADR-002 R6 forward-slot `agent: { enabled, running? }` — `running` holds the ping-derived "responsive" boolean — which avoids a `schemaVersion` bump. Same information, existing key. See Action Item 3.)*

**Deferred (stretch): `qm_read_file` / `qm_write_file`.** The guest agent supports file read/write (via `pvesh …/agent/file-read|file-write`, base64-bodied, agent-enforced size limits), and ADR-003's target-descriptor scheme extends naturally (`kind: "qm"`). Deferred because VM config edits are rare in this lab relative to container edits; if implemented, reads inherit the ADR-004 size cap and writes run the full ADR-003 pipeline. Listed as a stretch action item rather than a decision. **(Subsequently shipped 2026-06-10 against fixtures — see action item 10; the lab still has no VM to exercise it end-to-end.)**

### Part 2 — Operator toolkit

**`health_check`** `{ sections?: Array<"node" | "storage" | "guests" | "units" | "updates"> }`

Fixed read-only probes (census pattern: independent probes, per-probe timeout, section-level errors) feeding **pure threshold evaluators** that return `{ status: "ok" | "warn" | "crit", finding, detail }` per check:

| Check | Probe | Default thresholds (config-driven) |
|---|---|---|
| Load / memory | `cat /proc/loadavg`, `free -b` | warn ≥ 0.8×cores / 85% mem; crit ≥ 1.5× / 95% |
| Root + storage usage | `df -B1`, `pvesm status` | warn ≥ 80%, crit ≥ 90% per filesystem/store |
| ZFS health | `zpool status -x` (tolerate absence) | anything but "all pools are healthy" ⇒ crit |
| Failed units (host) | `systemctl --failed --no-legend --plain` | any ⇒ warn (configurable crit list) |
| Onboot-but-stopped guests | `pct list`/`qm list` + per-guest `onboot` from config | any ⇒ warn |
| Pending updates | `apt-get -s -o Debug::NoLocking=true upgrade \| grep -c ^Inst` (count only) | informational; warn above configured count |

Response: findings array + an overall worst-status rollup. No mutation, no audit record.

**`tail_log`** `{ target: { kind: "host" } | { kind: "pct", vmid }, unit?: string, path?: string, lines?: number, since?: string }`
- Exactly one of `unit` | `path`. Unit mode: `journalctl -u <unit> -n <lines> --no-pager [--since <since>]`; path mode: `validatePath` then `tail -n <lines> <path>`. Container targets route through `pct exec`.
- `lines` capped (default cap 500, configurable); `unit` and `since` are validated against strict charsets (unit-name pattern; `since` accepted as ISO timestamp or `^\d+\s*(min|hour|day)s?\s*ago$`) — no free-form strings reach the shell.
- **All output passes through the ADR-002 redaction module before return** — logs leak tokens, connection strings, and Authorization headers constantly.
- Read-only; not audited.

**`query_audit`** `{ tool?: AuditTool, vmid?: number, pathContains?: string, since?: string, until?: string, largeOnly?: boolean, limit?: number }`
- Entirely local: pure filter/summarize functions over the JSONL via the existing `readAll()` (acceptable at homelab scale; streaming read is a noted future optimization, not a blocker).
- Returns `{ summary: { total, byTool, byVmid, firstTs, lastTs }, records }` with `records` bounded by `limit` (default 50, capped 200), newest first.
- Gives the audit log its first consumer beyond revert; pairs with the census drift diff to answer "what changed *and who did it*."

**`diff_config`** `{ backupPath?: string, path?: string, vmid?: number }`
- Either a specific `backupPath`, or `path` (+ optional `vmid` for container targets) meaning "latest revertible backup for this target."
- Resolves the target from backup meta (ADR-003 descriptors), restores the blob in memory, reads current content via the matching transport path, returns `computeUnifiedDiff(current, backup)` (ADR-004), truncated at the shared diff line cap, plus both hashes and the backup's timestamp/kind.
- Metadata-only backups ⇒ structured "non-revertible, no content to diff" response, not an error.
- Read-only; not audited. Completes the preview triad: `dryRun` (before a write) → `diff_config` (before a revert) → `query_audit` (after the fact).

## Options Considered

### Option A: Guest-agent `qm_exec` + four thin toolkit tools *(chosen)*
Pros: VM coverage with honest availability semantics; every toolkit tool reuses tested infrastructure; bounded, structured, redacted outputs replace ad-hoc `execute` archaeology. Cons: `qm_exec` quality depends on per-guest agent installation (mitigated by census visibility); health thresholds need tuning to this lab.

### Option B: VM access via SSH directly into each guest
Pros: no agent dependency; full PTY-less exec parity. Cons: N keys to manage and install, N trust relationships, per-guest network reachability assumptions — multiplies the exact credential-management burden ADR-001 centralized into one key. Rejected.

### Option C: `health_check`/`tail_log` as Claude-side conventions over `execute` (no new tools)
Pros: zero code. Cons: unbounded unredacted output into context (the Option-B-of-ADR-002 problem again); no pure evaluators to test; non-deterministic probe sets. Rejected for the same reason census Option B was.

### Option D: Full VM file tools now (not stretch)
Deferred as described — demand-driven; the descriptor scheme means no design work is lost by waiting.

## Security & Audit Model

- `qm_exec` is the third consumer of denylist v2 + the confirm gate; the gate pattern now covers every command-execution path uniformly.
- The honest limitation — agent-based timeout cannot guarantee process termination inside the guest — is surfaced in results and tool descriptions rather than papered over (contrast: ADR-004's host wrapper, which can guarantee it).
- `tail_log` is the second mandatory consumer of the redaction module after the census; its strict input charsets keep free-form strings out of command construction.
- All Part-2 tools are read-only with bounded output; none mutate, none require new guardrail classes.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| `qm list` parser | Unit | Fixtures: running/stopped VMs, missing PID column states |
| Agent-exec JSON parser | Unit (critical) | exited/exitcode mapping, `out-truncated`, not-exited ⇒ `timedOut` + pid, malformed JSON ⇒ structured error |
| `qm_exec` flow | Unit (FakeTransport) | Ping precheck gating, denylist v2 + confirm tier on inner command, audit with vmid |
| Health evaluators | Unit | Pure threshold functions per check incl. boundary values; worst-status rollup; onboot-vs-status join |
| `tail_log` input validation | Unit (critical) | Unit-name charset, `since` grammar, lines cap, path validation, unit/path exclusivity; redaction applied (fixture secrets never appear) |
| `query_audit` filters | Unit | Each filter alone + combined; time-range edges; limit bounding; summary counts |
| `diff_config` resolution | Unit | backupPath vs latest-for-target; pct descriptor routing; metadata-only response; diff truncation |
| Toolkit end-to-end | Integration | Docker harness (+ `qm` shim alongside ADR-003's `pct` shim): health probes parse, tail_log bounded output, qm_exec against shim |
| Real-host smoke | E2E (manual) | `qm_agent_ping` across real VMs; health_check thresholds sanity-tuned against the live node |

## Action Items

1. [x] Implement `qm list` + agent-exec JSON parsers (pure, fixtures first). *(Docker `qm` shim deferred — no Docker on the Windows dev machine; integration coverage is a CI/Linux task.)*
2. [x] Implement `qm_list`, `qm_agent_ping`, `qm_exec` (denylist v2 + confirm gate on inner command; audit with vmid); extend the `AuditTool` union.
3. [x] Amend the census `vms` section with agent status (ADR-002 amendment). **Impl note:** populated the existing R6 forward-slot `agent: { enabled, running? }` rather than the `{ enabled, responsive }` shape above, so no `schemaVersion` bump was needed — "responsive (from ping)" maps onto the `running` boolean. The field carries the same information; only the key name differs.
4. [x] Implement health probes + pure evaluators + config thresholds; section error isolation per the census pattern.
5. [x] Implement `tail_log` with strict input validation and mandatory redaction pass.
6. [x] Implement `query_audit` (pure filters/summary over `readAll()`).
7. [x] Implement `diff_config` over backup meta + `computeUnifiedDiff`.
8. [x] Config additions: health thresholds, tail-lines cap, query_audit limit cap.
9. [x] Update CLAUDE.md tool table and the project overview.
10. [x] (Stretch) `qm_read_file`/`qm_write_file` through the ADR-003 pipeline with `kind: "qm"` descriptors and agent size limits. **Shipped 2026-06-10** (`qmFiles.ts` pure builders/parsers + I/O; `qmReadFile.ts`/`qmWriteFile.ts` handlers; `BackupTarget` `kind: "qm"` → `qm:<vmid>:<path>` key; `revert_file` routes `kind === "qm"`; `qm_write_file` enforces `tools.qmWriteMaxBytes`). Built against fixtures/`FakeTransport` (the live lab currently has **zero VMs**, so end-to-end agent exercise awaits a VM). **Honest limits made explicit:** the agent endpoints are text-oriented (binary lossy/refused) and the write endpoint preserves **no** mode/owner (file lands with the guest umask — unlike `pct push`). Docker `qm` integration coverage remains a CI/Linux task (no Docker on the Windows dev machine).

## References

- ADR-002 — fixed-probe pattern, redaction module, census `vms` amendment
- ADR-003 — target descriptors, backup meta, Docker shim approach
- ADR-004 — `ExecResult`, `computeUnifiedDiff`, denylist v2, confirm gate, size caps
- Proxmox `qm` man page — `guest exec`, `agent ping`; PVE API `agent/file-read|file-write` (stretch)