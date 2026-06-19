import { describe, it, expect } from "vitest";
import { computeDriftTrend, type DriftSnapshotLike, type DriftLeafLike } from "./driftStats.js";

/** ADR-015 §2 — pure drift-rate trend over retained verify snapshots. */

function leaf(over: Partial<DriftLeafLike>): DriftLeafLike {
  return {
    path: "host/etc/x",
    nodePath: "/etc/x",
    status: "unexplained",
    l1: true,
    l2: true,
    l3: true,
    ...over,
  };
}

function snap(savedAt: string, drift: DriftLeafLike[], extra: Partial<DriftSnapshotLike["data"]> = {}): DriftSnapshotLike {
  return { savedAt, data: { level: "smart", scope: "", drift, ...extra } };
}

describe("computeDriftTrend", () => {
  it("reports insufficient-data with no runs", () => {
    const t = computeDriftTrend([]);
    expect(t.totalRuns).toBe(0);
    expect(t.latestUnexplained).toBeNull();
    expect(t.previousUnexplained).toBeNull();
    expect(t.trend).toBe("insufficient-data");
    expect(t.sensitiveEverNonZero).toBe(false);
  });

  it("a single run is still insufficient-data for a trend", () => {
    const t = computeDriftTrend([snap("2026-06-10T00:00:00.000Z", [leaf({})])]);
    expect(t.totalRuns).toBe(1);
    expect(t.latestUnexplained).toBe(1);
    expect(t.previousUnexplained).toBeNull();
    expect(t.trend).toBe("insufficient-data");
  });

  it("sorts newest-first input oldest→newest and reads the trend off the last two", () => {
    const t = computeDriftTrend([
      snap("2026-06-12T00:00:00.000Z", [leaf({}), leaf({}), leaf({})]), // 3 unexplained (newest)
      snap("2026-06-11T00:00:00.000Z", [leaf({})]), // 1
      snap("2026-06-10T00:00:00.000Z", []), // 0 (oldest)
    ]);
    expect(t.runs.map((r) => r.savedAt)).toEqual([
      "2026-06-10T00:00:00.000Z",
      "2026-06-11T00:00:00.000Z",
      "2026-06-12T00:00:00.000Z",
    ]);
    expect(t.latestUnexplained).toBe(3);
    expect(t.previousUnexplained).toBe(1);
    expect(t.trend).toBe("up");
    expect(t.maxUnexplained).toBe(3);
  });

  it("detects a falling and a flat trend", () => {
    const down = computeDriftTrend([
      snap("2026-06-10T00:00:00.000Z", [leaf({}), leaf({})]),
      snap("2026-06-11T00:00:00.000Z", [leaf({})]),
    ]);
    expect(down.trend).toBe("down");

    const flat = computeDriftTrend([
      snap("2026-06-10T00:00:00.000Z", [leaf({})]),
      snap("2026-06-11T00:00:00.000Z", [leaf({ path: "host/etc/y" })]),
    ]);
    expect(flat.trend).toBe("flat");
  });

  it("splits explained vs unexplained and counts L1-only touches", () => {
    const t = computeDriftTrend([
      snap("2026-06-10T00:00:00.000Z", [
        leaf({ status: "explained" }),
        leaf({ status: "unexplained" }),
        leaf({ status: "unexplained", l1: true, l2: false, l3: false }), // L1-only touch
      ]),
    ]);
    const run = t.runs[0];
    expect(run.total).toBe(3);
    expect(run.explained).toBe(1);
    expect(run.unexplained).toBe(2);
    expect(run.l1OnlyTouches).toBe(1);
  });

  it("counts sensitive-path drift and raises the alarm flag", () => {
    const t = computeDriftTrend(
      [
        snap("2026-06-10T00:00:00.000Z", [
          leaf({ nodePath: "/etc/pve/storage.cfg" }),
          leaf({ nodePath: "/etc/hosts" }),
        ]),
      ],
      ["/etc/pve"]
    );
    expect(t.runs[0].sensitive).toBe(1);
    expect(t.sensitiveEverNonZero).toBe(true);
  });

  it("flags a freshly-seeded run", () => {
    const t = computeDriftTrend([snap("2026-06-10T00:00:00.000Z", [], { baselineSeeded: true })]);
    expect(t.runs[0].seeded).toBe(true);
    expect(t.runs[0].total).toBe(0);
  });

  it("ADR-018 §1: prefers `mode` and flags a seeded run via it", () => {
    const t = computeDriftTrend([snap("2026-06-10T00:00:00.000Z", [], { mode: "seeded" })]);
    expect(t.runs[0].seeded).toBe(true);
  });

  it("ADR-018 §1: a trailing seeded run does NOT become a clean 0-unexplained trend point", () => {
    // Two real comparisons (2 → 1 unexplained, a real 'down'), then a seed run that
    // reports 0. Without the fix the seed's 0 would read as 'down to 0 → flat-ish'
    // and mask the actual comparison series.
    const t = computeDriftTrend([
      snap("2026-06-10T00:00:00.000Z", [leaf({}), leaf({})]), // compared: 2 unexplained
      snap("2026-06-11T00:00:00.000Z", [leaf({})]), // compared: 1 unexplained
      snap("2026-06-12T00:00:00.000Z", [], { mode: "seeded", seededReason: "level-changed" }), // SEEDED: 0, no detection
    ]);
    // headline derives from the two compared runs, ignoring the seed
    expect(t.latestUnexplained).toBe(1);
    expect(t.previousUnexplained).toBe(2);
    expect(t.trend).toBe("down");
    expect(t.maxUnexplained).toBe(2);
    // the full series still carries the seed marker for the chart
    expect(t.totalRuns).toBe(3);
    expect(t.runs[2].seeded).toBe(true);
  });

  it("ADR-018 §1: a series of only seeded runs is insufficient-data (no real comparison)", () => {
    const t = computeDriftTrend([
      snap("2026-06-10T00:00:00.000Z", [], { mode: "seeded" }),
      snap("2026-06-11T00:00:00.000Z", [], { mode: "seeded" }),
    ]);
    expect(t.totalRuns).toBe(2);
    expect(t.latestUnexplained).toBeNull();
    expect(t.trend).toBe("insufficient-data");
  });
});
