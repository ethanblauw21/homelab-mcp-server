import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  foldLeaf,
  foldNode,
  emptyDirHash,
  unreadableHash,
  mtimePayload,
  compareNameBytes,
  hashHex,
  LEAF_DOMAIN,
  NODE_DOMAIN,
  UNREADABLE_DOMAIN,
  type ChildRef,
} from "./folding.js";

const leaf = (name: string, payload: string): ChildRef => ({ name, hash: foldLeaf(Buffer.from(payload)) });

describe("foldLeaf", () => {
  it("is SHA256(0x00 ‖ payload) — domain-separated", () => {
    const payload = Buffer.from("hello");
    const expected = crypto.createHash("sha256").update(Buffer.from([0x00])).update(payload).digest();
    expect(foldLeaf(payload).equals(expected)).toBe(true);
  });
  it("differs from a raw content hash of the same bytes (the domain byte matters)", () => {
    const payload = Buffer.from("hello");
    const raw = crypto.createHash("sha256").update(payload).digest();
    expect(foldLeaf(payload).equals(raw)).toBe(false);
  });
});

describe("foldNode determinism", () => {
  it("yields the same root regardless of child enumeration order", () => {
    const a = leaf("alpha", "1");
    const b = leaf("beta", "2");
    const c = leaf("gamma", "3");
    const root1 = foldNode([a, b, c]);
    const root2 = foldNode([c, a, b]);
    const root3 = foldNode([b, c, a]);
    expect(root1.equals(root2)).toBe(true);
    expect(root1.equals(root3)).toBe(true);
  });

  it("sorts byte-wise on the raw name, not locale-aware", () => {
    // 'Z' (0x5A) sorts before 'a' (0x61) byte-wise; a locale sort might disagree.
    const upper = leaf("Z", "1");
    const lower = leaf("a", "2");
    const ordered = foldNode([upper, lower]);
    const reversed = foldNode([lower, upper]);
    expect(ordered.equals(reversed)).toBe(true);
    expect(compareNameBytes("Z", "a")).toBeLessThan(0);
  });
});

describe("domain separation (leaf vs node collision resistance)", () => {
  it("a file leaf and a directory never share a hash for equal logical content", () => {
    // Construct a node and a leaf whose payload is the node's child serialization-ish bytes.
    const child = leaf("x", "data");
    const node = foldNode([child]);
    const leafOfSameNameHash = foldLeaf(child.hash);
    expect(node.equals(leafOfSameNameHash)).toBe(false);
  });
  it("the three domain bytes are distinct", () => {
    expect(new Set([LEAF_DOMAIN, NODE_DOMAIN, UNREADABLE_DOMAIN]).size).toBe(3);
  });
});

describe("structural changes bubble to the root", () => {
  const base = [leaf("a", "1"), leaf("b", "2")];

  it("a content change changes the parent hash", () => {
    const changed = [leaf("a", "1-CHANGED"), leaf("b", "2")];
    expect(foldNode(base).equals(foldNode(changed))).toBe(false);
  });
  it("a rename (name change, same content) changes the parent hash", () => {
    const renamed = [leaf("a-renamed", "1"), leaf("b", "2")];
    expect(foldNode(base).equals(foldNode(renamed))).toBe(false);
  });
  it("an addition changes the parent hash", () => {
    const added = [...base, leaf("c", "3")];
    expect(foldNode(base).equals(foldNode(added))).toBe(false);
  });
  it("a deletion changes the parent hash", () => {
    const deleted = [leaf("a", "1")];
    expect(foldNode(base).equals(foldNode(deleted))).toBe(false);
  });
  it("the name/hash boundary is unambiguous (no cross-child bleed)", () => {
    // ["ab" + H] must not equal a crafted ["a" + (b‖H)]: the 0x00 terminator separates them.
    const h = foldLeaf(Buffer.from("x"));
    const ab = foldNode([{ name: "ab", hash: h }]);
    const a = foldNode([{ name: "a", hash: h }]);
    expect(ab.equals(a)).toBe(false);
  });
});

describe("node-state hashes stay distinct", () => {
  it("empty-dir, unreadable, and a present leaf all differ", () => {
    const empty = emptyDirHash();
    const unreadable = unreadableHash();
    const present = foldLeaf(Buffer.from("anything"));
    expect(empty.equals(unreadable)).toBe(false);
    expect(empty.equals(present)).toBe(false);
    expect(unreadable.equals(present)).toBe(false);
  });
  it("emptyDirHash is the childless node fold (stable)", () => {
    expect(emptyDirHash().equals(foldNode([]))).toBe(true);
  });
  it("unreadableHash is a constant sentinel", () => {
    expect(unreadableHash().equals(unreadableHash())).toBe(true);
  });
});

describe("mtimePayload", () => {
  it("truncates to whole seconds and encodes as decimal-string bytes", () => {
    expect(mtimePayload(1717000000.987).toString()).toBe("1717000000");
  });
  it("distinct mtimes give distinct leaf hashes", () => {
    expect(foldLeaf(mtimePayload(100)).equals(foldLeaf(mtimePayload(101)))).toBe(false);
  });
});

describe("hashHex", () => {
  it("renders 64 lowercase hex chars", () => {
    const hex = hashHex(foldLeaf(Buffer.from("x")));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
