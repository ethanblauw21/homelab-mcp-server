import { describe, it, expect } from "vitest";
import { summarizeBackupStore, classifyKind, type BackupStatEntry, type BackupCaps } from "./backupStats.js";

/** ADR-015 §3 — pure backup-store health: capacity, version pressure, kind mix, re-anchors. */

const caps: BackupCaps = { perFileVersionCap: 10, globalSizeCapBytes: 1000 };

function entry(over: Partial<BackupStatEntry>): BackupStatEntry {
  return {
    fileKey: "k1",
    kind: "gzip-diff",
    sizeBytes: 100,
    reanchored: false,
    requiresBaseHash: "base",
    timestamp: "2026-06-10T00-00-00-000Z",
    ...over,
  };
}

describe("classifyKind", () => {
  it("maps each kind to the delta / self-contained / metadata-only mix", () => {
    expect(classifyKind(entry({ kind: "gzip-diff", requiresBaseHash: "base" }))).toBe("delta");
    expect(classifyKind(entry({ kind: "gzip-diff", requiresBaseHash: null }))).toBe("selfContained");
    expect(classifyKind(entry({ kind: "gzip-full" }))).toBe("selfContained");
    expect(classifyKind(entry({ kind: "metadata-only" }))).toBe("metadataOnly");
    expect(classifyKind(entry({ kind: "something-else" }))).toBe("selfContained");
  });
});

describe("summarizeBackupStore", () => {
  it("returns an empty-store shape with no divide-by-zero", () => {
    const s = summarizeBackupStore([], caps);
    expect(s.totalBytes).toBe(0);
    expect(s.totalVersions).toBe(0);
    expect(s.targetCount).toBe(0);
    expect(s.reanchorFraction).toBe(0);
    expect(s.usedFraction).toBe(0);
    expect(s.overCap).toBe(false);
    expect(s.headroomBytes).toBe(1000);
  });

  it("computes capacity, headroom, and the over-cap flag", () => {
    const under = summarizeBackupStore([entry({ sizeBytes: 400 }), entry({ sizeBytes: 200 })], caps);
    expect(under.totalBytes).toBe(600);
    expect(under.headroomBytes).toBe(400);
    expect(under.usedFraction).toBeCloseTo(0.6);
    expect(under.overCap).toBe(false);

    const over = summarizeBackupStore([entry({ sizeBytes: 700 }), entry({ sizeBytes: 700 })], caps);
    expect(over.totalBytes).toBe(1400);
    expect(over.headroomBytes).toBe(-400);
    expect(over.overCap).toBe(true);
  });

  it("counts per-target version pressure at and near the cap", () => {
    const entries: BackupStatEntry[] = [];
    // target A: 10 versions (at cap)
    for (let i = 0; i < 10; i++) entries.push(entry({ fileKey: "A", timestamp: `t${i}` }));
    // target B: 8 versions (near cap: >= ceil(0.8*10)=8)
    for (let i = 0; i < 8; i++) entries.push(entry({ fileKey: "B", timestamp: `t${i}` }));
    // target C: 2 versions (clear)
    for (let i = 0; i < 2; i++) entries.push(entry({ fileKey: "C", timestamp: `t${i}` }));

    const s = summarizeBackupStore(entries, caps);
    expect(s.targetCount).toBe(3);
    expect(s.totalVersions).toBe(20);
    expect(s.targetsAtCap).toBe(1); // A only
    expect(s.targetsNearCap).toBe(2); // A and B
  });

  it("tallies the kind mix and re-anchor frequency", () => {
    const s = summarizeBackupStore(
      [
        entry({ kind: "gzip-diff", requiresBaseHash: "b" }),
        entry({ kind: "gzip-full", reanchored: true }),
        entry({ kind: "gzip-full" }),
        entry({ kind: "metadata-only" }),
      ],
      caps
    );
    expect(s.kindMix).toEqual({ delta: 1, selfContained: 2, metadataOnly: 1 });
    expect(s.reanchorCount).toBe(1);
    expect(s.reanchorFraction).toBeCloseTo(0.25);
  });
});
