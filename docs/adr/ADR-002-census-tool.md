# ADR-002: Homelab Census Tool (`describe_homelab`) + Shared Redaction Module

**Status:** Proposed
**Date:** 2026-06-09
**Deciders:** Ethan
**Depends on:** ADR-001 (SSH MCP server), TESTING-STRATEGY-ssh-mcp-server.md
**Required by:** ADR-016 (reuses the redaction module for `docker_inspect` env masking), ADR-017 (output budgeting — `describe_homelab` `status` depth + `describe_guest`, reusing the census parsers), ADR-019 (reuses the redaction module as the opt-in read-redactor)

## Context

The MCP server (ADR-001) can act on the homelab but has no structured picture of it. Planning conversations, future ADRs, and drift analysis all currently rely on memory or ad-hoc `execute` calls. We want a single read-only tool that walks the Proxmox node and emits a **structured inventory snapshot** — the lab's "shape" — that becomes shared ground truth:

- Committed to the repo (`HOMELAB.md` + `inventory.json`) so both Claude Code and the Claude.ai Project see the same map.
- Stored locally as timestamped snapshots so future runs can be diffed for drift.
- Safe to share and to feed into LLM context, which makes **secret redaction a hard prerequisite**: `pct config`, container env files (e.g. Gluetun VPN credentials), and network configs contain secrets that must never leave the server unredacted.

Coordination note: audit-log redaction is being implemented separately in Claude Code. The redaction logic specified here MUST be built as a **shared pure module** (`src/guardrails/redaction.ts`) so the audit path and the census path use one implementation with one test suite. If a redaction module already exists when this ADR is implemented, extend it; do not duplicate it.

Constraints carried over from ADR-001: tool-layer guardrails are the security boundary; pure functions for everything testable; config-driven thresholds; bounded output (MCP responses land in LLM context — a full config dump of every container would blow the budget).

## Decision

Add one new MCP tool, `describe_homelab`, plus a shared redaction module.

### Tool: `describe_homelab`

A **strictly read-only composite tool**. It runs a fixed, hardcoded set of probe commands (no caller-supplied command strings — the input schema cannot inject shell), parses their output with pure functions, redacts the result, and returns a structured inventory.

**Input schema (Zod):**

```ts
{
  sections?: Array<"node" | "storage" | "network" | "containers" | "vms" | "services" | "tailscale">,
      // default: all sections
  depth?: "summary" | "full",
      // summary (default): identity + status per item, bounded
      // full: includes parsed per-guest config (redacted)
  saveSnapshot?: boolean,   // default true — persist snapshot locally
  compareToPrevious?: boolean // default false — include a drift diff vs the latest stored snapshot
}
```

**Probes per section** (each independent; a failing probe records a section-level error and the census continues — partial results beat a failed run):

| Section | Probes (read-only) |
|---|---|
| `node` | `hostname`, `pveversion`, `uptime -p`, `nproc`, `free -b`, `cat /proc/loadavg` |
| `storage` | `pvesm status`, `df -B1 --output=target,size,used,avail -x tmpfs -x devtmpfs`, `zpool status -x` (tolerate absence) |
| `network` | `ip -br addr`, `ip -br link`, bridge summary from `/etc/network/interfaces` (parsed, never raw-dumped) |
| `containers` | `pct list`; in `full` depth: `pct config <vmid>` per container (parsed key/value, redacted) |
| `vms` | `qm list`; in `full` depth: `qm config <vmid>` per VM (parsed, redacted) |
| `services` | per *running* container: `pct exec <vmid> -- sh -c 'systemctl list-units --failed --no-legend --plain; command -v docker >/dev/null && docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"'` (tolerate non-systemd / non-docker guests) |
| `tailscale` | `tailscale status --json` on the host if present; else per-container detection in `full` depth |

**Output (after redaction):**

```jsonc
{
  "ts": "2026-06-09T…Z",
  "host": "pve",
  "sections": {
    "node": { "version": "…", "uptime": "…", "cpu": 8, "memBytes": …, "load": [ … ] },
    "storage": [ { "name": "local-lvm", "type": "lvmthin", "totalBytes": …, "usedBytes": …, "active": true } ],
    "network": [ { "iface": "vmbr0", "state": "UP", "addrs": ["10.0.0.10/24"] } ],
    "containers": [ { "vmid": 101, "name": "gluetun", "status": "running",
                      "config": { "cores": "2", "memory": "1024", "net0": "…", "…": "…" } } ],
    "vms": [ … ],
    "services": [ { "vmid": 101, "failedUnits": [], "docker": [ { "name": "…", "image": "…", "status": "…" } ] } ],
    "tailscale": { "self": "…", "peerCount": 12 }
  },
  "errors": [ { "section": "vms", "probe": "qm list", "error": "…" } ],
  "redactions": 7,            // count of values redacted — a tripwire metric
  "snapshotPath": "…\\census\\2026-06-09T….json"   // when saveSnapshot
}
```

**Snapshot storage:** `<censusDir>/<ISO-ts>.json` on the Windows host (default `%LOCALAPPDATA%\claude-mcp\census\`, configurable). Snapshots are subject to a retention cap (count-based, default 30) reusing the eviction planner pattern from `backup/eviction.ts`. Committing `HOMELAB.md`/`inventory.json` to the repo is the **client's** job (Claude Code), not the server's — the server has no git or repo awareness.

**Drift (`compareToPrevious`):** a pure function over two snapshots returning `{ added, removed, changed }` per section (e.g. new container, status change, storage delta beyond a configurable % threshold). Cosmetic noise (uptime, load, timestamps) is excluded from comparison by design.

### Module: `guardrails/redaction.ts` (shared, pure)

`redact(input: string | Record<string, string>): { value, redactedCount }` applied to **every** census value before it is returned or persisted. Strategy is layered, conservative, and key-name-first:

1. **Key-name denylist** (case-insensitive): any key matching `/(pass(word)?|secret|token|api[_-]?key|private[_-]?key|auth|credential|wireguard.*key|psk)/` has its value replaced with `[REDACTED:<key>]`.
2. **Value patterns:** PEM blocks (`-----BEGIN … KEY-----`), WireGuard keys (44-char base64), JWTs (`eyJ…`), URLs with embedded credentials (`scheme://user:pass@`), `Authorization:`/`Bearer` headers.
3. **Env-style lines** in any free-text output: `NAME=value` where NAME matches the key denylist.
4. **Fail closed on parse ambiguity:** if a config blob can't be parsed into key/value pairs, it is summarized (`[unparsed: N lines, M redactions by pattern scan]`) rather than passed through raw.

Patterns are config-extendable (`REDACTION_EXTRA_KEYS` env, comma-separated) but the built-ins cannot be disabled. The same module is the one the audit-log redaction work consumes.

## Design Refinements (2026-06-09, post-review)

Six structural decisions adopted after first implementation, to keep the census extensible and its redaction guarantee load-bearing rather than discipline-based. These are normative.

### R1 — Probes are data, not code

Probes are rows in a declarative table (`{ section, key, command, parser, timeoutMs?, soft? }`) consumed by one generic runner, not fifteen hand-rolled call sites. Two scheduled changes — ADR-005's agent-status on the `vms` section and ADR-003's snapshot-capability-per-storage — must land as **a new row plus a parser**, not surgery on a bespoke handler. The dynamic fan-outs (per-guest `config`, per-running-container `services`) stay code, but run through the same runner.

Corollary: every probe result routes through one `expectSuccess(result)` helper instead of inline `exitCode === 0` checks. When ADR-004's `ExecResult` migration lands (`exitCode: number | null`, `timedOut: boolean`), it changes that one function, not every probe.

### R2 — Redaction enforced by the type system

The failure mode to design against is not the redactor missing a pattern — it is a future probe whose output never reaches the redactor. One chokepoint: the handler assembles a `RawCensusSnapshot`; exactly one function `finalizeInventory(raw): RedactedCensusSnapshot` redacts it; and snapshot persistence + the MCP response accept **only** the branded `RedactedCensusSnapshot`. The brand is a module-private symbol, so "add a probe, forget redaction" is a compile error at the persist/return boundary rather than a credential leak. `finalizeInventory` is the single site that may construct the branded type.

### R3 — Versioned, stabilized snapshot schema

Drift diffing compares snapshots across time, hence across code versions. Therefore:
- `schemaVersion` (currently `1`) is in the envelope from day one; the differ **refuses-or-degrades gracefully** on mismatch (returns a `schemaMismatch` marker and skips detailed diffing rather than producing garbage).
- Ordering is deterministic: containers/vms sorted by `vmid`, storage by `name`, interfaces by name, services by `vmid`, and guest-config keys sorted — so diffs reflect reality, not iteration order.
- Field volatility is annotated once (`VOLATILE_FIELDS`: snapshot `ts`; node `uptime`/`load`/`memUsedBytes`) and both the differ (which omits the node section for this reason) and any future renderer consult that single annotation rather than carrying ad-hoc ignore-lists.

### R4 — Fixture-fed dev loop; capture fixtures as a deliberate manual step

The standing safety rule (no live-node contact until tests are green) applies doubly to an unattended agent loop. Sequence: **(a)** run the probe commands by hand over SSH once, **(b)** sanitize the outputs and commit them as fixtures (this is what forces the redaction fixtures to be real-shaped, e.g. a sanitized Gluetun config), **(c)** develop parsers + handler against fixtures and `FakeTransport` only. The census's first contact with the real node is a **supervised smoke run** after the loop, where `redactions > 0` is eyeballed before anything is persisted or committed.

### R5 — Explicit truncation contract

"Bounded output" is given numbers: a per-section item cap (`maxItemsPerSection`, default 200) and a total response budget (`maxResponseBytes`, default 512 KiB). Every truncation is **explicit** in the output — a `truncations: [{ section, reason, omitted }]` array and a `truncated` boolean — never silent. Over budget at `full` depth drops per-guest configs first (recorded as a `_response` truncation). The explicit flags are what let the drift differ distinguish "container removed" from "container truncated": a section flagged truncated in the newer snapshot suppresses `removed` reporting for that section.

### R6 — Forward-define `vms.agent?`

Even though agent status is ADR-005 work, the `vms` guest type carries an optional `agent?: { enabled: boolean; running?: boolean }` field now, so its later population is data, not a schema migration that bumps `schemaVersion` for one field.

**Realized by ADR-005 (2026-06-10):** the slot is now populated — `enabled` from the parsed guest config, `running` from `qm_agent_ping` — with no `schemaVersion` change, exactly as forward-defined here.

## Options Considered

### Option A: Composite census tool with fixed probes *(chosen)*
Pros: zero new attack surface (no caller-controlled commands), bounded and structured output, parsers are pure and unit-testable, one tool call for the whole map. Cons: probe list needs maintenance as the lab evolves; partial coverage of exotic guests.

### Option B: Let Claude assemble the census from existing `execute`/`pct_exec` calls
Pros: nothing to build. Cons: ~20 unredacted tool calls per census (secrets land in context **before** any redaction could apply), unbounded output, non-deterministic shape, no snapshots/drift. Rejected — redaction must happen server-side, before the model sees anything.

### Option C: Pull inventory from the Proxmox REST API (`pvesh`/token)
Pros: structured JSON natively, cleaner parsing. Cons: doesn't cover in-guest reality (services, docker, failed units) which is half the value; adds a second auth model for a read path SSH already serves. Deferred — `pvesh get … --output-format json` MAY be used as an *implementation detail* for node/storage probes where it simplifies parsing, since it runs over the same SSH session.

## Security Model

- The tool is read-only by construction: the probe set is a compile-time constant; the input schema carries no command or path strings. Path validation and the command denylist are therefore not load-bearing here — **redaction is**, and inherits the same status as the ADR-001 guardrail core: ~90%+ line/branch coverage plus adversarial fixtures.
- Redaction runs **inside the server**, before the MCP response is serialized and before snapshots are written. Snapshots on disk are post-redaction only.
- The `redactions` count is surfaced so a run that redacts *zero* values on a lab known to contain secrets reads as a red flag, not a success.
- `services` probes execute inside containers via the existing `pct exec` plumbing but with fixed command strings; per-probe timeout (default 10 s, configurable) so one wedged guest can't hang the census.

## Consequences

- **Easier:** every future planning conversation starts from `inventory.json` instead of archaeology; drift becomes a diff; the census + audit log together answer "what is there" and "what changed."
- **Harder:** parser maintenance across Proxmox versions (pin fixtures to real captured output); redaction false negatives are a real risk class — treat every newly discovered secret shape as a test case first, pattern second.
- **Marketable:** no surveyed community Proxmox/SSH MCP server ships an inventory-with-redaction primitive; this plus backup/revert is the project's differentiation story.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Redaction module | Unit (critical, 90%+) | Adversarial fixtures: Gluetun env (`OPENVPN_PASSWORD=…`, `WIREGUARD_PRIVATE_KEY=…`), PEM blocks, JWTs, URL creds, mixed-case keys, secrets split across whitespace; assert known plaintexts never appear in output; assert `redactedCount` accuracy; assert fail-closed path for unparsable blobs |
| `pct config` / `qm config` / `pvesm` / `ip -br` parsers | Unit | Real captured output as fixtures, incl. stopped guests, locked guests, empty lists |
| Section error isolation | Unit (FakeTransport) | One probe throws → section error recorded, other sections intact |
| Drift diff | Unit | Added/removed/changed container; noise fields ignored; storage % threshold |
| Snapshot retention | Unit | Reuse eviction-planner pattern; seed over cap, assert oldest evicted |
| Census end-to-end | Integration | Against Docker SSH host with stubbed `pct`/`qm` shims on PATH; assert response shape + snapshot file written + zero unredacted fixture secrets |
| Real-host smoke | E2E (manual) | Read-only by nature; verify `redactions > 0` and spot-check `HOMELAB.md` before first commit |

## Action Items

1. [ ] Implement `src/guardrails/redaction.ts` as a pure module with the layered strategy above; coordinate with the in-flight audit-log redaction work so both consume this one module.
2. [ ] Write redaction unit tests first (adversarial fixtures, including a captured-and-sanitized Gluetun config); get green.
3. [ ] Implement pure parsers (`src/tools/censusParsers.ts`) for `pct list/config`, `qm list/config`, `pvesm status`, `df`, `ip -br`, `tailscale status --json`, with real-output fixtures.
4. [ ] Implement `describe_homelab` handler: fixed probe table, per-probe timeout, section error isolation, depth/sections filtering, redaction pass, snapshot persistence + retention.
5. [ ] Implement the pure drift-diff function and `compareToPrevious`.
6. [ ] Add config: `censusDir`, snapshot retention cap, per-probe timeout, storage-drift % threshold, `REDACTION_EXTRA_KEYS`.
7. [ ] Integration test with stubbed `pct`/`qm` shims in the Docker harness; wire into CI.
8. [ ] First real run: review output by hand, confirm redaction, then have Claude Code render and commit `HOMELAB.md` + `inventory.json` to the repo.
9. [ ] (Stretch) `HOMELAB.md` renderer as a pure function over the snapshot, so the markdown view is reproducible from any stored snapshot.

## References

- ADR-001 — privilege model, backup/eviction patterns reused here
- TESTING-STRATEGY-ssh-mcp-server.md — coverage tiers this ADR extends