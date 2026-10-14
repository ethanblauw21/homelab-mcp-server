/**
 * Permission tier registry (ADR-007 §1–2). The tier model is **data, not code** —
 * the same pattern as the census probe table. A tool declares its `minTier`; the
 * server registers only the tools at or below the configured tier, so the model
 * never sees a tool it is not allowed to run (there is nothing to refuse at
 * runtime — the attack surface for an absent tier is zero).
 *
 * Enforcement grades differ by tier and this is a documentation requirement, not
 * a footnote:
 *   - observe / operate  → **Proxmox RBAC** (API token only; the node refuses
 *     anything above the token's privileges regardless of a server bug or an
 *     injected prompt).
 *   - companion / root   → **MCP server** (registration filtering + the ADR-004
 *     denylist/confirm gates + the ADR-007 protected set — tripwires, not a
 *     sandbox: the credential *could* do more and the software chooses not to).
 */

export type Tier = "observe" | "operate" | "companion" | "root";

/** Strict superset ordering: each tier contains every tier below it. */
export const TIER_ORDER: readonly Tier[] = ["observe", "operate", "companion", "root"];

export function tierRank(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

/** True when `have` is at least `need` in the superset ordering. */
export function tierAtLeast(have: Tier, need: Tier): boolean {
  return tierRank(have) >= tierRank(need);
}

/**
 * Tool → minimum tier. The single source of truth consulted at registration
 * time (index.ts) and by tier-aware handlers. Adding a tool means adding a row
 * here; nothing else gates it.
 */
export const TOOL_MIN_TIER: Record<string, Tier> = {
  // observe — read-only, Proxmox-RBAC-enforced (query_audit/list_backups read
  // only local Windows state, so they are observe-safe by construction).
  pct_list: "observe",
  qm_list: "observe",
  qm_agent_ping: "observe",
  describe_homelab: "observe",
  health_check: "observe",
  query_audit: "observe",
  list_backups: "observe",

  // operate — guest lifecycle, Proxmox-RBAC-enforced via the API backend. These
  // are the API-native operate-tier guest controls (previously raw `execute`).
  guest_start: "operate",
  guest_stop: "operate",
  guest_restart: "operate",

  // companion — everything that needs the root SSH key (MCP-enforced).
  // Snapshot tools remain SSH-routed for now (the mcp-prefix protection, retention
  // eviction, and stop/rollback/restart orchestration live in the SSH handlers);
  // the ApiBackend already implements the per-guest snapshot endpoints, so moving
  // them to an operate-tier API path is a documented follow-up (ADR-007 §2 note).
  // diff_config / revert_file are registered here but a HOST target additionally
  // requires root (see assertTargetTier): their floor follows the target kind.
  snapshot_list: "companion",
  snapshot_create: "companion",
  snapshot_rollback: "companion",
  snapshot_delete: "companion",
  pct_exec: "companion",
  qm_exec: "companion",
  pct_read_file: "companion",
  pct_write_file: "companion",
  qm_read_file: "companion",
  qm_write_file: "companion",
  tail_log: "companion",
  diff_config: "companion",
  revert_file: "companion",
  config_sweep: "companion",
  // ADR-017 §4 — single-guest census. Reuses the same `pct config`/`pct exec`
  // (docker/units) probes as the companion-tier census internals, so it lands at
  // companion even though `describe_homelab` is observe (the whole-node census
  // degrades exec-bound sections below companion; describe_guest is exec-bound by
  // construction — config/docker/units all need SSH).
  describe_guest: "companion",

  // ADR-009 — the Merkle integrity forest reads file content (host SFTP / pct pull)
  // to fold L2/L3 hashes, so it sits at companion alongside the other content-reading
  // tools. All three are read-mostly: verify_integrity is read-only; compute_tree and
  // accept_truth only mutate the *local* node store (never the node).
  compute_tree: "companion",
  verify_integrity: "companion",
  accept_truth: "companion",

  // ADR-008 — the Docker layer rides the companion-tier `pct exec` plumbing; the
  // daemon socket is never exposed. A `docker` write target is companion-grade
  // via assertTargetTier (targetMinTier("docker") = "companion"), so revert_file /
  // diff_config / list_backups accept the kind without a separate row.
  docker_ps: "companion",
  docker_exec: "companion",
  docker_read_file: "companion",
  docker_write_file: "companion",
  docker_logs: "companion",

  // ADR-016 — Docker introspection. Three read-only, not-audited siblings of
  // docker_ps, all on the same companion `pct exec docker …` boundary (no new
  // transport/tier/mutation surface). docker_inspect redacts env values via the
  // shared module; docker_stats/compose_discover expose only metadata.
  docker_inspect: "companion",
  docker_stats: "companion",
  compose_discover: "companion",

  // ADR-008 §6 — outcome-level rollback. Snapshot-tier unification: every
  // service-affecting guest verb (snapshot_*, guest_backup*, compose_redeploy)
  // lands at companion/MCP-enforced, ONE enforcement story. vzdump is
  // API-expressible (and rides the API backend when configured), but the mcp-
  // archive-ownership boundary + retention + confirm gate are MCP-server tripwires
  // with no RBAC equivalent — so the tier floor stays companion even though ADR §6's
  // first draft floated operate. A destructive whole-guest restore must not sit
  // behind RBAC that is blind to the mcp- tag.
  guest_backup: "companion",
  guest_backup_restore: "companion",
  // H9/F9 — read-only archive inventory; same companion `NodeOps` reach as the
  // backup pair (and not audited, like the other read-only census/list verbs).
  guest_backup_list: "companion",
  compose_redeploy: "companion",

  // ADR-025 — container update workflow, on the same companion `pct exec docker …`
  // boundary as the rest of the Docker family. docker_restart + compose_update are
  // confirm-gated, audited mutations; image_updates is read-only and not audited.
  // compose_update's automatic re-tag rollback joins the ADR-021 breaker family.
  docker_restart: "companion",
  image_updates: "companion",
  compose_update: "companion",

  // ADR-012 — compose_preflight reads a compose file inside an LXC and probes
  // ports in the guest (pct exec/pull), exactly the Docker family's companion
  // reach; an observe-tier API token cannot exec in a container, so it would be
  // inert there. Read-only and NOT audited (like diff_config) — the agent-principal
  // companion floor is about credential reach, not whether the tool mutates.
  compose_preflight: "companion",

  // ADR-011 — find-and-replace edit tools share their write surface's tier
  // EXACTLY: an edit's blast radius equals a write's (it produces a full new
  // file through the same pipeline), so pct/qm/docker edits are companion and
  // the host edit is root — identical floors to the matching *_write_file rows.
  pct_edit_file: "companion",
  qm_edit_file: "companion",
  docker_edit_file: "companion",

  // ADR-020 §1 — systemd front door. Floor is companion (an LXC unit via pct exec);
  // a HOST unit additionally requires root via assertTargetTier (the whole trio,
  // including read-only status/logs, follows the target kind — one tier story).
  service_status: "companion",
  service_logs: "companion",
  service_restart: "companion",

  // ADR-020 §2 — reachability probes. Host-side by default (Node net/http, zero
  // credentials), so observe. http_probe's fromVmid runs inside an LXC via pct
  // exec and asserts companion at runtime; tcp_ping is host-only.
  tcp_ping: "observe",
  http_probe: "observe",

  // ADR-020 §3 — content-addressed regex read. Floor companion (LXC/Docker path
  // via pct/docker exec); a HOST path requires root via assertTargetTier.
  search_file_regex: "companion",

  // root — everything on the host (flag-gated; MCP-enforced).
  execute: "root",
  read_file: "root",
  write_file: "root",
  edit_file: "root",
  list_directory: "root",
};

export function isToolEnabled(tool: string, tier: Tier): boolean {
  const min = TOOL_MIN_TIER[tool];
  if (!min) return false; // unknown tool: never registered
  return tierAtLeast(tier, min);
}

/** The exact set of tools registered at a tier (sorted for stable snapshots). */
export function toolsForTier(tier: Tier): string[] {
  return Object.keys(TOOL_MIN_TIER)
    .filter((t) => isToolEnabled(t, tier))
    .sort();
}

/**
 * Target-kind tier rule for the two tools whose floor follows their target
 * (ADR-007 §2): a guest target is companion-grade, a host target is root-grade.
 */
export type TargetKind = "host" | "pct" | "qm" | "docker";

export function targetMinTier(kind: TargetKind): Tier {
  // Only host file ops are root-grade; every guest kind (pct/qm/docker) is
  // companion-grade (ADR-007 §2; ADR-008 adds docker at the same floor).
  return kind === "host" ? "root" : "companion";
}

/** Throw a structured tier error when a target's required tier exceeds `tier`. */
export function assertTargetTier(tool: string, kind: TargetKind, tier: Tier): void {
  const need = targetMinTier(kind);
  if (!tierAtLeast(tier, need)) {
    throw new Error(
      `${tool}: a ${kind} target requires the '${need}' tier, but the server is running at '${tier}'. ` +
        `Host-file operations are root-tier only (ADR-007 §2); raise the tier via setup + restart.`
    );
  }
}

// ---------------------------------------------------------------------------
// ADR-024 — startup tool allowlist. An operator-chosen subset INSIDE the tier:
// registered(tool) = isToolEnabled(tool, tier) && (no allowlist || listed). The
// allowlist can only remove tools, never add one above the tier. Read once at
// startup; there is no runtime path to change it (ADR-007's no-escalation rule,
// applied in both directions).
// ---------------------------------------------------------------------------

/** True when `tool` is registered: tier-enabled AND (no allowlist, or listed). */
export function isToolRegistered(tool: string, tier: Tier, allowlist?: readonly string[]): boolean {
  if (!isToolEnabled(tool, tier)) return false;
  return allowlist === undefined || allowlist.includes(tool);
}

/** The exact registered set at a tier under an optional allowlist (sorted). */
export function registeredTools(tier: Tier, allowlist?: readonly string[]): string[] {
  return toolsForTier(tier).filter((t) => allowlist === undefined || allowlist.includes(t));
}

export interface AllowlistCheck {
  /** Listed tools that exist but sit above the active tier (warn, never register). */
  aboveTier: string[];
}

/**
 * Validate an allowlist against the registry, fail-closed (ADR-024 §2): an empty
 * list or any unknown name is a STARTUP ERROR (a typo must never silently drop a
 * tool the operator thinks they enabled). Known tools above the tier are returned
 * for a stderr warning. `undefined` (unset) is the no-filter case and always passes.
 */
export function checkToolAllowlist(allowlist: readonly string[] | undefined, tier: Tier): AllowlistCheck {
  if (allowlist === undefined) return { aboveTier: [] };
  if (allowlist.length === 0) {
    throw new Error(
      "MCP_TOOL_ALLOWLIST is set but empty. An empty allowlist would register zero tools; " +
        "unset it for the full tier set, or list the tools to expose (comma-separated)."
    );
  }
  const known = Object.keys(TOOL_MIN_TIER);
  const unknown = allowlist.filter((t) => !(t in TOOL_MIN_TIER));
  if (unknown.length > 0) {
    const hints = unknown.map((u) => {
      const near = nearestNames(u, known);
      return near.length > 0 ? `${u} (did you mean ${near.join(" / ")}?)` : u;
    });
    throw new Error(
      `MCP_TOOL_ALLOWLIST names unknown tool(s): ${hints.join(", ")}. ` +
        "Refusing to start: a misspelled entry would silently drop a tool (ADR-024 §2)."
    );
  }
  return { aboveTier: allowlist.filter((t) => !isToolEnabled(t, tier)) };
}

/** Up to three known names within a small edit distance of `name` (typo hints). */
export function nearestNames(name: string, known: readonly string[]): string[] {
  const maxDist = Math.max(2, Math.floor(name.length / 4));
  return known
    .map((k) => ({ k, d: editDistance(name, k) }))
    .filter((x) => x.d <= maxDist)
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, 3)
    .map((x) => x.k);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
