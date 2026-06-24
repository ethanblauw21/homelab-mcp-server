import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { BackupEntry } from "./eviction.js";
import type { BackupKind } from "./policy.js";
import { planEviction, isOverCap } from "./eviction.js";
import { applyReverseDiff } from "./policy.js";
import type { Config } from "../config.js";
import type { BackupStatEntry } from "../metrics/backupStats.js";

/**
 * Identifies what a backup belongs to. Host files and guest files share the same
 * store but must never collide on disk, so the file key is derived from a
 * descriptor string: bare path for host, `pct:<vmid>:<path>` for containers,
 * `qm:<vmid>:<path>` for VMs, `docker:<vmid>:<container>:<path>` for Docker
 * containers (ADR-008). Docker identity is the container *name* (survives
 * recreation) — the same string the caller named, regardless of whether the
 * write took the bind-mount fast path or the `docker cp` slow path.
 */
export type BackupTargetKind = "host" | "pct" | "qm" | "docker";

export interface BackupTarget {
  kind: BackupTargetKind;
  vmid?: number;
  /** Docker container name (ADR-008 `docker` kind only). */
  container?: string;
  remotePath: string;
}

export function targetKeyString(t: BackupTarget): string {
  if (t.kind === "pct") return `pct:${t.vmid}:${t.remotePath}`;
  if (t.kind === "qm") return `qm:${t.vmid}:${t.remotePath}`;
  if (t.kind === "docker") return `docker:${t.vmid}:${t.container}:${t.remotePath}`;
  return t.remotePath;
}

/**
 * Build a BackupTarget from the loose `path`/`vmid`/`container` inputs that the
 * read/diff/revert tools accept (docker > pct > host). `container` requires `vmid`
 * (a Docker target is addressed by the LXC host vmid plus the container name). Pure;
 * shared by `diff_config` and `revert_file` so their target resolution can't drift.
 * Note: `qm` targets cannot be addressed this way (they carry no descriptor-stable
 * path) — pass a `backupPath` for those.
 */
export function targetFromInput(remotePath: string, vmid?: number, container?: string): BackupTarget {
  if (container !== undefined) {
    if (vmid === undefined) {
      throw new Error("`container` requires `vmid` (a Docker target is addressed by vmid + container).");
    }
    return { kind: "docker", vmid, container, remotePath };
  }
  if (vmid !== undefined) return { kind: "pct", vmid, remotePath };
  return { kind: "host", remotePath };
}

export interface BackupResult {
  backupPath: string | null;   // null for dedup (points to existing) or metadata-only
  existingPath?: string;       // set for dedup
  kind: BackupKind["type"];
  revertible: boolean;
}

export interface BackupVersionInfo {
  backupPath: string;
  timestamp: string;
  kind: string;
  sizeBytes: number;
  /**
   * Whether the version carries restorable content at all (content-bearing). This
   * is NOT the honest "can I revert right now" verdict — that depends on the live
   * file and is computed by the list_backups handler via classifyRevertibility
   * (ADR-014 §1), which overwrites this flag and may add `revertReason`.
   */
  revertible: boolean;
  /** ADR-014 §1 — the meta `hash` (= sha256 of the content the write produced). */
  hash?: string;
  /** ADR-014 §1 — base the live file must match for a delta to apply (null ⇒ self-contained). */
  requiresBaseHash?: string | null;
  /** ADR-014 §2 — true if this is a self-contained snapshot of out-of-band-drifted content. */
  reanchored?: boolean;
  /** ADR-014 §1 — why a version is not revertible right now (set by the handler). */
  revertReason?: string;
}

function fileKey(target: BackupTarget): string {
  return crypto.createHash("sha256").update(targetKeyString(target)).digest("hex").slice(0, 16);
}

function listEntries(baseDir: string): BackupEntry[] {
  const entries: BackupEntry[] = [];
  if (!fs.existsSync(baseDir)) return entries;

  for (const key of fs.readdirSync(baseDir)) {
    const keyDir = path.join(baseDir, key);
    if (!fs.statSync(keyDir).isDirectory()) continue;
    for (const file of fs.readdirSync(keyDir)) {
      const filePath = path.join(keyDir, file);
      const stat = fs.statSync(filePath);
      entries.push({
        path: filePath,
        fileKey: key,
        timestamp: file.replace(/\.(gz|meta)$/, ""),
        sizeBytes: stat.size,
      });
    }
  }
  return entries;
}

export class BackupStore {
  private readonly cfg: Config["backup"];

  constructor(cfg: Config["backup"]) {
    this.cfg = cfg;
  }

  private ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Map content-hash → backup BLOB path (the `.gz`), for dedup resolution.
   *
   * Historically this mapped the hash to the `.meta` sidecar, but `restore()`
   * refuses `.meta` paths, so deduplicated backups reported `revertible: true`
   * yet could never be reverted (ADR-003 coordination defect). Resolving to the
   * blob — and preferring the meta's `blobPath` field, falling back to the
   * sibling `.gz` for legacy meta — fixes that. Metadata-only backups have no
   * blob and are intentionally skipped (nothing to dedup against).
   */
  buildExistingHashMap(baseDir: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(baseDir)) return map;
    for (const key of fs.readdirSync(baseDir)) {
      const keyDir = path.join(baseDir, key);
      if (!fs.statSync(keyDir).isDirectory()) continue;
      for (const file of fs.readdirSync(keyDir)) {
        if (!file.endsWith(".meta")) continue;
        const metaPath = path.join(keyDir, file);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          if (!meta.hash) continue;
          // ADR-014 §2 — a re-anchor snapshot's blob holds prevContent while its
          // meta.hash records newContent. Mapping that hash → blob would hand a
          // future dedup the WRONG bytes, so re-anchor metas are never dedup targets.
          if (meta.reanchored === true) continue;
          let blob: string | undefined = meta.blobPath;
          if (!blob) {
            // Legacy meta without blobPath: derive the sibling .gz.
            const candidate = metaPath.replace(/\.meta$/, ".gz");
            if (fs.existsSync(candidate)) blob = candidate;
          }
          if (blob && fs.existsSync(blob)) map.set(meta.hash, blob);
        } catch {
          // skip corrupt meta
        }
      }
    }
    return map;
  }

  runEviction(): void {
    const entries = listEntries(this.cfg.baseDir);
    const { toDelete } = planEviction(entries, this.cfg.perFileVersionCap, this.cfg.globalSizeCapBytes);
    for (const e of toDelete) {
      try { fs.unlinkSync(e.path); } catch { /* already gone */ }
    }
  }

  checkDiskPressure(): boolean {
    const entries = listEntries(this.cfg.baseDir);
    const kept = planEviction(entries, this.cfg.perFileVersionCap, this.cfg.globalSizeCapBytes).toKeep;
    return isOverCap(kept, this.cfg.globalSizeCapBytes);
  }

  async storeBackup(
    target: BackupTarget,
    kind: BackupKind,
    newHash: string
  ): Promise<BackupResult> {
    // Run eviction before storing new backup
    this.runEviction();

    if (kind.type === "dedup") {
      // existingPath now resolves to a BLOB (see buildExistingHashMap), so the
      // deduplicated backup is genuinely revertible.
      return { backupPath: null, existingPath: kind.existingPath, kind: "dedup", revertible: true };
    }

    if (kind.type === "metadata-only") {
      const key = fileKey(target);
      const keyDir = path.join(this.cfg.baseDir, key);
      this.ensureDir(keyDir);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const metaPath = path.join(keyDir, `${ts}.meta`);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({ target, remotePath: target.remotePath, hash: newHash, kind: "metadata-only", revertible: false })
      );
      return { backupPath: metaPath, kind: "metadata-only", revertible: false };
    }

    // gzip-full or gzip-diff
    const key = fileKey(target);
    const keyDir = path.join(this.cfg.baseDir, key);
    this.ensureDir(keyDir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const blobPath = path.join(keyDir, `${ts}.gz`);
    fs.writeFileSync(blobPath, kind.blob);

    // ADR-014 §1 — record what a revert needs from the live file. A gzip-diff
    // carries its base requirement (null ⇒ self-contained large-file fallback); a
    // gzip-full is always self-contained. `reanchored` marks a self-contained
    // snapshot of drifted prevContent (its blob ≠ its hash — see buildExistingHashMap).
    const requiresBaseHash = kind.type === "gzip-diff" ? kind.requiresBaseHash : null;
    const reanchored = kind.type === "gzip-full" ? kind.reanchored === true : false;

    // Write companion meta carrying the target descriptor + blob pointer so
    // revert can route restoration (host SFTP vs. pct push) from the meta alone.
    const metaPath = path.join(keyDir, `${ts}.meta`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        target,
        remotePath: target.remotePath,
        blobPath,
        hash: newHash,
        kind: kind.type,
        requiresBaseHash,
        reanchored,
      })
    );

    return { backupPath: blobPath, kind: kind.type, revertible: true };
  }

  /**
   * ADR-015 §3 — project the `.meta` sidecars into stat entries for the pure
   * `summarizeBackupStore`. One entry per version (one meta), with `sizeBytes` =
   * meta + blob bytes so the total matches what the eviction planner sums. Reuses
   * the same `baseDir/<key>/*` directory walk as `buildExistingHashMap`; reads metas
   * only (never blob content), so it is a cheap local-disk scan. Corrupt metas are
   * skipped. Credential-free — `BackupStore` imports no SSH/API client, so the
   * ADR-010 renderer may call this without tripping the source-scan test.
   */
  storeStats(): BackupStatEntry[] {
    const baseDir = this.cfg.baseDir;
    const out: BackupStatEntry[] = [];
    if (!fs.existsSync(baseDir)) return out;

    for (const key of fs.readdirSync(baseDir)) {
      const keyDir = path.join(baseDir, key);
      if (!fs.statSync(keyDir).isDirectory()) continue;
      for (const file of fs.readdirSync(keyDir)) {
        if (!file.endsWith(".meta")) continue;
        const metaPath = path.join(keyDir, file);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          const kind: string = meta.kind ?? "gzip-full";
          let sizeBytes = fs.statSync(metaPath).size;
          // Prefer the meta's blobPath; fall back to the sibling .gz (legacy meta).
          let blob: string | undefined = meta.blobPath;
          if (!blob) {
            const candidate = metaPath.replace(/\.meta$/, ".gz");
            if (fs.existsSync(candidate)) blob = candidate;
          }
          if (blob && fs.existsSync(blob)) sizeBytes += fs.statSync(blob).size;
          out.push({
            fileKey: key,
            kind,
            sizeBytes,
            reanchored: meta.reanchored === true,
            requiresBaseHash: "requiresBaseHash" in meta ? meta.requiresBaseHash : undefined,
            timestamp: file.replace(/\.meta$/, ""),
          });
        } catch {
          /* skip corrupt meta */
        }
      }
    }
    return out;
  }

  /**
   * Resolve the target descriptor recorded alongside a backup blob (or `.meta`).
   * Legacy meta without a `target` is interpreted as a host write.
   */
  readBackupTarget(backupPath: string): BackupTarget {
    const metaPath = backupPath.endsWith(".meta")
      ? backupPath
      : backupPath.replace(/\.gz$/, ".meta");
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Backup metadata not found for ${backupPath}`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.target) return meta.target as BackupTarget;
    return { kind: "host", remotePath: meta.remotePath };
  }

  listBackupsForPath(target: BackupTarget): BackupVersionInfo[] {
    const key = fileKey(target);
    const keyDir = path.join(this.cfg.baseDir, key);
    if (!fs.existsSync(keyDir)) return [];

    const files = fs.readdirSync(keyDir);
    const timestamps = new Set(files.map((f) => f.replace(/\.(gz|meta)$/, "")));
    const results: BackupVersionInfo[] = [];

    for (const ts of timestamps) {
      const gzPath = path.join(keyDir, `${ts}.gz`);
      const metaPath = path.join(keyDir, `${ts}.meta`);

      if (fs.existsSync(gzPath)) {
        const stat = fs.statSync(gzPath);
        let kind = "gzip-full";
        let hash: string | undefined;
        let requiresBaseHash: string | null | undefined;
        let reanchored: boolean | undefined;
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            kind = meta.kind ?? "gzip-full";
            hash = meta.hash;
            // `requiresBaseHash` may be legitimately null (self-contained); only
            // treat it as "absent" (legacy meta) when the key is missing entirely.
            requiresBaseHash = "requiresBaseHash" in meta ? meta.requiresBaseHash : undefined;
            reanchored = meta.reanchored === true;
          } catch { /* use default */ }
        }
        results.push({
          backupPath: gzPath,
          timestamp: ts,
          kind,
          sizeBytes: stat.size,
          revertible: true,
          hash,
          requiresBaseHash,
          reanchored,
        });
      } else if (fs.existsSync(metaPath)) {
        const stat = fs.statSync(metaPath);
        results.push({ backupPath: metaPath, timestamp: ts, kind: "metadata-only", sizeBytes: stat.size, revertible: false });
      }
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * ADR-014 §2 — the `hash` of the most recent managed backup for this target: the
   * content that write produced, i.e. what the live file *should* be if nothing has
   * touched it since. The next write compares its current-on-disk hash against this
   * to detect out-of-band drift. Returns null when there is no chain yet (first
   * write) or no readable meta — either way the caller skips the drift check.
   */
  latestBaseHash(target: BackupTarget): string | null {
    const key = fileKey(target);
    const keyDir = path.join(this.cfg.baseDir, key);
    if (!fs.existsSync(keyDir)) return null;

    const metas = fs.readdirSync(keyDir).filter((f) => f.endsWith(".meta"));
    if (metas.length === 0) return null;
    // Newest by timestamp (filename is the ISO-ish stamp; lexical sort = chronological).
    metas.sort((a, b) => b.localeCompare(a));
    for (const f of metas) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(keyDir, f), "utf8"));
        if (typeof meta.hash === "string") return meta.hash;
      } catch { /* skip corrupt meta, try the next-newest */ }
    }
    return null;
  }

  /**
   * Restore the content stored in a backup blob.
   * Works for gzip-full and gzip-diff (reverse diffs) — both decompress to the
   * previous content. Returns null if the backup is metadata-only (non-revertible).
   */
  async restore(backupPath: string, currentContent?: Buffer): Promise<Buffer | null> {
    if (!fs.existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);
    if (backupPath.endsWith(".meta")) return null; // metadata-only, non-revertible
    const blob = fs.readFileSync(backupPath);
    return applyReverseDiff(blob, currentContent);
  }
}
