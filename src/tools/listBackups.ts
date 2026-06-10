import { z } from "zod";
import { validatePath } from "../guardrails/pathValidation.js";
import type { BackupStore, BackupVersionInfo } from "../backup/store.js";
import type { Config } from "../config.js";

export const ListBackupsInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path on the Proxmox host to list backups for"),
});

export type ListBackupsInput = z.infer<typeof ListBackupsInputSchema>;

export type { BackupVersionInfo };

export async function listBackupsHandler(
  input: ListBackupsInput,
  backupStore: BackupStore,
  cfg: Config
): Promise<{ path: string; versions: BackupVersionInfo[] }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const versions = backupStore.listBackupsForPath(input.path);
  return { path: input.path, versions };
}
