import { describe, it, expect } from "vitest";
import { planEviction, isOverCap } from "./eviction.js";
import type { BackupEntry } from "./eviction.js";

function entry(fileKey: string, ts: string, sizeBytes: number): BackupEntry {
  return { path: `/backups/${fileKey}/${ts}.gz`, fileKey, timestamp: ts, sizeBytes };
}

describe("planEviction", () => {
  describe("per-file version cap", () => {
    it("evicts oldest versions when over per-file cap", () => {
      const entries = [
        entry("file1", "2024-01-01T00:00:00.000Z", 100),
        entry("file1", "2024-01-02T00:00:00.000Z", 100),
        entry("file1", "2024-01-03T00:00:00.000Z", 100),
        entry("file1", "2024-01-04T00:00:00.000Z", 100),
      ];
      const { toDelete, toKeep } = planEviction(entries, 2, Infinity);
      expect(toDelete).toHaveLength(2);
      expect(toKeep).toHaveLength(2);
      // Oldest two should be deleted
      const deletedTs = toDelete.map((e) => e.timestamp).sort();
      expect(deletedTs).toEqual(["2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z"]);
    });

    it("keeps exactly cap versions per file", () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        entry("fileA", `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, 50)
      );
      const { toKeep } = planEviction(entries, 3, Infinity);
      expect(toKeep).toHaveLength(3);
    });

    it("does not evict when under per-file cap", () => {
      const entries = [
        entry("f1", "2024-01-01T00:00:00.000Z", 100),
        entry("f1", "2024-01-02T00:00:00.000Z", 100),
      ];
      const { toDelete } = planEviction(entries, 5, Infinity);
      expect(toDelete).toHaveLength(0);
    });

    it("handles multiple files independently", () => {
      const entries = [
        entry("fileA", "2024-01-01T00:00:00.000Z", 100),
        entry("fileA", "2024-01-02T00:00:00.000Z", 100),
        entry("fileA", "2024-01-03T00:00:00.000Z", 100),
        entry("fileB", "2024-01-01T00:00:00.000Z", 100),
        entry("fileB", "2024-01-02T00:00:00.000Z", 100),
      ];
      const { toDelete } = planEviction(entries, 2, Infinity);
      const deletedKeys = toDelete.map((e) => e.fileKey);
      expect(deletedKeys.filter((k) => k === "fileA")).toHaveLength(1);
      expect(deletedKeys.filter((k) => k === "fileB")).toHaveLength(0);
    });
  });

  describe("global size cap", () => {
    it("evicts oldest entries to get under global cap", () => {
      const entries = [
        entry("f1", "2024-01-01T00:00:00.000Z", 40),
        entry("f2", "2024-01-02T00:00:00.000Z", 40),
        entry("f3", "2024-01-03T00:00:00.000Z", 40),
      ]; // total = 120
      const { toDelete, toKeep } = planEviction(entries, 100, 80);
      const keptSize = toKeep.reduce((s, e) => s + e.sizeBytes, 0);
      expect(keptSize).toBeLessThanOrEqual(80);
      expect(toDelete.length).toBeGreaterThan(0);
    });

    it("always retains newest when evicting for size", () => {
      const entries = [
        entry("f1", "2024-01-01T00:00:00.000Z", 30),
        entry("f1", "2024-01-02T00:00:00.000Z", 30),
        entry("f1", "2024-01-03T00:00:00.000Z", 30),
      ];
      const { toKeep } = planEviction(entries, 10, 30);
      const timestamps = toKeep.map((e) => e.timestamp);
      expect(timestamps).toContain("2024-01-03T00:00:00.000Z");
    });

    it("evicts 40 oldest out of 50 to satisfy cap", () => {
      const entries = Array.from({ length: 50 }, (_, i) =>
        entry(
          `f${i}`,
          `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          1
        )
      );
      const { toDelete, toKeep } = planEviction(entries, 100, 10);
      expect(toKeep.length).toBeLessThanOrEqual(10);
      expect(toDelete.length).toBeGreaterThanOrEqual(40);
    });
  });

  describe("combined caps", () => {
    it("applies both per-file and global caps together", () => {
      const entries = [
        entry("fileA", "2024-01-01T00:00:00.000Z", 20),
        entry("fileA", "2024-01-02T00:00:00.000Z", 20),
        entry("fileA", "2024-01-03T00:00:00.000Z", 20),
        entry("fileB", "2024-01-01T00:00:00.000Z", 20),
        entry("fileB", "2024-01-02T00:00:00.000Z", 20),
      ]; // total = 100
      const { toKeep } = planEviction(entries, 2, 60);
      const keptSize = toKeep.reduce((s, e) => s + e.sizeBytes, 0);
      expect(keptSize).toBeLessThanOrEqual(60);
    });
  });

  describe("sort order independence", () => {
    it("evicts oldest even when input arrives in newest-first (descending) order", () => {
      const entries = [
        entry("f1", "2024-01-04T00:00:00.000Z", 100), // newest — arrives first
        entry("f1", "2024-01-03T00:00:00.000Z", 100),
        entry("f1", "2024-01-02T00:00:00.000Z", 100),
        entry("f1", "2024-01-01T00:00:00.000Z", 100), // oldest — arrives last
      ];
      const { toDelete } = planEviction(entries, 2, Infinity);
      const deletedTs = toDelete.map((e) => e.timestamp).sort();
      expect(deletedTs).toEqual([
        "2024-01-01T00:00:00.000Z",
        "2024-01-02T00:00:00.000Z",
      ]);
    });
  });

  describe("idempotency", () => {
    it("running planEviction twice on the same input gives same result", () => {
      const entries = [
        entry("f1", "2024-01-01T00:00:00.000Z", 50),
        entry("f1", "2024-01-02T00:00:00.000Z", 50),
        entry("f1", "2024-01-03T00:00:00.000Z", 50),
      ];
      const first = planEviction(entries, 2, Infinity);
      const second = planEviction(first.toKeep, 2, Infinity);
      expect(second.toDelete).toHaveLength(0);
    });
  });
});

describe("isOverCap", () => {
  it("returns true when total exceeds cap", () => {
    const kept = [entry("f1", "2024-01-01T00:00:00.000Z", 60)];
    expect(isOverCap(kept, 50)).toBe(true);
  });

  it("returns false when total equals cap", () => {
    const kept = [entry("f1", "2024-01-01T00:00:00.000Z", 50)];
    expect(isOverCap(kept, 50)).toBe(false);
  });

  it("returns false when under cap", () => {
    const kept = [entry("f1", "2024-01-01T00:00:00.000Z", 30)];
    expect(isOverCap(kept, 50)).toBe(false);
  });
});
