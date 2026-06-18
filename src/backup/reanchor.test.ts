import { describe, it, expect } from "vitest";
import { selectBackupKind, contentHash, classifyRevertibility, applyReverseDiff } from "./policy.js";
import zlib from "zlib";
import { promisify } from "util";

const gunzip = promisify(zlib.gunzip);

function makeInput(overrides: Partial<Parameters<typeof selectBackupKind>[0]> = {}) {
  return {
    newContent: Buffer.from("new content"),
    prevContent: Buffer.from("old content"),
    prevHash: contentHash(Buffer.from("old content")),
    isText: true,
    largeFileBytesThreshold: 1024 * 1024,
    largeFilePolicy: "diff" as const,
    existingHashToPaths: new Map<string, string>(),
    ...overrides,
  };
}

describe("ADR-014 §2 — re-anchor on out-of-band drift", () => {
  it("no chainBaseHash → ordinary delta (first-write path is unchanged)", async () => {
    const kind = await selectBackupKind(makeInput({ chainBaseHash: undefined }));
    expect(kind.type).toBe("gzip-diff");
    if (kind.type === "gzip-diff") {
      // requiresBaseHash is the new content's hash (the delta's base requirement).
      expect(kind.requiresBaseHash).toBe(contentHash(Buffer.from("new content")));
    }
  });

  it("chainBaseHash matches prevHash (no drift) → ordinary delta", async () => {
    const prevContent = Buffer.from("old content");
    const kind = await selectBackupKind(
      makeInput({ prevContent, prevHash: contentHash(prevContent), chainBaseHash: contentHash(prevContent) })
    );
    expect(kind.type).toBe("gzip-diff");
  });

  it("chainBaseHash differs from prevHash (out-of-band drift) → re-anchor gzip-full of prevContent", async () => {
    const prevContent = Buffer.from("DRIFTED out-of-band content");
    const kind = await selectBackupKind(
      makeInput({
        prevContent,
        prevHash: contentHash(prevContent),
        chainBaseHash: "a".repeat(64), // what we last wrote — no longer what is on disk
      })
    );
    expect(kind.type).toBe("gzip-full");
    if (kind.type === "gzip-full") {
      expect(kind.reanchored).toBe(true);
      // The snapshot holds the DRIFTED prevContent, self-contained (no base needed).
      const stored = await gunzip(kind.blob);
      expect(stored.equals(prevContent)).toBe(true);
      const restored = await applyReverseDiff(kind.blob);
      expect(restored.equals(prevContent)).toBe(true);
    }
  });

  it("drift on a large text file also re-anchors (not a delta)", async () => {
    const prevContent = Buffer.from("x".repeat(2000));
    const kind = await selectBackupKind(
      makeInput({
        newContent: Buffer.from("y".repeat(2000)),
        prevContent,
        prevHash: contentHash(prevContent),
        isText: true,
        largeFileBytesThreshold: 1024, // force the large-file branch
        chainBaseHash: "b".repeat(64),
      })
    );
    expect(kind.type).toBe("gzip-full");
    if (kind.type === "gzip-full") expect(kind.reanchored).toBe(true);
  });

  it("dedup still wins over the drift check (identical re-write)", async () => {
    const newContent = Buffer.from("same bytes");
    const existingHashToPaths = new Map([[contentHash(newContent), "/backups/x.gz"]]);
    const kind = await selectBackupKind(
      makeInput({ newContent, existingHashToPaths, chainBaseHash: "c".repeat(64) })
    );
    expect(kind.type).toBe("dedup");
  });

  it("no prevHash (new file) never re-anchors even with a chain set", async () => {
    const kind = await selectBackupKind(
      makeInput({ prevContent: null, prevHash: null, chainBaseHash: "d".repeat(64) })
    );
    expect(kind.type).toBe("gzip-full");
    if (kind.type === "gzip-full") expect(kind.reanchored ?? false).toBe(false);
  });
});

describe("ADR-014 §1 — classifyRevertibility", () => {
  it("metadata-only is never revertible", () => {
    const v = classifyRevertibility({ kind: "metadata-only" }, "abc");
    expect(v.revertible).toBe(false);
    expect(v.reason).toMatch(/no content stored/i);
  });

  it("self-contained (requiresBaseHash null) is always revertible, even on a drifted file", () => {
    expect(classifyRevertibility({ kind: "gzip-full", requiresBaseHash: null }, "deadbeef").revertible).toBe(true);
    expect(classifyRevertibility({ kind: "gzip-diff", requiresBaseHash: null }, "deadbeef").revertible).toBe(true);
  });

  it("delta is revertible only while the live file matches its base", () => {
    const ok = classifyRevertibility({ kind: "gzip-diff", requiresBaseHash: "base12345" }, "base12345");
    expect(ok.revertible).toBe(true);

    const stale = classifyRevertibility({ kind: "gzip-diff", requiresBaseHash: "base12345" }, "otherhash");
    expect(stale.revertible).toBe(false);
    expect(stale.reason).toMatch(/edited out-of-band|no longer be applied/i);
  });

  it("delta on an unreadable/missing file is non-revertible (unverifiable)", () => {
    const v = classifyRevertibility({ kind: "gzip-diff", requiresBaseHash: "base12345" }, null);
    expect(v.revertible).toBe(false);
    expect(v.reason).toMatch(/unreadable or missing/i);
  });

  it("legacy gzip-diff (no requiresBaseHash) falls back to requiring meta.hash as the base", () => {
    // Conservative degradation: a legacy delta envelope's baseHash equals meta.hash.
    expect(classifyRevertibility({ kind: "gzip-diff", hash: "H" }, "H").revertible).toBe(true);
    expect(classifyRevertibility({ kind: "gzip-diff", hash: "H" }, "DRIFTED").revertible).toBe(false);
  });

  it("legacy gzip-full (no requiresBaseHash) is treated as self-contained", () => {
    expect(classifyRevertibility({ kind: "gzip-full", hash: "H" }, "anything").revertible).toBe(true);
  });

  it("unknown legacy kind is treated as self-contained (the restore is still guarded)", () => {
    expect(classifyRevertibility({ kind: "unknown" }, null).revertible).toBe(true);
  });
});
