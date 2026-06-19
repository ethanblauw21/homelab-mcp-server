import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256, type AuditTool } from "../audit/record.js";
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

/** The previous in-VM content of a target, read once via the agent (ADR-011 §3). */
export interface QmPrev {
  /** PVE node name resolved for the `pvesh agent/*` paths — read once, reused for the write. */
  node: string;
  prevContent: Buffer | null;
  prevHash: string | null;
  isNewFile: boolean;
}

/**
 * Read a VM file's current bytes via the guest agent, after an agent precheck
 * and a one-time node-name resolve (both the read and the later write need the
 * node). Shared by `qm_write_file` and `qm_edit_file` so the edit door applies
 * its replacement to the SAME bytes the pipeline backs up (ADR-011 §3). A null
 * read means file-not-found (new file); any other read failure throws inside
 * readVmFile and is surfaced.
 */
export async function readQmPrev(
  transport: SshTransport,
  vmid: number,
  path: string,
  timeoutMs: number
): Promise<QmPrev> {
  await assertAgentAvailable(transport, vmid, timeoutMs);
  const node = await resolveNodeName(transport, timeoutMs);
  const { content: prevContent } = await readVmFile(transport, node, vmid, path, timeoutMs);
  return {
    node,
    prevContent,
    prevHash: prevContent ? sha256(prevContent) : null,
    isNewFile: prevContent === null,
  };
}

export interface WriteResolvedQmArgs {
  vmid: number;
  path: string;
  dryRun?: boolean;
  prev: QmPrev;
  newContent: Buffer;
  tool: Extract<AuditTool, "qm_write_file" | "qm_edit_file">;
  transport: SshTransport;
  audit: AuditLog;
  backupStore: BackupStore;
  cfg: Config;
  timeoutMs: number;
}

/**
 * The post-read VM write pipeline (ADR-011 §3): both `qm_write_file` and
 * `qm_edit_file` funnel through here, inheriting the backup, the hash-anchored
 * audit record (ADR-009), and the two agent-imposed limits — the
 * `tools.qmWriteMaxBytes` payload cap (checked here, on the RESOLVED bytes, so
 * an edit that grows the file past the cap is refused the same way a write is)
 * and no perm preservation (the agent write takes no mode/owner). There is no
 * config-history capture: a VM has no descriptor-stable fs (ADR-006).
 */
export async function writeResolvedQm(
  args: WriteResolvedQmArgs
): Promise<QmWriteFileResult | QmWriteFileDryRunResult> {
  const { vmid, path, prev, newContent, tool, transport, audit, backupStore, cfg, timeoutMs } = args;
  const { node, prevContent, prevHash, isNewFile } = prev;

  // #20 — re-anchor a delta backup to a self-contained full copy when the live
  // file drifted out-of-band since the last managed write.
  const lastBackupBaseHash = backupStore.latestBaseHash({ kind: "qm", vmid, remotePath: path });

  // Size cap on the RESOLVED payload — the guest-agent write endpoint bounds a
  // single payload, so a write/edit over the cap is refused (use qm_exec for
  // larger in-guest edits) rather than truncated in the guest.
  if (newContent.length > cfg.tools.qmWriteMaxBytes) {
    throw new Error(
      `Content is ${newContent.length} bytes, over the ${cfg.tools.qmWriteMaxBytes}-byte ` +
        `guest-agent write cap. Use qm_exec for larger in-guest edits.`
    );
  }

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

  // dryRun: full pipeline READ-ONLY, no side effects (write/backup/audit).
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
    lastBackupBaseHash,
  });

  const newHash = contentHash(newContent);
  // Local backup written BEFORE the guest write. File key derives from the qm:
  // descriptor (no host/pct collision).
  const backupResult = await backupStore.storeBackup(
    { kind: "qm", vmid, remotePath: path },
    kind,
    newHash
  );

  await writeVmFile(transport, node, vmid, path, newContent, timeoutMs);

  const record = buildAuditRecord({
    tool,
    host: cfg.ssh.host,
    vmid,
    path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    // ADR-009 content fingerprint. A VM is NOT in the Merkle forest (no
    // descriptor-stable fs), so this never explains a forest drift — it only
    // makes the write queryable by content hash in query_audit.
    beforeHash: prevContent ? contentLeafHash(prevContent) : undefined,
    afterHash: contentLeafHash(newContent),
    hashScope: path,
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    note: largeChange.isLarge ? largeChange.reason : undefined,
  });

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
    vmid,
  };
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
  // Fast-fail the cap BEFORE any agent call — the write payload is known upfront,
  // so an over-cap write never touches the guest. (The edit door can't do this:
  // its bytes aren't known until after the read, so writeResolvedQm re-checks.)
  if (newContent.length > cfg.tools.qmWriteMaxBytes) {
    throw new Error(
      `Content is ${newContent.length} bytes, over the ${cfg.tools.qmWriteMaxBytes}-byte ` +
        `guest-agent write cap. Use qm_exec for larger in-guest edits.`
    );
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const prev = await readQmPrev(transport, input.vmid, input.path, timeoutMs);

  return writeResolvedQm({
    vmid: input.vmid,
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "qm_write_file",
    transport,
    audit,
    backupStore,
    cfg,
    timeoutMs,
  });
}
