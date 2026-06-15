import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256 } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { assertContainerRunning, type GuestPerms } from "./pctFiles.js";
import { assertDockerName } from "./dockerHelpers.js";
import {
  resolveDockerContainer,
  readDockerFile,
  statDockerPerms,
  writeDockerFile,
} from "./dockerFiles.js";
import { computeUnifiedDiff } from "../util/diff.js";

export const DockerWriteFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name"),
  path: z.string().min(1).describe("Absolute path of the file inside the Docker container"),
  content: z.string().describe("File content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of the content field"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Preview only: returns a unified diff + would-be metadata. No write, no backup, no audit."
    ),
});

export type DockerWriteFileInput = z.infer<typeof DockerWriteFileInputSchema>;

export interface DockerWriteFileResult {
  backupPath: string | null;
  auditId: string;
  revertible: boolean;
  vmid: number;
  container: string;
  viaBindMount: boolean;
  newFile: boolean;
  // ADR-008 §3 — diff-on-write: every write is its own review at zero extra I/O.
  diff: string | null;
  diffTruncated?: boolean;
  note?: string;
}

export interface DockerWriteFileDryRunResult {
  dryRun: true;
  vmid: number;
  container: string;
  isNewFile: boolean;
  viaBindMount: boolean;
  kind: string;
  isLargeChange: boolean;
  largeChangeReason?: string;
  prevBytes: number;
  newBytes: number;
  diff: string | null;
  diffTruncated?: boolean;
  note?: string;
}

/** Pure: build the diff-on-write payload from prev/new content (shared by §3). */
function buildWriteDiff(
  prevContent: Buffer | null,
  newContent: Buffer,
  isNewFile: boolean,
  maxLines: number
): { diff: string | null; truncated?: boolean } {
  const diffable =
    isTextContent(newContent) && (isNewFile || (prevContent !== null && isTextContent(prevContent)));
  if (!diffable) return { diff: null };
  const d = computeUnifiedDiff(
    prevContent ? prevContent.toString("utf8") : "",
    newContent.toString("utf8"),
    maxLines
  );
  return { diff: d.diff, truncated: d.truncated };
}

/**
 * `docker_write_file` (ADR-008 §2/§3). Full pipeline parity with `pct_write_file`:
 * bind-mount fast path or `docker cp` slow path, backup (keyed on the `docker:`
 * descriptor — identity is the container *name*, following intent not plumbing),
 * large-change detection, disk pressure, `dryRun` preview, and a diff in the
 * response. Docker targets have no git-mirror layout (like qm) so the ADR-006
 * mutation-commit path is skipped.
 */
export async function dockerWriteFileHandler(
  input: DockerWriteFileInput,
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

  const newContent = Buffer.from(input.content, input.encoding);
  const timeoutMs = cfg.ssh.commandTimeoutMs;

  await assertContainerRunning(transport, input.vmid, timeoutMs);
  const inspect = await resolveDockerContainer(transport, input.vmid, input.container, timeoutMs);

  const { content: prevContent, viaBindMount } = await readDockerFile(
    transport,
    input.vmid,
    input.container,
    input.path,
    inspect,
    cfg.container.nodeTempDir,
    timeoutMs
  );
  const isNewFile = prevContent === null;
  const prevHash = prevContent ? sha256(prevContent) : null;

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

  const writeDiff = buildWriteDiff(prevContent, newContent, isNewFile, cfg.tools.dryRunDiffMaxLines);

  // dryRun: full pipeline READ-ONLY, zero side effects (ADR-004 §6).
  if (input.dryRun) {
    const existingHashMap = backupStore.buildExistingHashMap(cfg.backup.baseDir);
    const kind = await selectBackupKind({
      newContent,
      prevContent,
      prevHash,
      isText: isTextContent(newContent),
      largeFileBytesThreshold: cfg.backup.largeFileBytesThreshold,
      largeFilePolicy: cfg.backup.largeFilePolicy,
      existingHashToPaths: existingHashMap,
    });
    return {
      dryRun: true,
      vmid: input.vmid,
      container: input.container,
      isNewFile,
      viaBindMount,
      kind: kind.type,
      isLargeChange: largeChange.isLarge,
      largeChangeReason: largeChange.isLarge ? largeChange.reason : undefined,
      prevBytes: prevContent?.length ?? 0,
      newBytes: newContent.length,
      diff: writeDiff.diff,
      diffTruncated: writeDiff.truncated,
      note: writeDiff.diff === null ? "binary content — diff omitted" : undefined,
    };
  }

  if (backupStore.checkDiskPressure()) {
    if (cfg.backup.diskPressureFailSafe === "refuse") {
      throw new Error("Backup storage is over cap; write refused by disk-pressure fail-safe");
    }
  }

  // Slow-path ownership: capture perms BEFORE the write (the cp endpoint preserves
  // none). Bind-path perm preservation is handled inside writeDockerFile.
  const prevPerms =
    !viaBindMount && !isNewFile
      ? await statDockerPerms(transport, input.vmid, input.container, input.path, timeoutMs)
      : null;

  const existingHashMap = backupStore.buildExistingHashMap(cfg.backup.baseDir);
  const kind = await selectBackupKind({
    newContent,
    prevContent,
    prevHash,
    isText: isTextContent(newContent),
    largeFileBytesThreshold: cfg.backup.largeFileBytesThreshold,
    largeFilePolicy: cfg.backup.largeFilePolicy,
    existingHashToPaths: existingHashMap,
  });

  const newHash = contentHash(newContent);
  // Local backup BEFORE any push; key derives from the docker: descriptor
  // (no host/pct/qm collision). Identity is the container name.
  const backupResult = await backupStore.storeBackup(
    { kind: "docker", vmid: input.vmid, container: input.container, remotePath: input.path },
    kind,
    newHash
  );

  const newFileDefaults: GuestPerms = {
    mode: cfg.container.newFileMode,
    uid: cfg.container.newFileUid,
    gid: cfg.container.newFileGid,
  };
  const writeRes = await writeDockerFile(
    transport,
    input.vmid,
    input.container,
    input.path,
    newContent,
    inspect,
    prevPerms,
    newFileDefaults,
    cfg.container.nodeTempDir,
    timeoutMs
  );

  const record = buildAuditRecord({
    tool: "docker_write_file",
    host: cfg.ssh.host,
    vmid: input.vmid,
    container: input.container,
    containerId: inspect.id || undefined,
    path: input.path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    // Docker targets have no git-mirror layout (parity with qm).
    historyCommitted: false,
    note: [largeChange.isLarge ? largeChange.reason : undefined, writeRes.note]
      .filter(Boolean)
      .join("; ") || undefined,
  });

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
    vmid: input.vmid,
    container: input.container,
    viaBindMount: writeRes.viaBindMount,
    newFile: isNewFile,
    diff: writeDiff.diff,
    diffTruncated: writeDiff.truncated,
    note: writeRes.note,
  };
}
