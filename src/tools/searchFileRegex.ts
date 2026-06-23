/**
 * `search_file_regex` (ADR-020 §3) — the regex "balloon" scanner. Find a stanza
 * and return just its neighborhood (`grep -C`), not the whole file. The read-side
 * analogue of `edit_file`'s find-and-replace front door: `read_file`'s
 * `offset`/`maxBytes` is a *blind byte window* (you must already know where to
 * look); this is *content-addressed* windowing — find first, return only the
 * matched lines plus N lines of context each side, capped with an overflow marker.
 *
 * **Tier follows the target kind** (`assertTargetTier`): a host path ⇒ root, an
 * LXC path (`vmid`) or a Docker path (`vmid`+`container`) ⇒ companion.
 *
 * **Honest deviation from the ADR sketch.** The ADR says "reuses the *_read_file
 * read plumbing." We run `grep` *remotely* (host shell / `pct exec` / `docker
 * exec`) rather than pulling the file to the Windows host and matching here. This
 * is strictly better for the dominant cost (token economy, ADR-011 §1 / ADR-017):
 * only the matched neighborhoods ever transit, never the whole file, and it avoids
 * adding a client-side regex engine. The trade-off is a dependency on `grep` in
 * the target (universal on the host/LXC; busybox images vary — a missing/odd grep
 * surfaces as an honest exit-2 error). We reuse the surface *selection*,
 * `validatePath`, and the container charset guard — the read family's guardrails,
 * just not its byte transfer.
 */
import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { shSingleQuote } from "../ssh/command.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerExecCommand } from "./dockerHelpers.js";
import { assertTargetTier, type Tier } from "../tiers/registry.js";

// ---------------------------------------------------------------------------
// Pure helpers (no I/O).
// ---------------------------------------------------------------------------

/**
 * Build a `grep -C` "balloon" command for one file. `-a` (text) so binary-ish
 * config files still match, `-n` (line numbers — the basis for before/after
 * reconstruction), `-E` (ERE), `-m N` to bound work and *detect* overflow (we ask
 * for one more than the caller's cap). Pattern and path are single-quoted; neither
 * reaches the shell unescaped.
 */
export function buildGrepCommand(
  path: string,
  pattern: string,
  context: number,
  maxMatches: number
): string {
  return (
    `grep -a -n -E -C ${context} -m ${maxMatches + 1} ` +
    `-e ${shSingleQuote(pattern)} -- ${shSingleQuote(path)}`
  );
}

export interface RegexMatch {
  lineNo: number;
  matchLine: string;
  before: string[];
  after: string[];
}

export interface ParsedGrep {
  matches: RegexMatch[];
  truncated: boolean;
}

/**
 * Parse `grep -n -C` output into per-match balloons. GNU grep prints match lines
 * as `<n>:<text>` and context lines as `<n>-<text>`, with `--` between
 * non-adjacent groups (overlapping contexts merge into one group with no
 * separator). We index every emitted line by its number, then reconstruct each
 * match's before/after from the neighbors actually present — robust to merged
 * groups. `truncated` is true when grep returned more than `maxMatches` (we asked
 * for `maxMatches + 1`); the extra match is dropped from the result.
 */
export function parseGrepContext(
  output: string,
  context: number,
  maxMatches: number
): ParsedGrep {
  const byLine = new Map<number, string>();
  const matchLineNos: number[] = [];
  for (const raw of output.split("\n")) {
    if (raw === "" || raw === "--") continue;
    const m = /^(\d+)([:-])([\s\S]*)$/.exec(raw);
    if (!m) continue;
    const lineNo = parseInt(m[1], 10);
    const text = m[3];
    byLine.set(lineNo, text);
    if (m[2] === ":") matchLineNos.push(lineNo);
  }

  const truncated = matchLineNos.length > maxMatches;
  const kept = matchLineNos.slice(0, maxMatches);
  const matches: RegexMatch[] = kept.map((lineNo) => {
    const before: string[] = [];
    for (let i = lineNo - context; i < lineNo; i++) {
      const t = byLine.get(i);
      if (t !== undefined) before.push(t);
    }
    const after: string[] = [];
    for (let i = lineNo + 1; i <= lineNo + context; i++) {
      const t = byLine.get(i);
      if (t !== undefined) after.push(t);
    }
    return { lineNo, matchLine: byLine.get(lineNo) ?? "", before, after };
  });
  return { matches, truncated };
}

/**
 * Clamp a requested value into [floor, max], defaulting when omitted. `floor`
 * defaults to 1, but `context` passes floor 0 — the schema declares `context`
 * `minimum: 0` and `context: 0` legitimately means "just the match line, no
 * neighbourhood" (ADR-023 §3); flooring it at 1 silently returned an extra line.
 */
function clamp(requested: number | undefined, def: number, max: number, floor = 1): number {
  if (requested === undefined) return Math.min(def, max);
  return Math.max(floor, Math.min(requested, max));
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export const SearchFileRegexInputSchema = z.object({
  path: z.string().min(1).describe("Absolute POSIX path to search"),
  pattern: z.string().min(1).describe("Extended regular expression (grep -E)"),
  context: z.number().int().nonnegative().optional().describe("lines of context each side (clamped to the cap)"),
  maxMatches: z.number().int().positive().optional().describe("max matches before the overflow marker (clamped)"),
  vmid: z.number().int().positive().optional().describe("target a file inside this LXC (companion)"),
  container: z
    .string()
    .optional()
    .describe("with vmid: target a file inside this Docker container in the LXC (companion)"),
});

export type SearchFileRegexInput = z.infer<typeof SearchFileRegexInputSchema>;

export interface SearchFileRegexResult {
  path: string;
  vmid?: number;
  container?: string;
  pattern: string;
  matchCount: number;
  truncated: boolean;
  matches: RegexMatch[];
}

export async function searchFileRegexHandler(
  input: SearchFileRegexInput,
  transport: SshTransport,
  cfg: Config,
  tier: Tier
): Promise<SearchFileRegexResult> {
  if (input.container !== undefined && input.vmid === undefined) {
    throw new Error("search_file_regex: container requires vmid (the LXC hosting the Docker container).");
  }

  // Tier follows the target kind, exactly like diff_config/revert_file.
  const kind = input.container !== undefined ? "docker" : input.vmid !== undefined ? "pct" : "host";
  assertTargetTier("search_file_regex", kind, tier);

  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const context = clamp(input.context, cfg.tools.searchDefaultContext, cfg.tools.searchMaxContext, 0);
  const maxMatches = clamp(input.maxMatches, cfg.tools.searchDefaultMaxMatches, cfg.tools.searchMaxMatches);

  const grep = buildGrepCommand(input.path, input.pattern, context, maxMatches);
  let command: string;
  if (kind === "docker") {
    command = buildPctExecCommand(input.vmid!, buildDockerExecCommand(input.container!, grep));
  } else if (kind === "pct") {
    command = buildPctExecCommand(input.vmid!, grep);
  } else {
    command = grep;
  }

  const r = await transport.exec(command, cfg.ssh.commandTimeoutMs);
  // grep exit codes: 0 = matched, 1 = no match (NOT an error), 2 = real error.
  if (r.exitCode === 1) {
    return {
      path: input.path,
      ...(input.vmid !== undefined ? { vmid: input.vmid } : {}),
      ...(input.container !== undefined ? { container: input.container } : {}),
      pattern: input.pattern,
      matchCount: 0,
      truncated: false,
      matches: [],
    };
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `search_file_regex failed (exit ${r.exitCode}): ${r.stderr.trim() || "no output"}`
    );
  }

  const parsed = parseGrepContext(r.stdout, context, maxMatches);
  return {
    path: input.path,
    ...(input.vmid !== undefined ? { vmid: input.vmid } : {}),
    ...(input.container !== undefined ? { container: input.container } : {}),
    pattern: input.pattern,
    matchCount: parsed.matches.length,
    truncated: parsed.truncated,
    matches: parsed.matches,
  };
}
