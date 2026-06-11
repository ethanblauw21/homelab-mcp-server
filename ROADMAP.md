# Roadmap

Deferred work from the ADR series, plus natural next steps. Nothing here is a commitment — this is a working homelab tool, not a product with a release schedule.

## Near-term

### Census and health at lower tiers

`describe_homelab` and `health_check` currently return `{ unavailableAtTier: "companion" }` for sections that require exec access: `network`, `services`, and `tailscale` in the census, and `units` and `guests` in the health check. These sections are exec-bound today because no equivalent API endpoint exists in the initial implementation.

The path forward is routing each section through `NodeOps` so it runs via the API backend at `observe` and `operate`. This completes the ADR-007 §6 design intent for tier-aware census and health.

### Snapshot tools at `operate` tier

Snapshots are companion-only today because the stop/rollback/start orchestration, `mcp-` prefix protection, and snapshot eviction run over SSH. The PVE API snapshot endpoints are already implemented and fixture-tested in `ApiBackend` — the groundwork is there.

Moving snapshot management to an API-native implementation would allow `snapshot_create`, `snapshot_list`, `snapshot_rollback`, and `snapshot_delete` to operate at the `operate` tier without requiring a root SSH key.

## Longer-term

### Config history push modes

The `push-lan` and `push-encrypted` modes exist in the config schema and the `GitEngine` push path, but are untested end-to-end against a real remote. Validating these — a LAN git server for `push-lan`, a remote with transport encryption for `push-encrypted` — would complete the ADR-006 off-host durability story.

### VM config in config history

VMs are intentionally excluded from the git mirror today: a VM exposes no descriptor-stable filesystem path through the hypervisor the way `pct` does for a container. A targeted alternative would be recording `qm config <vmid>` output as a synthetic target — not the guest filesystem, but the VM's configuration as Proxmox knows it.

### Integration tests against a real node

The Docker SSH harness covers transport-layer behavior. A real Proxmox node at `observe` tier would allow integration tests for the API backend, census, health check, and tier enforcement (including the 403 negative test) without requiring root or live VMs.

## Not planned

- Multi-node support
- Non-Proxmox hypervisors
- A web UI or daemon mode
- Runtime tier escalation (hard design exclusion — ADR-007 §4)
