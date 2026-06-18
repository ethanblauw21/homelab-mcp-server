import { describe, it, expect } from "vitest";
import { assembleSubtree, parentForestPath, leafName, SUPER_ROOT, type RawEntry } from "./tree.js";
import type { StoredNode } from "./nodeStore.js";

const dir = (path: string, state: RawEntry["state"] = "present"): RawEntry => ({ path, kind: "dir", mtime: 50, state });
const file = (path: string, mtime = 100, state: RawEntry["state"] = "present"): RawEntry => ({
  path,
  kind: "file",
  mtime,
  state,
});

/** A simple content-hash table; missing key ⇒ unreadable content. */
const hashes = (m: Record<string, string>) => (p: string) => m[p];
const byPath = (nodes: StoredNode[]) => new Map(nodes.map((n) => [n.path, n]));

describe("parentForestPath / leafName", () => {
  it("derives parent and name on the / boundary", () => {
    expect(parentForestPath("host/etc/ssh")).toBe("host/etc");
    expect(parentForestPath("host")).toBe(SUPER_ROOT);
    expect(leafName("host/etc/ssh")).toBe("ssh");
    expect(leafName("host")).toBe("host");
  });
});

describe("assembleSubtree L3 (full content)", () => {
  const entries = [dir("host"), dir("host/etc"), file("host/etc/a"), file("host/etc/b")];

  it("folds every file, roots at SUPER_ROOT, links parents", () => {
    const nodes = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries,
      contentHash: hashes({ "host/etc/a": "AA", "host/etc/b": "BB" }),
      isConfigFile: () => false,
    });
    const m = byPath(nodes);
    expect(m.size).toBe(4);
    expect(m.get("host")!.parentPath).toBe(SUPER_ROOT);
    expect(m.get("host/etc")!.parentPath).toBe("host");
    expect(m.get("host/etc")!.childNames).toEqual(["a", "b"]);
    expect(m.get("host/etc/a")!.childNames).toBeNull(); // file leaf
  });

  it("a content change reroots the host subtree (bubbles up)", () => {
    const base = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries,
      contentHash: hashes({ "host/etc/a": "AA", "host/etc/b": "BB" }),
      isConfigFile: () => false,
    });
    const changed = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries,
      contentHash: hashes({ "host/etc/a": "AA-CHANGED", "host/etc/b": "BB" }),
      isConfigFile: () => false,
    });
    expect(byPath(base).get("host")!.hash).not.toBe(byPath(changed).get("host")!.hash);
  });

  it("a file with no content hash folds as unreadable, not empty", () => {
    const nodes = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries: [dir("host"), file("host/secret")],
      contentHash: hashes({}), // nothing readable
      isConfigFile: () => false,
    });
    const m = byPath(nodes);
    // its hash should equal the unreadable sentinel leaf, distinct from a readable file
    const readable = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries: [dir("host"), file("host/secret")],
      contentHash: hashes({ "host/secret": "ok" }),
      isConfigFile: () => false,
    });
    expect(m.get("host/secret")!.hash).not.toBe(byPath(readable).get("host/secret")!.hash);
  });
});

describe("assembleSubtree L1 (mtime)", () => {
  const entries = [dir("host"), file("host/etc")];
  it("uses mtime as the payload — content is irrelevant, mtime drives the hash", () => {
    const t1 = assembleSubtree({ level: "l1", rootPath: "host", entries, contentHash: hashes({}), isConfigFile: () => false });
    const entries2 = [dir("host"), file("host/etc", 999)];
    const t2 = assembleSubtree({ level: "l1", rootPath: "host", entries: entries2, contentHash: hashes({}), isConfigFile: () => false });
    expect(byPath(t1).get("host/etc")!.hash).not.toBe(byPath(t2).get("host/etc")!.hash);
  });
});

describe("assembleSubtree L2 (config subset)", () => {
  const entries = [
    dir("host"),
    dir("host/etc"),
    file("host/etc/sshd_config"),
    dir("host/etc/cache"),
    file("host/etc/cache/blob.bin"),
  ];
  const isConfig = (p: string) => p.endsWith("_config") || p.endsWith(".yml");

  it("prunes dirs with no config descendant; keeps the config path-to-root", () => {
    const nodes = assembleSubtree({
      level: "l2",
      rootPath: "host",
      entries,
      contentHash: hashes({ "host/etc/sshd_config": "S", "host/etc/cache/blob.bin": "B" }),
      isConfigFile: isConfig,
    });
    const paths = nodes.map((n) => n.path).sort();
    expect(paths).toEqual(["host", "host/etc", "host/etc/sshd_config"]);
    // the cache dir + blob were pruned (not config); host/etc lists only the config child
    expect(byPath(nodes).get("host/etc")!.childNames).toEqual(["sshd_config"]);
  });

  it("a config-empty subtree still yields the root as an empty dir", () => {
    const nodes = assembleSubtree({
      level: "l2",
      rootPath: "host",
      entries: [dir("host"), dir("host/etc"), file("host/etc/blob.bin")],
      contentHash: hashes({ "host/etc/blob.bin": "B" }),
      isConfigFile: isConfig,
    });
    expect(nodes.map((n) => n.path)).toEqual(["host"]);
    expect(nodes[0].state).toBe("empty-dir");
  });
});

describe("assembleSubtree node states", () => {
  it("an unreadable directory folds to the unreadable sentinel", () => {
    const nodes = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries: [dir("host"), dir("host/locked", "unreadable")],
      contentHash: hashes({}),
      isConfigFile: () => false,
    });
    expect(byPath(nodes).get("host/locked")!.state).toBe("unreadable");
  });

  it("an empty present directory is marked empty-dir", () => {
    const nodes = assembleSubtree({
      level: "l3",
      rootPath: "host",
      entries: [dir("host"), dir("host/empty")],
      contentHash: hashes({}),
      isConfigFile: () => false,
    });
    expect(byPath(nodes).get("host/empty")!.state).toBe("empty-dir");
  });
});
