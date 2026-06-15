import { describe, it, expect } from "vitest";
import {
  assembleForest,
  buildForestEnumCommand,
  parseForestEnumeration,
  type SubtreeSource,
} from "./forest.js";
import { SUPER_ROOT } from "./tree.js";
import type { StoredNode } from "./nodeStore.js";
import type { EnumeratedEntry } from "./forestShape.js";

/** A fake source backed by in-memory entries + content. */
function fakeSource(
  prefix: string,
  entries: EnumeratedEntry[],
  content: Record<string, string>,
  opts: { available?: boolean } = {}
): SubtreeSource {
  return {
    prefix,
    available: async () => opts.available ?? true,
    enumerate: async () => entries,
    hashFiles: async (nodePaths) => {
      const m = new Map<string, string>();
      for (const p of nodePaths) if (content[p] !== undefined) m.set(p, content[p]);
      return m;
    },
  };
}

const f = (nodePath: string, mtime = 100): EnumeratedEntry => ({ nodePath, kind: "file", mtime, state: "present" });
const d = (nodePath: string): EnumeratedEntry => ({ nodePath, kind: "dir", mtime: 50, state: "present" });
const byPath = (ns: StoredNode[]) => new Map(ns.map((n) => [n.path, n]));

const GLOBS = ["**/*.conf", "**/*.yml"];

describe("assembleForest", () => {
  it("builds host + container subtrees under a super-root", async () => {
    const host = fakeSource("host", [d("/etc"), f("/etc/a.conf")], { "/etc/a.conf": "AA" });
    const ct = fakeSource("pct/101", [d("/etc"), f("/etc/b.conf")], { "/etc/b.conf": "BB" });
    const nodes = await assembleForest({ level: "l3", sources: [host, ct], configFileGlobs: GLOBS });
    const m = byPath(nodes);
    expect(m.get(SUPER_ROOT)!.childNames).toEqual(["host", "pct"]);
    expect(m.get("host/etc/a.conf")).toBeTruthy();
    expect(m.get("pct/101/etc/b.conf")).toBeTruthy();
  });

  it("L2 prunes non-config files; L3 keeps them (membership differs by level)", async () => {
    const host = fakeSource("host", [d("/etc"), f("/etc/app.conf"), f("/etc/data.bin")], {
      "/etc/app.conf": "C",
      "/etc/data.bin": "D",
    });
    const l2 = byPath(await assembleForest({ level: "l2", sources: [host], configFileGlobs: GLOBS }));
    const l3 = byPath(await assembleForest({ level: "l3", sources: [host], configFileGlobs: GLOBS }));
    expect(l2.get("host/etc/data.bin")).toBeUndefined(); // not config ⇒ pruned at L2
    expect(l2.get("host/etc/app.conf")).toBeTruthy();
    expect(l3.get("host/etc/data.bin")).toBeTruthy(); // full content ⇒ present at L3
  });

  it("L1 hashes by mtime — no content fetch is requested", async () => {
    let hashCalled = false;
    const host: SubtreeSource = {
      prefix: "host",
      available: async () => true,
      enumerate: async () => [d("/etc"), f("/etc/a.conf", 100)],
      hashFiles: async (paths) => {
        hashCalled = true;
        return new Map(paths.map((p) => [p, "x"]));
      },
    };
    await assembleForest({ level: "l1", sources: [host], configFileGlobs: GLOBS });
    expect(hashCalled).toBe(false);
  });

  it("a stopped guest freezes to its baseline and is marked unavailable (no mass-deletion)", async () => {
    const baselineNodes: StoredNode[] = [
      { path: "pct/101", hash: "FROZEN", state: "present", mtime: null, parentPath: "pct", childNames: ["etc"] },
      { path: "pct/101/etc", hash: "E", state: "present", mtime: 50, parentPath: "pct/101", childNames: [] },
    ];
    const ct = fakeSource("pct/101", [], {}, { available: false });
    const nodes = await assembleForest({
      level: "l3",
      sources: [ct],
      configFileGlobs: GLOBS,
      frozenBaseline: (prefix) => (prefix === "pct/101" ? baselineNodes : []),
    });
    const m = byPath(nodes);
    expect(m.get("pct/101")!.state).toBe("unavailable");
    expect(m.get("pct/101")!.hash).toBe("FROZEN"); // frozen at last-known hash
    expect(m.get("pct/101/etc")).toBeTruthy(); // children preserved, not deleted
  });

  it("a first-run stopped guest yields a single unavailable placeholder, never empty", async () => {
    const ct = fakeSource("pct/101", [], {}, { available: false });
    const nodes = await assembleForest({ level: "l3", sources: [ct], configFileGlobs: GLOBS });
    const m = byPath(nodes);
    expect(m.get("pct/101")!.state).toBe("unavailable");
  });
});

describe("buildForestEnumCommand", () => {
  it("emits a type/mtime/path find for the host", () => {
    expect(buildForestEnumCommand(["/etc", "/root"])).toBe(
      "find '/etc' '/root' -printf '%y\\t%T@\\t%p\\n' 2>/dev/null"
    );
  });
  it("wraps in pct exec for a container", () => {
    expect(buildForestEnumCommand(["/etc"], 101)).toContain("pct exec 101 -- sh -c");
  });
});

describe("parseForestEnumeration", () => {
  it("parses type letters into kinds, truncates mtime to whole seconds", () => {
    const out = parseForestEnumeration("d\t50.5\t/etc\nf\t100.9\t/etc/a\nl\t101\t/etc/link\n");
    expect(out).toEqual([
      { nodePath: "/etc", kind: "dir", mtime: 50, state: "present" },
      { nodePath: "/etc/a", kind: "file", mtime: 100, state: "present" },
      { nodePath: "/etc/link", kind: "file", mtime: 101, state: "present" },
    ]);
  });
  it("skips malformed and non-absolute lines", () => {
    expect(parseForestEnumeration("garbage\nf\t1\trelative/path\n")).toEqual([]);
  });
});
