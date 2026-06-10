import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { BackupEntry } from "./eviction.js";
import type { BackupKind } from "./policy.js";
import { planEviction, isOverCap } from "./eviction.js";
import { applyReverseDiff } from "./policy.js";
import type { Config } from "../config.js";

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

function fileKey(remotePath: string): string {
  return crypto.createHash("sha256").update(remotePath).digest("hex").slice(0, 16);
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

  buildExistingHashMap(baseDir: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(baseDir)) return map;
    for (const key of fs.readdirSync(baseDir)) {
      const keyDir = path.join(baseDir, key);
      if (!fs.statSync(keyDir).isDirectory()) continue;
      for (const file of fs.readdirSync(keyDir)) {
        // Hash is stored as part of metadata
        const metaPath = path.join(keyDir, file);
        if (file.endsWith(".meta")) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (meta.hash) map.set(meta.hash, metaPath);
          } catch {
            // skip corrupt meta
          }
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
    remotePath: string,
    kind: BackupKind,
    newHash: string
  ): Promise<BackupResult> {
    // Run eviction before storing new backup
    this.runEviction();

    if (kind.type === "dedup") {
      return { backupPath: null, existingPath: kind.existingPath, kind: "dedup", revertible: true };
    }

    if (kind.type === "metadata-only") {
      const key = fileKey(remotePath);
      const keyDir = path.join(this.cfg.baseDir, key);
      this.ensureDir(keyDir);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const metaPath = path.join(keyDir, `${ts}.meta`);
      fs.writeFileSync(metaPath, JSON.stringify({ remotePath, hash: newHash, revertible: false }));
      return { backupPath: metaPath, kind: "metadata-only", revertible: false };
    }

    // gzip-full or gzip-diff
    const key = fileKey(remotePath);
    const keyDir = path.join(this.cfg.baseDir, key);
    this.ensureDir(keyDir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const blobPath = path.join(keyDir, `${ts}.gz`);
    fs.writeFileSync(blobPath, kind.blob);

    // Write companion meta
    const metaPath = path.join(keyDir, `${ts}.meta`);
    fs.writeFileSync(metaPath, JSON.stringify({ remotePath, hash: newHash, kind: kind.type }));

    return { backupPath: blobPath, kind: kind.type, revertible: true };
  }

  listBackupsForPath(remotePath: string): BackupVersionInfo[] {
    const key = fileKey(remotePath);
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
