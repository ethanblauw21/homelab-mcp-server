/**
 * Opt-in read-family redaction (ADR-019) — the single, pure decision point shared
 * by the four file-read tools (`read_file`, `pct_read_file`, `qm_read_file`,
 * `docker_read_file`).
 *
 * Doctrine (ADR-004 amended): reads return **fidelity by default**. The caller may
 * opt into the *same* ADR-002 redaction the log tools (`tail_log`/`docker_logs`)
 * always apply, for the "show me the config shape, not its secrets" read. This adds
 * a call site, never a second matcher.
 *
 * Strictly a **return-boundary** transform: it shapes only what is handed back to the
 * caller. It is never on the backup, diff-on-write, integrity-hash, or `revert_file`
 * path — those operate on true bytes (asserted in tests). Encoding interaction is
 * honest: `redact` is meaningful only for `utf8`; for `base64` (binary) it is a no-op
 * and the result *says so* (`redacted: false`) rather than implying a scan it skipped.
 */
import { redactString } from "../guardrails/redaction.js";

/**
 * The redaction-related fields merged into a read result. All three are **absent**
 * when `redact` was not requested, so a default read is byte-for-byte unchanged
 * (ADR-019's load-bearing default-invariance constraint).
 */
export interface ReadRedaction {
  content: string;
  /** Present only when `redact` was requested. `true` ⇒ scanned (utf8); `false` ⇒ skipped (base64). */
  redacted?: boolean;
  /** Present only when redaction actually ran; the count of masked spans. */
  redactionCount?: number;
}

/**
 * Apply opt-in redaction at a read tool's return boundary.
 *
 * @param content  the decoded string the handler is about to return
 * @param encoding the read encoding (`"utf8"` | `"base64"`)
 * @param redact   the caller's opt-in flag (absent/false ⇒ verbatim, no extra fields)
 * @param extraKeys `cfg.census.redactionExtraKeys` — the same extension list the log tools pass
 */
export function applyReadRedaction(
  content: string,
  encoding: string,
  redact: boolean | undefined,
  extraKeys: string[] = []
): ReadRedaction {
  // Flag absent/false: exact current behavior — no redaction, no extra result fields.
  if (!redact) return { content };
  // Requested but binary: redaction has no meaning on a base64 blob. Say so honestly.
  if (encoding !== "utf8") return { content, redacted: false };
  const r = redactString(content, extraKeys);
  return { content: r.value, redacted: true, redactionCount: r.redactedCount };
}
