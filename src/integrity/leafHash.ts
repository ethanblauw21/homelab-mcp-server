/**
 * The bridge between a write tool and the Merkle forest (ADR-009 §5.3) — PURE.
 *
 * `verify_integrity` classifies a drifted leaf as *explained* when the leaf's stored
 * Merkle hash equals some audit record's `afterHash`. For that join to land, a write
 * handler must stamp the SAME hash the forest would later compute for that file's
 * content leaf. At L2/L3 a file leaf is:
 *
 *   leaf_hash = foldLeaf( utf8( sha256_hex(content) ) )    // see tree.ts contentBuffer
 *
 * i.e. the content's SHA-256 hex string, fed as the leaf payload through the
 * domain-separated `foldLeaf`. This helper reproduces exactly that, so a `write_file`
 * (or `pct_write_file`, `qm_write_file`, …) records a `before`/`afterHash` that the
 * forest will recognize as its own handiwork — turning a would-be "unexplained"
 * tamper alert into an "explained, by write_file at <auditId>" entry.
 *
 * NOTE: this matches the L2/L3 *content* leaf only — never the L1 mtime leaf (which
 * folds a timestamp the server cannot predict). That is correct: a write changes
 * content, so the content-level drift is what gets explained; the mtime drift on the
 * same path rides along under the same leaf path.
 */
import crypto from "crypto";
import { foldLeaf, hashHex } from "./folding.js";

/** The L2/L3 Merkle content-leaf hash for a file's bytes (hex). */
export function contentLeafHash(content: Buffer): string {
  const contentHex = crypto.createHash("sha256").update(content).digest("hex");
  return hashHex(foldLeaf(Buffer.from(contentHex, "utf8")));
}
