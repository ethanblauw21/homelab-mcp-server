# ADR-010: Localhost UI Sidecar — Read-Mostly Dashboard & Human-Principal Actions

**Status:** Accepted — implemented 2026-06-14
**Date:** 2026-06-12
**Deciders:** Ethan
**Amends:** ADR-001's "only alive while a Claude client runs" property (reframed — §1; old property becomes a special case, not a contradiction).
**Depends on:** ADR-002 (census artifacts), ADR-005 (audit log, health), ADR-006 (config-history git), ADR-007 (tiers, registration-filtering), ADR-009 (Merkle drift report, `accept_truth`)
**Required by:** ADR-022 (the "no standing network-reachable surface fronting the server" property is why the semantic feed is **pull**, not push-from-this-server; the `healthSink`/`driftSink` sink-wiring pattern is mirrored by the `audit.db` projector sink)

## Context

Across ADRs 001–009 every server output became a clean structured artifact on the client (Windows host): census `inventory.json`, the audit JSONL, the Merkle drift report, health ok/warn/crit sections, the config-history git log, the backup store. The system is now, almost by accident, a fully-formed data model with no human-facing way to *see* it except through an AI agent relaying JSON.

Two distinct needs follow. First, **observability**: a person should be able to look at the lab's state — what guests exist, what drifted, what changed when — without prompting Claude. Second, and newer: ADR-009 introduced **human-principal tools** like `accept_truth`, whose entire intent is "a human reviewed this drift and blesses it." A button is a strictly better interface for that intent than a CLI invocation. Neither need existed when ADR-001 was written, which is why ADR-001's transport property — sound for its time — needs a principled update rather than a workaround.

Constraints settled in design discussion: **localhost-only** (no remote access — that reopens the tabled tunnel/exposure question and is explicitly out of scope); **read-mostly**, where the only actions are human-principal tools; **never a path for the UI to direct the AI or to run open-ended agent tools**; and **cheap** — the UI renders artifacts the system already emits, plus cached snapshots, so it never becomes its own project to maintain.

## Decision

### 1. Reframe ADR-001's standing-surface property (the foundation this ADR sits on)

**Why the original property existed.** ADR-001 chose stdio transport with no listening port: the server only runs while a Claude client runs, so the single trust boundary is the SSH private key on the Windows host. That choice is load-bearing — it is what makes "the default install has no inbound network surface fronting node credentials" true, the property that flipped the auth-model comparison in this project's favor against every surveyed alternative. At the time, **every capability was an AI-invoked tool**, so "no server without Claude" and "no standing actuation surface" were the *same statement*.

**Why it must change now.** Those two statements have come apart. ADR-009 created tools whose principal is the *human*, not the agent (`accept_truth` chief among them). The original property was always a *proxy* for the real goal — **no standing, network-reachable surface that fronts open-ended node actuation** — and clinging to the proxy after the goal shifted would block exactly the human tools this UI exists to expose. The mutation/read axis is also the wrong line (it would carve out `accept_truth`, a mutation, as an asterisk on the rule's most important case). The axis that holds is **principal**.

**The reformulated property:**

> A standing, human-facing process (the UI sidecar) may execute **only the bounded, enumerated set of human-principal tools** it was wired with — never the open-ended agent-principal tools (`execute`, `write_file`, `read_file`, `list_directory`, `pct_exec`, `qm_exec`, `docker_exec`, `*_write_file`, guest lifecycle, snapshot rollback/restore). The agent-principal tools remain reachable **exclusively through an MCP client session.**

**Why this is a principled evolution, not a convenient loosening.** The original property is a strict *special case* of the new one: "only while Claude runs" ≡ "the standing human-tool set is empty." The new property parameterizes the old; the old behavior falls out at zero registered human-tools. Enforcement is the **same registration-filtering mechanism ADR-007 already uses for tiers** — the UI's executor does not *refuse* `execute` at runtime, it does not *have* `execute` wired into the process, so the attack surface for agent tools through the UI is the same zero as for an absent tier. The guarantee is not weakened; it is bounded by the same machinery that always governed it.

**Two guardrails that keep the reframe safe (§5 expands):** the human-tool set is small and conservative, and **adding a tool to it is an ADR-level decision, never a casual registry edit**; and the standing process is localhost-only and still bounded by ADR-007's configured tier.

### 2. Architecture: a renderer, with a credential-light human-action executor

Two cleanly separated halves:

**The renderer (zero credentials, always available).** A localhost web UI that reads only client-side artifacts — it never touches the node and holds no SSH key or API token. It renders:
- **Census dashboard** — latest `inventory.json`: guests (status, snapshot-capability from ADR-008), storage (with the warn/crit thresholds), network, services, Tailscale.
- **Drift view (the flagship)** — the ADR-009 Merkle report: changed leaves, each tagged **explained** (with the audit id/tool/when) or **unexplained**, with `accept_truth` buttons inline (§3). Reviewing the drift and blessing it happen in the same view — the exact place a button beats a CLI.
- **Audit timeline** — the JSONL as a filterable feed (by tool, vmid, path, time, large-only, hash-scope), including the before/after hashes and `hashScope:"unknown"` markers.
- **Health board** — ok/warn/crit per section from the latest `health_check`.
- **Change feed** — the config-history git log (ADR-006).

**The cached-state model (the cheap observability trick).** The renderer shows the **last persisted snapshot** of anything tool-derived, labelled as such: *"Last census — 2026-06-12 21:30"* with a **"View last census"** action that loads the cached artifact, not a live run. This gives a full sense of the lab's state with **zero node access and zero credentials** — the common case (looking at recent state) costs nothing and is always available even with no Claude session and no executor running. A subtle, honest UI rule: tool-derived panels always show their snapshot timestamp, so the user is never misled into thinking a cached view is live.

**The human-action executor (bounded credentials, runs the enumerated set).** A minimal local component that *can* run the human-principal tools when the user clicks a live action (refresh census, run a verify, accept truth). It:
- is wired with **only** the human-tool registry (§5) — agent tools are not present in it, per §1;
- runs at the **ADR-007 configured tier** — it can never exceed what the install was provisioned for (an observe install's executor can refresh a census but the operate/companion-only actions are simply absent);
- binds **localhost only**;
- writes an **audit record for every action it executes**, identical to the MCP path — a button-press is as logged as a tool call (this preserves ADR-009's "truth changes are never silent" property for the auto/▸ manual accept paths alike).

When no executor is configured/running, the renderer still works fully (cached views); live-action buttons are disabled with a "start a session to run this" affordance, which *is* the original property in its empty-set form.

### 3. `accept_truth` as a first-class button (the motivating case)

In the drift view, each unexplained change (and any flagged-not-auto-accepted set from ADR-009's policy) carries an **Accept** control, scoped: accept this leaf, this subtree, or all currently-flagged. Clicking invokes `accept_truth { scope }` through the executor, which folds the baseline and writes the audit record. Explained changes are shown but not actionable (the audit log already authorized them; ADR-009 auto-folds them). This makes the review→bless loop a single screen instead of "read CLI report, mentally map paths, type accept command."

### 4. Stack: deliberately boring

Localhost-only and read-mostly means **no build pipeline, no SPA framework**. A single small static frontend (vanilla or a tiny no-build library) served by a minimal local HTTP layer, or — even cheaper — static files the server writes that a browser opens directly for the pure-renderer case. The bar: the UI must stay a *cheap sidecar*, never a maintained application. Any proposal that adds a bundler, a node_modules for the frontend, or a framework upgrade treadmill is out of scope by design.

### 5. The human-tool registry (the safety-critical list)

A dedicated, explicit registry — separate from the MCP tier registry — naming the tools the standing UI may execute, each with a one-line justification of *why it is human-principal and bounded*:

| Tool | Why standing-safe |
|---|---|
| `accept_truth` | Human-principal by definition (a person blesses reviewed drift); blast radius bounded to a baseline the user is looking at |
| `verify_integrity` | Read-only drift report |
| `compute_tree` | Read-only baseline computation |
| `config_sweep` | Bounded, hash-gated capture into the local git mirror; no arbitrary action |
| *(deferred) census refresh* | Read-only; safe, but see note |

**Explicitly excluded, and why:** every agent-principal tool (§1 list). **Borderline, held out of v1:** `guest_stop`/`guest_start`/`guest_restart` — human-friendly, but they *act on the node's running state*, so they stay agent-gated until usage proves the button is missed; promoting them is an ADR decision, not a config change. A `census refresh` live action is read-only and safe to include, but is listed cautiously so the registry's discipline (every entry justified) is established from the first tool.

**The hard rule:** adding any tool to this registry is an ADR-level change with a recorded justification. The entire safety of §1's reframe rests on this set staying tiny and never acquiring a general-purpose actuator. A comment at the head of the registry states this in the code itself.

## Options Considered

### Option A: Localhost renderer + cached-state + bounded human-action executor *(chosen)*
Pros: full observability with zero credentials in the common (cached) path; `accept_truth` as a button without exposing any agent tool; the security property strengthens into a cleaner, parameterized form enforced by existing machinery; cheap. Cons: the executor is a small standing surface holding bounded node access (mitigated: localhost-only, tier-bound, enumerated-tools-only, every action audited).

### Option B: Pure renderer, no executor (the strict empty-set property)
Rejected as the *only* option: it cannot offer `accept_truth` as a live button, which is the motivating feature. Retained as the **default sub-mode** — the renderer alone, with live buttons disabled — so the strict property is always available to users who want it.

### Option C: UI shells the full server / holds full credentials
Rejected: makes the UI a full second principal with the open-ended agent tools behind a localhost port — precisely the standing-actuation surface §1's reframe forbids. The enumerated-registry design exists specifically to avoid this.

### Option D: UI queues actions for the next Claude session to execute
Rejected: defeats the "button is easier/immediate" goal; the cached-renderer already covers the no-executor case more usefully.

### Option E: Remote/network-accessible UI
Out of scope: reopens the tabled exposure/tunnel decision; localhost-only is a hard constraint of this ADR.

## Security Model

- **§1 reframe is the spine:** open-ended agent tools are reachable only via an MCP session; a small enumerated human-tool set may run from the standing localhost UI, enforced by registration-filtering (the tool isn't in the process), not runtime checks. Old property = this property with the human-set empty.
- **Renderer holds no credentials** and cannot touch the node — the common path is credential-free by construction.
- **Executor is tier-bound (ADR-007) and localhost-bound**, runs only the §5 registry, and **audits every action** — a UI button-press leaves the same trail as a tool call (preserves ADR-009's no-silent-mutation guarantee).
- **Registry discipline is load-bearing:** additions are ADR-gated; the agent-tool exclusion is absolute; `guest_*` held out pending demonstrated need.
- No new caller-controlled command strings: the only inputs are bounded (a `scope` path for `accept_truth`, validated; selections from rendered lists).

## Consequences

- **Easier:** see the lab at a glance with no AI and no credentials; review-and-bless drift in one screen; the project gains a visual story (a drift timeline screenshot) that sells the safety thesis on GitHub better than prose.
- **Harder:** a second (small, localhost, bounded) process to run for live actions; the human-tool registry is now a security-critical list requiring ADR discipline; cached panels must always show their snapshot age to avoid implying liveness.
- **Property:** ADR-001's transport property is formally superseded by the §1 reframe; docs and ARCHITECTURE.md update to state the principal-based rule and that the old rule is its empty-set special case.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Human-tool registry | Unit (critical) | Exactly the §5 set is wired into the executor; **every agent-principal tool is absent** (registration-filtering proof, mirroring the tier-registry snapshot tests); `guest_*` absent in v1 |
| Executor tier binding | Unit | Executor cannot exceed configured tier; observe install ⇒ operate/companion actions absent |
| Action auditing | Unit | Every executor action writes an audit record identical to the MCP path; `accept_truth` via UI == via CLI in the log |
| Renderer credential-free | Unit | Renderer code path imports no SSH/API client; reads only client artifacts; functions with no executor present |
| Cached-state labelling | Unit | Tool-derived panels always carry a snapshot timestamp; "view last census" loads cache, never triggers a live run |
| Drift view → accept | Integration | Flagged unexplained change → Accept button → `accept_truth` folds baseline + audit record; explained changes non-actionable |
| Strict sub-mode | Unit | Renderer-only mode disables live buttons cleanly (the empty-set property) |

## Action Items

1. [x] Define the human-tool registry (`src/ui/humanTools.ts`) with per-entry justification + the head comment stating ADR-gated additions; wire the executor to it via registration-filtering. *(`HUMAN_TOOLS` = `{accept_truth, verify_integrity, compute_tree, config_sweep}`; `EXCLUDED_AGENT_TOOLS` test anchor; `humanTools.test.ts` pins the exact set + empty intersection with agent tools.)*
2. [x] Implement the executor: tier-bound (reuse ADR-007 config), localhost bind, audits every action, only the registry's tools present. *(`src/ui/executor.ts` — `humanToolsForTier(tier)` wiring; strict mode wires nothing and holds no creds; delegates to the same handlers as the MCP path for audit parity.)*
3. [x] Implement the renderer: census / drift / audit / health / change-feed panels over client artifacts; snapshot-age labels; works with no executor. *(`src/ui/artifacts.ts` — credential-free `ArtifactReader`, source-scan test enforces no SSH/API client import.)*
4. [x] Cached-state loading ("view last census" et al.) from persisted snapshots. *(`src/ui/snapshotStore.ts` generic `SnapshotStore<T>`; `health_check`/`verify_integrity` sinks wired in `index.ts` so agent runs feed the cache; census reuses the existing `CensusStore`.)*
5. [x] Drift view with inline scoped `accept_truth` controls (leaf / subtree / all-flagged). *(`src/ui/page.ts` — per-leaf Accept + Accept-ALL, gated on `canAct()`.)*
6. [x] Boring stack: minimal local HTTP layer + no-build static frontend; document the "stays a cheap sidecar" constraint. *(`src/ui/server.ts` built-in `http` + JSON endpoints; `src/ui/router.ts` flat dispatch; `page.ts` is one self-contained HTML string — no bundler, no frontend node_modules.)*
7. [x] Strict renderer-only sub-mode (live buttons disabled) as the default-safe option. *(`enableActions` defaults false; executor inert; router 403s every `/action/*`; UI hides buttons.)*
8. [x] Setup integration: optional "enable local UI" prompt; bind address fixed to localhost. *(`scripts/setup.mjs` prompt; `isLoopbackAddress` guard in `server.ts` refuses any non-loopback bind, fail-closed at startup.)*
9. [x] Docs/ARCHITECTURE.md: the §1 reframe (with the old-property-as-special-case explanation), the principal-based tool split, the registry-discipline rule. *(CLAUDE.md "Localhost UI sidecar (ADR-010)" section.)*

## References

- ADR-001 — the transport property this reframes (and why it existed)
- ADR-007 — registration-filtering and tier-binding, reused for the executor
- ADR-009 — `accept_truth`, the Merkle drift report, no-silent-mutation guarantee
- ADR-002/005/006/008 — the artifacts the renderer displays