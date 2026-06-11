import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { BackupEntry } from "./eviction.js";
import type { BackupKind } from "./policy.js";
import { planEviction, isOverCap } from "./eviction.js";
import { applyReverseDiff } from "./policy.js";
import type { Config } from "../config.js";

/**
 * Identifies what a backup belongs to. Host files and container files share the
 * same store but must never collide on disk, so the file key is derived from a
 * descriptor string: bare path for host, `pct:<vmid>:<path>` for containers.
 */
export type BackupTargetKind = "host" | "pct" | "qm";

export interface BackupTarget {
  kind: BackupTargetKind;
  vmid?: number;
  remotePath: string;
}

export function targetKeyString(t: BackupTarget): string {
  if (t.kind === "pct") return `pct:${t.vmid}:${t.remotePath}`;
  if (t.kind === "qm") return `qm:${t.vmid}:${t.remotePath}`;
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
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            kind = meta.kind ?? "gzip-full";
          } catch { /* use default */ }
        }
        results.push({ backupPath: gzPath, timestamp: ts, kind, sizeBytes: stat.size, revertible: true });
      } else if (fs.existsSync(metaPath)) {
        const stat = fs.statSync(metaPath);
        results.push({ backupPath: metaPath, timestamp: ts, kind: "metadata-only", sizeBytes: stat.size, revertible: false });
      }
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
