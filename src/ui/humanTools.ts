/**
 * ADR-010 §5 — the human-tool registry. THE SAFETY-CRITICAL LIST.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ Adding a tool to this set is an ADR-LEVEL decision with a recorded         │
 * │ justification — NEVER a casual edit. The entire safety of ADR-010 §1's     │
 * │ reframe rests on this set staying tiny and never acquiring a general-      │
 * │ purpose actuator. The standing localhost UI may execute ONLY these tools;  │
 * │ every open-ended agent-principal tool (execute, *_write_file, *_exec,      │
 * │ guest lifecycle, snapshot rollback, …) is reachable EXCLUSIVELY through an │
 * │ MCP client session. Enforcement is registration-filtering (the executor    │
 * │ does not *have* the agent tools wired in), the same mechanism ADR-007 uses │
 * │ for tiers — not a runtime refusal.                                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Each entry is human-principal (a person, not the agent, is the actor) and has a
 * bounded blast radius. The old ADR-001 property — "no server without Claude" — is
 * exactly this property with the human set EMPTY; the new property parameterizes it.
 */
import { isToolEnabled, type Tier } from "../tiers/registry.js";

/**
 * The bounded set the standing UI executor may run. Deliberately four tools, all
 * read-mostly: the only state any of them mutates is the LOCAL client (the Merkle
 * baseline / the git mirror), never the node's running state.
 *
 * Held out of v1 (promotion is an ADR decision, never a config change):
 *  - `guest_start`/`guest_stop`/`guest_restart` — human-friendly, but they ACT on
 *    the node's running state, so they stay agent-gated until usage proves the
 *    button is missed (§5 "Borderline").
 *  - census refresh (`describe_homelab`) — read-only and safe, but DEFERRED so the
 *    registry's discipline is established from the smallest possible first set; the
 *    census panel is cached-only in v1.
 */
export const HUMAN_TOOLS = [
  "accept_truth",
  "verify_integrity",
  "compute_tree",
  "config_sweep",
] as const;

export type HumanTool = (typeof HUMAN_TOOLS)[number];

/** Per-entry justification (§5 table) — why each is human-principal AND bounded. */
export const HUMAN_TOOL_JUSTIFICATION: Record<HumanTool, string> = {
  accept_truth:
    "Human-principal by definition (a person blesses reviewed drift); blast radius bounded to a baseline the user is looking at.",
  verify_integrity: "Read-only drift report.",
  compute_tree: "Read-only baseline computation (mutates only the local node store).",
  config_sweep:
    "Bounded, hash-gated capture into the local git mirror; no arbitrary action and read-only against the node.",
};

/**
 * The agent-principal tools §1 explicitly forbids from the standing surface. This
 * is documentation + a test anchor: the executor must wire NONE of these, and a
 * snapshot test asserts the intersection with what the executor exposes is empty.
 */
export const EXCLUDED_AGENT_TOOLS = [
  "execute",
  "read_file",
  "write_file",
  "list_directory",
  "pct_exec",
  "qm_exec",
  "docker_exec",
  "pct_write_file",
  "qm_write_file",
  "docker_write_file",
  "guest_start",
  "guest_stop",
  "guest_restart",
  "guest_backup",
  "guest_backup_restore",
  "compose_redeploy",
  "snapshot_create",
  "snapshot_rollback",
  "snapshot_delete",
] as const;

export function isHumanTool(name: string): name is HumanTool {
  return (HUMAN_TOOLS as readonly string[]).includes(name);
}

/**
 * The human tools the executor may run at a given tier. A human tool still obeys
 * its ADR-007 tier floor: all four are companion-tier, so an observe/operate
 * install's executor exposes an EMPTY set (renderer-only in practice). This is the
 * §2 promise — "an observe install's executor's companion-only actions are simply
 * absent" — enforced by the same registry that gates the MCP server.
 */
export function humanToolsForTier(tier: Tier): HumanTool[] {
  return HUMAN_TOOLS.filter((t) => isToolEnabled(t, tier));
}
