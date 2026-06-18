import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { contentLeafHash } from "./leafHash.js";
import { assembleSubtree } from "./tree.js";

/**
 * The whole point of contentLeafHash is that a write handler stamps the SAME hash the
 * forest will later compute for that file's content leaf — otherwise the explained
 * classification never lands. These tests pin that equality at both L2 and L3.
 */
describe("contentLeafHash bridges the write family to the forest", () => {
  function forestLeafHash(content: Buffer, level: "l2" | "l3"): string {
    const contentHex = crypto.createHash("sha256").update(content).digest("hex");
    const nodes = assembleSubtree({
      level,
      rootPath: "host",
      entries: [
        { path: "host", kind: "dir", mtime: 1, state: "present" },
        { path: "host/app.conf", kind: "file", mtime: 2, state: "present" },
      ],
      contentHash: (p) => (p === "host/app.conf" ? contentHex : undefined),
      isConfigFile: () => true, // ".conf" so it survives L2 pruning
    });
    return nodes.find((n) => n.path === "host/app.conf")!.hash;
  }

  it("equals the forest's L3 content leaf for the same bytes", () => {
    const content = Buffer.from("listen 8080\nroot /srv\n");
    expect(contentLeafHash(content)).toBe(forestLeafHash(content, "l3"));
  });

  it("equals the forest's L2 content leaf (L2 and L3 share the content payload)", () => {
    const content = Buffer.from("key=value");
    expect(contentLeafHash(content)).toBe(forestLeafHash(content, "l2"));
  });

  it("is deterministic and content-sensitive", () => {
    expect(contentLeafHash(Buffer.from("a"))).toBe(contentLeafHash(Buffer.from("a")));
    expect(contentLeafHash(Buffer.from("a"))).not.toBe(contentLeafHash(Buffer.from("b")));
  });
});
