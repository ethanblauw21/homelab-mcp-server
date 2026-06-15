import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256 } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { assertAgentAvailable, resolveNodeName, readVmFile, writeVmFile } from "./qmFiles.js";
import { computeUnifiedDiff } from "../util/diff.js";
import { contentLeafHash } from "../integrity/leafHash.js";

export const QmWriteFileInputSchema = z.object({
  vmid: z.number().int().positive().describe("VM ID (qm guest)"),
  path: z.string().min(1).describe("Absolute path of the file inside the VM"),
  content: z.string().describe("File content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of the content field"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Preview only: returns a unified diff + would-be metadata. No write, no backup, no audit."
    ),
});

export type QmWriteFileInput = z.infer<typeof QmWriteFileInputSchema>;

export interface QmWriteFileResult {
  backupPath: string | null;
  auditId: string;
  revertible: boolean;
  vmid: number;
}

export interface QmWriteFileDryRunResult {
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

/**
 * `qm_write_file` — write a file inside a VM via the QEMU guest agent (ADR-005
 * stretch). Mirrors `pct_write_file`'s ADR-003 pipeline (backup before write,
 * dedup/diff backup kind, audit) with two agent-imposed differences:
 *
 *  - **Size cap.** The guest-agent write endpoint bounds a single payload; a
 *    write over `tools.qmWriteMaxBytes` is refused (use `qm_exec` for larger
 *    edits) rather than truncated in the guest.
 *  - **No perm preservation.** Unlike `pct push`, the agent write takes no
 *    mode/owner; the file lands with the guest's default umask.
 */
export async function qmWriteFileHandler(
  input: QmWriteFileInput,
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

  const newContent = Buffer.from(input.content, input.encoding);
  if (newContent.length > cfg.tools.qmWriteMaxBytes) {
    throw new Error(
      `Content is ${newContent.length} bytes, over the ${cfg.tools.qmWriteMaxBytes}-byte ` +
        `guest-agent write cap. Use qm_exec for larger in-guest edits.`
    );
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  await assertAgentAvailable(transport, input.vmid, timeoutMs);
  const node = await resolveNodeName(transport, timeoutMs);

  // Read previous content via the agent. null = file does not exist (new file);
  // any other read failure throws inside readVmFile and is surfaced.
  const { content: prevContent } = await readVmFile(transport, node, input.vmid, input.path, timeoutMs);
  const isNewFile = prevContent === null;
  const prevHash = prevContent ? sha256(prevContent) : null;

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

  // dryRun: full pipeline READ-ONLY, no side effects (write/backup/audit).
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
  // Local backup written BEFORE the guest write. File key derives from the qm:
  // descriptor (no host/pct collision).
  const backupResult = await backupStore.storeBackup(
    { kind: "qm", vmid: input.vmid, remotePath: input.path },
    kind,
    newHash
  );

  await writeVmFile(transport, node, input.vmid, input.path, newContent, timeoutMs);

  const record = buildAuditRecord({
    tool: "qm_write_file",
    host: cfg.ssh.host,
    vmid: input.vmid,
    path: input.path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    // ADR-009 content fingerprint. A VM is NOT in the Merkle forest (no
    // descriptor-stable fs), so this never explains a forest drift — it only
    // makes the write queryable by content hash in query_audit.
    beforeHash: prevContent ? contentLeafHash(prevContent) : undefined,
    afterHash: contentLeafHash(newContent),
    hashScope: input.path,
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    note: largeChange.isLarge ? largeChange.reason : undefined,
  });

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
    vmid: input.vmid,
  };
}
