# ADR-012: `compose_preflight` — static hazard analysis of a compose change before deploy

**Status:** Accepted
**Date:** 2026-06-17
**Deciders:** Ethan
**Depends on:** ADR-001 (SSH transport, path validation), ADR-004 (denylist/path validation, read caps, dryRun doctrine), ADR-007 (permission tiers, registration filtering, hybrid transport), ADR-008 (Docker layer — `pct exec` plumbing, `docker_ps`/`compose_redeploy`, the three-layer node→LXC→Docker topology)
**Relates to:** GitHub #19

## Context

The dockerBoss stack — and the shared-netns "one tailscale container, every service behind it" topology generally — has two failure modes that are **invisible until deploy time** and then surface only as a generic **HTTP 500** in Portainer, with no hint at the cause:

1. **Port collisions inside a shared network namespace.** Every service is attached to the `tailscale` container's netns via `network_mode: service:tailscale` (or `container:<id>`). They therefore share **one** port space: two services that listen on the same internal port silently conflict, and the loser fails to bind. This session, Dozzle defaulted to `8080` (already held by qBittorrent), and `8888`/`9999` were taken by gluetun's HTTP proxy; the working port (`9090`) was found only by hand-parsing `/proc/net/tcp` in the guest.
2. **Netns-provider recreate deadlock.** Any edit to the `tailscale` service's `ports:` (or its definition at all) forces Docker to **recreate** the provider container. That recreate cannot complete while the netns-dependent containers are still attached to the old sandbox — `docker compose up -d` wedges and Portainer returns the 500. The supported move is a full `down` → `up`, not an in-place update.

Both hazards are **predictable from the compose file** (and a cheap snapshot of what is actually bound in the guest) *before* anyone hits deploy. Today that knowledge is tribal — "remember the netns constraint, hand-check the ports" — and tribal knowledge is exactly what failed twice in one session.

This is the natural complement to **`compose_redeploy`** (ADR-008 §6): redeploy is the *actuator*, preflight is the *check you run first*. It also rhymes with the doctrine the rest of the server already follows — `dryRun`, `diff_config`, `verify_integrity`, `health_check`: **predict the bad outcome cheaply and read-only, before committing the expensive/destructive one.**

## Decision

Add **`compose_preflight`** — a **read-only, never-audited** tool that statically analyzes a proposed compose file against the running stack and returns a structured hazard report. It makes **no changes** and is the recommended step before `compose_redeploy` / `revert_file` on a stack.

### 1. Surface & inputs

```
compose_preflight({
  vmid: number,                 // LXC hosting the Docker daemon (ADR-008 topology)
  composePath: string,          // absolute path to the proposed compose file inside the LXC
  composeContent?: string,      // OPTIONAL: analyze this content instead of reading composePath
                                //   (lets the model preflight an edit it has in hand, pre-write)
  checkBoundPorts?: boolean,    // default true: cross-check declared ports against live bindings
})
```

- The **provider/dependent topology and the proposed ports come from the compose file** (read via the ADR-008 `pct pull` / bind-aware path, or taken directly from `composeContent`).
- The **currently-deployed compose** is read from the same `composePath` *as it exists on disk right now* when `composeContent` is supplied (so the diff is "proposed vs on-disk"); when only `composePath` is given there is no "previous" and the recreate check degrades to "provider touched at all ⇒ warn if dependents exist" (see §3.2).
- **Live bound ports** (`checkBoundPorts`) are read inside the guest with a read-only probe (`ss -tlnp` / `cat /proc/net/tcp*`, plus `docker ps --format` for the published map) — never a mutation.

### 2. The pure analyzer is the security- and correctness-critical core

Per the house invariant (**pure core, thin I/O shell**), all judgment lives in a pure module `tools/composePreflight.ts` with **no I/O**:

```ts
parseCompose(text): ComposeModel          // thin wrapper over the YAML parse → typed model
groupByNetns(model): NetnsGroup[]          // provider + its service:/container: dependents
detectPortCollisions(groups, declared): Hazard[]
detectNetnsRecreate(prev, next): Hazard[]
crossCheckBoundPorts(declared, bound): Hazard[]
analyzeCompose(next, prev?, bound?): PreflightReport   // the orchestrating pure fn
```

The thin handler (`composePreflightHandler`) does only I/O: validate inputs, fetch the compose text + the bound-port snapshot through the existing ADR-008 transport, hand structured data to `analyzeCompose`, return its report. Every threshold/rule is unit-testable against fixtures with zero SSH — the same discipline as `denylist.ts`, `healthEvaluators.ts`, `sweepPlanner.ts`.

### 3. The three checks

**3.1 Port collisions across a shared netns.** Build netns groups: a service with `network_mode: service:<p>` (or `container:<p>`) joins provider `<p>`'s group; the provider's own `ports:`/`expose:` belong to the group too (in this topology only the provider may publish — a dependent with its own `ports:` is itself an **error**, since published ports must live on the netns owner). Within each group, collect every declared internal/published port (`ports:` target side, `expose:`, and a small set of **well-known env hints** — `WEBUI_PORT`, `PORT`, `HTTP_PROXY_PORT`, etc.) and flag any port claimed by two services. Severity `error` for a hard duplicate, `warn` for an env-hint-derived one (lower confidence).

**3.2 Netns-provider recreate deadlock.** If the proposed change touches the **provider** service (its `ports:`, `image`, or any definition field) **and** the group has ≥1 dependent, flag a `netns-recreate` hazard: an in-place `up -d` will wedge. Recommendation: `compose_redeploy` will not suffice — do a full `down` then `up` (or stop dependents first). When a `prev` model is available (i.e. `composeContent` was supplied so we can diff against on-disk), the check is precise (only a real provider-field change fires); without it, the check is conservative (any preflight of a stack whose provider has dependents emits an `info` reminder of the constraint).

**3.3 Live bound-port cross-check.** When `checkBoundPorts`, compare each declared port against the ports actually bound in the guest **by a different container/process**. A requested port already held elsewhere is an `error` ("9999 is bound by gluetun"); this is what turns "guess and get a 500" into "told you so, pick another." Honest limit: this is a snapshot — a port free at preflight can be taken before deploy (TOCTOU). It narrows the failure window; it does not close it.

### 4. Output

A structured `PreflightReport` (never prose the model must re-parse — ADR-011 L-7):

```ts
{
  ok: boolean,                 // false iff any hazard.severity === "error"
  stack: { provider: string|null, services: string[], netnsGroups: {...}[] },
  hazards: Array<{
    kind: "port-collision" | "dependent-publishes" | "netns-recreate" | "port-bound-elsewhere",
    severity: "error" | "warn" | "info",
    services: string[],        // the service(s) involved
    port?: number,
    detail: string,            // human-readable, e.g. "8080 declared by both dozzle and qbittorrent"
    recommendation: string,    // the actionable fix
  }>,
  boundPortsChecked: boolean,  // false when checkBoundPorts was off or the probe was unavailable
}
```

### 5. Tier placement — companion, read-only (not the issue's "observe")

Issue #19 proposes **observe** ("pure analysis; makes no changes"). The *analysis* is indeed pure and read-only, but **tier in this server is about credential reach and registration, not about whether a tool mutates** (ADR-007). `compose_preflight` must **read a file inside an LXC and probe ports inside the guest** — that is exactly the companion-tier `pct exec` / `pct pull` reach the rest of the Docker family rides (`docker_ps`, `docker_logs`, `compose_redeploy`). An observe-tier credential (API token, Proxmox-RBAC-enforced) cannot exec inside a container, so the tool would be inert there.

**Resolution:** `compose_preflight` lands at **companion** (`TOOL_MIN_TIER`), alongside `compose_redeploy` and the `docker_*` family, and is **read-only and NOT audited** — the same class as `diff_config`, `query_audit`, `verify_integrity`, `tail_log`-style read tools. It reads; it never writes a backup, never appends an audit record, never touches the node's state. The "observe-grade" character the issue intends is preserved as **the pure analyzer**, which has no I/O and could back a future observe-tier or UI-sidecar surface that is *handed* the compose text + a port snapshot. (The ADR-010 UI sidecar's human-tool set is explicitly **not** extended here — `compose_preflight` is agent-principal and stays MCP-only; recorded so the §5/`humanTools.ts` safety list is not silently grown.)

This keeps the **one-enforcement-story** property of the Docker/compose family intact (ADR-008 §6): everything that reaches inside a guest is companion / MCP-enforced.

### 6. YAML parsing — add the `yaml` dependency, parse in the shell

Compose files are YAML; the server has no YAML parser today (deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `ssh2`, `zod`). Three options:

- **(a) Add `yaml`** (the `eemeli/yaml` package): pure-JS, no native build, well-maintained, spec-complete. Parse in the thin handler, hand the plain object to the pure analyzer.
- (b) Hand-roll a compose-subset parser. Rejected: YAML's edge cases (anchors, multiline scalars, flow vs block, quoting) are a footgun; a partial parser that silently mis-reads a service's `network_mode` would produce a *confidently wrong* preflight — worse than no tool.
- (c) Shell `yq` in the guest. Rejected: adds a guest-side dependency we don't control and moves parsing off the pure, testable core.

**Decision: (a).** `yaml` is pure JS (no `node-gyp`, unlike `better-sqlite3`), so it costs nothing on the Windows host and keeps parsing on the client where the pure analyzer can be fixture-tested. The parse is wrapped (`parseCompose`) so the analyzer sees a typed `ComposeModel`, never raw YAML — and a parse failure is a clean, structured refusal ("could not parse compose at `<path>`: <reason>"), never a thrown stack trace.

### 7. What it deliberately does NOT do (honest limits — a tripwire, not a proof)

- **It cannot see ports an app binds from inside its own code/config.** Detection is from what the compose file *declares* (`ports:`, `expose:`) plus a small known-env-hint table. A service that hardcodes a listener with no compose/env signal is invisible to check 3.1. This is the same "tripwire, not a sandbox" honesty as the denylist (ADR-004) — it raises the floor, it does not guarantee.
- **The bound-port snapshot is TOCTOU.** Free at preflight ≠ free at deploy (§3.3).
- **No autofix.** It reports and recommends; it never edits the compose file or picks a port. Remediation is a human/`edit_file` + `compose_redeploy` step, so the existing backup/audit/diff pipeline owns every actual change.
- **v1 is single-file, single-stack.** Cross-stack port contention on the same host netns, multiple providers, and `extends:`/`include:` resolution are out of scope and recorded as roadmap.

## Consequences

**Positive**
- Turns two recurring deploy-time 500s into a cheap, read-only, pre-deploy check — the doctrine the server already lives by (`dryRun`/`diff_config`/`verify`).
- Pairs with `compose_redeploy`: *preflight → redeploy → (on regret) `revert_file` → redeploy* is a complete, honest stack-change loop.
- All judgment is a pure, fixture-tested core; the node sees only read-only probes.

**Negative / costs**
- One new runtime dependency (`yaml`) — pure-JS, low risk, but a dependency nonetheless.
- The env-hint table is a maintenance surface (new images, new conventions) and is explicitly best-effort.
- Companion-tier, so it is unavailable below companion — but an observe-only deployment cannot exec inside a guest anyway, so there is no capability actually lost.

## Testing strategy

Per ADR-001 testing doctrine and the pure-core invariant, **unit tests first, against the pure analyzer**:
- `groupByNetns`: `service:`/`container:` providers, nested/transitive, a service with no netns (own bridge) excluded from a shared group.
- `detectPortCollisions`: hard duplicate (error), env-hint duplicate (warn), a dependent that declares its own `ports:` (the `dependent-publishes` error), no-collision clean pass.
- `detectNetnsRecreate`: provider `ports:` change with dependents (error/warn), provider change with **no** dependents (no hazard), non-provider change (clean), and the degraded no-`prev` conservative `info`.
- `crossCheckBoundPorts`: requested-port-already-bound (error), bound-by-self ignored, probe-unavailable ⇒ `boundPortsChecked: false`.
- `parseCompose`: malformed YAML ⇒ structured refusal; anchors/flow style parsed correctly.
- Handler tests over `FakeTransport`: fixture `pct pull` of a compose file + a fixture `ss`/`docker ps` snapshot → asserts the wired report; confirms **no audit record is written** and **no backup is created**.
- A `TOOL_MIN_TIER` registry test pinning `compose_preflight` at companion and asserting it is filtered out below companion (ADR-007 registration test pattern).

## Alternatives considered

- **Operator discipline** (remember the netns rule, hand-check ports): the status quo — it failed twice in one session. Rejected; the whole point is to encode the tribal knowledge.
- **A live "try it and roll back" deploy probe:** actually run `up -d`, catch the 500, `down`. Rejected — it *causes* the outage it is meant to prevent and burns a recreate; static prediction is strictly cheaper and safer.
- **Folding the checks into `compose_redeploy` as a mandatory pre-step:** rejected for separation of concerns — preflight is read-only/observe-grade and useful on its own (and pre-write, via `composeContent`); coupling it to the actuator would force companion-mutation semantics onto a pure check and prevent previewing an edit you have not written yet.

## Rollout

1. Add `yaml` to `dependencies`; scaffold `tools/composePreflight.ts` (pure) + `composePreflightHandler` (shell).
2. Unit tests green on the pure analyzer (the build-order §3 gate) before any handler wiring.
3. Register at companion in `tiers/registry.ts` (`TOOL_MIN_TIER`), add to the tool table in `CLAUDE.md`.
4. Handler + `FakeTransport` tests; confirm read-only (no audit/backup) by assertion.
5. Smoke against the dockerBoss compose file (read-only) — verify it reproduces the Dozzle `8080` collision and the tailscale-`ports:` recreate warning from this session.
