# Homelab Inventory

> **🧹 CLEANUP TODO (committed deliberately for an agent handoff, 2026-06-10):**
> This file and `inventory.json` are committed **only** so they can be uploaded to
> another agent. They contain LAN IPs, MAC addresses, and infra layout — low
> sensitivity (no secrets; the census never reads in-guest secret material), but
> they don't belong in the repo long-term. **Once the handoff is done, remove both
> from version control** (delete, or move to a gitignored `local/` folder — the
> original quarantine approach) so the repo stops carrying a point-in-time census.
> They also go stale the moment the lab changes; re-run `describe_homelab` for fresh data.

> Generated from `describe_homelab` (depth: `full`) on **2026-06-10T23:44Z**.
> Source node `10.0.0.10` (PVE 9.2.3). Census redactions: **0**; probe errors: **none**.
> This is a generated census snapshot — re-run `describe_homelab` to refresh, and
> `describe_homelab(compareToPrevious: true)` to see drift against the last snapshot.

## ⚠️ Needs attention

- **`local` storage at ~80.1%** (80.8 / 100.9 GB) — at/over the 80% `health_check` warn threshold. Watch or prune.
- **`watchtower` (CT 101) is crash-looping** — reported `Restarting (1)` on consecutive census runs. The other 12 containers are healthy/up 11 days.

## Node

| Field | Value |
|-------|-------|
| Host | `10.0.0.10` (bridge `vmbr0`, gw `10.0.0.1`) |
| PVE | 9.2.3 |
| CPU | 8 cores |
| Memory | 16.4 GB (~3.9 GB used at census time) |
| ZFS | none (`no pools`) |

## Storage

| Pool | Type | Used | Total | Used % |
|------|------|------|-------|--------|
| `local` | dir | 80.8 GB | 100.9 GB | **~80.1%** |
| `local-lvm` | lvmthin | 142.7 GB | 374.5 GB | ~38.1% |

## Network

- **`vmbr0`** — `10.0.0.10/24`, port `nic0` (management bridge).
- Gateway `10.0.0.1`. Containers use static IPs on this subnet.
- `wlp0s20f3` (wifi) is DOWN; the `fwbr*/fwln*/fwpr*/veth*` interfaces are per-container firewall bridges.

## Guests

### LXC containers

| VMID | Name | Status | Cores | Mem | IP | Rootfs | Notes |
|------|------|--------|-------|-----|----|--------|-------|
| 100 | `adguard-dns` | running | 1 | 512 MB | `10.0.0.51/24` | 8 GB | unprivileged, `nesting=1` |
| 101 | `dockerBoss` | running | 2 | 4 GB | `10.0.0.52/24` | 140 GB | unprivileged, `nesting=1`, passthrough (below) |

**CT 101 `dockerBoss` passthrough / mapping** (from `pct config`):

- **GPU passthrough** — Ice Lake i7-1065G7 iGPU: `lxc.mount.entry` binds `/dev/dri/renderD128`; `lxc.cgroup2.devices.allow: c 226:128 rwm`.
- **VPN tunnel passthrough** (per the config description).
- **ID mapping** — `lxc.idmap: g 994 100994 64542` (bridging group 993).
- **AppArmor** — `unconfined`.
- **Bind mount** — host `/mnt/media` → container `/data` (`mp0`).

### VMs

None. The cluster currently runs **zero QEMU/KVM VMs** — the `qm_*` toolset is present but dormant until a VM exists.

## Services

### CT 100 `adguard-dns`
No Docker; no failed systemd units. (Runs AdGuard Home as the LAN DNS.)

### CT 101 `dockerBoss` — Docker stack (13 containers)

| Container | Image | Status |
|-----------|-------|--------|
| jellyfin | `jellyfin/jellyfin:latest` | Up 11 days (healthy) |
| flaresolverr | `ghcr.io/flaresolverr/flaresolverr:latest` | Up 11 days |
| radarr | `lscr.io/linuxserver/radarr:latest` | Up 11 days |
| gluetun | `qmcgaw/gluetun:latest` | Up 11 days (healthy) |
| qbittorrent | `lscr.io/linuxserver/qbittorrent:latest` | Up 11 days |
| prowlarr | `lscr.io/linuxserver/prowlarr:latest` | Up 11 days |
| jellyseerr | `fallenbagel/jellyseerr:latest` | Up 11 days |
| sonarr | `lscr.io/linuxserver/sonarr:latest` | Up 11 days |
| homepage | `ghcr.io/gethomepage/homepage:latest` | Up 11 days (healthy) |
| qnexus | `qnexus:local` | Up 11 days |
| tailscale | `tailscale/tailscale:latest` | Up 11 days |
| watchtower | `containrrr/watchtower` | **Restarting — crash-looping** |
| portainer | `portainer/portainer-ce:latest` | Up 11 days |

No failed systemd units on either container.

> **Note on Tailscale:** the host-level `tailscale` census slot is `null` — Tailscale runs *inside* CT 101 as a Docker container (above), not on the Proxmox host. Likewise, secrets (gluetun VPN creds, tailscale authkeys) live inside CT 101's filesystem, which the census deliberately never reads — that's why this inventory exposes only hypervisor-level metadata (MACs, LAN IPs, mounts) and has 0 redactions.
