import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256, type AuditTool } from "../audit/record.js";
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
import { contentLeafHash } from "../integrity/leafHash.js";

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
  // ADR-008 §3 — diff-on-write (new-file ⇒ diff vs empty; binary ⇒ diff: null).
  newFile: boolean;
  diff: string | null;
  diffTruncated?: boolean;
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

/** The previous in-container content of a target, read once (ADR-011 §3). */
export interface PctPrev {
  prevContent: Buffer | null;
  prevHash: string | null;
  isNewFile: boolean;
}

/**
 * Read a container file's current bytes via the pull flow, gated on a running
 * guest (A3.1). Shared by `pct_write_file` and `pct_edit_file` so the edit door
 * applies its replacement to the SAME bytes the pipeline backs up (ADR-011 §3).
 * A null pull result means file-not-found (new file); any other pull failure
 * throws inside pullContainerFile and is surfaced, never reinterpreted.
 */
export async function readPctPrev(
  transport: SshTransport,
  vmid: number,
  path: string,
  cfg: Config,
  timeoutMs: number
): Promise<PctPrev> {
  await assertContainerRunning(transport, vmid, timeoutMs);
  const { content: prevContent } = await pullContainerFile(
    transport,
    vmid,
    path,
    cfg.container.nodeTempDir,
    timeoutMs
  );
  return {
    prevContent,
    prevHash: prevContent ? sha256(prevContent) : null,
    isNewFile: prevContent === null,
  };
}

export interface WriteResolvedPctArgs {
  vmid: number;
  path: string;
  dryRun?: boolean;
  prev: PctPrev;
  newContent: Buffer;
  tool: Extract<AuditTool, "pct_write_file" | "pct_edit_file">;
  transport: SshTransport;
  audit: AuditLog;
  backupStore: BackupStore;
  cfg: Config;
  history?: ConfigHistory;
  timeoutMs: number;
}

/**
 * The post-read container write pipeline (ADR-011 §3): both `pct_write_file` and
 * `pct_edit_file` funnel through here, inheriting backup, perm-preservation,
 * the hash-anchored audit record (ADR-009), and config-history capture (ADR-006)
 * byte-for-byte.
 */
export async function writeResolvedPct(
  args: WriteResolvedPctArgs
): Promise<PctWriteFileResult | PctWriteFileDryRunResult> {
  const { vmid, path, prev, newContent, tool, transport, audit, backupStore, cfg, history, timeoutMs } =
    args;
  const { prevContent, prevHash, isNewFile } = prev;

  // ADR-014 §2 — last managed write's content hash; drives the re-anchor on drift.
  const chainBaseHash = backupStore.latestBaseHash({ kind: "pct", vmid, remotePath: path });

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

  // Diff-on-write (ADR-008 §3): computed once, shared by dryRun + the real push.
  const diffable =
    isTextContent(newContent) && (isNewFile || (prevContent !== null && isTextContent(prevContent)));
  const diff = diffable
    ? computeUnifiedDiff(
        prevContent ? prevContent.toString("utf8") : "",
        newContent.toString("utf8"),
        cfg.tools.dryRunDiffMaxLines
      )
    : null;

  // dryRun: run the full pipeline READ-ONLY and return a preview. No push, no
  // backup stored, no audit record — a dry run has zero side effects (ADR-004 §6).
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
      chainBaseHash,
    });

    return {
      dryRun: true,
      vmid,
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
    chainBaseHash,
  });

  const newHash = contentHash(newContent);
  // Local backup is written BEFORE the push, so a leaked node temp never holds
  // the only copy. File key derives from the pct: descriptor (no host collision).
  const backupResult = await backupStore.storeBackup(
    { kind: "pct", vmid, remotePath: path },
    kind,
    newHash
  );

  // Preserve existing perms/owner; new files use configured defaults.
  let perms: GuestPerms;
  if (isNewFile) {
    perms = { mode: cfg.container.newFileMode, uid: cfg.container.newFileUid, gid: cfg.container.newFileGid };
  } else {
    perms =
      (await statContainerPerms(transport, vmid, path, timeoutMs)) ?? {
        mode: cfg.container.newFileMode,
        uid: cfg.container.newFileUid,
        gid: cfg.container.newFileGid,
      };
  }

  await pushContainerFile(
    transport,
    vmid,
    path,
    newContent,
    perms,
    cfg.container.nodeTempDir,
    timeoutMs
  );

  const record = buildAuditRecord({
    tool,
    host: cfg.ssh.host,
    vmid,
    path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    // ADR-009 hash anchor: matches the pct/<vmid> forest content-leaf hash.
    beforeHash: prevContent ? contentLeafHash(prevContent) : undefined,
    afterHash: contentLeafHash(newContent),
    hashScope: path,
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    note: largeChange.isLarge ? largeChange.reason : undefined,
  });

  // ADR-006 capture path A (best-effort; never fails the push).
  if (history) {
    record.historyCommitted = await history.recordMutation(
      transport,
      { kind: "pct", vmid, remotePath: path },
      newContent,
      tool,
      record.id,
      timeoutMs
    );
  }

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
    vmid,
    newFile: isNewFile,
    diff: diff ? diff.diff : null,
    diffTruncated: diff ? diff.truncated : undefined,
  };
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

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const prev = await readPctPrev(transport, input.vmid, input.path, cfg, timeoutMs);
  const newContent = Buffer.from(input.content, input.encoding);

  return writeResolvedPct({
    vmid: input.vmid,
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "pct_write_file",
    transport,
    audit,
    backupStore,
    cfg,
    history,
    timeoutMs,
  });
}
