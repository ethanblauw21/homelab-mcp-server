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
  readHostPrev,
  writeResolvedHost,
  type WriteFileResult,
  type WriteFileDryRunResult,
} from "./writeFile.js";

/**
 * `edit_file` (ADR-011) — the token-cheaper front door to `write_file`. The
 * model sends only `oldString`→`newString`; the server reads the file once,
 * applies the literal replacement, and funnels the resulting bytes through the
 * EXACT `writeResolvedHost` pipeline `write_file` uses (backup → audit + ADR-009
 * anchor → diff-on-write → config-history). No new mutation surface: every
 * guardrail is inherited byte-for-byte.
 */
export const EditFileInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host (file must already exist)"),
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
    .describe("Preview only: returns a unified diff + would-be metadata. No write, no backup, no audit."),
});

export type EditFileInput = z.infer<typeof EditFileInputSchema>;

export async function editFileHandler(
  input: EditFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config,
  history?: ConfigHistory,
  rootTier = false
): Promise<WriteFileResult | WriteFileDryRunResult> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  // The ONE content read; the edit is applied to exactly these bytes (ADR-011 §3).
  const prev = await readHostPrev(transport, input.path);

  // Edit preconditions (ADR-011 §2): the file must exist and be text. New-file
  // creation and binary writes stay with write_file (no token win to capture).
  if (prev.isNewFile || prev.prevContent === null) {
    throw new Error(
      `edit_file: ${input.path} does not exist. Use write_file to create a new file.`
    );
  }
  if (!isTextContent(prev.prevContent)) {
    throw new Error(
      `edit_file: ${input.path} is binary (or non-UTF-8). Use write_file for binary content.`
    );
  }

  const result = applyStringEdit({
    prev: prev.prevContent.toString("utf8"),
    oldString: input.oldString,
    newString: input.newString,
    replaceAll: input.replaceAll,
  });
  if (!result.ok) {
    throw new Error(`edit_file: ${editFailureMessage(result)}`);
  }

  const newContent = Buffer.from(result.next, "utf8");

  return writeResolvedHost({
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "edit_file",
    transport,
    audit,
    backupStore,
    cfg,
    history,
    rootTier,
  });
}
