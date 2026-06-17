/**
 * ADR-011 §3 — the pure core of the find-and-replace edit tools.
 *
 * `applyStringEdit` is the ONLY novel logic an edit tool adds over its
 * `*_write_file` sibling: it turns `prev + (oldString → newString)` into the
 * full new file content, which then flows through the *unchanged* write
 * pipeline (backup → audit → diff → history → integrity anchor). It performs
 * no I/O and belongs to the same pure-function family as
 * `guardrails/denylist.ts` and `backup/policy.ts` (key-invariant coverage bar).
 *
 * Semantics (mirror the Claude Code `Edit` tool the model already knows):
 *  - **Literal** substring match — never regex (predictable; no injection
 *    surface in a root-capable operator tool).
 *  - **Unique match by default** — `oldString` must occur exactly once unless
 *    `replaceAll` is set; ambiguity is refused (`not_unique`), never guessed.
 *  - **No-op refusal** — a replacement that yields byte-identical content
 *    (incl. `oldString === newString`) is refused (`no_change`), so an edit
 *    never burns a backup/audit slot on a write that changes nothing.
 *
 * Replacement is done by index splice / split-join, NOT `String.prototype.replace`
 * — the latter interprets `$&`, `$1`, `$$` in the replacement string even when
 * the pattern is a plain string, which would corrupt a literal `newString`.
 */

export type EditFailureReason = "not_found" | "not_unique" | "no_change";

export type EditResult =
  | { ok: true; next: string; replacements: number }
  | { ok: false; reason: EditFailureReason; count?: number };

export interface ApplyStringEditArgs {
  prev: string;
  oldString: string;
  newString: string;
  /** Replace every occurrence instead of requiring a unique match. */
  replaceAll?: boolean;
}

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0; // an empty needle has no well-defined count
  return haystack.split(needle).length - 1;
}

export function applyStringEdit(args: ApplyStringEditArgs): EditResult {
  const { prev, oldString, newString, replaceAll = false } = args;

  // An empty oldString cannot address anything — treat as not found (the schema
  // also enforces a min length, this is the pure-core backstop).
  if (oldString.length === 0) {
    return { ok: false, reason: "not_found", count: 0 };
  }

  const count = countOccurrences(prev, oldString);
  if (count === 0) {
    return { ok: false, reason: "not_found", count: 0 };
  }
  if (!replaceAll && count > 1) {
    return { ok: false, reason: "not_unique", count };
  }

  // Literal replacement (no $-pattern interpretation): split/join for all,
  // index splice for the unique-match case.
  let next: string;
  if (replaceAll) {
    next = prev.split(oldString).join(newString);
  } else {
    const idx = prev.indexOf(oldString);
    next = prev.slice(0, idx) + newString + prev.slice(idx + oldString.length);
  }

  if (next === prev) {
    return { ok: false, reason: "no_change" };
  }

  return { ok: true, next, replacements: replaceAll ? count : 1 };
}

/** Human-readable refusal message for a failed edit, shared by all four handlers. */
export function editFailureMessage(result: Extract<EditResult, { ok: false }>): string {
  switch (result.reason) {
    case "not_found":
      return "oldString was not found in the file. Check whitespace/indentation and that the text exists verbatim.";
    case "not_unique":
      return (
        `oldString occurs ${result.count} times — it must be unique. ` +
        "Include more surrounding context to single out one occurrence, or pass replaceAll: true."
      );
    case "no_change":
      return "The edit would not change the file (oldString equals newString). No write performed.";
  }
}
