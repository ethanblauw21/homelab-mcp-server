import { describe, it, expect } from "vitest";
import { computeAuditStats, toolFamily } from "./auditStats.js";
import type { AuditRecord, AuditTool } from "../audit/record.js";

/** ADR-015 §1 — pure audit statistics: families, buckets, windows, silent-failure signals. */

let seq = 0;
function rec(tool: AuditTool, ts: string, extra: Partial<AuditRecord> = {}): AuditRecord {
  return { id: `id-${seq++}`, ts, tool, ...extra };
}

describe("toolFamily", () => {
  it("classifies the four families and falls back to 'other'", () => {
    expect(toolFamily("write_file")).toBe("write");
    expect(toolFamily("revert_file")).toBe("write");
    expect(toolFamily("docker_edit_file")).toBe("write");
    expect(toolFamily("execute")).toBe("exec");
    expect(toolFamily("qm_exec")).toBe("exec");
    expect(toolFamily("read_file")).toBe("read");
    expect(toolFamily("list_directory")).toBe("read");
    expect(toolFamily("snapshot_create")).toBe("other");
    expect(toolFamily("verify_integrity")).toBe("other");
  });
});

describe("computeAuditStats", () => {
  it("returns an all-zero shape for no records", () => {
    const s = computeAuditStats([]);
    expect(s.total).toBe(0);
    expect(s.throughput).toEqual([]);
    expect(s.family).toEqual({ write: 0, exec: 0, read: 0, other: 0 });
    expect(s.historyMissRate).toBe(0);
    expect(s.unknownScopeRate).toBe(0);
    expect(s.bucket).toBe("day");
  });

  it("tallies family counts and a per-tool histogram", () => {
    const s = computeAuditStats([
      rec("write_file", "2026-06-10T01:00:00.000Z"),
      rec("write_file", "2026-06-10T02:00:00.000Z"),
      rec("execute", "2026-06-10T03:00:00.000Z"),
      rec("read_file", "2026-06-10T04:00:00.000Z"),
      rec("snapshot_create", "2026-06-10T05:00:00.000Z"),
    ]);
    expect(s.total).toBe(5);
    expect(s.family).toEqual({ write: 2, exec: 1, read: 1, other: 1 });
    expect(s.byTool.write_file).toBe(2);
    expect(s.byTool.execute).toBe(1);
  });

  it("buckets throughput by day (default) chronologically", () => {
    const s = computeAuditStats([
      rec("execute", "2026-06-11T10:00:00.000Z"),
      rec("write_file", "2026-06-10T10:00:00.000Z"),
      rec("write_file", "2026-06-10T23:59:00.000Z"),
    ]);
    expect(s.throughput.map((t) => t.bucket)).toEqual(["2026-06-10", "2026-06-11"]);
    expect(s.throughput[0]).toMatchObject({ bucket: "2026-06-10", total: 2, write: 2 });
    expect(s.throughput[1]).toMatchObject({ bucket: "2026-06-11", total: 1, exec: 1 });
  });

  it("buckets by hour when asked", () => {
    const s = computeAuditStats(
      [
        rec("execute", "2026-06-10T10:15:00.000Z"),
        rec("execute", "2026-06-10T10:45:00.000Z"),
        rec("execute", "2026-06-10T11:05:00.000Z"),
      ],
      { bucket: "hour" }
    );
    expect(s.bucket).toBe("hour");
    expect(s.throughput.map((t) => t.bucket)).toEqual(["2026-06-10T10", "2026-06-10T11"]);
    expect(s.throughput[0].total).toBe(2);
  });

  it("applies the inclusive ISO window", () => {
    const s = computeAuditStats(
      [
        rec("execute", "2026-06-09T10:00:00.000Z"),
        rec("execute", "2026-06-10T10:00:00.000Z"),
        rec("execute", "2026-06-11T10:00:00.000Z"),
      ],
      { window: { since: "2026-06-10T00:00:00.000Z", until: "2026-06-10T23:59:59.000Z" } }
    );
    expect(s.total).toBe(1);
    expect(s.windowSince).toBe("2026-06-10T00:00:00.000Z");
    expect(s.windowUntil).toBe("2026-06-10T23:59:59.000Z");
  });

  it("counts change-weight and gate-activity flags", () => {
    const s = computeAuditStats([
      rec("write_file", "2026-06-10T01:00:00.000Z", { isLargeChange: true }),
      rec("execute", "2026-06-10T02:00:00.000Z", { isHeavy: true, confirmGated: true }),
      rec("write_file", "2026-06-10T03:00:00.000Z", { rootTier: true }),
    ]);
    expect(s.largeChangeCount).toBe(1);
    expect(s.heavyCount).toBe(1);
    expect(s.confirmGatedCount).toBe(1);
    expect(s.rootTierCount).toBe(1);
  });

  it("surfaces the silent-failure signals (history miss, timeout, signal kill)", () => {
    const s = computeAuditStats([
      rec("write_file", "2026-06-10T01:00:00.000Z", { historyCommitted: true }),
      rec("write_file", "2026-06-10T02:00:00.000Z", { historyCommitted: false }),
      rec("pct_write_file", "2026-06-10T03:00:00.000Z", { historyCommitted: false }),
      rec("execute", "2026-06-10T04:00:00.000Z", { timedOut: true, exitCode: 124 }),
      rec("execute", "2026-06-10T05:00:00.000Z", { exitCode: null }),
    ]);
    expect(s.historyEligibleCount).toBe(3);
    expect(s.historyMissCount).toBe(2);
    expect(s.historyMissRate).toBeCloseTo(2 / 3);
    expect(s.timedOutCount).toBe(1);
    expect(s.signalKillCount).toBe(1);
  });

  it("computes the unknown-scope exec rate (the drift blind spot)", () => {
    const s = computeAuditStats([
      rec("execute", "2026-06-10T01:00:00.000Z", { hashScope: "unknown" }),
      rec("pct_exec", "2026-06-10T02:00:00.000Z", { hashScope: "unknown" }),
      rec("qm_exec", "2026-06-10T03:00:00.000Z", { hashScope: "/etc/x" }),
      rec("write_file", "2026-06-10T04:00:00.000Z", { hashScope: "/etc/y" }),
    ]);
    expect(s.execTotal).toBe(3);
    expect(s.unknownScopeCount).toBe(2);
    expect(s.unknownScopeRate).toBeCloseTo(2 / 3);
  });
});
