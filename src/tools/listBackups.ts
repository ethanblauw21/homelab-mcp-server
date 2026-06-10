import { z } from "zod";
import { validatePath } from "../guardrails/pathValidation.js";
import type { BackupStore, BackupVersionInfo, BackupTarget } from "../backup/store.js";
import type { Config } from "../config.js";

export const ListBackupsInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path of the file to list backups for"),
  vmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("If set, scope the query to a container file (pct:<vmid>:<path>) instead of a host file"),
});

export type ListBackupsInput = z.infer<typeof ListBackupsInputSchema>;

export type { BackupVersionInfo };

export async function listBackupsHandler(
  input: ListBackupsInput,
  backupStore: BackupStore,
  cfg: Config
): Promise<{ path: string; vmid?: number; versions: BackupVersionInfo[] }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  const target: BackupTarget =
    input.vmid !== undefined
      ? { kind: "pct", vmid: input.vmid, remotePath: input.path }
      : { kind: "host", remotePath: input.path };

  const versions = backupStore.listBackupsForPath(target);
  return { path: input.path, vmid: input.vmid, versions };
}
