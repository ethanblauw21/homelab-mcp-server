# Census snapshots — ADR-007 tier handoff

> **Short-term handoff artifact.** These three `describe_homelab` snapshots were
> captured for handing off to another AI agent. They are **not** part of the
> server's runtime state (the live store is `%LOCALAPPDATA%\claude-mcp\census\`)
> and should be **removed from git once the handoff is done** — see the
> `census-docs-cleanup-todo` note.

## What these are

Output of the `describe_homelab` tool run against the live Proxmox node
(`10.0.0.10`, PVE 9.2.3) at each of the three selectable ADR-007 permission
tiers, on 2026-06-11 (UTC). They demonstrate the tier-gated census model end to
end.

| File | Tier | Transport | Captured (UTC) |
|------|------|-----------|----------------|
| `observe-2026-06-11T01-50-54-734Z.json`   | **observe**   | API (`https`, PVEAuditor token) | 01:50:54 |
| `operate-2026-06-11T01-53-04-757Z.json`   | **operate**   | API (`https`, MCPOperate token) | 01:53:04 |
| `companion-2026-06-11T01-54-22-520Z.json` | **companion** | root SSH                          | 01:54:22 |

(Original filenames in the runtime store are the bare ISO timestamps; the tier
prefix was added here for the handoff.)

## How to read them (ADR-007 §6)

- **Below companion (observe/operate)** the census runs an **API-only** path:
  `node`, `storage`, `containers`, `vms` come back live, while the exec-bound
  sections (`network`, `services`, `tailscale`) carry a structured
  `{ "unavailableAtTier": "companion" }` marker instead of data.
- **At companion** the SSH path fills in everything, including the full network
  interface list and the in-guest docker stack under `services`.
- **observe and operate census content is identical** — `operate` adds the
  `guest_start`/`guest_stop`/`guest_restart` *tools*, not new census data.
- The `drift` block compares each snapshot to the previous one. Per §6, a
  section that was `unavailableAtTier` is treated as **not observed** — it never
  shows up as `removed`. (See the observe snapshot's `drift.network`, which is
  empty even though the prior full snapshot had a network section.)

## Node facts captured here

- PVE 9.2.3, 8 cores, ~16.4 GB RAM, no ZFS pools.
- Storage: `local` (dir) ~80.1% used (at the health warn line); `local-lvm` (lvmthin) ~38%.
- 2 LXC running: **100 adguard-dns**, **101 dockerBoss** (13-container docker stack).
- 0 QEMU VMs.
- Note: `watchtower` in CT 101 is crash-looping (`Restarting`).

## Known cosmetic transport differences

Tracked in **issue #12**: on the API path `node.version` is the full
`pve-manager/9.2.3/<hash>` string (SSH strips it to `9.2.3`), and `host` is `""`
(SSH sets `10.0.0.10`). Data is correct on both paths; only the field shape
differs.
