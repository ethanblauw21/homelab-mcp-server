import { shQuote, parsePctStatus } from "./pctFiles.js";
import { parseGuestConfig, hasDevicePassthrough, rootfsStorageName, type GuestConfig } from "./censusParsers.js";

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

/** `pct config <vmid>` / `qm config <vmid>` — read a guest's config for diagnosis. */
export function buildGuestConfigCommand(type: GuestType, vmid: number): string {
  return `${type} config ${vmid}`;
}

// ---------------------------------------------------------------------------
// #15 — snapshot_create failure enrichment
// ---------------------------------------------------------------------------

/**
 * Proxmox emits this class of message when the guest's storage/config cannot take
 * a snapshot ("snapshot feature is not available"). It is the signal to diagnose a
 * structural blocker rather than surface a bare CLI error.
 */
const SNAPSHOT_FEATURE_ERROR = /feature is not available|does not support snapshot|snapshot feature|not supported/i;

export interface BindMount {
  key: string;
  hostPath: string;
  mountPoint?: string;
}

/**
 * Detect LXC bind mounts in a guest config: a `mpN:` mount point whose source is
 * an absolute *host* path (`/srv/data,...`) rather than a `storage:volume`
 * reference. Proxmox refuses to snapshot a container that bind-mounts host
 * directories — the host fs is outside the guest's snapshot-capable storage.
 */
export function detectBindMounts(config: GuestConfig): BindMount[] {
  const out: BindMount[] = [];
  for (const key of Object.keys(config)) {
    if (!/^mp\d+$/.test(key)) continue;
    const val = config[key]!;
    const first = (val.split(",")[0] ?? "").trim();
    if (first.startsWith("/")) {
      // Host-path bind mount, not a storage-backed volume.
      const mp = /(?:^|,)mp=([^,]+)/.exec(val);
      out.push({ key, hostPath: first, mountPoint: mp?.[1] });
    }
  }
  return out;
}

/**
 * #15 — turn an opaque "snapshot feature is not available" CLI failure into an
 * actionable diagnosis. Pure: takes the failed stderr, the guest type/vmid, and
 * the raw `<type> config <vmid>` text (null when the diagnostic fetch failed), and
 * returns an enriched message that names the structural blocker (device
 * passthrough, a bind mount, or dir-typed root storage) and points at the
 * `guest_backup` (vzdump) fallback — the supported rollback path for
 * snapshot-incapable guests (ADR-008 §6).
 *
 * Non-feature failures (a transient error, a name collision) are passed through
 * verbatim so we never mislead about an unrelated cause.
 */
export function enrichSnapshotFailure(
  stderr: string,
  type: GuestType,
  vmid: number,
  configText: string | null
): string {
  const base = `snapshot create failed: ${stderr.trim()}`;
  if (!SNAPSHOT_FEATURE_ERROR.test(stderr)) return base;

  const reasons: string[] = [];
  if (configText !== null) {
    const config = parseGuestConfig(configText);
    if (hasDevicePassthrough(config)) {
      reasons.push("a passed-through device (snapshots require none)");
    }
    if (type === "pct") {
      for (const b of detectBindMounts(config)) {
        reasons.push(
          `bind mount ${b.key} (${b.hostPath}${b.mountPoint ? ` → ${b.mountPoint}` : ""}) — host directories are outside snapshot-capable storage`
        );
      }
    }
    if (reasons.length === 0) {
      const storage = rootfsStorageName(config);
      reasons.push(
        storage
          ? `the root disk's backing storage ('${storage}') likely does not support snapshots (e.g. a 'dir' store)`
          : "the guest's backing storage likely does not support snapshots (e.g. a 'dir' store)"
      );
    }
  }

  const why =
    reasons.length > 0
      ? ` Likely cause: ${reasons.join("; ")}.`
      : "";
  return (
    `${base}.${why} This guest cannot be snapshotted as configured. ` +
    `Use guest_backup (vzdump) for a full-archive rollback point instead — it is the supported ` +
    `fallback for snapshot-incapable guests (GPU passthrough, bind mounts, or dir storage).`
  );
}
