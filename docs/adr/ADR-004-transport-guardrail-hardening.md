# ADR-004: Transport & Guardrail Hardening

**Status:** Proposed
**Date:** 2026-06-09
**Deciders:** Ethan
**Depends on:** ADR-001 (SSH MCP server), ADR-003 (confirm-gate pattern), TESTING-STRATEGY-ssh-mcp-server.md

## Context

A code review of v0.1 found that the transport layer and the guardrail stack each undercut the project's own security thesis in specific, fixable ways:

1. **Host keys are not verified.** `ssh2` performs no known-hosts checking unless a `hostVerifier` is supplied; the current code only supplies one when *skipping* verification. The default configuration therefore silently accepts any host key, exposing the root credential to first-connection (or ARP-spoofed) man-in-the-middle on the LAN. This is the project's only true open security hole.
2. **Timeouts abandon, not terminate.** On client-side timeout the promise rejects but the remote command keeps running — a hung `tar` survives its own "timeout," and the channel leaks.
3. **Exit codes lie about signals.** `exitCode: null` (signal-terminated) is coerced to `0`, so a killed command reports success — and that false success lands in the audit log.
4. **`read_file` is unbounded.** A multi-GB file gets slurped fully into server memory and then into model context.
5. **The denylist over- and under-blocks.** `\b(shutdown|reboot|…)\b` matches *anywhere*, so `grep reboot /var/log/syslog`, `systemctl status reboot.target`, and `echo "don't reboot"` are all refused — while a *deliberate* operator-intended reboot is impossible. The default configured entry `chown -R` (substring-matched after normalization) blocks every legitimate recursive chown.
6. **`reconnectDelay` is dead config** — declared, defaulted, never read.

These are individually small; together they are the difference between a safety-*themed* server and a safe one. They are also prerequisites: ADR-003 deferred auto-snapshot-before-heavy-command explicitly on denylist anchoring, and any future external adoption (the census as a "selling point") inherits its trust model from this layer.

Out of scope here: audit-log secret redaction (in flight separately, consuming ADR-002's shared module) and concurrency serialization over the shared connection (tracked, deferred — current sync-fs usage makes races unlikely at single-operator scale).

## Decision

Six changes, grouped into transport honesty and guardrail precision, plus one interaction-model addition (`dryRun`).

### 1. Host key verification (fail closed, TOFU-assisted)

- `Ssh2Transport` always supplies a `hostVerifier`. Verification compares the presented key's **SHA-256 fingerprint** against the expected value.
- Expected value sources, in priority order:
  1. `SSH_HOST_KEY_FINGERPRINT` env (explicit pin — recommended; printable via `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -`).
  2. A local **trust-on-first-use store** (`%LOCALAPPDATA%\claude-mcp\known_hosts.json`, configurable): if no pin is configured and no entry exists for `host:port`, the first connection records the fingerprint and logs a prominent warning ("pinned on first use — verify out of band"); every subsequent connection must match.
- A mismatch **fails closed**: connection refused, error names both fingerprints, and the resolution (re-pin after verifying the node's key really changed) is in the error text. No automatic re-pinning, ever.
- `skipHostVerification: true` retains its meaning (verifier returns true) but now logs a warning on every connect; it exists for the Docker integration harness, which sets it explicitly.
- The setup docs and `generate-ssh-key.ps1` flow gain a fingerprint-capture step.

### 2. Server-side timeout enforcement

- Client timers cannot kill remote processes reliably (signal delivery over exec channels varies by server). Enforcement therefore moves **to the node**: `exec` wraps every command as
  `timeout --signal=TERM --kill-after=5 <secs> sh -c '<cmd>'`
  using the same single-quote escaping as `buildPctExecCommand` (extracted to a shared pure helper). The wrapper's `<secs>` derives from the effective per-call timeout.
- The client timer remains as a backstop at `effective + grace` (grace default 10 s, configurable) for the case where the connection itself is wedged; on backstop firing, the channel is closed and the transport marks the connection for reconnect.
- coreutils `timeout` exits `124` on expiry; the transport maps this to `{ timedOut: true }` in the result rather than surfacing a bare 124. `pct_exec` composes the same wrapper inside the container.

### 3. Honest exit semantics

`ExecResult` becomes:

```ts
{ stdout: string; stderr: string; exitCode: number | null;
  signal?: string; timedOut?: boolean }
```

- `null` is preserved when the command died to a signal; `signal` carries the name when ssh2 reports it; `timedOut` is set per §2.
- Handlers and audit records propagate all three fields; nothing coerces `null` to `0`. `pct_list` and any other "did it succeed" checks test `exitCode === 0` explicitly (already true) and now also surface `timedOut` in errors.

### 4. `read_file` bounds

- Before reading, the transport SFTP-`stat`s the path. Files above `readFileMaxBytes` (default **2 MB**, configurable) are refused with an error that names the size and suggests the right tools (`execute` with `head`/`tail`/`grep`/`wc`) instead.
- `read_file` gains optional `offset`/`maxBytes` inputs (both bounded by the cap) for deliberate windowed reads of large files. `pct_read_file` (ADR-003) applies the same cap by checking size via `pct exec stat` before pulling.

### 5. Denylist v2: segment-anchored, two-tier

The denylist is rebuilt around **command segments**: the normalized command is split on shell separators (`;`, `&&`, `||`, `|`, `&`, newline, `$(`, backtick), and patterns evaluate against each segment, distinguishing the **command position** (segment's leading token) from arguments.

Two tiers, two behaviors:

- **DENY (unconditional):** destructive-by-nature patterns — `rm -rf /` (and `/*`), `mkfs*`, `dd` writing to block devices, redirects into block devices, fork bombs, `chmod -R 777 /`. These remain regex-based but segment-aware (e.g. a redirect-to-`/dev/sdX` is checked per segment). No flag bypasses DENY.
- **CONFIRM (deliberate-action gate):** availability-class commands — `shutdown`, `reboot`, `halt`, `poweroff`, `init 0|6`, `systemctl reboot|poweroff|halt` — match **only in command position**. `execute`/`pct_exec` gain `confirm?: boolean`; a CONFIRM match without `confirm: true` is refused with text explaining the gate (reusing ADR-003's pattern verbatim); with it, the command runs and the audit record notes `confirmGated: true`.

Fixes that fall out: `grep reboot …`, `systemctl status reboot.target`, and `echo "reboot"` all pass (argument/string position); a deliberate `reboot` becomes possible; **`chown -R` is removed from the default configured denylist**. Configured denylist entries change from substring matching to **segment-prefix matching** (entry matches iff some segment starts with the normalized entry), and the config format allows per-entry tier annotation (`confirm:` prefix), defaulting to DENY.

Known honest limit, restated from ADR-001: this is a tripwire against catastrophic and availability-affecting commands, not a sandbox — root can still do unbounded damage with commands that match nothing. The tiers narrow false positives; they do not claim completeness.

### 6. `dryRun` for writes + reconnect backoff

- `write_file` and `pct_write_file` gain `dryRun?: boolean`. When true, the full pipeline runs **read-only**: path validation, previous-content read, large-change detection, backup-kind selection — and the response carries a unified line diff (pure function, `computeUnifiedDiff(prev, next)`, truncated at a configurable line cap) plus the would-be metadata (`kind`, `isLargeChange`, sizes). **No write, no backup stored, no audit record** — a dry run has no side effects anywhere. The diff function is shared infrastructure for ADR-005's `diff_config`.
- `reconnectDelay` becomes real: on connection loss, reconnection attempts use exponential backoff starting at `reconnectDelay` (cap 60 s, jittered), resetting on success. Alternatively stated: the dead config either works or is deleted; this ADR chooses works.

## Options Considered

### Option A: All six changes as specified *(chosen)*
Pros: closes the only true security hole; makes every result field honest; converts the worst false-positive source into a deliberate-action UX; all changes are independently shippable. Cons: `ExecResult` shape change touches every handler and test; the `timeout` wrapper assumes coreutils on host and guests (true for Proxmox/Debian and standard LXC templates; exotic guests degrade to client-backstop behavior).

### Option B: Host-key pinning only, defer the rest
Rejected: the remaining items block ADR-003's stretch goal, ADR-005's toolkit, and daily usability (denylist false positives bite within a week of real use).

### Option C: Replace the denylist with an allowlist of permitted commands
Pros: strongest model. Cons: directly contradicts ADR-001's open-ended "manage whatever service" goal; the maintenance burden lands on the operator. Rejected for the default; the config already supports a path allowlist, and a command allowlist can be revisited if the server is ever exposed beyond a single trusted operator.

### Option D: TOFU-only host keys (no explicit pin support)
Rejected: TOFU alone protects every connection except the one that matters most. Explicit pin is first-class; TOFU is the assist for the lazy path, with a loud warning.

## Security & Audit Model

- Host-key verification moves the trust anchor from "the LAN is friendly" to "this specific key, verified once" — the residual risk concentrates, as ADR-001 intended, on the two key files on the Windows host.
- The CONFIRM tier is the second consumer of the deliberate-action gate (after `snapshot_rollback`), establishing it as the standard pattern: schema-level boolean, explanatory refusal, audited execution.
- `timedOut`/`signal`/`null` propagation means the audit log can no longer record a false success — relevant for any future `query_audit` consumer.
- Nothing in this ADR adds caller-controlled strings to command construction beyond what exists; the `timeout` wrapper reuses the tested quoting helper.

## Consequences

- **Easier:** trustworthy transport results; deliberate reboots without disabling guardrails; safe previews via `dryRun` (the conversational `terraform plan`); ADR-003's auto-snapshot stretch is unblocked.
- **Harder:** `ExecResult` migration ripples through handlers, fakes, and tests in one coordinated change; first-connection UX gains one verification step (capture the fingerprint); the integration harness must set `skipHostVerification` explicitly.
- **Compatibility:** wrapped commands are visible in audit `cmd` fields — record the *original* command in `cmd` and the wrapper parameters in a `timeoutSecs` field to keep the log clean.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Host verifier | Unit | Pin match/mismatch; TOFU first-record path; TOFU mismatch fails closed; skip flag warns; store round-trip |
| Host verifier | Integration | Docker harness: correct fingerprint connects; wrong pin refused; TOFU file created on first connect |
| Timeout wrapper construction | Unit | Quoting via shared helper; secs threading; pct composition (wrapper inside container) |
| Timeout behavior | Integration | `sleep 60` with 2 s timeout → `timedOut: true`, exit 124 mapped, remote process gone (assert via follow-up `pgrep`) |
| Exit semantics | Unit + Integration | Signal-killed command → `exitCode: null`, `signal` set, never coerced; audit record carries fields |
| `read_file` cap | Unit (FakeTransport) + Integration | Oversize refused with helpful error; `offset`/`maxBytes` windowing; `pct_read_file` parity |
| Segment splitter | Unit (critical) | Separators incl. `$(`, backticks; quoted separators not split (document the chosen fidelity level); command-position extraction |
| Denylist v2 | Unit (critical, 90%+) | All v1 cases re-pass; false-positive fixtures (`grep reboot`, `systemctl status reboot.target`, `echo "reboot"`, recursive chown) now pass; CONFIRM without flag refused, with flag runs + audited; tier annotation parsing; segment-prefix config matching |
| `dryRun` | Unit (FakeTransport) | Full pipeline runs; diff correct; zero writes, zero backups, zero audit records; diff truncation |
| Reconnect backoff | Integration | Drop connection (container restart) → next call reconnects; backoff timing within bounds |

## Action Items

1. [ ] Extract the single-quote escaping helper from `pctHelpers` into a shared pure module; add the `timeout` wrapper builder with tests.
2. [ ] Implement host-key verification (pin + TOFU store + fail-closed mismatch); update `Ssh2Transport`, config schema, setup scripts/docs; integration coverage.
3. [ ] Migrate `ExecResult` (`exitCode: number | null`, `signal`, `timedOut`) through transport, fake, handlers, audit record, and all tests in one change set.
4. [ ] Implement `read_file` stat-gated cap + `offset`/`maxBytes`; mirror in ADR-003's `pct_read_file`.
5. [ ] Implement the segment splitter and denylist v2 (DENY/CONFIRM tiers, command-position matching, segment-prefix config entries); remove `chown -R` from defaults; write the false-positive regression suite first.
6. [ ] Add `confirm` to `execute`/`pct_exec` reusing the ADR-003 gate; audit `confirmGated`.
7. [ ] Implement `computeUnifiedDiff` (pure) + `dryRun` on both write tools.
8. [ ] Implement reconnect backoff; delete or honor every remaining declared-but-unused config field (audit the schema).
9. [ ] Update CLAUDE.md and the project overview to reflect the new trust model and result shape.

## References

- ADR-001 — trust-boundary rationale this ADR completes
- ADR-003 — confirm-gate pattern (reused), `pct_read_file` cap parity
- v0.1 code review findings (2026-06-09) — items 2–4, 6–7, and 9 of the action list
- `ssh2` docs — `hostVerifier`, `hostHash`; coreutils `timeout(1)`