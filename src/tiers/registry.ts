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

  // root — everything on the host (flag-gated; MCP-enforced).
  execute: "root",
  read_file: "root",
  write_file: "root",
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
export type TargetKind = "host" | "pct" | "qm";

export function targetMinTier(kind: TargetKind): Tier {
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
