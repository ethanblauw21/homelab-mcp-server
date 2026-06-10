import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { shSingleQuote } from "../ssh/command.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { redactString } from "../guardrails/redaction.js";

export const TailLogInputSchema = z.object({
  target: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("host") }),
      z.object({ kind: z.literal("pct"), vmid: z.number().int().positive() }),
    ])
    .default({ kind: "host" })
    .describe("Where to read: the Proxmox host, or inside an LXC container"),
  unit: z.string().optional().describe("systemd unit to read via journalctl (exclusive with path)"),
  path: z.string().optional().describe("absolute log file path to tail (exclusive with unit)"),
  lines: z.number().int().positive().optional().describe("number of trailing lines (clamped to the cap)"),
  since: z
    .string()
    .optional()
    .describe('time filter: ISO timestamp or relative like "30 min ago" (unit mode only)'),
});

export type TailLogInput = z.infer<typeof TailLogInputSchema>;
export type TailTarget = TailLogInput["target"];

/**
 * systemd unit-name charset (A5): alphanumerics plus `@ : . _ - \` and an
 * optional type suffix. No spaces, no shell metacharacters — nothing free-form
 * reaches command construction.
 */
const UNIT_RE = /^[A-Za-z0-9@:._\\-]{1,256}$/;

/** ISO timestamp, or `<n> (min|hour|day)s ago`. The only two accepted `since` shapes. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const RELATIVE_RE = /^\d+\s*(min|hour|day)s?\s*ago$/;

export function validateUnitName(unit: string): boolean {
  return UNIT_RE.test(unit);
}

export function validateSince(since: string): boolean {
  return ISO_RE.test(since.trim()) || RELATIVE_RE.test(since.trim());
}

export function clampLines(requested: number | undefined, cap: number): number {
  const n = requested ?? Math.min(100, cap);
  return Math.max(1, Math.min(n, cap));
}

export interface BuiltTailCommand {
  command: string;
  mode: "unit" | "path";
  lines: number;
}

/**
 * Pure command builder with all validation (A5). Enforces unit XOR path, the unit
 * charset, the `since` grammar, the line cap, and (path mode) `validatePath`.
 * Throws on any violation so no unvalidated string is ever interpolated.
 */
export function buildTailCommand(input: TailLogInput, cfg: Config): BuiltTailCommand {
  const hasUnit = input.unit !== undefined && input.unit !== "";
  const hasPath = input.path !== undefined && input.path !== "";
  if (hasUnit === hasPath) {
    throw new Error("Provide exactly one of `unit` or `path`.");
  }
  const lines = clampLines(input.lines, cfg.tools.tailLinesCap);

  let inner: string;
  let mode: "unit" | "path";
  if (hasUnit) {
    const unit = input.unit!;
    if (!validateUnitName(unit)) {
      throw new Error(`Invalid unit name: ${JSON.stringify(unit)}`);
    }
    let cmd = `journalctl -u ${shSingleQuote(unit)} -n ${lines} --no-pager`;
    if (input.since !== undefined && input.since !== "") {
      if (!validateSince(input.since)) {
        throw new Error(
          `Invalid \`since\`: ${JSON.stringify(input.since)}. Use an ISO timestamp or "<n> min|hour|day ago".`
        );
      }
      cmd += ` --since ${shSingleQuote(input.since.trim())}`;
    }
    inner = cmd;
    mode = "unit";
  } else {
    if (input.since !== undefined && input.since !== "") {
      throw new Error("`since` is only valid with `unit` (journalctl), not with `path`.");
    }
    const pathResult = validatePath(input.path!, {
      allowlist: cfg.guardrails.pathAllowlist,
      denylist: cfg.guardrails.pathDenylist,
    });
    if (!pathResult.valid) {
      throw new Error(`Invalid path: ${pathResult.reason}`);
    }
    inner = `tail -n ${lines} ${shSingleQuote(input.path!)}`;
    mode = "path";
  }

  const command =
    input.target.kind === "pct" ? buildPctExecCommand(input.target.vmid, inner) : inner;
  return { command, mode, lines };
}

export interface TailLogResult {
  target: TailTarget;
  mode: "unit" | "path";
  source: string;
  lines: number;
  content: string;
}

/**
 * `tail_log` — bounded, validated, redacted log reads (ADR-005 §Part 2).
 *
 * Read-only, not audited. Output ALWAYS passes through the ADR-002 redaction
 * module before return — logs leak tokens, connection strings, and Authorization
 * headers constantly; over-redaction here is the safe failure mode.
 */
export async function tailLogHandler(
  input: TailLogInput,
  transport: SshTransport,
  cfg: Config
): Promise<TailLogResult> {
  const built = buildTailCommand(input, cfg);
  const r = await transport.exec(built.command, cfg.health.probeTimeoutMs);
  if (r.exitCode !== 0) {
    // Redact stderr too — a failing journalctl/tail can still echo a path/secret.
    const reason = redactString(r.stderr.trim() || `exit ${r.exitCode}`, cfg.census.redactionExtraKeys).value;
    throw new Error(`tail_log failed (exit ${r.exitCode}): ${reason}`);
  }
  const content = redactString(r.stdout, cfg.census.redactionExtraKeys).value;
  return {
    target: input.target,
    mode: built.mode,
    source: input.unit ?? input.path ?? "",
    lines: built.lines,
    content,
  };
}
