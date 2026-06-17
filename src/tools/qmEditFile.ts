import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { applyStringEdit, editFailureMessage } from "./editString.js";
import {
  readQmPrev,
  writeResolvedQm,
  type QmWriteFileResult,
  type QmWriteFileDryRunResult,
} from "./qmWriteFile.js";

/**
 * `qm_edit_file` (ADR-011) — find-and-replace front door to `qm_write_file`.
 * Reads the VM file once (via the guest agent, agent-precheck gated), applies a
 * literal replacement, and funnels the result through the identical
 * `writeResolvedQm` pipeline (same size cap, backup, audit). No new mutation
 * surface; the VM is not in the Merkle forest, like a plain qm write.
 */
export const QmEditFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("VM ID (qm guest)"),
  path: z.string().min(1).describe("Absolute path inside the VM (file must already exist)"),
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

export type QmEditFileInput = z.infer<typeof QmEditFileInputSchema>;

export async function qmEditFileHandler(
  input: QmEditFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config
): Promise<QmWriteFileResult | QmWriteFileDryRunResult> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const prev = await readQmPrev(transport, input.vmid, input.path, timeoutMs);

  if (prev.isNewFile || prev.prevContent === null) {
    throw new Error(
      `qm_edit_file: ${input.path} does not exist in VM ${input.vmid}. Use qm_write_file to create it.`
    );
  }
  if (!isTextContent(prev.prevContent)) {
    throw new Error(
      `qm_edit_file: ${input.path} is binary (or non-UTF-8). Use qm_write_file for binary content.`
    );
  }

  const result = applyStringEdit({
    prev: prev.prevContent.toString("utf8"),
    oldString: input.oldString,
    newString: input.newString,
    replaceAll: input.replaceAll,
  });
  if (!result.ok) {
    throw new Error(`qm_edit_file: ${editFailureMessage(result)}`);
  }

  const newContent = Buffer.from(result.next, "utf8");

  return writeResolvedQm({
    vmid: input.vmid,
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "qm_edit_file",
    transport,
    audit,
    backupStore,
    cfg,
    timeoutMs,
  });
}
