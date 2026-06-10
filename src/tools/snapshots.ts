import { shQuote, parsePctStatus } from "./pctFiles.js";

/**
 * Snapshot guard primitives. The hard rule: the server only ever manages
 * snapshots it created, identified by the reserved `mcp-` name prefix. Anything
 * without that prefix is human-made and invisible to retention / un-targetable
 * by rollback and delete.
 */

export const MCP_SNAPSHOT_PREFIX = "mcp-";

export type GuestType = "pct" | "qm";

export interface SnapshotInfo {
  name: string;
  description: string;
  mcpManaged: boolean;
}

export function isMcpSnapshot(name: string): boolean {
  return name.startsWith(MCP_SNAPSHOT_PREFIX);
}

/**
 * Constrain a name to Proxmox's snapshot charset ([A-Za-z0-9_-], leading
 * letter). Server-generated names are already valid; this is belt-and-braces.
 */
export function sanitizeSnapshotName(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_-]/g, "-");
  if (!/^[A-Za-z]/.test(s)) s = `s${s}`;
  return s.slice(0, 40);
}

/**
 * `mcp-<compact-UTC-ts>`, e.g. `mcp-20260609-213000`. UTC keeps it deterministic
 * for tests and collision-resistant at one-second granularity.
 */
export function generateSnapshotName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const ts =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return sanitizeSnapshotName(`${MCP_SNAPSHOT_PREFIX}${ts}`);
}

/**
 * Parse `pct listsnapshot` / `qm listsnapshot`. The output is a small tree; we
 * strip the drawing characters, take the first token as the snapshot name, and
 * keep the remainder as the description. The `current` pseudo-node ("You are
 * here!") marks HEAD, not a snapshot, and is skipped.
 */
export function parseSnapshotList(output: string): SnapshotInfo[] {
  const out: SnapshotInfo[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/[`|]/g, " ").replace(/->/g, " ").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const name = parts[0];
    if (!name || name === "current") continue;
    out.push({
      name,
      description: parts.slice(1).join(" "),
      mcpManaged: isMcpSnapshot(name),
    });
  }
  return out;
}

/**
 * Retention planner (pure). Given the existing `mcp-` snapshot names for a guest,
 * the per-guest cap, and how many snapshots are about to be created (default 1),
 * return the oldest names to delete so the post-create count stays within cap.
 * Names embed sortable timestamps, so lexical sort is chronological. Non-`mcp-`
 * names must never be passed in — they are never eligible for eviction.
 */
export function planSnapshotEviction(mcpNames: string[], cap: number, incoming = 1): string[] {
  const sorted = [...mcpNames].sort();
  const allowed = Math.max(0, cap - incoming);
  if (sorted.length <= allowed) return [];
  return sorted.slice(0, sorted.length - allowed);
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export function buildGuestStatusCommand(type: GuestType, vmid: number): string {
  return `${type} status ${vmid}`;
}

export function buildGuestStopCommand(type: GuestType, vmid: number): string {
  return `${type} stop ${vmid}`;
}

export function buildGuestStartCommand(type: GuestType, vmid: number): string {
  return `${type} start ${vmid}`;
}

export function buildSnapshotListCommand(type: GuestType, vmid: number): string {
  return `${type} listsnapshot ${vmid}`;
}

export interface SnapshotCreateOpts {
  description?: string;
  /** A3.2 — only meaningful for `qm`; includes RAM state when true. */
  vmstate?: boolean;
}

export function buildSnapshotCreateCommand(
  type: GuestType,
  vmid: number,
  name: string,
  opts: SnapshotCreateOpts = {}
): string {
  let cmd = `${type} snapshot ${vmid} ${name}`;
  if (opts.description) cmd += ` --description ${shQuote(opts.description)}`;
  // Containers have no RAM-state snapshot; --vmstate applies to VMs only.
  if (type === "qm") cmd += ` --vmstate ${opts.vmstate ? 1 : 0}`;
  return cmd;
}

export function buildSnapshotRollbackCommand(type: GuestType, vmid: number, name: string): string {
  return `${type} rollback ${vmid} ${name}`;
}

export function buildSnapshotDeleteCommand(type: GuestType, vmid: number, name: string): string {
  return `${type} delsnapshot ${vmid} ${name}`;
}

/** Re-export for callers that resolve guest running-state from `<tool> status`. */
export function parseGuestStatus(output: string): string {
  return parsePctStatus(output);
}
