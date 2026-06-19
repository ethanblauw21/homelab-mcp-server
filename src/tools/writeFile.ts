import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256, type AuditTool } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { computeUnifiedDiff } from "../util/diff.js";
import type { ConfigHistory } from "../history/configHistory.js";
import { contentLeafHash } from "../integrity/leafHash.js";

export const WriteFileInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host"),
  content: z.string().describe("File content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of the content field"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Preview only: returns a unified diff + would-be metadata. No write, no backup, no audit."
    ),
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export interface WriteFileResult {
  backupPath: string | null;
  auditId: string;
  revertible: boolean;
  // ADR-008 §3 — diff-on-write: every write is its own review at zero extra I/O.
  // New-file writes report diff against empty; binary content reports diff: null.
  newFile: boolean;
  diff: string | null;
  diffTruncated?: boolean;
}

export interface WriteFileDryRunResult {
  dryRun: true;
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

/** The previous on-host content of a target, read once (ADR-011 §3). */
export interface HostPrev {
  prevContent: Buffer | null;
  prevHash: string | null;
  isNewFile: boolean;
}

/**
 * Read a host file's current bytes (best-effort; a missing file is `isNewFile`).
 * Shared by `write_file` and `edit_file` so `prev` is read exactly once on each
 * path — the edit door applies its string replacement to the SAME bytes that the
 * pipeline below hashes and backs up (no read-then-reread TOCTOU gap, ADR-011 §3).
 */
export async function readHostPrev(transport: SshTransport, path: string): Promise<HostPrev> {
  try {
    const prevContent = await transport.readFile(path);
    return { prevContent, prevHash: sha256(prevContent), isNewFile: false };
  } catch {
    return { prevContent: null, prevHash: null, isNewFile: true };
  }
}

export interface WriteResolvedHostArgs {
  path: string;
  dryRun?: boolean;
  /** Already-read previous content (one read; see readHostPrev). */
  prev: HostPrev;
  /** The fully resolved bytes to write (write: from content; edit: from applyStringEdit). */
  newContent: Buffer;
  /** Honest tool name stamped on the audit record + history commit. */
  tool: Extract<AuditTool, "write_file" | "edit_file">;
  transport: SshTransport;
  audit: AuditLog;
  backupStore: BackupStore;
  cfg: Config;
  history?: ConfigHistory;
  rootTier?: boolean;
}

/**
 * The post-read host write pipeline (ADR-011 §3): large-change detection,
 * diff-on-write, dryRun preview, disk-pressure fail-safe, backup, the write
 * itself, the hash-anchored audit record (ADR-009), and config-history capture
 * (ADR-006). `write_file` and `edit_file` both funnel through here so every
 * guardrail is inherited byte-for-byte — an audit reviewer sees identical
 * treatment regardless of which door produced `newContent`.
 */
export async function writeResolvedHost(
  args: WriteResolvedHostArgs
): Promise<WriteFileResult | WriteFileDryRunResult> {
  const { path, prev, newContent, tool, transport, audit, backupStore, cfg, history } = args;
  const { prevContent, prevHash, isNewFile } = prev;
  const rootTier = args.rootTier ?? false;

  // ADR-014 §2 — the last managed write's content hash for this target; passed to
  // selectBackupKind so an out-of-band drift since then re-anchors instead of
  // taking an unreachable delta.
  const chainBaseHash = backupStore.latestBaseHash({ kind: "host", remotePath: path });

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

  // Diff-on-write (ADR-008 §3): computed once from the two contents already in
  // hand, shared by the dryRun preview and the real write's response.
  const diffable =
    isTextContent(newContent) && (isNewFile || (prevContent !== null && isTextContent(prevContent)));
  const diff = diffable
    ? computeUnifiedDiff(
        prevContent ? prevContent.toString("utf8") : "",
        newContent.toString("utf8"),
        cfg.tools.dryRunDiffMaxLines
      )
    : null;

  // dryRun: run the full pipeline READ-ONLY and return a preview. No write, no
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

  // Check disk pressure; apply fail-safe if still over cap after eviction
  if (backupStore.checkDiskPressure()) {
    if (cfg.backup.diskPressureFailSafe === "refuse") {
      throw new Error("Backup storage is over cap; write refused by disk-pressure fail-safe");
    }
    // warn — proceed with logging
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
  const backupResult = await backupStore.storeBackup(
    { kind: "host", remotePath: path },
    kind,
    newHash
  );

  // Write the file
  await transport.writeFile(path, newContent);

  const record = buildAuditRecord({
    tool,
    host: cfg.ssh.host,
    path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    // ADR-009 hash anchor: the L2/L3 forest content-leaf hashes, so a later
    // verify_integrity recognizes this write as the explainer for the drift.
    beforeHash: prevContent ? contentLeafHash(prevContent) : undefined,
    afterHash: contentLeafHash(newContent),
    hashScope: path,
    ...(rootTier ? { rootTier: true } : {}),
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    note: largeChange.isLarge ? largeChange.reason : undefined,
  });

  // ADR-006 capture path A: append one history step (best-effort, never fails
  // the write). The blob backup above is the operational revert mechanism; this
  // is the archaeology layer.
  if (history) {
    record.historyCommitted = await history.recordMutation(
      transport,
      { kind: "host", remotePath: path },
      newContent,
      tool,
      record.id,
      cfg.ssh.commandTimeoutMs
    );
  }

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
    newFile: isNewFile,
    diff: diff ? diff.diff : null,
    diffTruncated: diff ? diff.truncated : undefined,
  };
}

export async function writeFileHandler(
  input: WriteFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config,
  history?: ConfigHistory,
  // ADR-007 §4 — stamps rootTier:true on the audit record at the root tier.
  rootTier = false
): Promise<WriteFileResult | WriteFileDryRunResult> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const prev = await readHostPrev(transport, input.path);
  const newContent = Buffer.from(input.content, input.encoding);

  return writeResolvedHost({
    path: input.path,
    dryRun: input.dryRun,
    prev,
    newContent,
    tool: "write_file",
    transport,
    audit,
    backupStore,
    cfg,
    history,
    rootTier,
  });
}
