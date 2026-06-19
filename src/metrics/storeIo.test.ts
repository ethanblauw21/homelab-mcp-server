import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { BackupStore } from "../backup/store.js";
import { SnapshotStore } from "../ui/snapshotStore.js";
import type { Config } from "../config.js";

/** ADR-015 — the two thin I/O additions feeding the pure aggregators. */

describe("BackupStore.storeStats", () => {
  let dir: string;
  let store: BackupStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bstats-"));
    store = new BackupStore({ baseDir: dir, perFileVersionCap: 10, globalSizeCapBytes: 1000 } as unknown as Config["backup"]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeVersion(key: string, ts: string, meta: Record<string, unknown>, blob?: string): void {
    const keyDir = path.join(dir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    if (blob !== undefined) fs.writeFileSync(path.join(keyDir, `${ts}.gz`), blob);
    fs.writeFileSync(path.join(keyDir, `${ts}.meta`), JSON.stringify(meta));
  }

  it("returns an empty list when the store does not exist", () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(store.storeStats()).toEqual([]);
  });

  it("projects one entry per .meta, summing meta + blob bytes", () => {
    writeVersion("k1", "2026-06-10T00-00-00-000Z", { kind: "gzip-diff", hash: "h", requiresBaseHash: "b", blobPath: path.join(dir, "k1", "2026-06-10T00-00-00-000Z.gz") }, "BLOBDATA");
    const stats = store.storeStats();
    expect(stats).toHaveLength(1);
    const e = stats[0];
    expect(e.fileKey).toBe("k1");
    expect(e.kind).toBe("gzip-diff");
    expect(e.requiresBaseHash).toBe("b");
    expect(e.reanchored).toBe(false);
    // size = meta bytes + blob ("BLOBDATA" = 8 bytes)
    const metaSize = fs.statSync(path.join(dir, "k1", "2026-06-10T00-00-00-000Z.meta")).size;
    expect(e.sizeBytes).toBe(metaSize + 8);
  });

  it("flags re-anchored versions and tolerates a corrupt meta", () => {
    writeVersion("k1", "ts1", { kind: "gzip-full", reanchored: true }, "X");
    // corrupt meta — must be skipped, not throw
    fs.writeFileSync(path.join(dir, "k1", "ts2.meta"), "{not json");
    const stats = store.storeStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].reanchored).toBe(true);
  });

  it("falls back to the sibling .gz when the meta omits blobPath (legacy)", () => {
    writeVersion("k1", "tsL", { kind: "gzip-full" }, "LEGACY");
    const e = store.storeStats()[0];
    const metaSize = fs.statSync(path.join(dir, "k1", "tsL.meta")).size;
    expect(e.sizeBytes).toBe(metaSize + 6); // "LEGACY"
  });
});

describe("SnapshotStore.loadAll", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapall-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns [] when nothing is stored", () => {
    const store = new SnapshotStore<{ n: number }>(dir, 10);
    expect(store.loadAll()).toEqual([]);
  });

  it("loads the whole retained window newest-first, skipping unreadable files", () => {
    let t = 0;
    const clocks = ["2026-06-10T00:00:00.000Z", "2026-06-11T00:00:00.000Z", "2026-06-12T00:00:00.000Z"];
    const store = new SnapshotStore<{ n: number }>(dir, 10, () => new Date(clocks[t++]));
    store.save({ n: 1 });
    store.save({ n: 2 });
    store.save({ n: 3 });
    // Corrupt one file on disk.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    fs.writeFileSync(path.join(dir, files[0]), "{broken");

    const all = store.loadAll();
    expect(all).toHaveLength(2);
    // newest-first (listSnapshots sorts descending by filename = timestamp)
    expect(all[0].data.n).toBeGreaterThan(all[1].data.n);
  });
});
