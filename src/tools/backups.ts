import { shSingleQuote } from "../ssh/command.js";
import type { GuestType } from "../node/nodeOps.js";

/**
 * vzdump archive guard primitives (ADR-008 §6) — the outcome-level rollback for
 * guests that cannot snapshot (device passthrough / dir storage). These mirror the
 * snapshot guard (`snapshots.ts`) one layer up: the server only ever manages
 * archives **it** created, identified by a reserved `mcp-` prefix carried in the
 * archive **notes** (vzdump's `--notes-template`). A human-made archive has no
 * `mcp-` note and is therefore invisible to retention and un-targetable by restore
 * (`isMcpArchive` is false), exactly like a non-`mcp-` snapshot.
 *
 * Everything here is pure (builders + parsers + the retention planner). The two
 * NodeOps backends — `ApiBackend` (POST /vzdump etc.) and `SshBackend` (`vzdump`
 * CLI + `pvesh` JSON) — are the thin I/O shells over these.
 */

export const MCP_BACKUP_PREFIX = "mcp-";

export type BackupMode = "snapshot" | "suspend" | "stop";

export interface ArchiveInfo {
  /** Proxmox volume id, e.g. "local:backup/vzdump-lxc-101-2026_06_14-...tar.zst". */
  volid: string;
  vmid: number;
  /** Unix seconds, when the listing reports it. */
  ctime?: number;
  sizeBytes?: number;
  /** The archive notes; the `mcp-` ownership tag lives here when server-made. */
  notes?: string;
  format?: string;
  mcpManaged: boolean;
}

/** True when an archive's notes mark it server-managed (`mcp-` prefix). */
export function isMcpArchive(notes: string | undefined): boolean {
  return typeof notes === "string" && notes.trimStart().startsWith(MCP_BACKUP_PREFIX);
}

/**
 * `mcp-<compact-UTC-ts>` (+ optional human note), e.g.
 * `mcp-20260614-153000 — before portainer stack edit`. UTC keeps it deterministic
 * for tests; the leading `mcp-` is the ownership marker retention/restore key on.
 * No `{{ }}` is ever emitted, so passing this through vzdump's `--notes-template`
 * is literal (no template expansion).
 */
export function generateBackupNote(now: Date, note?: string): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const ts =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const base = `${MCP_BACKUP_PREFIX}${ts}`;
  const extra = note?.trim();
  return extra ? `${base} — ${extra}` : base;
}

/**
 * Retention planner (pure). Given the archives for ONE guest, the per-guest cap on
 * `mcp-` archives, and how many are about to be created (default 1), return the
 * volids of the oldest `mcp-` archives to free so the post-create count stays
 * within cap. Newest-first by `ctime` (undefined ctime sorts oldest, and volid
 * breaks ties deterministically). Non-`mcp-` archives are never eligible.
 */
export function planArchiveEviction(archives: ArchiveInfo[], cap: number, incoming = 1): string[] {
  const mcp = archives.filter((a) => a.mcpManaged);
  const sorted = [...mcp].sort((a, b) => {
    const at = a.ctime ?? 0;
    const bt = b.ctime ?? 0;
    if (at !== bt) return bt - at; // newest first
    return b.volid.localeCompare(a.volid);
  });
  const allowed = Math.max(0, cap - incoming);
  return sorted.slice(allowed).map((a) => a.volid);
}

/**
 * Parse a Proxmox storage-content listing (the array shape returned by both the
 * REST API `/storage/<s>/content?content=backup` and `pvesh get … --output-format
 * json`). Tolerant of the two notes field names PVE has used (`notes` / `comment`)
 * and of `size`/`ctime` arriving as numbers or numeric strings.
 */
export function parseArchiveContent(data: unknown): ArchiveInfo[] {
  if (!Array.isArray(data)) return [];
  const out: ArchiveInfo[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const volid = typeof r["volid"] === "string" ? (r["volid"] as string) : "";
    if (!volid) continue;
    const notes =
      typeof r["notes"] === "string"
        ? (r["notes"] as string)
        : typeof r["comment"] === "string"
          ? (r["comment"] as string)
          : undefined;
    out.push({
      volid,
      vmid: numOr(r["vmid"], 0),
      ctime: r["ctime"] !== undefined ? numOr(r["ctime"], 0) : undefined,
      sizeBytes: r["size"] !== undefined ? numOr(r["size"], 0) : undefined,
      notes,
      format: typeof r["format"] === "string" ? (r["format"] as string) : undefined,
      mcpManaged: isMcpArchive(notes),
    });
  }
  return out;
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Charset guards (belt-and-braces before any interpolation)
// ---------------------------------------------------------------------------

/** A storage name (Proxmox: alnum, `-`, `_`, `.`). Validated before interpolation. */
const STORAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function assertStorageName(storage: string): void {
  if (!STORAGE_RE.test(storage)) {
    throw new Error(`Invalid storage name: ${JSON.stringify(storage)} (expected ${STORAGE_RE}).`);
  }
}

/**
 * A backup volid `<storage>:backup/<file>`. The file segment is restricted to the
 * vzdump charset so it is safe to interpolate into a `pvesm free` / `pvesh` path.
 */
const VOLID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*:backup\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
export function assertVolid(volid: string): void {
  if (!VOLID_RE.test(volid)) {
    throw new Error(
      `Invalid backup volid: ${JSON.stringify(volid)} (expected "<storage>:backup/<file>").`
    );
  }
}

// ---------------------------------------------------------------------------
// SSH CLI builders (SshBackend)
// ---------------------------------------------------------------------------

export interface VzdumpCliOpts {
  mode: BackupMode;
  storage: string;
  notes: string;
  compress?: string;
}

/** `vzdump <vmid> --storage <s> --mode <m> --compress zstd --notes-template '<note>'`. */
export function buildVzdumpCommand(vmid: number, opts: VzdumpCliOpts): string {
  assertStorageName(opts.storage);
  const compress = opts.compress ?? "zstd";
  return (
    `vzdump ${vmid} --storage ${opts.storage} --mode ${opts.mode} ` +
    `--compress ${compress} --notes-template ${shSingleQuote(opts.notes)}`
  );
}

/** `pvesh get /nodes/<node>/storage/<s>/content --content backup --output-format json`. */
export function buildListBackupsCommand(node: string, storage: string): string {
  assertStorageName(storage);
  return (
    `pvesh get /nodes/${node}/storage/${storage}/content ` +
    `--content backup --output-format json`
  );
}

/**
 * Restore a guest from an archive (destructive overwrite). LXC ⇒ `pct restore`,
 * QEMU ⇒ `qmrestore`; both take `--force` to overwrite the existing guest.
 */
export function buildRestoreCommand(type: GuestType, vmid: number, volid: string): string {
  assertVolid(volid);
  if (type === "lxc") {
    return `pct restore ${vmid} ${shSingleQuote(volid)} --force`;
  }
  return `qmrestore ${shSingleQuote(volid)} ${vmid} --force`;
}

/** `pvesm free <volid>` — delete one archive volume. */
export function buildArchiveFreeCommand(volid: string): string {
  assertVolid(volid);
  return `pvesm free ${shSingleQuote(volid)}`;
}
