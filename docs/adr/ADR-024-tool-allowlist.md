# ADR-024: Startup Tool Allowlist — an Operator-Chosen Subset Inside the Tier

**Status:** Proposed — §1–§4 implemented 2026-10-13 (unit-tested); §5 setup prompt not yet built
**Date:** 2026-10-13
**Deciders:** Ethan
**Depends on:** ADR-007 (tiers, `TOOL_MIN_TIER`, registration filtering, "no runtime escalation"), ADR-010 (the human-principal executor set `humanToolsForTier`), ADR-006 (`config_sweep`'s conditional registration)
**Required by:** ADR-025 (new tools inherit the allowlist gate with no extra wiring)
**Source:** Operator feature request (2026-10-13): "a tool allowlist setting, read when the server starts, applied on top of the tier, so only the listed tools exist."

## Context

ADR-007 made the tier the unit of capability: four nested sets, chosen at setup, enforced by registration filtering. That granularity is coarse at exactly the tier where it matters most. **Companion** is one jump from "start/stop guests" to "~50 tools including `pct_exec`, `docker_exec`, every guest write, snapshots and vzdump restore." An operator who wants an agent that can *read Docker state and restart one container* has no way to say so — they get all of companion or none of it.

The registration gate already exists (`register` in `index.ts` short-circuits on `isToolEnabled(name, activeTier)`). The request is a second predicate on the same gate.

## Decision

### §1 The allowlist is an intersection, applied at registration

A new optional setting, `tier.toolAllowlist: string[] | undefined` (env `MCP_TOOL_ALLOWLIST`, comma-separated), read once at startup. The registration predicate becomes:

```
registered(tool) = isToolEnabled(tool, activeTier) && (allowlist === undefined || allowlist.has(tool))
```

- **Intersection only.** The allowlist can remove tools, never add them: a listed tool above the active tier stays unregistered. Tier remains the ceiling; the allowlist is a subset within it.
- **Startup-only, restart to change.** No runtime mutation path, no tool to edit it — the same "no runtime escalation, ever" exclusion as ADR-007 (and narrowing at runtime would just be the reverse door).
- **Pure core in `tiers/registry.ts`:** `parseToolAllowlist(raw) → {tools, unknown, empty}` and `isToolRegistered(tool, tier, allowlist)`; `toolsForTier` gains an optional allowlist argument so the snapshot tests cover the composed set.

### §2 Fail closed on ambiguity

| Input | Behaviour |
|---|---|
| Unset | No filter — the full tier set (today's behaviour, byte-for-byte). |
| Set to empty / whitespace | **Startup error.** "Zero tools" is never what someone meant; an empty server is indistinguishable from a broken one. |
| Contains a name not in `TOOL_MIN_TIER` | **Startup error** naming the unknown entries and the nearest known names. A typo must not silently drop a tool the operator thinks they enabled — nor, worse, be "fixed" later by a rename that silently adds one. |
| Contains a known tool above the active tier | **stderr warning** (one line, listing them), then continue. It is a legitimate config to keep one list across tier changes. |

The startup banner (`homelab-mcp v… | tier: …`) adds `| allowlist: N/M tools` when set, and the full registered list goes to stderr once.

### §3 Capability gates stay on the tier, not the allowlist

`index.ts` also calls `isToolEnabled` for non-registration purposes — e.g. `isToolEnabled("pct_exec", activeTier)` decides whether the SSH transport is handed to the revertibility check, and `isToolEnabled("verify_integrity", …)` decides whether to open the native SQLite store. These ask **"does the credential reach this?"**, not "is this tool exposed?". They keep calling `isToolEnabled` (tier-only). Only the `register` wrapper consults the allowlist. Concretely: the integrity store opens iff an integrity tool is *registered* (so a companion server allowlisted to Docker tools doesn't load `better-sqlite3`), while the revertibility probe keeps its tier gate (allowlisting `revert_file` without `pct_exec` must still be able to revert a container file).

`config_sweep`'s git-presence gate (ADR-006) composes as an AND: git missing ⇒ unregistered regardless of the allowlist.

### §4 The UI sidecar honours the same list

`humanToolsForTier(tier)` becomes `humanToolsForTier(tier, allowlist?)` — the ADR-010 executor wires only human tools that are also allowlisted. One operator setting, one meaning: a tool the operator excluded must not be reachable from a button either. The renderer half is unaffected (it reads artifacts, not tools).

### §5 Setup

`setup.mjs` gains an optional prompt after tier selection ("Restrict to a subset of tools? [N]"), offering the tier's tool list and a few named presets as starting points (e.g. `docker-operator`: `docker_ps`, `docker_inspect`, `docker_logs`, `docker_stats`, `docker_restart`, `compose_discover`, `image_updates`, `query_audit`). Presets are setup-time sugar that expand to an explicit list in the emitted env; the server only ever sees names.

## Scope boundaries

- **Not a deny-list.** Only an allowlist; "everything except X" invites the next added tool to slip through by default.
- **Not per-argument.** It does not narrow *what* a tool may target (e.g. "`docker_restart` only for container `sonarr`"). That is a different, larger feature (target scoping) and is out of scope.
- **Not per-session or per-principal.** One stdio process, one list.

## Consequences

**Positive.** Companion becomes usable as a narrow role without inventing new tiers. Zero runtime cost; new tools (ADR-025) are covered automatically because they pass through `register`.

**Negative.** A second knob to reason about when "why can't the model see tool X?" — mitigated by the startup stderr listing and the banner count.

**Honest limits.** This is **MCP-enforced, like companion itself** — it shrinks the *exposed* surface, not the credential's reach. A companion server allowlisted to `docker_ps` still holds a root SSH key; a server bug or a future registration path that bypasses `register` would not be stopped by Proxmox. It narrows what an injected prompt can *ask for*, which is the threat it addresses; it is not a sandbox. At observe/operate the allowlist is a convenience on top of RBAC, which remains the real boundary.

## Implementation notes

- `config.ts`: `tier.toolAllowlist` (zod `z.array(z.string()).optional()`), env parse in the existing loader; parse errors are startup errors.
- `tiers/registry.ts`: pure `parseToolAllowlist`, `isToolRegistered`, `toolsForTier(tier, allowlist?)`.
- `index.ts`: `register` uses `isToolRegistered`; the integrity-store gate switches to "any integrity tool registered"; the revertibility probe gate is unchanged.
- `ui/humanTools.ts`: allowlist parameter; `humanTools.test.ts` adds "allowlist can only shrink the set" and keeps the empty-intersection-with-agent-tools assertion.
- Tests: registry unit tests for each §2 row; a snapshot test of `toolsForTier("companion", preset)`; an index-level test that an allowlisted companion server registers exactly the list.
- `CLAUDE.md`: one line under the ADR-007 section.
