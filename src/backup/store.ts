import fs from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import type { BackupEntry } from "./eviction.js";
import type { BackupKind, BlobRevertibility } from "./policy.js";
import { planEviction, isOverCap } from "./eviction.js";
import { applyReverseDiff, classifyBlobRevertibility } from "./policy.js";
import type { Config } from "../config.js";

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
  revertible: boolean;
  /**
   * #20 — true for a delta (`mcp-rdiff-v1`) blob: it can only be applied while
   * the live file still matches its `baseHash`. When `revertible` is false on a
   * version carrying this flag, a companion-tier `diff_config` can still confirm
   * applicability against the live file (observe-tier `list_backups` cannot).
   */
  requiresLiveMatch?: boolean;
  /** #20 — the live content hash a delta backup is anchored to (present for deltas). */
  baseHash?: string;
  /** #20 — why a version is non-revertible: stale base, unknown current, or metadata-only. */
  revertibleReason?: "stale-base" | "current-unknown" | "metadata-only";
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

    // Write companion meta carrying the target descriptor + blob pointer so
    // revert can route restoration (host SFTP vs. pct push) from the meta alone.
    const metaPath = path.join(keyDir, `${ts}.meta`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ target, remotePath: target.remotePath, blobPath, hash: newHash, kind: kind.type })
    );

    return { backupPath: blobPath, kind: kind.type, revertible: true };
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

  /**
   * #20 — list backup versions with **honest** revertibility.
   *
   * A `.gz` blob is inspected (decompressed locally — no node access) to learn
   * whether it is self-contained or an `mcp-rdiff-v1` delta. A delta is only
   * applicable while the live file still hashes to its `baseHash`:
   *  - `currentHash` supplied (companion `diff_config`, which reads the live
   *    file): the delta's `revertible` is the real `currentHash === baseHash`.
   *  - `currentHash` omitted (observe `list_backups`, no node access): a delta
   *    cannot be confirmed, so `revertible: false` with `requiresLiveMatch: true`
   *    + `baseHash` — never the old overstated `revertible: true`.
   * Self-contained blobs are unconditionally `revertible: true`.
   */
  listBackupsForPath(target: BackupTarget, currentHash?: string | null): BackupVersionInfo[] {
    const key = fileKey(target);
    const keyDir = path.join(this.cfg.baseDir, key);
    if (!fs.existsSync(keyDir)) return [];

    const files = fs.readdirSync(keyDir);
    const timestamps = new Set(files.map((f) => f.replace(/\.(gz|meta)$/, "")));
    const results: BackupVersionInfo[] = [];
    const liveHash = currentHash ?? null;

    for (const ts of timestamps) {
      const gzPath = path.join(keyDir, `${ts}.gz`);
      const metaPath = path.join(keyDir, `${ts}.meta`);

      if (fs.existsSync(gzPath)) {
        const stat = fs.statSync(gzPath);
        let kind = "gzip-full";
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            kind = meta.kind ?? "gzip-full";
          } catch { /* use default */ }
        }
        // Inspect the blob itself — meta.kind alone is not authoritative (a
        // "gzip-diff" blob falls back to raw content for very large files).
        let rev: BlobRevertibility = { revertible: true, requiresLiveMatch: false };
        try {
          const decompressed = zlib.gunzipSync(fs.readFileSync(gzPath));
          rev = classifyBlobRevertibility(decompressed, liveHash);
        } catch { /* unreadable blob — leave optimistic default */ }
        results.push({
          backupPath: gzPath,
          timestamp: ts,
          kind,
          sizeBytes: stat.size,
          revertible: rev.revertible,
          requiresLiveMatch: rev.requiresLiveMatch || undefined,
          baseHash: rev.baseHash,
          revertibleReason: rev.reason,
        });
      } else if (fs.existsSync(metaPath)) {
        const stat = fs.statSync(metaPath);
        results.push({ backupPath: metaPath, timestamp: ts, kind: "metadata-only", sizeBytes: stat.size, revertible: false, revertibleReason: "metadata-only" });
      }
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * #20 — the `baseHash` of the newest stored backup for a target: the live
   * content hash that backup expects (`meta.hash` === SHA-256 of the content
   * written at that time). The write path compares the about-to-be-written
   * `prevHash` against this to detect an out-of-band drift and re-anchor to a
   * self-contained full copy (see `chainBaseDrifted`). Returns null when no
   * prior content backup exists.
   */
  latestBaseHash(target: BackupTarget): string | null {
    const key = fileKey(target);
    const keyDir = path.join(this.cfg.baseDir, key);
    if (!fs.existsSync(keyDir)) return null;

    const metas = fs
      .readdirSync(keyDir)
      .filter((f) => f.endsWith(".meta"))
      .sort((a, b) => b.localeCompare(a)); // newest timestamp first
    for (const m of metas) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(keyDir, m), "utf8"));
        // Only content backups anchor a chain; metadata-only carries no live base.
        if (meta.kind && meta.kind !== "metadata-only" && typeof meta.hash === "string") {
          return meta.hash as string;
        }
      } catch { /* skip corrupt meta */ }
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
