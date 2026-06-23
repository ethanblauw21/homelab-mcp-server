# ADR-020: Closing the Raw-Exec Gaps — systemd Front Door, Service Probes, Content-Addressed Read

**Status:** Accepted (implemented 2026-06-22)
**Date:** 2026-06-22
**Deciders:** Ethan
**Depends on:** ADR-001 (`execute`/`pct_exec` plumbing), ADR-004 (denylist/confirm gate, `validatePath`, honest `ExecResult` exit semantics, read caps), ADR-005 (`tail_log`/`buildTailCommand` reuse, the fixed-probe `health_check` pattern, the structured `query_audit` record as the payoff), ADR-007 (tiers + the target-kind tier rule `assertTargetTier`), ADR-011 (token economy as a design axis — for the regex read), ADR-016 (the "dedicated tool beats raw exec" doctrine + the audit-log evidence method), ADR-017 (content-addressed windowing extends the output-budgeting doctrine)
**Required by:** — none yet —
**Source:** `docs/tool-ideas.md` items 5–7, ranked highest-value of the live dogfooding backlog. Same evidence method as ADR-016: the audit log shows recurring free-form `systemctl`/`journalctl`, `curl`/`nc`, and `grep -C` strings funneled through `execute`/`pct_exec` for operations that are fully enumerable.

## Context

ADR-016 made an argument from the audit log: **227 of 257 records were `pct_exec` running hand-rolled `docker inspect`/`docker stats`/`docker exec cat` loops**, because the Docker layer listed and logged but never *inspected*. The same shape of evidence points at three more gaps the toolkit never closed — operations that are completely enumerable yet still go through free-form command text:

1. **systemd has no front door.** Restarting a unit, checking if it is active, tailing its journal — all go through raw `execute` (host) or `pct_exec` (LXC). The model writes `systemctl restart nginx`, `systemctl is-active …`, `journalctl -u …` by hand. That is unstructured, un-queryable command text in the audit log, a denylist/quoting surface, for the single most common class of "operate a service" action.
2. **No structured "did it come back?" check.** After a `compose_redeploy`, `guest_restart`, or `service_restart`, the model confirms recovery by hand-writing `curl -sS -o /dev/null -w '%{http_code}'` or `nc -z` through `*_exec`. The post-mutation reachability check is the most common follow-up step and has no tool — it is free-form and quoting-prone every time.
3. **Reads are blind-windowed or whole-file.** Finding one stanza in a config means `read_file` (the whole file, or a *guessed* `offset`/`maxBytes` byte window) or dropping to `execute grep`. Neither returns "the match **plus N lines of context**" without burning context on the surrounding file — and ADR-011 §1 / ADR-017 named the token economy the dominant real-use cost.

None of these are bugs. They are **missing dedicated tools** for enumerable operations, exactly the gap ADR-016 closed for Docker introspection. The cost is real and recurring: free-form audit rows the ADR-010 UI and ADR-015 metrics cannot parse, a wider denylist/quoting surface, and (for reads) un-budgeted output. This ADR groups the three backlog items (`tool-ideas.md` 5–7) that share two properties: **highest dogfooding value** and **no new subsystem** — each is a thin, structured shell over plumbing that already exists (`buildTailCommand`, the `pct exec` boundary, `validatePath`, the read family, the target-kind tier rule).

It deliberately excludes the rest of the backlog: item 8 (rollback circuit breaker) is cheap but needs cross-call **session-state** semantics the stdio server does not yet have; item 9 (semantic history) requires an embedding dependency and conflicts with ADR-006's "git never on the write's critical path" invariant; item 10 (`index_path`) depends on two indexer subsystems that do not exist in this repo. Those stay in `tool-ideas.md`.

## Decision

Three small, structured tool groups, each replacing a recurring free-form `execute`/`pct_exec` pattern. All reuse existing plumbing; no new transport, store, or dependency.

### 1. systemd front door — `service_status` / `service_logs` / `service_restart`

A dedicated trio that builds the `systemctl`/`journalctl` invocation from **validated params** (`unit` charset-checked against a strict systemd-unit charset; `vmid?` targets an LXC via the existing `pct exec` plumbing). Tier **follows the target kind** exactly like `diff_config`/`revert_file` (`assertTargetTier`): a **host** unit ⇒ root (like `execute`), an **LXC** unit (`vmid` set) ⇒ companion (like `pct_exec`).

- **`service_status(unit, vmid?)`** → parsed `{active, sub, enabled, since, mainPid}` from `systemctl show -p ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,MainPID <unit>` (key=value output, trivially parsed — no `is-active` string-matching). Read-only, not audited.
- **`service_logs(unit, vmid?, lines?, since?)`** → bounded, **always-redacted** journal tail. This is literally `tail_log` with a `unit`-only contract: it **reuses `buildTailCommand`** and inherits `tail_log`'s validation (`since` accepts only ISO or `<n> (min|hour|day) ago`), the `tools.tailLinesCap` clamp, and the mandatory ADR-002 redaction pass. Behaviour parity with `tail_log` is the point — no new log path.
- **`service_restart(unit, vmid?)`** → confirm-gated mutation (`confirm?: boolean`, refused without it — a restart interrupts service), full ADR-004 audit row with honest `ExecResult` exit semantics propagated.

**The payoff is the structured audit object.** `{tool:"service_restart", unit:"nginx", vmid:105}` is the clean, parse-free record the ADR-010 UI and ADR-015 metrics want and a free-form `execute "systemctl restart nginx"` string can never be. This is the same "dedicated tool beats raw exec" move that justified the whole `docker_*`/`guest_*` family (ADR-016 most recently); systemd is the obvious remaining gap.

### 2. service probes — `tcp_ping` / `http_probe`

The structured **outcome** check that pairs with every lifecycle/deploy verb. `health_check` is fixed-probe and node-scoped; these are operator-directed at one endpoint. Read-only, not audited (like the other read tools).

- **`tcp_ping(host, port, timeoutMs?)`** → `{reachable, latencyMs}` — one TCP connect, no payload, from the **Windows host** (Node `net`, **zero node round-trip, zero credentials**).
- **`http_probe(url, expectStatus?, timeoutMs?, fromVmid?)`** → `{status, ok, latencyMs, bodyBytes}`. `expectStatus` turns it into an assertion (`ok:false` when the status misses). `fromVmid?` runs the probe **inside** an LXC via `pct exec` (`curl`/`wget`) so it can reach container-network-only services; **absent ⇒ probe from the Windows host directly** (no node round-trip).

**Tier follows where the probe runs** (the same target-kind logic): the host-side path uses no node credentials at all and sits at the **observe** floor; `fromVmid` escalates to **companion** (it shells `pct exec`), asserted on the param the way `assertTargetTier` asserts on the target. **Honest limit, surfaced in the result:** a host-side probe and an in-guest probe see different network namespaces — the response states which one ran (`from: "host" | "vmid:<n>"`).

### 3. content-addressed read — `search_file_regex`

The read-side analogue of `edit_file`'s find-and-replace front door (ADR-011) and the surgical-read tool ADR-017's budgeting doctrine implies but does not yet provide.

**`search_file_regex(path, pattern, context?, maxMatches?, vmid?, container?)`** → for each match, the matched line plus `context` lines above/below (a `grep -C` "balloon"): `[{lineNo, matchLine, before:[…], after:[…]}]`, capped at `maxMatches` with an explicit overflow marker. The regex is validated, the path goes through `validatePath`, and it **reuses the host/LXC/Docker read plumbing the `*_read_file` family already has** — `vmid`/`container` select the surface exactly as elsewhere. Tier **follows the target kind**: host path ⇒ root, `vmid` (LXC) ⇒ companion, `container` (Docker) ⇒ companion. Read-only, not audited.

`read_file`'s `offset`/`maxBytes` is a **blind byte window** — you must already know where to look. This is **content-addressed** windowing: find first, then return just the neighborhood. It extends ADR-017's output-budgeting doctrine to the case the byte window cannot serve.

## Scope boundaries

- **No new plumbing.** Every tool here is a structured shell over existing transport: `service_*` over `execute`/`pct_exec` + `buildTailCommand`; the probes over Node `net`/`http` (host) and `pct exec` (`fromVmid`); `search_file_regex` over the `*_read_file` read path. No new store, transport, dependency, or census probe.
- **Tier follows the target, not a fixed row.** `service_*` and `search_file_regex` resolve their min-tier by target kind via `assertTargetTier` (host ⇒ root, guest ⇒ companion), like `diff_config`/`revert_file`. The probes floor at observe (host-side, credential-free) and escalate to companion only on `fromVmid`. No tool here grants a capability the operator's tier didn't already imply.
- **Mutation surface is one tool.** Only `service_restart` mutates; it is confirm-gated and fully audited. `service_status`, `service_logs`, both probes, and `search_file_regex` are read-only. `service_logs` is always-redacted (it inherits `tail_log` wholesale, redaction included).
- **Not a sandbox.** `service_restart` reuses the ADR-004 denylist/confirm tripwire model; the structured-param surface is *narrower* than free-form `execute` (the unit name is charset-validated, the verb is fixed) but it is a tripwire, not isolation — consistent with the project's standing threat model.
- **Deliberately excluded backlog.** Circuit breaker (8 — needs session-state semantics), semantic history (9 — embedding dependency + ADR-006 write-path invariant), `index_path` (10 — non-existent external indexers) are out of scope and remain ranked in `tool-ideas.md`.

## Consequences

**Positive.** The three most common free-form `execute`/`pct_exec` patterns left after ADR-016 each get a dedicated, structured, quoting-safe tool. The audit log gains parse-free rows for service operations (a win for the ADR-010 UI and ADR-015 metrics, which today see only opaque `cmd` strings). The post-mutation "did it come back?" check finally has a tool, closing the loop on every lifecycle/deploy verb. `search_file_regex` extends the token-economy doctrine (ADR-011 §1 / ADR-017) to content-addressed reads — find-then-return-neighborhood instead of whole-file or blind window. All of it reuses existing plumbing, so the implementation is thin.

**Negative / cost.** Six new tool surfaces (three `service_*`, two probes, one search) — six `TOOL_MIN_TIER` rows, three of them resolved by target kind. The systemd-unit charset and the `since` grammar are small maintained validators (the latter shared with `tail_log`). The probes add a host-side network path (Node `net`/`http`) the server did not previously exercise, and a per-param tier escalation (`fromVmid`) that must be enforced the way `assertTargetTier` is.

**Honest limits.**
- **The probes see one namespace at a time.** A host-side probe and an in-guest (`fromVmid`) probe can disagree because they sit in different network namespaces — the result names which ran, but the caller must read it. A green host-side probe does not prove in-guest reachability and vice versa.
- **`service_restart` is a tripwire, not isolation.** The structured surface is narrower than `execute`, but a determined caller at the same tier can still restart the unit via `execute`/`pct_exec`; the value is the clean audit row and the confirm gate, not new containment.
- **`search_file_regex` is still bounded.** A pathological pattern or a huge file is capped by `maxMatches` + the read caps; like `read_file` it can refuse rather than stream unbounded output. The overflow marker is honest about truncation, not a pager.
- **systemd-only.** `service_*` targets systemd units; SysV/OpenRC guests fall back to `execute`/`pct_exec` as today.

## Implementation notes

- **`tools/serviceTools.ts`** — `service_status`/`service_logs`/`service_restart` handlers. Pure `systemctl show` key=value parser + unit charset validator in a `serviceHelpers.ts` (pure, unit-tested). `service_logs` calls the existing `buildTailCommand` with a `unit`-only contract; `service_restart` runs the existing confirm-gate + audit pipeline. Tier via `assertTargetTier(host⇒root, vmid⇒companion)`.
- **`tools/probes.ts`** — `tcp_ping`/`http_probe`. Pure host/port/URL validators + result shaping (unit-tested without a socket). Host-side path uses Node `net`/`http`; `fromVmid` builds a `pct exec curl`/`wget` invocation. `fromVmid` asserts companion. `from` field records the namespace.
- **`tools/searchFileRegex.ts`** — pure `grep -C` balloon command builder + output parser (lineNo/matchLine/before/after, overflow marker); reuses the `*_read_file` surface selection (host/`vmid`/`container`) and `validatePath`. Tier via target kind.
- **`tiers/registry.ts`** — six `TOOL_MIN_TIER` rows; `service_*` and `search_file_regex` join the `assertTargetTier` target-kind set; the probes floor at observe with a `fromVmid`⇒companion escalation check.
- **Registration** in `index.ts` filtered by `isToolEnabled` per the active tier (ADR-007), as for every tool.
- **Docs:** add the six tools to the CLAUDE.md tool table once implemented; tick `tool-ideas.md` items 5–7 with the ADR-020 forward pointer (mirroring the items 1–4 → ADR-016/017 convention).

## Implementation status (2026-06-22)

Implemented on branch `adr-020-raw-exec-gap-closers`; +30 unit tests across three new pure cores (`serviceHelpers` 9 / `probes` 12 / `searchFileRegex` 9) plus updated `registry.test.ts` per-tier snapshots. Full unit suite green — **1207/1207** (an `npm rebuild better-sqlite3` was needed first to clear a stale native-ABI mismatch in `nodeStore.test.ts`, NODE_MODULE_VERSION 115≠137, unrelated to this ADR). Typecheck + lint clean.

- **`service_*` (`tools/serviceTools.ts` + pure `serviceHelpers.ts`).** `buildServiceStatusCommand`/`buildServiceRestartCommand` (single-quoted, charset-guarded via the reused `validateUnitName`) + `parseServiceShow` (key=value → `{active, sub, enabled, since?, mainPid?}`; `MainPID=0`/empty timestamp collapse to undefined). `service_logs` delegates to `tailLogHandler` (full reuse — `buildTailCommand`, `since` grammar, line cap, mandatory redaction). `service_restart` is confirm-gated + audited (`AuditTool` gained `"service_restart"`, `hashScope: "unknown"`).
  - **Deviation (documented in the handler head-comment): the WHOLE trio follows `assertTargetTier`, including read-only `service_status`/`service_logs`.** The ADR Decision §1 states "tier follows the target kind" for all three, so a host unit ⇒ root even for a read — deliberately *stricter* than `tail_log` (which reads host journals at companion). The trio shares one tier story; `tail_log` remains the companion-tier host-journal escape hatch. This is the one judgement call where least-privilege (read-only ⇒ companion) was traded for the simpler uniform invariant the ADR specified.
- **Probes (`tools/probes.ts`).** Pure `validateProbeHost`/`parseProbeUrl`/`resolveTimeoutMs`/`buildCurlProbeCommand`/`parseCurlProbeOutput`/`evaluateHttpOk`. `tcp_ping` uses Node `net` (observe, host-only); `http_probe` uses Node `http`/`https` host-side and `pct exec curl` for `fromVmid` (companion, asserted at runtime via `tierAtLeast`). `from` records the namespace.
  - **Deviation: `fromVmid` is `curl`-only (no `wget` fallback).** The sketch said "(curl/wget)"; v1 ships `curl` and lets a missing/odd `curl` surface as an honest exit-error. **TLS is not verified** (host-side `rejectUnauthorized:false`, in-guest `curl -k`) — a homelab reachability/status check, not a trust check; stated in the tool description and the head-comment.
- **`search_file_regex` (`tools/searchFileRegex.ts`).** Pure `buildGrepCommand` (`grep -a -n -E -C <ctx> -m <max+1>`, single-quoted pattern+path) + `parseGrepContext` (indexes every emitted line by number, reconstructs each match's before/after from neighbors actually present — robust to grep's merged overlapping-context groups; `-m max+1` detects + flags overflow).
  - **Deviation (head-comment): `grep` runs REMOTELY (host shell / `pct exec` / `docker exec`), not by pulling the file to the host and matching client-side.** The ADR sketch said "reuses the `*_read_file` read plumbing"; we reuse the surface *selection* + `validatePath` + the container charset guard, but not the byte transfer. Running `grep` in place is strictly better for the dominant cost (only matched neighborhoods transit, never the whole file) and avoids adding a client-side regex engine / a fourth quoting layer. Trade-off: a dependency on `grep` in the target (universal on host/LXC; busybox images vary → honest exit-2).
- **Config (`config.ts`).** New `tools.*` caps: `probeDefaultTimeoutMs`(5000)/`probeMaxTimeoutMs`(30000); `searchDefaultContext`(2)/`searchMaxContext`(20)/`searchDefaultMaxMatches`(20)/`searchMaxMatches`(200), each with a matching env override.
- **Registry/registration.** Six `TOOL_MIN_TIER` rows (`service_*`+`search_file_regex` at companion with runtime `assertTargetTier`; `tcp_ping`/`http_probe` at observe); `registry.test.ts` per-tier snapshots updated. Registered in `index.ts` via the tier-gated `register` wrapper, each handler receiving `activeTier`.
- **Live smoke:** read-only `service_status`/`tcp_ping`/`http_probe`/`search_file_regex` calls against `proxlab` are available on request (not gated on the merge, per the Safety rule).
