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
 * ADR-027 — post-create retention (pure). Runs only once the new archive is
 * confirmed and its volid resolved: the new archive is taken out of the
 * candidate set (it can never be evicted, whatever the cap), and the remaining
 * `mcp-` archives are trimmed so the total, new one included, is within cap.
 * A cap below 1 is treated as 1 — retention never deletes the only rollback point.
 */
export function planPostCreateEviction(archives: ArchiveInfo[], newVolid: string, cap: number): string[] {
  const others = archives.filter((a) => a.volid !== newVolid);
  return planArchiveEviction(others, Math.max(1, cap), 1);
}

/**
 * ADR-027 — will the storage hold one more archive before retention frees the old
 * ones? The estimate is the newest existing archive of the same guest (any owner),
 * the best size proxy the listing offers; with no prior archive or no storage
 * figure the check is `unknown`, never a refusal. A 10% margin covers growth.
 */
export function checkBackupHeadroom(
  archives: ArchiveInfo[],
  availBytes: number | undefined
): { verdict: "ok" | "insufficient" | "unknown"; estimateBytes?: number; availBytes?: number } {
  const sized = archives
    .filter((a) => typeof a.sizeBytes === "number" && a.sizeBytes > 0)
    .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
  const estimate = sized[0]?.sizeBytes;
  if (estimate === undefined || availBytes === undefined || !Number.isFinite(availBytes)) {
    return { verdict: "unknown", ...(estimate !== undefined && { estimateBytes: estimate }) };
  }
  const needed = Math.ceil((estimate * 11) / 10);
  return { verdict: availBytes >= needed ? "ok" : "insufficient", estimateBytes: estimate, availBytes };
}

/**
 * ADR-027 — the storage-content-type hint is attached ONLY when the vzdump exit
 * status is about content type or storage. Before, every failure (including a
 * plain "still running" timeout) carried it and sent operators to the wrong cause.
 */
export function backupFailureHint(exitstatus: string, storage: string): string | null {
  if (!/content.?type|storage/i.test(exitstatus)) return null;
  return (
    `Storage "${storage}" must have the \`backup\` content type — pass storage:"<name>" ` +
    "or set NODE_BACKUP_STORAGE (the default `local` usually cannot hold backups)."
  );
}

/** Human byte size for messages (binary units, one decimal). */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
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

/**
 * Extract the storage name from a volid `<storage>:backup/<file>` (third-pass
 * H3/F8). The volid the caller passes ALREADY names the storage the archive lives
 * on, so `guest_backup_restore` must search THAT storage — not the config default
 * `nodeBackupStorage` (`"local"`), which lacks the `backup` content type and so can
 * never hold an archive `guest_backup` created. Asserts the volid shape first.
 */
export function volidStorage(volid: string): string {
  assertVolid(volid);
  return volid.slice(0, volid.indexOf(":"));
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
