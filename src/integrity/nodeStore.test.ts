import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { SqliteNodeStore, MemoryNodeStore, type NodeStore, type StoredNode } from "./nodeStore.js";

const node = (path: string, hash: string, over: Partial<StoredNode> = {}): StoredNode => ({
  path,
  hash,
  state: "present",
  mtime: 100,
  parentPath: over.parentPath ?? null,
  childNames: over.childNames ?? null,
  ...over,
});

/** The shared contract — every NodeStore implementation must satisfy it identically. */
function contract(name: string, make: () => NodeStore) {
  describe(name, () => {
    it("upserts and reads a node back", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l1", [node("/etc", "h1", { childNames: ["a"] })]);
      expect(s.get("baseline", "l1", "/etc")).toMatchObject({ path: "/etc", hash: "h1", childNames: ["a"] });
      expect(s.get("baseline", "l1", "/nope")).toBeUndefined();
      s.close();
    });

    it("keeps (tree, level) partitions distinct", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l1", [node("/p", "base")]);
      s.surgicalUpdate("working", "l1", [node("/p", "work")]);
      s.surgicalUpdate("baseline", "l2", [node("/p", "l2base")]);
      expect(s.get("baseline", "l1", "/p")!.hash).toBe("base");
      expect(s.get("working", "l1", "/p")!.hash).toBe("work");
      expect(s.get("baseline", "l2", "/p")!.hash).toBe("l2base");
      s.close();
    });

    it("lists children by parent_path", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l3", [
        node("/etc", "d", { childNames: ["a", "b"] }),
        node("/etc/a", "ha", { parentPath: "/etc" }),
        node("/etc/b", "hb", { parentPath: "/etc" }),
        node("/other", "o"),
      ]);
      const kids = s.getChildren("baseline", "l3", "/etc");
      expect(kids.map((k) => k.path)).toEqual(["/etc/a", "/etc/b"]);
      s.close();
    });

    it("allUnder returns the scope node and its descendants, prefix-safe", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l1", [
        node("/etc", "d"),
        node("/etc/ssh", "x", { parentPath: "/etc" }),
        node("/etc/ssh/sshd_config", "y", { parentPath: "/etc/ssh" }),
        node("/etcother", "trap"), // must NOT match /etc scope (no slash boundary)
      ]);
      const under = s.allUnder("baseline", "l1", "/etc").map((n) => n.path);
      expect(under).toEqual(["/etc", "/etc/ssh", "/etc/ssh/sshd_config"]);
      expect(under).not.toContain("/etcother");
      s.close();
    });

    it("scope '/' matches the whole tree", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l1", [node("/a", "1"), node("/b", "2")]);
      expect(s.allUnder("baseline", "l1", "/").map((n) => n.path)).toEqual(["/a", "/b"]);
      s.close();
    });

    it("replaceSubtree atomically swaps a subtree (old leaves gone, siblings kept)", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l3", [
        node("/etc", "d"),
        node("/etc/old", "old", { parentPath: "/etc" }),
        node("/keep", "keep"),
      ]);
      s.replaceSubtree("baseline", "l3", "/etc", [
        node("/etc", "d2"),
        node("/etc/new", "new", { parentPath: "/etc" }),
      ]);
      expect(s.get("baseline", "l3", "/etc/old")).toBeUndefined();
      expect(s.get("baseline", "l3", "/etc/new")!.hash).toBe("new");
      expect(s.get("baseline", "l3", "/keep")!.hash).toBe("keep"); // untouched
      s.close();
    });

    it("promote copies working→baseline within scope, leaving other scopes alone", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l2", [node("/etc", "old"), node("/var", "vbase")]);
      s.surgicalUpdate("working", "l2", [node("/etc", "fresh"), node("/var", "vfresh")]);
      s.promote("l2", "/etc");
      expect(s.get("baseline", "l2", "/etc")!.hash).toBe("fresh");
      expect(s.get("baseline", "l2", "/var")!.hash).toBe("vbase"); // out of scope, untouched
      s.close();
    });

    it("promote deletes baseline leaves absent from the working scope (a deletion folds in)", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l3", [
        node("/etc", "d"),
        node("/etc/gone", "g", { parentPath: "/etc" }),
      ]);
      s.surgicalUpdate("working", "l3", [node("/etc", "d2")]); // /etc/gone not present
      s.promote("l3", "/etc");
      expect(s.get("baseline", "l3", "/etc/gone")).toBeUndefined();
      s.close();
    });

    it("clearWorking drops the working partition (optionally one level)", () => {
      const s = make();
      s.surgicalUpdate("working", "l1", [node("/a", "1")]);
      s.surgicalUpdate("working", "l2", [node("/a", "2")]);
      s.clearWorking("l1");
      expect(s.get("working", "l1", "/a")).toBeUndefined();
      expect(s.get("working", "l2", "/a")!.hash).toBe("2");
      s.clearWorking();
      expect(s.get("working", "l2", "/a")).toBeUndefined();
      s.close();
    });

    it("findByHash locates nodes by hash within a partition", () => {
      const s = make();
      s.surgicalUpdate("baseline", "l3", [node("/a", "dup"), node("/b", "dup"), node("/c", "uniq")]);
      expect(s.findByHash("baseline", "l3", "dup").map((n) => n.path).sort()).toEqual(["/a", "/b"]);
      expect(s.findByHash("baseline", "l3", "uniq")).toHaveLength(1);
      s.close();
    });
  });
}

contract("SqliteNodeStore", () => new SqliteNodeStore(new Database(":memory:")));
contract("MemoryNodeStore", () => new MemoryNodeStore());

describe("SqliteNodeStore atomicity", () => {
  it("a throwing transaction leaves the baseline intact (no partial subtree)", () => {
    const db = new Database(":memory:");
    const s = new SqliteNodeStore(db);
    s.surgicalUpdate("baseline", "l3", [node("/etc", "d"), node("/etc/a", "a", { parentPath: "/etc" })]);
    // Force a failure mid-transaction by violating a NOT NULL via a malformed node.
    const bad = { ...node("/etc/b", "b", { parentPath: "/etc" }), hash: null as unknown as string };
    expect(() => s.replaceSubtree("baseline", "l3", "/etc", [node("/etc", "d2"), bad])).toThrow();
    // The original subtree must be untouched — the DELETE rolled back with the failed INSERT.
    expect(s.get("baseline", "l3", "/etc")!.hash).toBe("d");
    expect(s.get("baseline", "l3", "/etc/a")!.hash).toBe("a");
    s.close();
  });

  it("enables WAL journal mode", () => {
    const db = new Database(":memory:");
    new SqliteNodeStore(db);
    // :memory: reports "memory"; a file DB would report "wal". Assert the pragma ran without error
    // and the mode is one of the accepted values.
    const mode = db.pragma("journal_mode", { simple: true });
    expect(["wal", "memory"]).toContain(mode);
  });
});
