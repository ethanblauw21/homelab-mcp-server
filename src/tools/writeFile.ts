import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { detectLargeFileWrite } from "../guardrails/largeChange.js";
import { selectBackupKind, contentHash, isTextContent } from "../backup/policy.js";
import type { BackupStore } from "../backup/store.js";
import { buildAuditRecord, sha256 } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const WriteFileInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host"),
  content: z.string().describe("File content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of the content field"),
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export async function writeFileHandler(
  input: WriteFileInput,
  transport: SshTransport,
  audit: AuditLog,
  backupStore: BackupStore,
  cfg: Config
): Promise<{ backupPath: string | null; auditId: string; revertible: boolean }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const newContent = Buffer.from(input.content, input.encoding);

  // Read previous content (best-effort; file may not exist yet)
  let prevContent: Buffer | null = null;
  let prevHash: string | null = null;
  let isNewFile = false;
  try {
    prevContent = await transport.readFile(input.path);
    prevHash = sha256(prevContent);
  } catch {
    isNewFile = true;
  }

  const largeChange = detectLargeFileWrite(
    newContent.length,
    isNewFile,
    cfg.backup.largeFileBytesThreshold
  );

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
  });

  const newHash = contentHash(newContent);
  const backupResult = await backupStore.storeBackup(input.path, kind, newHash);

  // Write the file
  await transport.writeFile(input.path, newContent);

  const record = buildAuditRecord({
    tool: "write_file",
    host: cfg.ssh.host,
    path: input.path,
    prevBackup: backupResult.backupPath ?? backupResult.existingPath,
    prevSha256: prevHash ?? undefined,
    newSha256: newHash,
    bytes: newContent.length,
    isLargeChange: largeChange.isLarge,
    isRevertible: backupResult.revertible,
    note: largeChange.isLarge ? largeChange.reason : undefined,
  });

  await audit.append(record);

  return {
    backupPath: backupResult.backupPath ?? backupResult.existingPath ?? null,
    auditId: record.id,
    revertible: backupResult.revertible,
  };
}
