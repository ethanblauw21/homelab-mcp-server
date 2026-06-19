import crypto from "crypto";
import zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export type BackupKind =
  | { type: "dedup"; existingPath: string }
  | { type: "gzip-diff"; blob: Buffer }
  | { type: "gzip-full"; blob: Buffer }
  | { type: "metadata-only" };

export interface BackupPolicyInput {
  newContent: Buffer;
  prevContent: Buffer | null;
  prevHash: string | null;
  isText: boolean;
  largeFileBytesThreshold: number;
  largeFilePolicy: "diff" | "metadata-only";
  existingHashToPaths: Map<string, string>;
  /**
   * #20 — the `baseHash` of the most recent backup for this target (the live
   * content it expects). When the about-to-be-written `prevHash` differs, the
   * live file drifted out-of-band and a delta would be born stale, so a
   * self-contained full copy is stored instead. Optional/absent ⇒ no re-anchor.
   */
  lastBackupBaseHash?: string | null;
}

export function contentHash(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isTextContent(buf: Buffer): boolean {
  // Heuristic: no null bytes in first 8 KB
  const sample = buf.slice(0, 8192);
  return !sample.includes(0x00);
}

// Files longer than this per side fall back to gzip-full of prevContent (avoids O(NM) memory).
const MAX_DIFF_LINES = 2_000;

// --- Wire format types (compact keys to minimise JSON size) ---

type DiffHunk =
  | { k: number }     // keep k lines from newContent
  | { d: number }     // delete d lines from newContent
  | { i: string[] };  // insert these lines (they were in prevContent)

interface ReverseDiffEnvelope {
  format: "mcp-rdiff-v1";
  baseHash: string;   // SHA-256 of newContent — used to detect stale base on restore
  hunks: DiffHunk[];
}

// --- LCS-based diff implementation ---

function buildHunks(newLines: string[], prevLines: string[]): DiffHunk[] {
  const n = newLines.length;
  const m = prevLines.length;

  // Standard O(NM) LCS table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (newLines[i - 1] === prevLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }

  // Backtrack to produce per-line edit sequence.
  type RawEdit = { t: "k" } | { t: "d" } | { t: "i"; v: string };
  const raw: RawEdit[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && newLines[i - 1] === prevLines[j - 1]) {
      raw.push({ t: "k" });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ t: "i", v: prevLines[j - 1] });
      j--;
    } else {
      raw.push({ t: "d" });
      i--;
    }
  }
  raw.reverse();

  // Run-length compress consecutive same-type edits into hunks.
  const hunks: DiffHunk[] = [];
  for (const e of raw) {
    const last = hunks[hunks.length - 1];
    if (e.t === "k") {
      if (last && "k" in last) { last.k++; } else { hunks.push({ k: 1 }); }
    } else if (e.t === "d") {
      if (last && "d" in last) { last.d++; } else { hunks.push({ d: 1 }); }
    } else {
      if (last && "i" in last) { last.i.push(e.v); } else { hunks.push({ i: [e.v] }); }
    }
  }
  return hunks;
}

function applyHunks(hunks: DiffHunk[], newLines: string[]): Buffer {
  const out: string[] = [];
  let ni = 0;
  for (const hunk of hunks) {
    if ("k" in hunk) {
      for (let c = 0; c < hunk.k; c++) {
        if (ni >= newLines.length) throw new Error("Delta corrupt: keep hunk overruns source");
        out.push(newLines[ni++]);
      }
    } else if ("d" in hunk) {
      ni += hunk.d;
    } else {
      out.push(...hunk.i);
    }
  }
  return Buffer.from(out.join("\n"), "utf8");
}

/**
 * Produce a reverse-diff blob that, when applied to newContent, reconstructs prevContent.
 * Falls back to raw prevContent for very large files (> MAX_DIFF_LINES per side).
 */
function computeReverseDiff(newContent: Buffer, prevContent: Buffer): Buffer {
  const newLines = newContent.toString("utf8").split("\n");
  const prevLines = prevContent.toString("utf8").split("\n");

  if (newLines.length > MAX_DIFF_LINES || prevLines.length > MAX_DIFF_LINES) {
    // Fall back: store full prevContent; applyReverseDiff will return it directly.
    return prevContent;
  }

  const envelope: ReverseDiffEnvelope = {
    format: "mcp-rdiff-v1",
    baseHash: contentHash(newContent),
    hunks: buildHunks(newLines, prevLines),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/**
 * Restore content from a backup blob.
 *
 * - gzip-diff blobs (format "mcp-rdiff-v1"): require currentContent (the version of the
 *   file that was current when the backup was written). Throws if absent or if the file
 *   has changed since then.
 * - gzip-full blobs and large-file fallbacks: self-contained; currentContent is unused.
 */
export async function applyReverseDiff(diffBlob: Buffer, currentContent?: Buffer): Promise<Buffer> {
  const decompressed = await gunzip(diffBlob);

  let parsed: unknown;
  try {
    parsed = JSON.parse(decompressed.toString("utf8"));
  } catch {
    // Not JSON — raw content (gzip-full or large-file fallback).
    return decompressed;
  }

  if (
    typeof parsed === "object" && parsed !== null &&
    (parsed as ReverseDiffEnvelope).format === "mcp-rdiff-v1"
  ) {
    const envelope = parsed as ReverseDiffEnvelope;
    if (!currentContent) {
      throw new Error(
        "This backup is in delta format and requires the current remote file for restore. " +
        "Ensure the target file exists on the host."
      );
    }
    const currentHash = contentHash(currentContent);
    if (currentHash !== envelope.baseHash) {
      throw new Error(
        `Cannot apply delta backup: the current file has changed since this backup was created ` +
        `(base ${envelope.baseHash.slice(0, 8)}…, current ${currentHash.slice(0, 8)}…). ` +
        `Try reverting a more recent backup first, or restore the file manually.`
      );
    }
    return applyHunks(envelope.hunks, currentContent.toString("utf8").split("\n"));
  }

  // Valid JSON but not our format — treat as raw content.
  return decompressed;
}

/**
 * #20 — the on-disk base a delta backup was anchored to drifted out-of-band.
 *
 * Each delta (gzip-diff envelope) backup can only be applied while the live file
 * still hashes to the bytes that were current when it was written. When the file
 * is edited outside the server (`sed -i` via `pct_exec`, a package upgrade), the
 * NEXT managed write sees a `prevHash` that no longer matches what the most
 * recent backup expected as the live base — proof the chain base drifted. In
 * that case we must NOT store another fragile delta: a self-contained full copy
 * of the pre-write content is the only thing that survives further live churn.
 *
 * Pure predicate: drift is detected only when both hashes are known and differ.
 */
export function chainBaseDrifted(
  prevHash: string | null,
  lastBackupBaseHash: string | null | undefined
): boolean {
  return (
    prevHash !== null &&
    lastBackupBaseHash !== null &&
    lastBackupBaseHash !== undefined &&
    prevHash !== lastBackupBaseHash
  );
}

/**
 * #20 — classify whether a (decompressed) backup blob can actually be reverted,
 * honestly, against the file's current content hash.
 *
 * A blob is one of two shapes (NOT distinguishable from `meta.kind` alone — a
 * "gzip-diff" blob falls back to raw content for very large files):
 *  - an `mcp-rdiff-v1` envelope → a **delta**, applicable ONLY when the live file
 *    still hashes to `baseHash`; `requiresLiveMatch: true`.
 *  - anything else (raw/full) → **self-contained**, unconditionally revertible.
 *
 * `currentHash === null` means the caller could not read the live file (e.g. the
 * observe-tier `list_backups`, which has no node access): a delta then cannot be
 * confirmed, so it is reported non-revertible with `requiresLiveMatch` so the
 * caller knows a companion-tier `diff_config` can still verify it.
 */
export interface BlobRevertibility {
  revertible: boolean;
  requiresLiveMatch: boolean;
  baseHash?: string;
  reason?: "stale-base" | "current-unknown" | "metadata-only";
}

export function classifyBlobRevertibility(
  decompressed: Buffer,
  currentHash: string | null
): BlobRevertibility {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decompressed.toString("utf8"));
  } catch {
    parsed = null;
  }
  if (
    typeof parsed === "object" && parsed !== null &&
    (parsed as ReverseDiffEnvelope).format === "mcp-rdiff-v1"
  ) {
    const baseHash = (parsed as ReverseDiffEnvelope).baseHash;
    if (currentHash === null) {
      return { revertible: false, requiresLiveMatch: true, baseHash, reason: "current-unknown" };
    }
    if (currentHash === baseHash) {
      return { revertible: true, requiresLiveMatch: true, baseHash };
    }
    return { revertible: false, requiresLiveMatch: true, baseHash, reason: "stale-base" };
  }
  // Raw / full self-contained content — applies regardless of the live file.
  return { revertible: true, requiresLiveMatch: false };
}

export async function selectBackupKind(input: BackupPolicyInput): Promise<BackupKind> {
  const { newContent, prevContent, prevHash, isText, largeFileBytesThreshold, largeFilePolicy, existingHashToPaths } = input;

  const newHash = contentHash(newContent);

  // Dedup: if we've already stored a blob with this hash, reuse it
  if (existingHashToPaths.has(newHash)) {
    return { type: "dedup", existingPath: existingHashToPaths.get(newHash)! };
  }

  // #20 — if the live file drifted out-of-band since the last managed write, a
  // delta would be born stale; store a self-contained full copy of prevContent
  // instead so the pre-write state survives further live churn.
  const reanchor = chainBaseDrifted(prevHash, input.lastBackupBaseHash);

  // Large-file policy
  if (newContent.length > largeFileBytesThreshold) {
    if (largeFilePolicy === "metadata-only" || !isText) {
      return { type: "metadata-only" };
    }
    // diff if text and policy allows (but a drifted base forces a full copy)
    if (prevContent !== null && !reanchor) {
      const diff = computeReverseDiff(newContent, prevContent);
      const blob = await gzip(diff);
      return { type: "gzip-diff", blob };
    }
    const blob = await gzip(reanchor && prevContent !== null ? prevContent : newContent);
    return { type: "gzip-full", blob };
  }

  // Normal text file: prefer reverse diff over prev (unless the base drifted)
  if (isText && prevContent !== null && prevHash !== null && !reanchor) {
    const diff = computeReverseDiff(newContent, prevContent);
    const blob = await gzip(diff);
    return { type: "gzip-diff", blob };
  }

  // Fallback / re-anchor: gzipped full copy. When re-anchoring we store the
  // pre-write content (the recoverable state); otherwise the new content.
  const blob = await gzip(reanchor && prevContent !== null ? prevContent : newContent);
  return { type: "gzip-full", blob };
}

export { isTextContent };
