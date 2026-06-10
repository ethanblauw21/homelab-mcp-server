import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import type { BackupStore, BackupTarget } from "../backup/store.js";
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

export const RevertFileInputSchema = z.object({
  backupPath: z.string().min(1).describe(
    "Local path to the backup blob (the backupPath returned by a prior write_file/pct_write_file call)"
  ),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional. If supplied, must match the path recorded in the backup metadata; otherwise the target is resolved from the backup itself."
    ),
});

export type RevertFileInput = z.infer<typeof RevertFileInputSchema>;

export async function revertFileHandler(
  input: RevertFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config
): Promise<{ auditId: string; restoredFrom: string; bytes: number; vmid?: number }> {
  // Resolve where this backup belongs (host SFTP vs. container push) from the
  // meta descriptor — the caller need only pass backupPath. When no meta exists
  // (legacy/bare blobs), fall back to a host target using the supplied path.
  let target: BackupTarget;
  try {
    target = backupStore.readBackupTarget(input.backupPath);
  } catch {
    if (!input.path) {
      throw new Error(
        "Backup metadata not found and no path supplied; cannot determine the restore target"
      );
    }
    target = { kind: "host", remotePath: input.path };
  }

  if (input.path !== undefined && input.path !== target.remotePath) {
    throw new Error(
      `Path mismatch: supplied "${input.path}" does not match backup target "${target.remotePath}"`
    );
  }

  const pathResult = validatePath(target.remotePath, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;

  // Read current content first — needed for the audit record and to apply
  // reverse-diff backups.
  let currentContent: Buffer | undefined;
  let prevHash: string | undefined;

  if (target.kind === "pct") {
    if (target.vmid === undefined) {
      throw new Error("Container backup is missing its vmid; cannot route revert");
    }
    await assertContainerRunning(transport, target.vmid, timeoutMs);
    const { content } = await pullContainerFile(
      transport,
      target.vmid,
      target.remotePath,
      cfg.container.nodeTempDir,
      timeoutMs
    );
    if (content) {
      currentContent = content;
      prevHash = sha256(content);
    }
  } else {
    try {
      currentContent = await transport.readFile(target.remotePath);
      prevHash = sha256(currentContent);
    } catch {
      /* file may not exist */
    }
  }

  const restored = await backupStore.restore(input.backupPath, currentContent);
  if (restored === null) {
    throw new Error("Backup is metadata-only — no content stored, cannot revert");
  }

  if (target.kind === "pct") {
    const perms: GuestPerms =
      (await statContainerPerms(transport, target.vmid!, target.remotePath, timeoutMs)) ?? {
        mode: cfg.container.newFileMode,
        uid: cfg.container.newFileUid,
        gid: cfg.container.newFileGid,
      };
    await pushContainerFile(
      transport,
      target.vmid!,
      target.remotePath,
      restored,
      perms,
      cfg.container.nodeTempDir,
      timeoutMs
    );
  } else {
    await transport.writeFile(target.remotePath, restored);
  }

  const record = buildAuditRecord({
    tool: "revert_file",
    host: cfg.ssh.host,
    vmid: target.kind === "pct" ? target.vmid : undefined,
    path: target.remotePath,
    prevSha256: prevHash,
    newSha256: sha256(restored),
    bytes: restored.length,
    note: `Reverted from backup: ${input.backupPath}`,
  });

  await audit.append(record);

  return {
    auditId: record.id,
    restoredFrom: input.backupPath,
    bytes: restored.length,
    vmid: target.kind === "pct" ? target.vmid : undefined,
  };
}
