/**
 * Pure unified-diff over lines (ADR-004 §6). Shared infrastructure: `dryRun`
 * previews here, and ADR-005's `diff_config` will reuse it. No I/O.
 *
 * This is a minimal LCS line diff — adequate for a human-readable preview, not a
 * patch-apply tool. Output is unified-*style* (context " ", removals "-",
 * additions "+"), truncated at a configurable line cap.
 */

export interface UnifiedDiffResult {
  diff: string;
  addedLines: number;
  removedLines: number;
  /** True when the rendered diff was cut off at the line cap. */
  truncated: boolean;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  // Keep it simple: normalize CRLF, split on LF, drop a single trailing empty.
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Build the LCS length table for two line arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

export function computeUnifiedDiff(prev: string, next: string, maxLines = 200): UnifiedDiffResult {
  const a = splitLines(prev);
  const b = splitLines(next);
  const table = lcsTable(a, b);

  const out: string[] = [];
  let addedLines = 0;
  let removedLines = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      removedLines++;
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      addedLines++;
      j++;
    }
  }
  while (i < a.length) {
    out.push(`- ${a[i]}`);
    removedLines++;
    i++;
  }
  while (j < b.length) {
    out.push(`+ ${b[j]}`);
    addedLines++;
    j++;
  }

  const truncated = out.length > maxLines;
  const shown = truncated ? out.slice(0, maxLines) : out;
  if (truncated) {
    shown.push(`… (${out.length - maxLines} more diff lines truncated)`);
  }

  return {
    diff: shown.join("\n"),
    addedLines,
    removedLines,
    truncated,
  };
}
