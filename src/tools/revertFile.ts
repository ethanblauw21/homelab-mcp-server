import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256 } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const RevertFileInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host to restore"),
  backupPath: z.string().min(1).describe(
    "Local path to the backup blob (the backupPath returned by a prior write_file call)"
  ),
});

export type RevertFileInput = z.infer<typeof RevertFileInputSchema>;

export async function revertFileHandler(
  input: RevertFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config
): Promise<{ auditId: string; restoredFrom: string; bytes: number }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  // Read current file first: needed both for the audit record and to apply delta backups.
  let currentContent: Buffer | undefined;
  let prevHash: string | undefined;
  try {
    currentContent = await transport.readFile(input.path);
    prevHash = sha256(currentContent);
  } catch { /* file may not exist */ }

  const restored = await backupStore.restore(input.backupPath, currentContent);
  if (restored === null) {
    throw new Error("Backup is metadata-only — no content stored, cannot revert");
  }

  await transport.writeFile(input.path, restored);

  const record = buildAuditRecord({
    tool: "revert_file",
    host: cfg.ssh.host,
    path: input.path,
    prevSha256: prevHash,
    newSha256: sha256(restored),
    bytes: restored.length,
    note: `Reverted from backup: ${input.backupPath}`,
  });

  await audit.append(record);

  return { auditId: record.id, restoredFrom: input.backupPath, bytes: restored.length };
}
