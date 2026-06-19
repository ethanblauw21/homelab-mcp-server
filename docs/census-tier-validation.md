# Census tier-degradation validation (ADR-007 §6)

**Purpose.** Capture `describe_homelab` at each of the three non-root tiers
(observe / operate / companion) against the live node and confirm the
ADR-007 §6 tier-aware degradation behaves as designed:

- Below companion the census routes metadata through `NodeOps` (the API),
  so the **API-complete** sections stay populated: `node`, `storage`,
  `containers`, `vms`.
- The **exec-bound** sections cannot be read over the API and must report a
  structured `{ unavailableAtTier: "companion" }` rather than empty/removed:
  `network`, `services`, `tailscale`.
- The drift differ treats `unavailableAtTier` as **not observed**
  (suppresses the sub-diff), never as a deletion.

Node under test: **`proxlab` (`10.0.0.10`)**, PVE 9.2.3.

---

## Operational reality: this is a multi-session ceremony

`scripts/setup.mjs` finishes every run by re-registering the single `homelab`
MCP server (`claude mcp remove`/`add`) and printing **"Restart Claude Code to
activate."** A tier switch therefore requires a Claude Code restart, so the
three captures happen in **three separate sessions** — they cannot all be done
in one.

That's fine, because **every `describe_homelab` run auto-persists** to
`%LOCALAPPDATA%\claude-mcp\census\<ISO-timestamp>.json` (`saveSnapshot` defaults
true). The captures accumulate on disk and survive restarts; the final session
reads all three and diffs them.

Each tier mints its **own** token (`mcp@pve!mcp-<tier>`), so provisioning
observe/operate is **additive on the node** — it does not disturb the existing
companion token or the `MCPOperate` role. Only the Claude registration is
overwritten, and companion is restored cleanly at the end.

---

## Captures

| Tier | Token (`mcp@pve!…`) | Role | Snapshot file | Status |
|------|---------------------|------|---------------|--------|
| companion | `mcp-companion` | `MCPOperate` + root SSH | `2026-06-19T14-11-37-508Z.json` | ✅ captured (baseline) |
| operate   | `mcp-operate`   | `MCPOperate` (RBAC) | `2026-06-19T14-33-15-034Z.json` | ✅ captured; 403 ✅ |
| observe   | `mcp-observe`   | `PVEAuditor` (RBAC) | `2026-06-19T14-37-31-259Z.json` | ✅ captured; 403 ✅ |

> Fill in each snapshot filename from the `snapshotPath` in the tool result as
> you capture it.

---

## Runbook

Run from the repo root (`C:\Users\ethan\homelab\homelabMCPServer`). `dist/` is
already built at the current master tip; re-run `npm run build` first if you've
changed source since.

### 1. operate

```powershell
.\scripts\setup.ps1 -Tier operate -NodeHost 10.0.0.10
```

- `auto` mode prompts once for the node's root SSH password, then runs the
  `pveum` provisioning over SSH (creates/updates the `MCPOperate` role, mints
  the `mcp-operate` token, grants the ACL).
- Watch for **`[ok] privilege separation confirmed (privileged POST refused
  with 403)`** in setup's output — that is the live RBAC-enforcement proof for
  this tier; note it in Findings.
- **Restart Claude Code.** Then, in the new session, ask me to run
  `describe_homelab` at `full` depth and I'll record the `snapshotPath`.

### 2. observe

```powershell
.\scripts\setup.ps1 -Tier observe -NodeHost 10.0.0.10
```

- Same flow; grants `PVEAuditor` and mints the `mcp-observe` token. The 403
  negative test runs here too.
- **Restart Claude Code**, then capture as above.

### 3. Restore companion (working state)

```powershell
.\scripts\setup.ps1 -Tier companion -NodeHost 10.0.0.10 -RotateToken
```

- `-RotateToken` mints a fresh `mcp-companion` secret (the original secret is
  only shown at creation and was consumed at first setup). Companion setup also
  re-installs the SSH public key (idempotent) and re-pins TLS/host fingerprints.
- **Restart Claude Code** — back to the full companion toolset.

---

## Findings

_(To be completed once operate + observe captures exist.)_

Expected per ADR-007 §6 — at observe and operate:

- [ ] `node`, `storage`, `containers`, `vms` populated (API path).
- [ ] `network` → `{ unavailableAtTier: "companion" }`.
- [ ] `services` → `{ unavailableAtTier: "companion" }`.
- [ ] `tailscale` → `{ unavailableAtTier: "companion" }`.
- [ ] `errors: []` (degradation is structured, not an error).
- [ ] operate tools registered: `guest_start`/`guest_stop`/`guest_restart`;
      companion-only tools (`pct_*`/`qm_*`/`docker_*`/snapshots/…) **not**
      registered (filtered out, never visible).
- [ ] observe: only read-only tools registered; no lifecycle tools.
- [ ] `[ok] privilege separation confirmed` (403) recorded for both RBAC tiers.

### operate — captured 2026-06-19 (`2026-06-19T14-33-15-034Z.json`)

All expectations met:

- [x] `node` / `storage` / `containers` / `vms` populated via API
      (node 9.2.3, up 21d; 3 storages; CT 100 adguard-dns + 101 dockerBoss
      running; vms `[]`).
- [x] `network` → `{ unavailableAtTier: "companion" }`.
- [x] `services` → `{ unavailableAtTier: "companion" }`.
- [x] `tailscale` → `{ unavailableAtTier: "companion" }`.
- [x] `errors: []`, `redactions: 0`.
- [x] drift vs companion baseline = no changes — API sections match the
      companion capture; the three exec-bound sections are suppressed as
      *not observed* (not reported removed). Confirms the differ's
      `unavailableAtTier` rule end-to-end.
- [x] operate tools registered (10 total): observe read set
      (`describe_homelab`, `health_check`, `query_audit`, `list_backups`,
      `pct_list`, `qm_list`, `qm_agent_ping`) + `guest_start`/`guest_stop`
      (confirm-gated)/`guest_restart`. Companion tools (`pct_exec`,
      `qm_*`/`docker_*` exec+file, `snapshot_*`, `*_write_file`,
      `revert_file`, `tail_log`, `config_sweep`, integrity trio,
      `compose_*`, `guest_backup*`, `diff_config`) **absent** — filtered at
      registration, never visible to the model.
- [x] `[ok] privilege separation confirmed (privileged POST refused with
      403)` printed during setup — live RBAC-enforcement proof for operate.

No deviations.

### observe — captured 2026-06-19 (`2026-06-19T14-37-31-259Z.json`)

All expectations met:

- [x] census identical to operate: `node`/`storage`/`containers`/`vms` via
      API; `network`/`services`/`tailscale` → `{ unavailableAtTier:
      "companion" }`; `errors: []`, `redactions: 0`.
- [x] drift vs the operate capture = no changes (the only deltas across all
      three runs are live node load/mem/uptime, which the differ does not
      track as drift).
- [x] tool set drops to **7 read-only tools** — `describe_homelab`,
      `health_check`, `query_audit`, `list_backups`, `pct_list`, `qm_list`,
      `qm_agent_ping`. The three `guest_*` lifecycle tools (operate) are gone:
      the MCP client logged them disconnecting on the tier switch, and they
      are absent from the reconnected registration. No mutating tool of any
      kind is visible.
- [x] `[ok] privilege separation confirmed (403)` printed during setup —
      live RBAC proof for observe.

No deviations.

---

## Conclusion

ADR-007 §6 tier-aware census degradation and the tier-gated registration
model are **validated against the live node (`proxlab` / `10.0.0.10`)** across
all three non-root tiers:

- The census stays **structurally honest** below companion: API-complete
  sections are populated, exec-bound sections report `unavailableAtTier`
  rather than empty/removed, and the drift differ treats that as *not
  observed* (no false "removed" diffs across the three captures).
- **Registration filtering is the enforcement**, exactly as designed — tools
  above the tier are never visible (observe 7 → operate 10 → companion full),
  so there is nothing to refuse at runtime.
- **Proxmox RBAC backs the lower two tiers**: the `403 on a privileged POST`
  negative test passed for both operate and observe, proving the node itself
  refuses anything above the token's privileges — not just the MCP server.

No census or tier code changes were required; this was validate-and-document,
and the design held. Companion restored via
`setup.ps1 -Tier companion -NodeHost 10.0.0.10 -RotateToken`.

---

Deviations and surprises go here.
