import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256, type AuditTool } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { assertContainerRunning, type GuestPerms } from "./pctFiles.js";
import { assertDockerName, type DockerInspect } from "./dockerHelpers.js";
import {
  resolveDockerContainer,
  readDockerFile,
  statDockerPerms,
  writeDockerFile,
} from "./dockerFiles.js";
import { computeUnifiedDiff } from "../util/diff.js";
import { contentLeafHash } from "../integrity/leafHash.js";

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

/** The previous in-container Docker content of a target, read once (ADR-011 §3). */
export interface DockerPrev {
  /** Resolved `docker inspect` — read once, reused by the write (mounts, id). */
  inspect: DockerInspect;
  prevContent: Buffer | null;
  viaBindMount: boolean;
  prevHash: string | null;
  isNewFile: boolean;
}

/**
 * Read a Docker container file's current bytes (bind-mount fast path or `docker
 * cp` relay), gated on a running LXC + a one-time `docker inspect` (both the read
 * and the later write need the mount table + id). Shared by `docker_write_file`
 * and `docker_edit_file` so the edit door applies its replacement to the SAME
 * bytes the pipeline backs up (ADR-011 §3). A null read means file-not-found
 * (new file); any other read failure throws and is surfaced.
 */
export async function readDockerPrev(
  transport: SshTransport,
  vmid: number,
  container: string,
  path: string,
  cfg: Config,
  timeoutMs: number
): Promise<DockerPrev> {
  await assertContainerRunning(transport, vmid, timeoutMs);
  const inspect = await resolveDockerContainer(transport, vmid, container, timeoutMs);
  const { content: prevContent, viaBindMount } = await readDockerFile(
    transport,
    vmid,
    container,
    path,
    inspect,
    cfg.container.nodeTempDir,
    timeoutMs
  );
  return {
    inspect,
    prevContent,
    viaBindMount,
    prevHash: prevContent ? sha256(prevContent) : null,
    isNewFile: prevContent === null,
  };
}

export interface WriteResolvedDockerArgs {
  vmid: number;
  container: string;
  path: string;
  dryRun?: boolean;
  prev: DockerPrev;
  newContent: Buffer;
  tool: Extract<AuditTool, "docker_write_file" | "docker_edit_file">;
  transport: SshTransport;
  audit: AuditLog;
  backupStore: BackupStore;
  cfg: Config;
  timeoutMs: number;
}

/**
 * The post-read Docker write pipeline (ADR-011 §3): both `docker_write_file` and
 * `docker_edit_file` funnel through here, inheriting the backup (keyed on the
 * `docker:` descriptor), large-change detection, disk pressure, the diff-on-write
 * response, and the hash-anchored audit record (ADR-009). Docker targets have no
 * git-mirror layout (like qm) so the ADR-006 mutation-commit path is skipped.
 */
export async function writeResolvedDocker(
  args: WriteResolvedDockerArgs
): Promise<DockerWriteFileResult | DockerWriteFileDryRunResult> {
  const { vmid, container, path, prev, newContent, tool, transport, audit, backupStore, cfg, timeoutMs } =
    args;
  const { inspect, prevContent, viaBindMount, prevHash, isNewFile } = prev;

  // #20 — re-anchor a delta backup to a self-contained full copy when the live
  // file drifted out-of-band since the last managed write.
  const lastBackupBaseHash = backupStore.latestBaseHash({ kind: "docker", vmid, container, remotePath: path });

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

  const writeDiff = buildWriteDiff(prevContent, newContent, isNewFile, cfg.tools.dryRunDiffMaxLines);

  // dryRun: full pipeline READ-ONLY, zero side effects (ADR-004 §6).
  if (args.dryRun) {
    const existingHashMap = backupStore.buildExistingHashMap(cfg.backup.baseDir);
    const kind = await selectBackupKind({
      newContent,
      prevContent,
      prevHash,
      isText: isTextContent(newContent),
      largeFileBytesThreshold: cfg.backup.largeFileBytesThreshold,
      largeFilePolicy: cfg.backup.largeFilePolicy,
      existingHashToPaths: existingHashMap,
      lastBackupBaseHash,
    });
    return {
      dryRun: true,
      vmid,
      container,
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
      ? await statDockerPerms(transport, vmid, container, path, timeoutMs)
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
    lastBackupBaseHash,
  });

  const newHash = contentHash(newContent);
  // Local backup BEFORE any push; key derives from the docker: descriptor
  // (no host/pct/qm collision). Identity is the container name.
  const backupResult = await backupStore.storeBackup(
    { kind: "docker", vmid, container, remotePath: path },
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
    vmid,
    container,
    path,
    newContent,
    inspect,
    prevPerms,
    newFileDefaults,
    cfg.container.nodeTempDir,
    timeoutMs
  );

  const record = buildAuditRecord({
    tool,
    host: cfg.ssh.host,
    vmid,
    container,
    containerId: inspect.id || undefined,
    path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    // ADR-009 content fingerprint. Docker files are not in the Merkle forest
    // (parity with qm), so this is queryable-by-hash, not a drift explainer.
    beforeHash: prevContent ? contentLeafHash(prevContent) : undefined,
    afterHash: contentLeafHash(newContent),
    hashScope: path,
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
    vmid,
    container,
    viaBindMount: writeRes.viaBindMount,
    newFile: isNewFile,
    diff: writeDiff.diff,
    diffTruncated: writeDiff.truncated,
    note: writeRes.note,
  };
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

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const prev = await readDockerPrev(
    transport,
    input.vmid,
    input.container,
    input.path,
    cfg,
    timeoutMs
  );
  const newContent = Buffer.from(input.content, input.encoding);

  return writeResolvedDocker({
    vmid: input.vmid,
    container: input.container,
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "docker_write_file",
    transport,
    audit,
    backupStore,
    cfg,
    timeoutMs,
  });
}
