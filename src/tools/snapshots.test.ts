import { describe, it, expect } from "vitest";
import {
  isMcpSnapshot,
  sanitizeSnapshotName,
  generateSnapshotName,
  parseSnapshotList,
  planSnapshotEviction,
  buildSnapshotCreateCommand,
  buildSnapshotRollbackCommand,
  buildSnapshotDeleteCommand,
  buildSnapshotListCommand,
  buildGuestStatusCommand,
} from "./snapshots.js";

describe("snapshots — ownership boundary", () => {
  it("isMcpSnapshot only matches the mcp- prefix", () => {
    expect(isMcpSnapshot("mcp-20260609-213000")).toBe(true);
    expect(isMcpSnapshot("preupgrade")).toBe(false);
    expect(isMcpSnapshot("my-mcp-thing")).toBe(false);
  });
});

describe("snapshots — name generation", () => {
  it("generates a sanitized, prefixed, UTC-based name", () => {
    const name = generateSnapshotName(new Date(Date.UTC(2026, 5, 9, 21, 30, 0)));
    expect(name).toBe("mcp-20260609-213000");
    expect(isMcpSnapshot(name)).toBe(true);
  });

  it("zero-pads single-digit components", () => {
    const name = generateSnapshotName(new Date(Date.UTC(2026, 0, 3, 4, 5, 6)));
    expect(name).toBe("mcp-20260103-040506");
  });

  it("sanitizeSnapshotName strips disallowed chars and ensures a leading letter", () => {
    expect(sanitizeSnapshotName("mcp-abc")).toBe("mcp-abc");
    expect(sanitizeSnapshotName("9bad")).toBe("s9bad");
    expect(sanitizeSnapshotName("a b/c")).toBe("a-b-c");
  });
});

describe("snapshots — listsnapshot parsing", () => {
  it("parses pct listsnapshot tree output and flags mcp-managed", () => {
    const out = [
      "`-> preupgrade            2026-06-01 12:00:00     manual before upgrade",
      "`-> mcp-20260609-213000   2026-06-09 21:30:00     automated checkpoint",
      "`-> current                                       You are here!",
    ].join("\n");
    const snaps = parseSnapshotList(out);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toMatchObject({ name: "preupgrade", mcpManaged: false });
    expect(snaps[1]).toMatchObject({ name: "mcp-20260609-213000", mcpManaged: true });
    expect(snaps.find((s) => s.name === "current")).toBeUndefined();
  });

  it("parses qm listsnapshot output", () => {
    const out = "`-> mcp-20260101-000000 2026-01-01 00:00:00 checkpoint";
    const snaps = parseSnapshotList(out);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.mcpManaged).toBe(true);
  });
});

describe("snapshots — retention planner", () => {
  it("evicts oldest mcp- snapshots to stay within cap after the incoming one", () => {
    const names = ["mcp-20260101-000000", "mcp-20260102-000000", "mcp-20260103-000000"];
    // cap 3, 3 existing, 1 incoming → must drop the single oldest
    expect(planSnapshotEviction(names, 3)).toEqual(["mcp-20260101-000000"]);
  });

  it("does not evict when under cap", () => {
    expect(planSnapshotEviction(["mcp-20260101-000000"], 3)).toEqual([]);
  });

  it("evicts multiple when far over cap", () => {
    const names = ["a-1", "a-2", "a-3", "a-4"].map((s) => `mcp-${s}`);
    // cap 2, incoming 1 → allowed 1 → drop oldest 3
    expect(planSnapshotEviction(names, 2)).toEqual(["mcp-a-1", "mcp-a-2", "mcp-a-3"]);
  });
});

describe("snapshots — command builders", () => {
  it("builds container create without --vmstate", () => {
    expect(buildSnapshotCreateCommand("pct", 101, "mcp-x", { description: "note" })).toBe(
      "pct snapshot 101 mcp-x --description 'note'"
    );
  });

  it("builds VM create with --vmstate following config (A3.2)", () => {
    expect(buildSnapshotCreateCommand("qm", 200, "mcp-x", { vmstate: false })).toBe(
      "qm snapshot 200 mcp-x --vmstate 0"
    );
    expect(buildSnapshotCreateCommand("qm", 200, "mcp-x", { vmstate: true })).toBe(
      "qm snapshot 200 mcp-x --vmstate 1"
    );
  });

  it("builds list/rollback/delete/status commands", () => {
    expect(buildSnapshotListCommand("pct", 101)).toBe("pct listsnapshot 101");
    expect(buildSnapshotRollbackCommand("qm", 200, "mcp-x")).toBe("qm rollback 200 mcp-x");
    expect(buildSnapshotDeleteCommand("pct", 101, "mcp-x")).toBe("pct delsnapshot 101 mcp-x");
    expect(buildGuestStatusCommand("qm", 200)).toBe("qm status 200");
  });
});
