import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { assertDockerName } from "./dockerHelpers.js";
import { applyStringEdit, editFailureMessage } from "./editString.js";
import {
  readDockerPrev,
  writeResolvedDocker,
  type DockerWriteFileResult,
  type DockerWriteFileDryRunResult,
} from "./dockerWriteFile.js";

/**
 * `docker_edit_file` (ADR-011) — find-and-replace front door to
 * `docker_write_file`. Reads the container file once (bind-mount fast path or
 * `docker cp` relay, running-LXC gated), applies a literal replacement, and
 * funnels the result through the identical `writeResolvedDocker` pipeline. No
 * new mutation surface; Docker files are not in the Merkle forest (parity with qm).
 */
export const DockerEditFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name"),
  path: z
    .string()
    .min(1)
    .describe("Absolute path inside the Docker container (file must already exist)"),
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

export type DockerEditFileInput = z.infer<typeof DockerEditFileInputSchema>;

export async function dockerEditFileHandler(
  input: DockerEditFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config
): Promise<DockerWriteFileResult | DockerWriteFileDryRunResult> {
  assertDockerName(input.container);
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const prev = await readDockerPrev(
    transport,
    input.vmid,
    input.container,
    input.path,
    cfg,
    timeoutMs
  );

  if (prev.isNewFile || prev.prevContent === null) {
    throw new Error(
      `docker_edit_file: ${input.path} does not exist in container ${input.container} (LXC ${input.vmid}). ` +
        `Use docker_write_file to create it.`
    );
  }
  if (!isTextContent(prev.prevContent)) {
    throw new Error(
      `docker_edit_file: ${input.path} is binary (or non-UTF-8). Use docker_write_file for binary content.`
    );
  }

  const result = applyStringEdit({
    prev: prev.prevContent.toString("utf8"),
    oldString: input.oldString,
    newString: input.newString,
    replaceAll: input.replaceAll,
  });
  if (!result.ok) {
    throw new Error(`docker_edit_file: ${editFailureMessage(result)}`);
  }

  const newContent = Buffer.from(result.next, "utf8");

  return writeResolvedDocker({
    vmid: input.vmid,
    container: input.container,
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "docker_edit_file",
    transport,
    audit,
    backupStore,
    cfg,
    timeoutMs,
  });
}
