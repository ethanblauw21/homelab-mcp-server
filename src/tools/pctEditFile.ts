import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import type { ConfigHistory } from "../history/configHistory.js";
import { applyStringEdit, editFailureMessage } from "./editString.js";
import {
  readPctPrev,
  writeResolvedPct,
  type PctWriteFileResult,
  type PctWriteFileDryRunResult,
} from "./pctWriteFile.js";

/**
 * `pct_edit_file` (ADR-011) — find-and-replace front door to `pct_write_file`.
 * Reads the container file once (pull, running-guest gated), applies a literal
 * replacement, and funnels the result through the identical `writeResolvedPct`
 * pipeline. No new mutation surface.
 */
export const PctEditFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID"),
  path: z.string().min(1).describe("Absolute path inside the container (file must already exist)"),
  oldString: z.string().min(1).describe("Exact text to find — must be unique unless replaceAll"),
  newString: z.string().describe("Replacement text (may be empty to delete the matched text)"),
  replaceAll: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace every occurrence instead of requiring a unique match"),
  dryRun: z
    .boolean()
    .optional()
    .describe("Preview only: returns a unified diff + would-be metadata. No push, no backup, no audit."),
});

export type PctEditFileInput = z.infer<typeof PctEditFileInputSchema>;

export async function pctEditFileHandler(
  input: PctEditFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config,
  history?: ConfigHistory
): Promise<PctWriteFileResult | PctWriteFileDryRunResult> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const prev = await readPctPrev(transport, input.vmid, input.path, cfg, timeoutMs);

  if (prev.isNewFile || prev.prevContent === null) {
    throw new Error(
      `pct_edit_file: ${input.path} does not exist in container ${input.vmid}. Use pct_write_file to create it.`
    );
  }
  if (!isTextContent(prev.prevContent)) {
    throw new Error(
      `pct_edit_file: ${input.path} is binary (or non-UTF-8). Use pct_write_file for binary content.`
    );
  }

  const result = applyStringEdit({
    prev: prev.prevContent.toString("utf8"),
    oldString: input.oldString,
    newString: input.newString,
    replaceAll: input.replaceAll,
  });
  if (!result.ok) {
    throw new Error(`pct_edit_file: ${editFailureMessage(result)}`);
  }

  const newContent = Buffer.from(result.next, "utf8");

  return writeResolvedPct({
    vmid: input.vmid,
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "pct_edit_file",
    transport,
    audit,
    backupStore,
    cfg,
    history,
    timeoutMs,
  });
}
