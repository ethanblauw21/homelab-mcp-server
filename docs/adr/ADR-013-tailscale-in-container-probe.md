# ADR-013: Tailscale-in-Container Census Probe — Look Where Tailscale Actually Runs

**Status:** Accepted
**Date:** 2026-06-18
**Deciders:** Ethan
**Depends on:** ADR-001 (census), ADR-002 (redacted census / drift), ADR-007 §6 (tier-aware census, exec-bound sections), ADR-008 (Docker layer — `docker ps` / `docker exec` via `pct exec`)

## Context

`describe_homelab` returns `"tailscale": null` even when Tailscale is up and routing the homelab. The census tailscale probe runs exactly one command — `tailscale status --json` **on the Proxmox host** — and in a very common homelab topology there is no `tailscale` binary on the host at all: Tailscale runs as a **Docker container inside an LXC guest** (e.g. `tailscale/tailscale:latest` in guest 101), and other containers share its network namespace via `network_mode: service:tailscale` (the "Tailscale-in-Docker as the netns provider for a VPN-routed stack" pattern).

The result is actively misleading. The full census already *sees* the evidence — `services[101].docker` lists a running `tailscale/tailscale` container — while the top-level `tailscale` section is a flat `null`. An operator reading `null` reasonably concludes "Tailscale is down," when in fact it is running one layer down, on the node that actually matters. The probe gives **no indication of where it looked**, so `null` conflates three distinct states: *not installed*, *installed-but-down*, and *running, just not on the host*.

This is issue #22. It is a visibility bug, not a security one — the fix reads, it does not mutate.

## Decision

Extend the SSH-path tailscale probe from a single host check to a **host-first, then guest-scan** discovery, and replace the ambiguous `null` with a **structured, scope-labelled** result.

### 1. Host-first, container-fallback discovery

The probe resolves in order, stopping at the first hit:

1. **Host scope.** Run `tailscale status --json` on the host (unchanged). A parse success ⇒ `{ scope: "host", ... }`.
2. **Container scope.** If the host has no Tailscale, scan the **running** LXC guests (the rows the census already enumerates). For each, list its Docker containers (`docker ps`, guarded by `command -v docker`) and look for a Tailscale image/name (`findTailscaleContainer`, pure). On the first match, run `tailscale status --json` **inside that container** via `pct exec <vmid> -- docker exec <name> tailscale status --json` and return `{ scope: "container", vmid, container, ... }`.
3. **None.** If neither yields Tailscale, return a structured **absent** marker `{ scope: "none", reason }` — never a bare `null`. The reason names what was checked ("no host-level Tailscale; no Tailscale container found in running guests"), so the operator can tell *not present* from *down*.

### 2. Richer self summary

`parseTailscaleStatus` is extended to also surface the fields the issue asks for — **online state** (`Self.Online`) and **tailnet IPs** (`Self.TailscaleIPs`, the 100.64.0.0/10 CGNAT addresses) — alongside the existing `self` identity and `peerCount`. These are additive and optional; an older stored snapshot without them still parses. The summary carries `scope`/`vmid`/`container` so a consumer can see *where* the data came from.

### 3. Transport & tier boundary (unchanged doctrine)

The container fallback is **companion-tier work** — it uses `pct exec` + `docker exec`, the same SSH plumbing ADR-008 established (the daemon socket is never touched). Below companion (observe/operate, API path) the tailscale section already reports `{ unavailableAtTier: "companion" }` (ADR-007 §6) and **that is unchanged** — an API token cannot exec into a container, so the honest answer there remains "not observed at this tier," not a host-only probe. The new discovery lives entirely on the SSH census path.

### 4. Cost control — one `docker ps` per running guest, memoized

The scan reuses the same guarded `docker ps` the `services` section runs. To avoid paying for it twice when both sections are requested, the per-guest Docker listing is **memoized** (`getContainerDocker(vmid)`), shared between `services` and `tailscale`. The scan is bounded by the existing census budget (`runner.soft` respects `budgetMs`), stops at the first Tailscale container found, and skips stopped guests (a `docker ps` needs a running guest — the same rule as ADR-006 sweep).

### 5. Drift & redaction

- **Drift.** The drift differ already collapses non-`peerCount` shapes to "not observed" via `observed()`; a `{ scope: "none" }` marker has no `peerCount`, so it suppresses the tailscale sub-diff rather than reporting spurious churn — the same rule as the `unavailableAtTier` marker. A host↔container scope flip is not treated as drift (it is the same tailnet, observed from a different vantage); only `peerCount` continues to drive the tailscale drift line.
- **Redaction.** The summary carries identity + 100.x tailnet IPs + container name — no secrets (no auth keys, no node IPs beyond the CGNAT range). It flows through the existing redaction chokepoint unchanged.

## Consequences

**Positive.** The flagship homelab topology (Tailscale-in-Docker) is finally visible in the census; `null` no longer reads as "down." The three states (*absent* / *host* / *container*) are now distinguishable, and the operator learns the exact guest+container serving the tailnet. Online state + tailnet IPs answer the issue's "hostname, tailnet IP, online state" ask directly.

**Negative / cost.** When the host has no Tailscale, the probe now does up to one `docker ps` per running guest (memoized, budget-bounded, first-match-wins). This is strictly more node work than the old single host command — acceptable for a read-only census probe, and zero extra cost when host-level Tailscale exists (step 1 short-circuits).

**Honest limits.** The probe finds the **first** Tailscale container; a node running multiple tailnets reports one (documented, not silently dropped — the scan order is guest-id ascending). Detection is image/name based (`/tailscale/i`), so a Tailscale repackaged under an unrecognizable image name is missed and falls through to `{ scope: "none" }` — a false "absent," never a false "present."

## Implementation notes

- **Pure core (`censusParsers.ts`):** `parseTailscaleStatus` gains `online`/`tailnetIPs`; new pure `findTailscaleContainer(containers)`. `TailscaleSummary` gains optional `online`/`tailnetIPs`/`scope`/`vmid`/`container`; new `TailscaleAbsent = { scope: "none"; reason: string }`.
- **Thin shell (`describeHomelab.ts`):** host-first/container-fallback orchestration in the SSH `tailscale` block; `getContainerDocker(vmid)` memoizer shared with `services`.
- **Types (`censusTypes.ts`):** the tailscale section widens to `TailscaleSummary | TailscaleAbsent | null | Unavailable` (`null` kept for back-compat with stored snapshots).
- **No new tool, no new tier row, no new mutation surface.** This is a census-probe enrichment within the existing `describe_homelab` registration.
