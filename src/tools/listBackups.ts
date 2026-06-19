import { z } from "zod";
import { validatePath } from "../guardrails/pathValidation.js";
import type { BackupStore, BackupVersionInfo, BackupTarget } from "../backup/store.js";
import type { Config } from "../config.js";
import type { SshTransport } from "../ssh/transport.js";
import { classifyRevertibility, contentHash } from "../backup/policy.js";
import { readCurrentForTarget } from "./targetContent.js";

export const ListBackupsInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path of the file to list backups for"),
  vmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("If set, scope the query to a container file (pct:<vmid>:<path>) instead of a host file"),
  container: z
    .string()
    .min(1)
    .optional()
    .describe(
      "If set (with vmid), scope the query to a Docker container file (docker:<vmid>:<container>:<path>)."
    ),
});

export type ListBackupsInput = z.infer<typeof ListBackupsInputSchema>;

export type { BackupVersionInfo };

export async function listBackupsHandler(
  input: ListBackupsInput,
  backupStore: BackupStore,
  cfg: Config,
  // ADR-014 §1 — when present (companion+), the live file is read once so each
  // version's `revertible` reflects what can actually be applied right now. Absent
  // (observe/operate, no SSH credential): self-contained versions stay revertible;
  // deltas report unverified rather than claiming a revert that would fail.
  transport?: SshTransport
): Promise<{ path: string; vmid?: number; container?: string; currentVerified: boolean; versions: BackupVersionInfo[] }> {
  const pathResult = validatePath(input.path, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathResult.valid) {
    throw new Error(`Invalid path: ${pathResult.reason}`);
  }

  if (input.container !== undefined && input.vmid === undefined) {
    throw new Error("`container` requires `vmid` (docker backups key on docker:<vmid>:<container>:<path>).");
  }

  let target: BackupTarget;
  if (input.container !== undefined) {
    target = { kind: "docker", vmid: input.vmid!, container: input.container, remotePath: input.path };
  } else if (input.vmid !== undefined) {
    target = { kind: "pct", vmid: input.vmid, remotePath: input.path };
  } else {
    target = { kind: "host", remotePath: input.path };
  }

  const versions = backupStore.listBackupsForPath(target);

  // ADR-014 §1 — read the live file ONCE and hash it; classify every version
  // against that single hash. Best-effort: any read failure (stopped guest,
  // unreachable node, no transport) leaves the hash unknown.
  let currentHash: string | null = null;
  let currentVerified = false;
  if (transport && versions.length > 0) {
    try {
      const content = await readCurrentForTarget(transport, target, cfg);
      currentHash = content === null ? null : contentHash(content);
      currentVerified = true;
    } catch {
      currentVerified = false; // unreadable — deltas fall back to non-revertible
    }
  }

  const classified = versions.map((v) => {
    const verdict = classifyRevertibility(
      { kind: v.kind, requiresBaseHash: v.requiresBaseHash, hash: v.hash },
      currentHash
    );
    return {
      ...v,
      revertible: verdict.revertible,
      revertReason: verdict.reason,
    };
  });

  return { path: input.path, vmid: input.vmid, container: input.container, currentVerified, versions: classified };
}
