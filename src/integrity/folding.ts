/**
 * Deterministic Merkle folding core (ADR-009 §1) — PURE, no I/O.
 *
 * A directory's hash folds its name-sorted children; a file's hash folds its
 * leaf payload. Two domain-separation bytes keep a file whose content equals a
 * folder's serialized child-list from colliding:
 *
 *   leaf  = SHA256( 0x00 ‖ leaf_payload )
 *   node  = SHA256( 0x01 ‖ for each child (byte-sorted name): name ‖ 0x00 ‖ child_hash )
 *
 * **Deviation from ADR §1's literal formula (kept in sync there):** the ADR wrote
 * the child serialization as `child_name ‖ child_hash`. We insert a single `0x00`
 * terminator between the (variable-length) name and the (fixed 32-byte) hash. NUL
 * is the one byte POSIX filenames cannot contain, so it is an unambiguous, still
 * fully-deterministic delimiter that removes a theoretical multi-child boundary
 * ambiguity (`["ab"+h]` vs a crafted `["a"+…]`). Same tree ⇒ same root on any OS.
 *
 * `leaf_payload` differs per level (§1): L1 = mtime, L2/L3 = content hash. The
 * folding core does not care which — it only folds bytes — so a single tested core
 * serves all three levels.
 */
import crypto from "crypto";

/** Domain-separation prefixes. Distinct bytes ⇒ leaf/node/unreadable never collide. */
export const LEAF_DOMAIN = 0x00;
export const NODE_DOMAIN = 0x01;
export const UNREADABLE_DOMAIN = 0x02;

/** The one byte a POSIX filename cannot contain — used as the name/hash delimiter. */
const NAME_TERMINATOR = 0x00;

/**
 * Node state (ADR-009 §1). These MUST stay distinct — collapsing any two
 * manufactures false drift (a stopped guest read as a mass deletion, etc.).
 *  - `present`     exists and was read.
 *  - `empty-dir`   exists, has no children (folds as a childless node).
 *  - `unavailable` could not be attempted (stopped guest, §4) — frozen, excluded from diff.
 *  - `unreadable`  exists but permission denied — a stable sentinel hash.
 */
export type NodeState = "present" | "empty-dir" | "unavailable" | "unreadable";

export interface ChildRef {
  /** Raw file/dir name (single path segment), byte-sorted before folding. */
  name: string;
  /** The child's 32-byte hash. */
  hash: Buffer;
}

/** A file leaf: SHA256(0x00 ‖ payload). Payload is mtime (L1) or content hash (L2/L3). */
export function foldLeaf(payload: Buffer): Buffer {
  return crypto.createHash("sha256").update(Buffer.from([LEAF_DOMAIN])).update(payload).digest();
}

/**
 * A directory node: SHA256(0x01 ‖ Σ name ‖ 0x00 ‖ child_hash), children byte-sorted
 * by raw name. An empty child list yields the canonical empty-dir hash. The sort is
 * byte-wise on the raw UTF-8 name (NOT locale-aware) so the root is OS-independent.
 */
export function foldNode(children: ChildRef[]): Buffer {
  const sorted = [...children].sort((a, b) => compareNameBytes(a.name, b.name));
  const h = crypto.createHash("sha256").update(Buffer.from([NODE_DOMAIN]));
  for (const c of sorted) {
    h.update(Buffer.from(c.name, "utf8"));
    h.update(Buffer.from([NAME_TERMINATOR]));
    h.update(c.hash);
  }
  return h.digest();
}

/** Canonical hash of an existing directory with no children (`empty-dir`). */
export function emptyDirHash(): Buffer {
  return foldNode([]);
}

/**
 * Sentinel hash for an `unreadable` node (exists, permission denied). A constant
 * derived from its own domain byte: all unreadable leaves share this hash, but the
 * parent folds in their distinct NAMES, so siblings never collapse together. Kept
 * distinct from both a real leaf (0x00) and an empty dir (0x01 ‖ ∅).
 */
export function unreadableHash(): Buffer {
  return crypto.createHash("sha256").update(Buffer.from([UNREADABLE_DOMAIN])).digest();
}

/** L1 leaf payload: mtime in whole seconds as its decimal-string bytes (§1, weakest signal). */
export function mtimePayload(mtimeSecs: number): Buffer {
  return Buffer.from(String(Math.trunc(mtimeSecs)), "utf8");
}

/** Byte-wise comparison of two raw names (locale-independent determinism). */
export function compareNameBytes(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

/** Lowercase hex of a 32-byte hash, for storage/query/display. */
export function hashHex(h: Buffer): string {
  return h.toString("hex");
}
