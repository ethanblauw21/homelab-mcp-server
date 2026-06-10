import { describe, it, expect } from "vitest";
import { selectBackupKind, contentHash, isTextContent, applyReverseDiff } from "./policy.js";
import zlib from "zlib";
import { promisify } from "util";

const gunzip = promisify(zlib.gunzip);

const THRESHOLD = 1024; // small for tests

function makeInput(overrides: Partial<Parameters<typeof selectBackupKind>[0]> = {}) {
  return {
    newContent: Buffer.from("hello world"),
    prevContent: null,
    prevHash: null,
    isText: true,
    largeFileBytesThreshold: THRESHOLD,
    largeFilePolicy: "diff" as const,
    existingHashToPaths: new Map(),
    ...overrides,
  };
}

describe("contentHash", () => {
  it("returns consistent SHA-256 hex", () => {
    const h = contentHash(Buffer.from("abc"));
    expect(h).toHaveLength(64);
    expect(contentHash(Buffer.from("abc"))).toBe(h);
  });

  it("differs for different content", () => {
    expect(contentHash(Buffer.from("a"))).not.toBe(contentHash(Buffer.from("b")));
  });
});

describe("isTextContent", () => {
  it("identifies UTF-8 text as text", () => {
    expect(isTextContent(Buffer.from("Hello, world!\n"))).toBe(true);
  });

  it("identifies null-byte content as binary", () => {
    const buf = Buffer.alloc(10); // all zeros
    expect(isTextContent(buf)).toBe(false);
  });

  it("large buffer (> 8192 bytes) with null byte only beyond the sample window is text", () => {
    const buf = Buffer.alloc(8193);
    buf.fill(0x41, 0, 8192); // 'A' for first 8192 bytes
    buf[8192] = 0x00; // null byte only after the sample window
    expect(isTextContent(buf)).toBe(true);
  });

  it("large buffer with null byte within the 8192-byte sample is binary", () => {
    const buf = Buffer.alloc(8193);
    buf.fill(0x41, 0, 8193);
    buf[100] = 0x00; // null byte within the sample
    expect(isTextContent(buf)).toBe(false);
  });
});

describe("applyReverseDiff (direct)", () => {
  it("gzip-full blob (non-JSON content) returns decompressed content", async () => {
    const content = Buffer.from("plain text — not valid JSON at all", "utf8");
    const gz = await (promisify(zlib.gzip))(content);
    const result = await applyReverseDiff(gz);
    expect(result).toEqual(content);
  });

  it("gzip of JSON null returns content as-is (no crash)", async () => {
    // parsed = null; typeof null === 'object' is true in JS, so the null-check matters
    const gz = await (promisify(zlib.gzip))(Buffer.from("null", "utf8"));
    const result = await applyReverseDiff(gz);
    expect(result.toString("utf8")).toBe("null");
  });

  it("valid JSON with unknown format returns decompressed content", async () => {
    const gz = await (promisify(zlib.gzip))(
      Buffer.from(JSON.stringify({ format: "something-else", data: 42 }), "utf8")
    );
    const result = await applyReverseDiff(gz);
    expect(JSON.parse(result.toString("utf8")).format).toBe("something-else");
  });
});

describe("selectBackupKind", () => {
  describe("dedup", () => {
    it("returns dedup when hash already exists", async () => {
      const content = Buffer.from("identical content");
      const hash = contentHash(content);
      const existingHashToPaths = new Map([[hash, "/backups/existing.gz"]]);
      const kind = await selectBackupKind(makeInput({ newContent: content, existingHashToPaths }));
      expect(kind.type).toBe("dedup");
      if (kind.type === "dedup") {
        expect(kind.existingPath).toBe("/backups/existing.gz");
      }
    });
  });

  describe("gzip-diff for text files with prev content", () => {
    it("returns gzip-diff when prev content exists", async () => {
      const kind = await selectBackupKind(
        makeInput({
          newContent: Buffer.from("new version"),
          prevContent: Buffer.from("old version"),
          prevHash: "somehash",
          isText: true,
        })
      );
      expect(kind.type).toBe("gzip-diff");
    });

    it("roundtrips: applyReverseDiff(blob, newContent) restores prevContent exactly", async () => {
      const newContent = Buffer.from("new version of file");
      const prevContent = Buffer.from("old version of file");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "prevhash", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("delta blob is smaller than gzip-full when only a few lines change", async () => {
      // 100 lines; only the middle one differs — the delta should store just that one line
      // plus hunk metadata, far smaller than the gzipped full prev content.
      const uniqueLine = (i: number) =>
        `entry-${String(i).padStart(3, "0")}: configuration value ${i * 7 + 13} for subsystem alpha-${i}`;
      const shared = Array.from({ length: 99 }, (_, i) => uniqueLine(i));
      const newLines = [...shared.slice(0, 49), "new-line-49: updated configuration for feature X", ...shared.slice(49)];
      const prevLines = [...shared.slice(0, 49), "prev-line-49: original configuration for feature X", ...shared.slice(49)];
      const newContent = Buffer.from(newLines.join("\n"), "utf8");
      const prevContent = Buffer.from(prevLines.join("\n"), "utf8");

      const kind = await selectBackupKind(makeInput({ newContent, prevContent, prevHash: "h", isText: true }));
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const fullBlob = await (promisify(zlib.gzip))(prevContent);
        expect(kind.blob.length).toBeLessThan(fullBlob.length);
        // Also verify correctness
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("throws when currentContent is absent for a delta-format blob", async () => {
      const kind = await selectBackupKind(
        makeInput({ newContent: Buffer.from("v2"), prevContent: Buffer.from("v1"), prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        await expect(applyReverseDiff(kind.blob)).rejects.toThrow(/delta format/i);
      }
    });

    it("throws when currentContent hash mismatches the stored baseHash", async () => {
      const newContent = Buffer.from("version two content");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent: Buffer.from("version one content"), prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const wrongBase = Buffer.from("completely different file content");
        await expect(applyReverseDiff(kind.blob, wrongBase)).rejects.toThrow(/changed since/i);
      }
    });

    it("binary content with prevContent under threshold produces gzip-full (not gzip-diff)", async () => {
      const newContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const prevContent = Buffer.from([0x04, 0x05, 0x06, 0x07]);
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: false })
      );
      expect(kind.type).toBe("gzip-full");
    });

    it("text content with null prevHash produces gzip-full", async () => {
      const kind = await selectBackupKind(
        makeInput({
          newContent: Buffer.from("some text"),
          prevContent: Buffer.from("old text"),
          prevHash: null,
          isText: true,
        })
      );
      expect(kind.type).toBe("gzip-full");
    });

    it("diff envelope has keep-only hunks when content is identical", async () => {
      const content = Buffer.from("line 1\nline 2\nline 3", "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent: content, prevContent: content, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        expect(envelope.hunks.every((h: Record<string, unknown>) => "k" in h)).toBe(true);
      }
    });

    it("boundary: exactly MAX_DIFF_LINES (2000) lines uses delta format, not fallback", async () => {
      const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
      const prevLines = [...lines];
      prevLines[999] = "different line"; // one difference
      const newContent = Buffer.from(lines.join("\n"), "utf8");
      const prevContent = Buffer.from(prevLines.join("\n"), "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        // Delta format requires currentContent
        await expect(applyReverseDiff(kind.blob)).rejects.toThrow(/delta format/i);
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("MAX_DIFF_LINES: newLines > limit but prevLines under limit triggers fallback", async () => {
      const newLines = Array.from({ length: 2001 }, (_, i) => `line ${i}`);
      const prevLines = Array.from({ length: 100 }, (_, i) => `prev ${i}`);
      const kind = await selectBackupKind(
        makeInput({
          newContent: Buffer.from(newLines.join("\n"), "utf8"),
          prevContent: Buffer.from(prevLines.join("\n"), "utf8"),
          prevHash: "h",
          isText: true,
        })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        // Fallback: self-contained, no currentContent needed
        const restored = await applyReverseDiff(kind.blob);
        expect(restored.toString("utf8")).toBe(prevLines.join("\n"));
      }
    });

    it("MAX_DIFF_LINES: prevLines > limit but newLines under limit triggers fallback", async () => {
      const newLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      const prevLines = Array.from({ length: 2001 }, (_, i) => `prev ${i}`);
      const kind = await selectBackupKind(
        makeInput({
          newContent: Buffer.from(newLines.join("\n"), "utf8"),
          prevContent: Buffer.from(prevLines.join("\n"), "utf8"),
          prevHash: "h",
          isText: true,
        })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const restored = await applyReverseDiff(kind.blob);
        expect(restored.toString("utf8")).toBe(prevLines.join("\n"));
      }
    });

    it("adjacent keep hunks are merged: identical 3-line content → single {k:3} hunk", async () => {
      const content = Buffer.from("line 1\nline 2\nline 3", "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent: content, prevContent: content, prevHash: "h", isText: true })
      );
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        expect(envelope.hunks).toHaveLength(1);
        expect(envelope.hunks[0]).toEqual({ k: 3 });
      }
    });

    it("adjacent delete hunks are merged: 4 unique new lines before 1 common → single {d:4}", async () => {
      const newContent = Buffer.from("del 1\ndel 2\ndel 3\ndel 4\ncommon", "utf8");
      const prevContent = Buffer.from("common", "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        const deleteHunks = envelope.hunks.filter((h: Record<string, unknown>) => "d" in h);
        expect(deleteHunks).toHaveLength(1);
        expect((deleteHunks[0] as { d: number }).d).toBe(4);
        // roundtrip
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("adjacent insert hunks are merged: 3 extra prev lines before common → single insert with 3 lines", async () => {
      const newContent = Buffer.from("common", "utf8");
      const prevContent = Buffer.from("ins 1\nins 2\nins 3\ncommon", "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        const insertHunks = envelope.hunks.filter((h: Record<string, unknown>) => "i" in h);
        expect(insertHunks).toHaveLength(1);
        expect((insertHunks[0] as { i: string[] }).i).toHaveLength(3);
        // roundtrip
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("LCS optimality: common line is kept, not deleted and re-inserted", async () => {
      // newLines=["a","c","e"], prevLines=["b","c","d"] — "c" is the LCS.
      // Optimal edit: delete "a", insert "b", keep "c", delete "e", insert "d".
      // Wrong dp (e.g. +1→-1) produces: delete all 3, insert ["b","c","d"] — no keep hunk.
      const newContent = Buffer.from("a\nc\ne", "utf8");
      const prevContent = Buffer.from("b\nc\nd", "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        // The common line "c" must appear in a keep hunk — not deleted and re-inserted
        const keepHunks = envelope.hunks.filter((h: Record<string, unknown>) => "k" in h);
        expect(keepHunks.length).toBeGreaterThan(0);
        const insertLines: string[] = envelope.hunks
          .filter((h: Record<string, unknown>) => "i" in h)
          .flatMap((h: Record<string, unknown>) => (h as { i: string[] }).i);
        expect(insertLines).not.toContain("c");
        // Roundtrip
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("content at exactly the large-file threshold is not treated as large", async () => {
      // "> THRESHOLD" (not ">="), so content AT the threshold is normal (not large)
      const atThreshold = Buffer.from("x".repeat(THRESHOLD));
      const prev = Buffer.from("y".repeat(THRESHOLD));
      const kind = await selectBackupKind(
        makeInput({
          newContent: atThreshold, prevContent: prev, prevHash: "h",
          isText: true, largeFilePolicy: "metadata-only",
        })
      );
      // Normal path → gzip-diff; large path → metadata-only
      expect(kind.type).toBe("gzip-diff");
    });

    it("large-file fallback: still restores correctly for files exceeding MAX_DIFF_LINES", async () => {
      // 3000-line file exceeds the 2000-line LCS cap; falls back to gzip-full of prevContent.
      const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
      const newContent = Buffer.from(lines.join("\n"), "utf8");
      const prevLines = [...lines];
      prevLines[1500] = "prev version of line 1500";
      const prevContent = Buffer.from(prevLines.join("\n"), "utf8");

      const kind = await selectBackupKind(makeInput({ newContent, prevContent, prevHash: "h", isText: true }));
      expect(kind.type).toBe("gzip-diff"); // still labelled gzip-diff
      if (kind.type === "gzip-diff") {
        // Fallback blob is self-contained — no currentContent needed
        const restored = await applyReverseDiff(kind.blob);
        expect(restored).toEqual(prevContent);
      }
    });
  });

  describe("gzip-full for text files without prev", () => {
    it("returns gzip-full for new text file", async () => {
      const kind = await selectBackupKind(makeInput({ prevContent: null }));
      expect(kind.type).toBe("gzip-full");
    });

    it("stored blob is smaller than or equal to raw content (compression)", async () => {
      const bigText = Buffer.from("a".repeat(500));
      const kind = await selectBackupKind(makeInput({ newContent: bigText, prevContent: null }));
      expect(kind.type).toBe("gzip-full");
      if (kind.type === "gzip-full") {
        expect(kind.blob.length).toBeLessThan(bigText.length);
      }
    });
  });

  describe("large-file policy: metadata-only", () => {
    it("returns metadata-only for large binary with metadata-only policy", async () => {
      const bigBinary = Buffer.alloc(THRESHOLD + 1); // binary (all zeros)
      const kind = await selectBackupKind(
        makeInput({
          newContent: bigBinary,
          isText: false,
          largeFilePolicy: "metadata-only",
        })
      );
      expect(kind.type).toBe("metadata-only");
    });

    it("returns metadata-only for large text when policy is metadata-only and no prev", async () => {
      const bigText = Buffer.from("x".repeat(THRESHOLD + 1));
      const kind = await selectBackupKind(
        makeInput({
          newContent: bigText,
          isText: true,
          largeFilePolicy: "metadata-only",
          prevContent: null,
        })
      );
      expect(kind.type).toBe("metadata-only");
    });
  });

  describe("large-file policy: diff", () => {
    it("stores gzip-diff for large text file when policy is diff", async () => {
      const bigText = Buffer.from("x".repeat(THRESHOLD + 1));
      const prev = Buffer.from("y".repeat(THRESHOLD + 1));
      const kind = await selectBackupKind(
        makeInput({
          newContent: bigText,
          prevContent: prev,
          prevHash: "prevhash",
          isText: true,
          largeFilePolicy: "diff",
        })
      );
      expect(kind.type).toBe("gzip-diff");
    });

    it("falls back to gzip-full for large text with no prev under diff policy", async () => {
      const bigText = Buffer.from("x".repeat(THRESHOLD + 1));
      const kind = await selectBackupKind(
        makeInput({
          newContent: bigText,
          prevContent: null,
          isText: true,
          largeFilePolicy: "diff",
        })
      );
      expect(kind.type).toBe("gzip-full");
    });
  });
});
