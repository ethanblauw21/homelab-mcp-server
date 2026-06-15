import { describe, it, expect } from "vitest";
import { treeDiff, viewOf, storeView, escalationTargets, type DriftEntry } from "./diff.js";
import { MemoryNodeStore, type StoredNode } from "./nodeStore.js";

const n = (path: string, hash: string, over: Partial<StoredNode> = {}): StoredNode => ({
  path,
  hash,
  state: "present",
  mtime: 100,
  parentPath: over.parentPath ?? null,
  childNames: over.childNames ?? null,
  ...over,
});

// A tiny forest: super-root "" → "host" → "host/etc" → {a, b}
const tree = (etcHash: string, aHash: string, bHash: string): StoredNode[] => [
  n("", "root-" + etcHash, { childNames: ["host"] }),
  n("host", "host-" + etcHash, { parentPath: "", childNames: ["etc"] }),
  n("host/etc", etcHash, { parentPath: "host", childNames: ["a", "b"] }),
  n("host/etc/a", aHash, { parentPath: "host/etc" }),
  n("host/etc/b", bHash, { parentPath: "host/etc" }),
];

const kinds = (d: DriftEntry[]) => d.map((e) => `${e.kind}:${e.path}`).sort();

describe("treeDiff short-circuit", () => {
  it("identical trees yield no drift (root hash matches, never descends)", () => {
    const base = tree("E", "A", "B");
    const work = tree("E", "A", "B");
    expect(treeDiff(viewOf(base), viewOf(work), "")).toEqual([]);
  });

  it("an unchanged sibling subtree is pruned; only the changed leaf reports", () => {
    const base = tree("E1", "A", "B");
    const work = tree("E2", "A-CHANGED", "B"); // only a changed; b identical
    const d = treeDiff(viewOf(base), viewOf(work), "");
    expect(kinds(d)).toEqual(["changed:host/etc/a"]);
  });
});

describe("treeDiff add / remove / state", () => {
  it("reports an added leaf", () => {
    const base = [n("", "r0", { childNames: [] })];
    const work = [n("", "r1", { childNames: ["x"] }), n("x", "X", { parentPath: "" })];
    expect(kinds(treeDiff(viewOf(base), viewOf(work), ""))).toEqual(["added:x"]);
  });

  it("reports a removed leaf", () => {
    const base = [n("", "r1", { childNames: ["x"] }), n("x", "X", { parentPath: "" })];
    const work = [n("", "r0", { childNames: [] })];
    expect(kinds(treeDiff(viewOf(base), viewOf(work), ""))).toEqual(["removed:x"]);
  });

  it("distinguishes a state change (present→unreadable) from a content change", () => {
    const base = tree("E1", "A", "B");
    const work = tree("E2", "A", "B");
    work[3] = n("host/etc/a", "Z", { parentPath: "host/etc", state: "unreadable" });
    const d = treeDiff(viewOf(base), viewOf(work), "");
    expect(d.find((e) => e.path === "host/etc/a")!.kind).toBe("state-changed");
  });
});

describe("treeDiff over a NodeStore partition", () => {
  it("diffs baseline vs working through storeView", () => {
    const s = new MemoryNodeStore();
    s.surgicalUpdate("baseline", "l3", tree("E1", "A", "B"));
    s.surgicalUpdate("working", "l3", tree("E2", "A2", "B"));
    const d = treeDiff(storeView(s, "baseline", "l3"), storeView(s, "working", "l3"), "");
    expect(kinds(d)).toEqual(["changed:host/etc/a"]);
  });
});

describe("escalationTargets", () => {
  it("collects added/changed/state-changed leaves, drops removed", () => {
    const l1: DriftEntry[] = [
      { path: "host/etc/a", kind: "changed" },
      { path: "host/etc/b", kind: "added" },
      { path: "host/etc/c", kind: "removed" },
      { path: "host/etc/d", kind: "state-changed" },
    ];
    expect(escalationTargets(l1)).toEqual(["host/etc/a", "host/etc/b", "host/etc/d"]);
  });

  it("an empty L1 diff escalates nothing (the cheap tripwire stayed quiet)", () => {
    expect(escalationTargets([])).toEqual([]);
  });
});
