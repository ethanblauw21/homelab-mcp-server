import crypto from "crypto";
import zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export type BackupKind =
  // A reverse-diff against newContent. `requiresBaseHash` is the hash the current
  // on-disk file must have for the delta to apply (= sha256(newContent)); `null`
  // means the blob is the large-file raw fallback (self-contained prevContent).
  | { type: "dedup"; existingPath: string }
  | { type: "gzip-diff"; blob: Buffer; requiresBaseHash: string | null }
  // `reanchored` marks a self-contained snapshot of prevContent stored because the
  // file drifted out-of-band since the last managed write (ADR-014 §2). Its blob
  // holds prevContent while the meta hash records newContent, so it must be kept
  // OUT of the dedup map.
  | { type: "gzip-full"; blob: Buffer; reanchored?: boolean }
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
   * ADR-014 §2 — the hash of the most recent managed backup for this target (what
   * the file *should* be if nothing touched it since our last write). When the
   * current on-disk content (`prevHash`) differs, the file drifted out-of-band and
   * the delta we are about to take would be unreachable; instead we re-anchor with
   * a self-contained snapshot of prevContent. Undefined/null ⇒ no chain yet, no
   * drift check (the common first-write path; preserves pre-ADR-014 behaviour).
   */
  chainBaseHash?: string | null;
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
 *
 * Returns the blob plus the `baseHash` the current file must match to apply it.
 * `baseHash` is `null` for the large-file raw fallback — that blob is self-contained
 * prevContent, so it carries no base requirement (ADR-014 §1: self-contained ⇒
 * always revertible).
 */
function computeReverseDiff(
  newContent: Buffer,
  prevContent: Buffer
): { buf: Buffer; baseHash: string | null } {
  const newLines = newContent.toString("utf8").split("\n");
  const prevLines = prevContent.toString("utf8").split("\n");

  if (newLines.length > MAX_DIFF_LINES || prevLines.length > MAX_DIFF_LINES) {
    // Fall back: store full prevContent; applyReverseDiff will return it directly.
    return { buf: prevContent, baseHash: null };
  }

  const envelope: ReverseDiffEnvelope = {
    format: "mcp-rdiff-v1",
    baseHash: contentHash(newContent),
    hunks: buildHunks(newLines, prevLines),
  };
  return { buf: Buffer.from(JSON.stringify(envelope), "utf8"), baseHash: envelope.baseHash };
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
 * ADR-014 §2 — has the file drifted out-of-band since our last managed write?
 * True only when we have a chain anchor AND a current on-disk hash AND they
 * disagree. A first write (no chain) or an unreadable current file never trips it.
 */
function driftedSinceLastWrite(prevHash: string | null, chainBaseHash: string | null | undefined): boolean {
  return chainBaseHash != null && prevHash != null && prevHash !== chainBaseHash;
}

export async function selectBackupKind(input: BackupPolicyInput): Promise<BackupKind> {
  const { newContent, prevContent, prevHash, isText, largeFileBytesThreshold, largeFilePolicy, existingHashToPaths } = input;

  const newHash = contentHash(newContent);

  // Dedup: if we've already stored a blob with this hash, reuse it. (The drift
  // check below sits AFTER this, so a genuinely-identical re-write still dedups.)
  if (existingHashToPaths.has(newHash)) {
    return { type: "dedup", existingPath: existingHashToPaths.get(newHash)! };
  }

  // ADR-014 §2 — re-anchor: if the current content drifted out-of-band, a delta
  // against it would be unreachable. Store a self-contained snapshot of the
  // drifted prevContent instead, so it stays revertible regardless of future writes.
  const drifted = driftedSinceLastWrite(prevHash, input.chainBaseHash);

  // Large-file policy
  if (newContent.length > largeFileBytesThreshold) {
    if (largeFilePolicy === "metadata-only" || !isText) {
      return { type: "metadata-only" };
    }
    // diff if text and policy allows
    if (prevContent !== null) {
      if (drifted) {
        const blob = await gzip(prevContent);
        return { type: "gzip-full", blob, reanchored: true };
      }
      const { buf, baseHash } = computeReverseDiff(newContent, prevContent);
      const blob = await gzip(buf);
      return { type: "gzip-diff", blob, requiresBaseHash: baseHash };
    }
    const blob = await gzip(newContent);
    return { type: "gzip-full", blob };
  }

  // Normal text file: prefer reverse diff over prev
  if (isText && prevContent !== null && prevHash !== null) {
    if (drifted) {
      const blob = await gzip(prevContent);
      return { type: "gzip-full", blob, reanchored: true };
    }
    const { buf, baseHash } = computeReverseDiff(newContent, prevContent);
    const blob = await gzip(buf);
    return { type: "gzip-diff", blob, requiresBaseHash: baseHash };
  }

  // Fallback: gzipped full copy
  const blob = await gzip(newContent);
  return { type: "gzip-full", blob };
}

// --- ADR-014 §1: honest revertibility classification ---

/** What a stored backup version exposes to the revertibility classifier. */
export interface RevertibilityView {
  /** Stored kind: "gzip-full" | "gzip-diff" | "metadata-only" | "unknown". */
  kind: string;
  /**
   * For ADR-014+ backups: the hash the current file must match for a delta to
   * apply, or `null` for a self-contained blob. Absent (`undefined`) for legacy
   * backups — then the classifier degrades conservatively (see below).
   */
  requiresBaseHash?: string | null;
  /** The meta `hash` (= sha256 of newContent). Used to recover a legacy delta's base. */
  hash?: string;
}

export interface Revertibility {
  revertible: boolean;
  reason?: string;
}

/**
 * Decide whether a backup version can actually be reverted *right now*, given the
 * current on-disk hash (or `null` if the live file is unreadable/missing).
 *
 * - metadata-only → never (no content stored).
 * - self-contained (`requiresBaseHash === null`, i.e. a gzip-full, the large-file
 *   raw fallback, or a re-anchor snapshot) → always.
 * - delta (`requiresBaseHash` a hash) → only while the file still matches that base.
 * - legacy (no `requiresBaseHash`): a `gzip-diff` is assumed to need its recorded
 *   `hash` as the base (understating, never overstating, is the safe direction); a
 *   `gzip-full` is self-contained. An `unknown` kind (a bare blob with no meta) is
 *   treated as self-contained — the caller still guards the actual restore.
 */
export function classifyRevertibility(view: RevertibilityView, currentHash: string | null): Revertibility {
  if (view.kind === "metadata-only") {
    return { revertible: false, reason: "metadata-only backup — no content stored, nothing to revert" };
  }

  let baseReq: string | null;
  if (view.requiresBaseHash !== undefined) {
    baseReq = view.requiresBaseHash; // ADR-014+ exact (null ⇒ self-contained)
  } else if (view.kind === "gzip-diff") {
    baseReq = view.hash ?? null; // legacy delta: envelope baseHash == meta.hash
  } else {
    baseReq = null; // gzip-full / unknown legacy ⇒ assume self-contained
  }

  if (baseReq === null) return { revertible: true };

  if (currentHash === null) {
    return {
      revertible: false,
      reason: "current file is unreadable or missing, so this delta backup cannot be verified for revert",
    };
  }
  if (currentHash === baseReq) return { revertible: true };
  return {
    revertible: false,
    reason:
      `delta backup needs the current file to match base ${baseReq.slice(0, 8)}…, ` +
      `but it is ${currentHash.slice(0, 8)}… — the file was edited out-of-band since this backup, ` +
      `so this version can no longer be applied (revert a more recent version, or restore manually)`,
  };
}

export { isTextContent };
