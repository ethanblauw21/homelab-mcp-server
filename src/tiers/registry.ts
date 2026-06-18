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
  compose_redeploy: "companion",

  // ADR-011 — find-and-replace edit tools share their write surface's tier
  // EXACTLY: an edit's blast radius equals a write's (it produces a full new
  // file through the same pipeline), so pct/qm/docker edits are companion and
  // the host edit is root — identical floors to the matching *_write_file rows.
  pct_edit_file: "companion",
  qm_edit_file: "companion",
  docker_edit_file: "companion",

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
