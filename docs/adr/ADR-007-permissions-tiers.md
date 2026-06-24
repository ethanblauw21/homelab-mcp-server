# ADR-007: Permission Tiers & Least-Privilege Transport

**Status:** Accepted (implemented 2026-06-10; §2 snapshot rehoming and §6 network/onboot deferred to API follow-up — see the implementation notes inline)
**Date:** 2026-06-10
**Deciders:** Ethan
**Supersedes:** ADR-001 §"root SSH by default" (partially — see Migration). ADR-001's tool-layer guardrail doctrine, backup/audit/revert pipeline, and stdio transport remain in force.
**Depends on:** ADR-002 (census), ADR-003 (snapshot tools, target descriptors), ADR-004 (pinned-trust pattern, denylist v2, confirm gate), ADR-005 (qm tools, toolkit)

## Context

ADR-001 deliberately granted root SSH because a single trusted operator managing one node needed open-ended capability, and tool-layer guardrails were an acceptable boundary for that audience. Two things changed: the project now aims at **other users**, and the v0.1 comparison review identified the auth model as the one column where API-based community servers decisively win. Shipping root-by-default to strangers is untenable; even for the original operator, most daily calls (census, health, status) never needed root.

The redesign goal: **least privilege by default, capability by explicit ceremony** — and wherever possible, enforcement by **Proxmox itself** (server-side RBAC) rather than by this codebase's guardrails (client-side tripwires).

Key technical facts shaping the design:
- Proxmox roles/ACLs (`pveum`) govern the **API only**; SSH bypasses them entirely.
- `pct`/`qm` and host file access require root over SSH — there is no lesser SSH credential that works.
- The PVE API has **no arbitrary-exec endpoint** — a feature: API-scoped tiers are *physically* incapable of shell access.
- API tokens support **privilege separation** (token privileges ⊆ user privileges), are stateless (static header per request; no tickets, no CSRF), and are individually revocable.

## Decision

### 1. Four tiers, each a strict superset of the one below

| Tier | Credentials present | Enforced by | Adds |
|---|---|---|---|
| **observe** *(default)* | API token only (auditor-grade) | **Proxmox RBAC** | All read-only tools |
| **operate** | API token (custom role) | **Proxmox RBAC** | Guest lifecycle + snapshots |
| **companion** | API token + root SSH key | **MCP server** (registration + guardrails) | Everything *inside guests* |
| **root** | Same as companion + env flag | **MCP server** (tripwires) | Everything on the host |

`observe`/`operate`/`companion` are selectable in setup; **root is never selectable** — it is enabled only via the acknowledgment flag (§4) on an existing companion install.

The enforcement-grade distinction is a documentation requirement, not a footnote: below companion, a server bug or injected prompt cannot exceed the token's privileges because the node refuses; at companion and above, the credential could do more and the *software chooses not to*. Docs and the setup script MUST state this plainly.

### 2. Tool → tier mapping

Tools declare `minTier` in their registration entry (data, not code — same pattern as the census probe table). **Tools above the configured tier are not registered at all** — the model never sees them; there is nothing to refuse at runtime.

| Tier | Tools registered |
|---|---|
| observe | `pct_list`, `qm_list`, `qm_agent_ping`, `describe_homelab` (tier-aware, §6), `health_check` (tier-aware), `query_audit`, `list_backups` *(both local-only)* |
| operate | + `guest_start`, `guest_stop`, `guest_restart` *(new tools — lifecycle previously required raw `execute`)* |
| companion | + `snapshot_list`, `snapshot_create`, `snapshot_rollback`, `snapshot_delete`, `pct_exec`, `qm_exec`, `pct_read_file`, `pct_write_file`, `qm_read_file`, `qm_write_file`, `tail_log`, `config_sweep`, `diff_config` (guest targets), `revert_file` (guest targets) |
| root | + `execute`, `read_file`, `write_file`, `list_directory`, `revert_file` (host targets), `diff_config` (host targets) |

Notes:
- `query_audit` and `list_backups` read only local Windows state — observe-safe by construction.
- `diff_config` and `revert_file` need to *read/write the live file*, so their minimum tier follows the target kind (guest ⇒ companion, host ⇒ root); a host-target request at companion returns a structured tier error.
- **Implementation note (snapshot tools land at companion, not operate):** ADR-003's snapshot handlers are deeply SSH-coupled — the `mcp-` prefix protection, retention eviction, and the stop→rollback→start orchestration all live in the SSH path with command-string-bound tests. `ApiBackend` already implements the per-guest snapshot endpoints (`createSnapshot`/`rollbackSnapshot`/`deleteSnapshot`/`listSnapshots`, fixture-tested), so moving them to an operate-tier **Proxmox-enforced** API path is a clean follow-up; until then they stay SSH-routed and therefore **companion-tier**. The operate tier's API-native capability is delivered by the three new lifecycle tools instead. The `mcp-` prefix rule and confirm gate are unchanged.
- All ADR-004 guardrails (denylist v2, confirm gate, caps) apply unchanged wherever exec/file tools exist.

### 3. Hybrid transport: the transport follows the tool, not the tier

A domain-level interface replaces direct transport coupling for guest/node operations:

```ts
interface NodeOps {  // illustrative, not exhaustive
  listGuests(): Guest[]
  guestStatus(vmid): GuestStatus
  guestConfig(vmid): Record<string,string>
  startGuest(vmid) / stopGuest(vmid) / restartGuest(vmid)
  snapshot(vmid, name, note?) / rollback(...) / deleteSnapshot(...) / listSnapshots(vmid)
  nodeStatus() / storageStatus() / networkConfig() / aptUpdates()
}
```

Two backends:
- **`ApiBackend`** — Node built-in `https` against `https://<host>:8006/api2/json/...` with `Authorization: PVEAPIToken=<id>=<secret>`. (Implementation note: `undici`/global `fetch` is not resolvable on this Node 20 build, and `https.request` is what carries the pinned-TLS agent cleanly anyway — see `apiClient.ts`.) The transport is injected as an `ApiHttp` function so unit tests use recorded fixtures, not the network. Returns structured JSON: the text parsers for `pct list`, `qm list`, `pvesm status`, etc. are **not needed on this path**.
- **`SshBackend`** — wraps the existing exec + parsers (kept for companion+ fallbacks and for anything API-less).

Routing rule: every operation `NodeOps` can express rides the **API backend at every tier** (even root) — SSH is used only for what only SSH can do (exec, arbitrary files, in-guest probes). `SshTransport` and its pipeline (ADR-003/004) are unchanged underneath.

**TLS trust:** the API connection reuses ADR-004's pinned-trust design verbatim — explicit cert-fingerprint pin (captured at setup), TOFU store as fallback, fail closed on mismatch, no silent `rejectUnauthorized: false` anywhere. Implemented as one shared `pinnedTrust` module with two consumers (SSH host key, API TLS cert).

**Statelessness:** unchanged and now uniform — every command is an independent API request or SSH exec channel; no session, no cwd, no env persistence between calls. API tokens (not tickets) keep the API side free of session machinery.

### 4. The root flag

- Env: `MCP_HOST_ROOT_ENABLED` — value must equal the exact acknowledgment string
  `I-understand-Claude-gets-root-and-can-break-this-node`.
  Any other value, **including `true`**, parses as disabled.
- Requires a server restart to take effect; there is **no runtime escalation path** — no tool, flag, or conversational mechanism can raise the tier of a running server (a runtime escalation prompt is a social-engineering surface aimed directly at the model; this is a hard design exclusion, see Option D).
- While enabled: a warning banner on stderr at every server start; every audit record produced by root-tier tools carries `rootTier: true`.
- **Protected set (absolute):** destructive operations against `/etc/pve` and cluster membership (`pvecm` destructive verbs, node add/remove, `rm`/`mv`/truncation targeting `/etc/pve`) are **DENY-tier with no confirm bypass at any tier including root**. Recovering a node's identity is always a human action. This is enforced at the guardrail layer and honestly documented as a tripwire, not a permission.

### 5. Setup script (one-time ceremony, supersedes `generate-ssh-key.ps1` + `install-proxmox-key.sh`)

One `setup.ps1` with a bootstrap fork:
- **Auto path:** one-time `ssh root@node` (password auth) runs provisioning remotely.
- **Paste path:** the script emits a single bash blob for the Proxmox web shell; the blob prints the values (token secret, both fingerprints) the user pastes back. No root password ever touches the Windows side.

Tier-conditional provisioning (idempotent; re-run = tier change):
- *observe:* `pveum user add mcp@pve` → ACL with auditor-grade role → token with `--privsep 1`. No keypair generated.
- *operate:* + create/update the custom role (`VM.PowerMgmt`, `VM.Snapshot`, `VM.Audit`, `Sys.Audit`, `Datastore.Audit`, …) and re-grant.
- *companion:* + Ed25519 keypair, `authorized_keys` install.
- *root:* no provisioning — flag-only on a companion install; the script never sets it and mentions it only in the warnings section.

Setup-time trust capture: SSH host-key fingerprint **and** API TLS cert fingerprint are pinned during the ceremony (strictly better than TOFU: zero unverified connections ever).

Verification before success is declared:
1. API smoke (`GET /version` with the token).
2. **Negative test:** deliberately call one endpoint *above* the configured tier and require a 403 — proving privilege separation is enforcing, not just configured.
3. (companion) SSH smoke against the pinned host key.
4. Emit the `claude mcp add` registration with the tier's env set.

**Downgrade deprovisions:** moving below companion removes the `authorized_keys` line, deletes the local private key, and (paste path) emits the removal blob. Token rotation is offered on every re-run. A least-privilege system that orphans root keys on downgrade is not one.

### 6. Census & toolkit tier-awareness (amends ADR-002 / ADR-005)

- Census sections resolve per tier: `node`, `storage`, `containers`, `vms` are **API-complete at observe** (served through `NodeOps` — `nodeStatus`/`storageStatus`/`listGuests`); `services` and `tailscale` require exec and report `{ unavailableAtTier: "companion" }` below it — a structured status, never an error.
  - **Implementation note (network is exec-bound, not API-complete):** the network section parses `/etc/network/interfaces` (bridge ports) which has no token-grade API equivalent in `NodeOps` today, so it also reports `unavailableAtTier: "companion"` below companion. Adding a `networkConfig()` method backed by `GET /nodes/<node>/network` would make it API-complete — a documented follow-up. `depth: "full"` per-guest configs are likewise an SSH/agent capability; the API census is summary-grade.
- `health_check` likewise: at observe the API path serves `node` (load/memory) and `storage` (PVE stores); `units`, `guests`, and `updates` all report `unavailableAtTier: "companion"`. **Implementation note:** the failed-systemd-units check (`units`) is exec-bound; onboot-vs-status detection (`guests`) needs `/etc/pve/*.conf` (the onboot flag is not in the API guest list); and `updates` is **not API-readable with a tier token** — `GET /nodes/<node>/apt/update` requires `Sys.Modify` (the read refreshes the apt cache), which the observe/operate roles deliberately lack, so it always 403s (confirmed live against proxlab, 2026-06-24). Earlier drafts wired it through `aptUpdates()` and it surfaced a recurring section error on every below-companion call; companion reads pending updates via SSH `apt-get -s` instead. ZFS and per-filesystem `df` usage have no token-grade API and are simply omitted (not errors).
- The drift differ treats `unavailableAtTier` as "not observed," never as "removed": when the *newer* snapshot did not observe a section, its sub-diff is suppressed entirely (no spurious "every interface removed").

## Options Considered

### Option A: Four tiers, hybrid API+SSH, fully separate enforcement per tier *(chosen)*
Pros: node-enforced security for the default and operate installs ("the default install contains no SSH key" is a story no surveyed community server can tell); JSON kills parsers on the API path; tiers are honest about their enforcement grade. Cons: two backends to maintain; API tests need recorded fixtures + real-host smoke (PVE API isn't Docker-trivial like OpenSSH).

### Option B: SSH everywhere + setup-generated sudoers per tier
Pros: one transport. Cons: sudoers allowlists are escape-prone (any allowed command that can shell out defeats them); enforcement stays client-adjacent; ADR-001 rejected this shape for good reasons and the tiering doesn't fix its core fragility. Rejected.

### Option C: API-only server
Pros: strongest possible enforcement story. Cons: amputates companion/root — arbitrary exec and file access are the project's founding requirement (ADR-001 Option C redux). Rejected.

### Option D: Runtime tier escalation (per-call confirm to temporarily elevate)
Rejected as a hard design exclusion: an in-conversation escalation mechanism is a standing social-engineering target; escalation must require leaving the conversation (re-run setup, or edit config + restart).

## Security & Audit Model

- Two enforcement grades, stated everywhere: **Proxmox-enforced** (observe/operate — blast radius capped by the node regardless of server bugs or prompt injection) and **MCP-enforced** (companion/root — registration filtering + denylist v2 + confirm gates + the protected set, i.e. tripwires).
- Registration-time filtering shrinks the attack surface to zero for absent tiers: unregistered tools cannot be socially engineered.
- Credentials are minimal per tier and individually revocable (token via `pveum`, key via `authorized_keys`); downgrade actively deprovisions.
- The shared `pinnedTrust` module gives both channels the same fail-closed trust model; setup-time pinning eliminates the TOFU window entirely for script users.
- The acknowledgment-string flag, restart requirement, stderr banner, and `rootTier` audit marking make root-tier operation deliberate, visible, and attributable.

## Consequences

- **Easier:** safe-by-default distribution; the comparison table's auth column flips in this project's favor while the capability ceiling is retained; API-path tools lose their text parsers; lifecycle gets first-class tools instead of raw `execute`.
- **Harder:** two backends; API test strategy (recorded fixtures + smoke) is new; docs must carry the enforcement-grade honesty and the tier-change friction ("re-run setup" instead of a runtime prompt — friction is the feature).
- **Migration:** existing installs (root SSH, no tier config) map to **companion + root flag unset ⇒ effectively companion**; to regain current behavior, the operator sets the acknowledgment flag. The setup script detects a legacy config and offers the migration. This is a deliberate, documented behavior change.

## Testing Additions (extends TESTING-STRATEGY)

| Area | Type | Notes |
|---|---|---|
| Tier registry | Unit (critical) | Per-tier registration snapshots: exactly the mapped tools, nothing above; target-kind tier errors for `diff_config`/`revert_file` |
| Flag parsing | Unit | Exact acknowledgment string ⇒ enabled; `true`, casing variants, whitespace ⇒ disabled; banner emitted; `rootTier` on audit records |
| `ApiBackend` | Unit | Recorded-fixture client tests per endpoint (status, lifecycle, snapshots, apt); token header construction; error mapping (401/403/5xx structured) |
| `pinnedTrust` | Unit + Integration | Shared module: pin match/mismatch/TOFU for both SSH and TLS consumers; fail-closed on mismatch |
| Privsep enforcement | E2E (manual + scripted) | Setup verification's 403 negative test; per-tier real-host smoke: observe cannot start a guest, operate cannot exec |
| Census/health tier-awareness | Unit | `unavailableAtTier` sections at observe/operate; differ treats them as not-observed |
| Setup script | Manual + dry-run mode | Idempotent re-run, tier upgrade, downgrade deprovisions key, token rotation, paste-path blob round-trip |
| Protected set | Unit (critical) | `/etc/pve` + `pvecm` destructive fixtures DENY at every tier incl. root; no confirm bypass |

## Action Items

1. [x] Extract `pinnedTrust` as a shared module (`src/trust/pinnedTrust.ts`; consumers `ssh/hostKey.ts` + `trust/tlsPin.ts`).
2. [x] Define `NodeOps` (`src/node/nodeOps.ts`) with `SshBackend` (behavior-neutral wrapper of the existing parsers).
3. [x] Implement `ApiBackend` (`https.request` not `fetch`, token auth, pinned-TLS agent, 401/403/5xx error mapping) with recorded fixtures (`apiBackend.test.ts`).
4. [x] Implement the tier registry (`src/tiers/registry.ts`, `minTier` per tool, registration-time filtering in `index.ts`) + the three lifecycle tools.
5. [x] Implement the root flag (`src/tiers/rootFlag.ts`: acknowledgment parsing, banner, `rootTier` audit field) and the protected set as DENY-tier entries.
6. [ ] Build `setup.ps1` (bootstrap fork, tier provisioning, dual pinning, 403 verification, deprovisioning, legacy migration); retire the two old scripts with pointers. *(in progress)*
7. [x] Census/health tier-awareness (`unavailableAtTier`) — `describeHomelab.ts` + `healthCheck.ts` API path; differ suppression in `censusDrift.ts`. (network/onboot deferred — see §6 notes.)
8. [ ] Documentation pass: tier table with enforcement grades, migration guide, root-flag warnings.
9. [x] CLAUDE.md invariants updated: tools depend on `NodeOps`/`SshTransport` interfaces; tier registry is data; no runtime escalation, ever.

## References

- ADR-001 — superseded §root-by-default; retained doctrine
- ADR-004 — pinned-trust pattern (shared), denylist v2, confirm gate
- ADR-002/003/005 — census sections, snapshot tools, qm tools rehomed onto tiers
- Proxmox docs — `pveum`, API tokens & privilege separation, role privileges, snapshot/lifecycle/apt endpoints