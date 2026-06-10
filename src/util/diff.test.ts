import { describe, it, expect } from "vitest";
import { computeUnifiedDiff } from "./diff.js";

describe("computeUnifiedDiff", () => {
  it("reports no changes for identical content", () => {
    const r = computeUnifiedDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(r.addedLines).toBe(0);
    expect(r.removedLines).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("detects a single changed line as one removal + one addition", () => {
    const r = computeUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(r.removedLines).toBe(1);
    expect(r.addedLines).toBe(1);
    expect(r.diff).toContain("- b");
    expect(r.diff).toContain("+ B");
    expect(r.diff).toContain("  a");
    expect(r.diff).toContain("  c");
  });

  it("treats a brand-new file as all additions", () => {
    const r = computeUnifiedDiff("", "x\ny\n");
    expect(r.addedLines).toBe(2);
    expect(r.removedLines).toBe(0);
  });

  it("treats a full deletion as all removals", () => {
    const r = computeUnifiedDiff("x\ny\n", "");
    expect(r.removedLines).toBe(2);
    expect(r.addedLines).toBe(0);
  });

  it("preserves common context lines around a change (LCS)", () => {
    const r = computeUnifiedDiff("1\n2\n3\n4\n", "1\n2\nX\n4\n");
    expect(r.removedLines).toBe(1);
    expect(r.addedLines).toBe(1);
  });

  it("truncates at the configured line cap", () => {
    const prev = "";
    const next = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const r = computeUnifiedDiff(prev, next, 10);
    expect(r.truncated).toBe(true);
    expect(r.diff).toMatch(/truncated/);
    // addedLines counts the full change, not the truncated view
    expect(r.addedLines).toBe(50);
  });
});
