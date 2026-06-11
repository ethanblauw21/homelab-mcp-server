import type { Tier } from "./registry.js";

/**
 * The root flag (ADR-007 §4). Root tier is **never selectable** via the tier
 * variable; it is enabled only by setting this exact acknowledgment string. Any
 * other value — including `true`, casing variants, or surrounding whitespace —
 * parses as disabled. There is no runtime escalation path (Option D, rejected):
 * raising the tier requires editing config + restarting the server.
 */
export const ROOT_ACK_STRING = "I-understand-Claude-gets-root-and-can-break-this-node";

export function parseRootFlag(value: string | undefined | null): boolean {
  return value === ROOT_ACK_STRING;
}

/**
 * Effective tier. The flag elevates an install to root; otherwise the configured
 * level (observe/operate/companion) stands. Root requires companion-grade
 * credentials (the root SSH key) — the setup script only sets the flag on a
 * companion install, and never sets it itself.
 */
export function resolveTier(
  level: "observe" | "operate" | "companion",
  rootEnabled: boolean
): Tier {
  return rootEnabled ? "root" : level;
}

/** The stderr warning banner emitted at every start while root tier is enabled. */
export function rootBanner(): string {
  return (
    "============================================================\n" +
    "  WARNING: ROOT TIER ENABLED (ADR-007 §4)\n" +
    "  Claude has full root capability on the Proxmox host: it can\n" +
    "  run arbitrary commands and read/write any host file. Every\n" +
    "  root-tier action is audited with rootTier:true. There is no\n" +
    "  runtime de-escalation — restart without the flag to drop root.\n" +
    "  The /etc/pve + cluster-membership protected set still applies.\n" +
    "============================================================"
  );
}
