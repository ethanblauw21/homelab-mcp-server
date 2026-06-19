import { describe, it, expect } from "vitest";
import {
  selectBackupKind,
  contentHash,
  isTextContent,
  applyReverseDiff,
  chainBaseDrifted,
  classifyBlobRevertibility,
} from "./policy.js";
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

describe("chainBaseDrifted (#20)", () => {
  it("is false when either hash is unknown (no prior backup / new file)", () => {
    expect(chainBaseDrifted(null, "abc")).toBe(false);
    expect(chainBaseDrifted("abc", null)).toBe(false);
    expect(chainBaseDrifted("abc", undefined)).toBe(false);
  });
  it("is false when the live base still matches the last backup", () => {
    expect(chainBaseDrifted("samehash", "samehash")).toBe(false);
  });
  it("is true when the live base drifted from the last backup (out-of-band edit)", () => {
    expect(chainBaseDrifted("live-drifted", "backup-expected")).toBe(true);
  });
});

describe("classifyBlobRevertibility (#20)", () => {
  it("treats a self-contained (raw) blob as unconditionally revertible", () => {
    const r = classifyBlobRevertibility(Buffer.from("plain file bytes"), null);
    expect(r).toEqual({ revertible: true, requiresLiveMatch: false });
  });
  it("a delta blob is revertible only when the live hash matches its baseHash", () => {
    const envelope = Buffer.from(JSON.stringify({ format: "mcp-rdiff-v1", baseHash: "deadbeef", hunks: [] }));
    expect(classifyBlobRevertibility(envelope, "deadbeef")).toEqual({
      revertible: true,
      requiresLiveMatch: true,
      baseHash: "deadbeef",
    });
  });
  it("a delta blob with a mismatched live hash is non-revertible with a stale-base reason", () => {
    const envelope = Buffer.from(JSON.stringify({ format: "mcp-rdiff-v1", baseHash: "deadbeef", hunks: [] }));
    expect(classifyBlobRevertibility(envelope, "0ther")).toEqual({
      revertible: false,
      requiresLiveMatch: true,
      baseHash: "deadbeef",
      reason: "stale-base",
    });
  });
  it("a delta blob with an unknown live hash (observe tier) is non-revertible but flags requiresLiveMatch", () => {
    const envelope = Buffer.from(JSON.stringify({ format: "mcp-rdiff-v1", baseHash: "deadbeef", hunks: [] }));
    expect(classifyBlobRevertibility(envelope, null)).toEqual({
      revertible: false,
      requiresLiveMatch: true,
      baseHash: "deadbeef",
      reason: "current-unknown",
    });
  });
});

describe("selectBackupKind re-anchor on drift (#20)", () => {
  it("stores a self-contained gzip-full (of prevContent) instead of a fragile delta when the base drifted", async () => {
    const newContent = Buffer.from("new version of file\n");
    const prevContent = Buffer.from("the out-of-band edited content\n");
    const kind = await selectBackupKind(
      makeInput({
        newContent,
        prevContent,
        prevHash: "live-hash-now", // current on-disk
        isText: true,
        lastBackupBaseHash: "what-the-last-backup-expected", // differs ⇒ drift
      })
    );
    expect(kind.type).toBe("gzip-full");
    if (kind.type === "gzip-full") {
      // The full copy must reconstruct the recoverable PRE-write state directly.
      const restored = await applyReverseDiff(kind.blob);
      expect(restored).toEqual(prevContent);
    }
  });

  it("still prefers a delta when the base did NOT drift", async () => {
    const kind = await selectBackupKind(
      makeInput({
        newContent: Buffer.from("v2\n"),
        prevContent: Buffer.from("v1\n"),
        prevHash: "matching",
        isText: true,
        lastBackupBaseHash: "matching", // same ⇒ no drift
      })
    );
    expect(kind.type).toBe("gzip-diff");
  });
});

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

  // --- Mutation-hardening: targeted kills for surviving mutants ---

  describe("guard precision (mutation-hardening)", () => {
    it("with a non-null prevHash but null prevContent, falls back to gzip-full (no diff attempt)", async () => {
      // Kills the `prevContent !== null` → `true` mutant on the normal-text branch:
      // the mutant would call computeReverseDiff(newContent, null) and crash on null.
      const kind = await selectBackupKind(
        makeInput({
          newContent: Buffer.from("some new text"),
          prevContent: null,
          prevHash: "a-non-null-hash",
          isText: true,
        })
      );
      expect(kind.type).toBe("gzip-full");
    });
  });

  describe("reverse-diff is byte-faithful for multibyte UTF-8 (encoding mutation-hardening)", () => {
    it("roundtrips multibyte content exactly through both encode sites", async () => {
      // Kills the two `"utf8"` → `""` StringLiteral mutants (envelope JSON encode at
      // computeReverseDiff, and the applyHunks output encode). ASCII content survives a
      // wrong/empty encoding; multibyte does not — the restored bytes diverge or throw.
      const newContent = Buffer.from("α\nβ\nγ", "utf8");
      const prevContent = Buffer.from("α\nДЕЛЬТА δ ☃\nγ", "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored.equals(prevContent)).toBe(true);
      }
    });
  });

  describe("LCS produces the MINIMAL hunk set (DP-table mutation-hardening)", () => {
    it("a single changed line in a 100-line file yields exactly 4 hunks", async () => {
      // A suboptimal LCS (any corrupted dp recurrence / loop bound / max-pick) emits
      // extra delete+insert hunks instead of one big keep run. Asserting the EXACT
      // optimal structure kills the dp mutants that mere roundtrip checks cannot.
      const newLines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
      const prevLines = [...newLines];
      prevLines[50] = "line-050-OLD-VERSION";
      const newContent = Buffer.from(newLines.join("\n"), "utf8");
      const prevContent = Buffer.from(prevLines.join("\n"), "utf8");

      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        const hunks = envelope.hunks as Array<Record<string, unknown>>;
        expect(hunks).toHaveLength(4);
        expect(hunks[0]).toEqual({ k: 50 });
        expect(hunks[3]).toEqual({ k: 49 });
        const middle = [hunks[1], hunks[2]];
        expect(middle).toContainEqual({ d: 1 });
        expect(middle).toContainEqual({ i: ["line-050-OLD-VERSION"] });
        // And it still restores exactly.
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    // Transposition inputs where the OPTIMAL alignment is not positional: the dp table
    // (not the backtrack's equality check) decides whether the long common run is found.
    // A corrupted recurrence / loop bound / max-pick fails to keep the run, so asserting
    // the run survives — and that the diff still roundtrips — kills those dp mutants.
    const keptRun = (hunks: Array<Record<string, unknown>>) =>
      hunks.filter((h) => "k" in h).reduce((sum, h) => sum + (h as { k: number }).k, 0);

    it("keeps the A,B,C run when X moves from the front to the back", async () => {
      const newContent = Buffer.from(["X", "A", "B", "C"].join("\n"), "utf8");
      const prevContent = Buffer.from(["A", "B", "C", "X"].join("\n"), "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        const hunks = envelope.hunks as Array<Record<string, unknown>>;
        // Optimal LCS length is 3 (A,B,C). Any suboptimal dp keeps fewer.
        expect(keptRun(hunks)).toBe(3);
        expect(hunks).toContainEqual({ k: 3 });
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });

    it("keeps the A,B,C run when X moves from the back to the front (last-row/col coverage)", async () => {
      // Mirror of the above so the participating LCS lines touch the final dp row AND
      // column — this is what kills the `i <= n`/`j <= m` loop-bound mutants.
      const newContent = Buffer.from(["A", "B", "C", "X"].join("\n"), "utf8");
      const prevContent = Buffer.from(["X", "A", "B", "C"].join("\n"), "utf8");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent, prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const envelope = JSON.parse((await gunzip(kind.blob)).toString("utf8"));
        const hunks = envelope.hunks as Array<Record<string, unknown>>;
        expect(keptRun(hunks)).toBe(3);
        expect(hunks).toContainEqual({ k: 3 });
        const restored = await applyReverseDiff(kind.blob, newContent);
        expect(restored).toEqual(prevContent);
      }
    });
  });

  describe("applyReverseDiff — error messages are specific (string mutation-hardening)", () => {
    it("the delta-format-without-current error names the remedy", async () => {
      // Kills the line-167 `"Ensure the target file exists on the host."` → `""` mutant.
      const kind = await selectBackupKind(
        makeInput({ newContent: Buffer.from("v2"), prevContent: Buffer.from("v1"), prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        await expect(applyReverseDiff(kind.blob)).rejects.toThrow(/delta format/i);
        await expect(applyReverseDiff(kind.blob)).rejects.toThrow(/Ensure the target file exists on the host/);
      }
    });

    it("the stale-base error shows TRUNCATED before/after hashes and the recovery hint", async () => {
      // Kills the line-174 mutants (two `.slice(0, 8)` removals → full hash, and the
      // whole-fragment emptying) plus the line-175 recovery-hint emptying.
      const newContent = Buffer.from("version two content");
      const kind = await selectBackupKind(
        makeInput({ newContent, prevContent: Buffer.from("version one content"), prevHash: "h", isText: true })
      );
      expect(kind.type).toBe("gzip-diff");
      if (kind.type === "gzip-diff") {
        const wrongBase = Buffer.from("completely different file content");
        // Exactly 8 hex digits immediately followed by the ellipsis — a full (un-sliced)
        // hash has a 9th hex char where the ellipsis must be, so these fail on the mutant.
        await expect(applyReverseDiff(kind.blob, wrongBase)).rejects.toThrow(/base [0-9a-f]{8}…/);
        await expect(applyReverseDiff(kind.blob, wrongBase)).rejects.toThrow(/current [0-9a-f]{8}…/);
        await expect(applyReverseDiff(kind.blob, wrongBase)).rejects.toThrow(/Try reverting a more recent backup first/);
      }
    });
  });
});
