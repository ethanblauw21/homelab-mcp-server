import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256 } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import {
  assertContainerRunning,
  pullContainerFile,
  statContainerPerms,
  pushContainerFile,
  type GuestPerms,
} from "./pctFiles.js";
import { computeUnifiedDiff } from "../util/diff.js";
import type { ConfigHistory } from "../history/configHistory.js";

export const PctWriteFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID"),
  path: z.string().min(1).describe("Absolute path of the file inside the container"),
  content: z.string().describe("File content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of the content field"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Preview only: returns a unified diff + would-be metadata. No push, no backup, no audit."
    ),
});

export type PctWriteFileInput = z.infer<typeof PctWriteFileInputSchema>;

export interface PctWriteFileResult {
  backupPath: string | null;
  auditId: string;
  revertible: boolean;
  vmid: number;
}

export interface PctWriteFileDryRunResult {
  dryRun: true;
  vmid: number;
  isNewFile: boolean;
  kind: string;
  isLargeChange: boolean;
  largeChangeReason?: string;
  prevBytes: number;
  newBytes: number;
  diff: string | null;
  diffTruncated?: boolean;
  note?: string;
}

export async function pctWriteFileHandler(
  input: PctWriteFileInput,
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

  const newContent = Buffer.from(input.content, input.encoding);
  const timeoutMs = cfg.ssh.commandTimeoutMs;

  // A3.1: refuse on a stopped container so a failed pull is never misread as
  // "new file" against a guest that can't receive the push.
  await assertContainerRunning(transport, input.vmid, timeoutMs);

  // Read previous content via the pull flow. A null result means the file does
  // not exist (running + file-not-found specifically); any other pull failure
  // throws inside pullContainerFile and is surfaced, never reinterpreted.
  const { content: prevContent } = await pullContainerFile(
    transport,
    input.vmid,
    input.path,
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

  // dryRun: run the full pipeline READ-ONLY and return a preview. No push, no
  // backup stored, no audit record — a dry run has zero side effects (ADR-004 §6).
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

    const diffable =
      isTextContent(newContent) && (isNewFile || (prevContent !== null && isTextContent(prevContent)));
    const diff = diffable
      ? computeUnifiedDiff(
          prevContent ? prevContent.toString("utf8") : "",
          newContent.toString("utf8"),
          cfg.tools.dryRunDiffMaxLines
        )
      : null;

    return {
      dryRun: true,
      vmid: input.vmid,
      isNewFile,
      kind: kind.type,
      isLargeChange: largeChange.isLarge,
      largeChangeReason: largeChange.isLarge ? largeChange.reason : undefined,
      prevBytes: prevContent?.length ?? 0,
      newBytes: newContent.length,
      diff: diff ? diff.diff : null,
      diffTruncated: diff ? diff.truncated : undefined,
      note: diff ? undefined : "binary content — diff omitted",
    };
  }

  if (backupStore.checkDiskPressure()) {
    if (cfg.backup.diskPressureFailSafe === "refuse") {
      throw new Error("Backup storage is over cap; write refused by disk-pressure fail-safe");
    }
    // warn — proceed
  }

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
  // Local backup is written BEFORE the push, so a leaked node temp never holds
  // the only copy. File key derives from the pct: descriptor (no host collision).
  const backupResult = await backupStore.storeBackup(
    { kind: "pct", vmid: input.vmid, remotePath: input.path },
    kind,
    newHash
  );

  // Preserve existing perms/owner; new files use configured defaults.
  let perms: GuestPerms;
  if (isNewFile) {
    perms = { mode: cfg.container.newFileMode, uid: cfg.container.newFileUid, gid: cfg.container.newFileGid };
  } else {
    perms =
      (await statContainerPerms(transport, input.vmid, input.path, timeoutMs)) ?? {
        mode: cfg.container.newFileMode,
        uid: cfg.container.newFileUid,
        gid: cfg.container.newFileGid,
      };
  }

  await pushContainerFile(
    transport,
    input.vmid,
    input.path,
    newContent,
    perms,
    cfg.container.nodeTempDir,
    timeoutMs
  );

  const record = buildAuditRecord({
    tool: "pct_write_file",
    host: cfg.ssh.host,
    vmid: input.vmid,
    path: input.path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    note: largeChange.isLarge ? largeChange.reason : undefined,
  });

  // ADR-006 capture path A (best-effort; never fails the push).
  if (history) {
    record.historyCommitted = await history.recordMutation(
      transport,
      { kind: "pct", vmid: input.vmid, remotePath: input.path },
      newContent,
      "pct_write_file",
      record.id,
      timeoutMs
    );
  }

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
    vmid: input.vmid,
  };
}
