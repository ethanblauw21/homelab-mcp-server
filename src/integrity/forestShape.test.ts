import { describe, it, expect } from "vitest";
import {
  synthesizeEntries,
  foldForestRoots,
  assertNonOverlap,
  toForestPath,
  toNodePath,
  type EnumeratedEntry,
} from "./forestShape.js";
import { assembleSubtree } from "./tree.js";
import { SUPER_ROOT } from "./tree.js";
import type { StoredNode } from "./nodeStore.js";

const ent = (nodePath: string, kind: "file" | "dir", mtime = 100): EnumeratedEntry => ({
  nodePath,
  kind,
  mtime,
  state: "present",
});

describe("toForestPath / toNodePath round-trip", () => {
  it("namespaces and de-namespaces on the prefix boundary", () => {
    expect(toForestPath("host", "/etc/ssh")).toBe("host/etc/ssh");
    expect(toForestPath("pct/101", "/etc")).toBe("pct/101/etc");
    expect(toNodePath("host", "host/etc/ssh")).toBe("/etc/ssh");
    expect(toNodePath("pct/101", "pct/101/etc")).toBe("/etc");
    expect(toNodePath("host", "host")).toBe("/");
  });
});

describe("synthesizeEntries", () => {
  it("creates the prefix root and fills ancestor gaps for a deep watch path", () => {
    const raw = synthesizeEntries("host", [ent("/var/lib/docker/daemon.json", "file")]);
    const paths = raw.map((r) => r.path).sort();
    expect(paths).toEqual([
      "host",
      "host/var",
      "host/var/lib",
      "host/var/lib/docker",
      "host/var/lib/docker/daemon.json",
    ]);
    // Synthesized ancestors are present dirs; the real leaf keeps its kind.
    expect(raw.find((r) => r.path === "host/var/lib")!.kind).toBe("dir");
    expect(raw.find((r) => r.path === "host/var/lib/docker/daemon.json")!.kind).toBe("file");
  });

  it("an empty enumeration still yields the prefix root", () => {
    expect(synthesizeEntries("pct/101", []).map((r) => r.path)).toEqual(["pct/101"]);
  });
});

describe("foldForestRoots", () => {
  // Two subtree roots under different groups: host (→ super-root) and pct/101 (→ pct → super-root).
  const hostNodes = assembleSubtree({
    level: "l3",
    rootPath: "host",
    entries: synthesizeEntries("host", [ent("/etc/a", "file")]),
    contentHash: () => "AA",
    isConfigFile: () => false,
  });
  const ctNodes = assembleSubtree({
    level: "l3",
    rootPath: "pct/101",
    entries: synthesizeEntries("pct/101", [ent("/etc/b", "file")]),
    contentHash: () => "BB",
    isConfigFile: () => false,
  });

  it("synthesizes the pct group dir and the super-root, folding both subtrees in", () => {
    const roots = foldForestRoots([...hostNodes, ...ctNodes]);
    const m = new Map(roots.map((n) => [n.path, n]));
    expect([...m.keys()].sort()).toEqual([SUPER_ROOT, "pct"]);
    expect(m.get(SUPER_ROOT)!.parentPath).toBeNull();
    expect(m.get(SUPER_ROOT)!.childNames).toEqual(["host", "pct"]);
    expect(m.get("pct")!.parentPath).toBe(SUPER_ROOT);
    expect(m.get("pct")!.childNames).toEqual(["101"]);
  });

  it("the super-root hash changes when a subtree changes (drift bubbles to the lab root)", () => {
    const base = foldForestRoots([...hostNodes, ...ctNodes]);
    const ctChanged = assembleSubtree({
      level: "l3",
      rootPath: "pct/101",
      entries: synthesizeEntries("pct/101", [ent("/etc/b", "file")]),
      contentHash: () => "BB-CHANGED",
      isConfigFile: () => false,
    });
    const changed = foldForestRoots([...hostNodes, ...ctChanged]);
    const rootHash = (ns: StoredNode[]) => ns.find((n) => n.path === SUPER_ROOT)!.hash;
    expect(rootHash(base)).not.toBe(rootHash(changed));
  });

  it("a single host source folds directly under the super-root (no group dir)", () => {
    const roots = foldForestRoots([...hostNodes]);
    expect(roots.map((n) => n.path)).toEqual([SUPER_ROOT]);
    expect(roots[0].childNames).toEqual(["host"]);
  });
});

describe("assertNonOverlap", () => {
  it("passes for disjoint sets", () => {
    expect(() => assertNonOverlap(["/etc", "/root"], ["/var/lib/vz"])).not.toThrow();
  });
  it("throws when a host watch path is the backing path or under it", () => {
    expect(() => assertNonOverlap(["/var/lib/vz"], ["/var/lib/vz"])).toThrow(/overlaps container-backing/);
    expect(() => assertNonOverlap(["/var/lib/vz/images"], ["/var/lib/vz"])).toThrow(/overlaps/);
  });
  it("does not false-match a sibling prefix", () => {
    expect(() => assertNonOverlap(["/var/lib/vzbackup"], ["/var/lib/vz"])).not.toThrow();
  });
});
