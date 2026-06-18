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
import { assertAgentAvailable, resolveNodeName, readVmFile, writeVmFile } from "./qmFiles.js";
import {
  resolveDockerContainer,
  readDockerFile,
  statDockerPerms,
  writeDockerFile,
} from "./dockerFiles.js";
import type { DockerInspect } from "./dockerHelpers.js";
import type { ConfigHistory } from "../history/configHistory.js";
import { contentLeafHash } from "../integrity/leafHash.js";

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
  cfg: Config,
  history?: ConfigHistory
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
  // Resolved lazily for qm targets and reused for the write-back below so the
  // node name is looked up once per revert.
  let qmNode: string | undefined;
  // Resolved lazily for docker targets (id + mounts) and reused for the write-back
  // so the container is inspected once per revert.
  let dockerInspect: DockerInspect | undefined;

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
  } else if (target.kind === "qm") {
    if (target.vmid === undefined) {
      throw new Error("VM backup is missing its vmid; cannot route revert");
    }
    await assertAgentAvailable(transport, target.vmid, timeoutMs);
    qmNode = await resolveNodeName(transport, timeoutMs);
    const { content } = await readVmFile(transport, qmNode, target.vmid, target.remotePath, timeoutMs);
    if (content) {
      currentContent = content;
      prevHash = sha256(content);
    }
  } else if (target.kind === "docker") {
    if (target.vmid === undefined || !target.container) {
      throw new Error("Docker backup is missing its vmid/container; cannot route revert");
    }
    await assertContainerRunning(transport, target.vmid, timeoutMs);
    dockerInspect = await resolveDockerContainer(transport, target.vmid, target.container, timeoutMs);
    const { content } = await readDockerFile(
      transport,
      target.vmid,
      target.container,
      target.remotePath,
      dockerInspect,
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
  } else if (target.kind === "qm") {
    // Agent precheck + node resolution already happened during the read above;
    // reuse the resolved node. (No perm preservation — the agent write takes none.)
    await writeVmFile(transport, qmNode!, target.vmid!, target.remotePath, restored, timeoutMs);
  } else if (target.kind === "docker") {
    // Reuse the inspect from the read above. Slow-path ownership restoration needs
    // perms captured before the overwrite; the bind fast path follows the LXC file.
    const bindFast = dockerInspect!.mounts.some(
      (m) => m.type === "bind" && (target.remotePath === m.destination || target.remotePath.startsWith(m.destination.replace(/\/+$/, "") + "/"))
    );
    const prevPerms = bindFast
      ? null
      : await statDockerPerms(transport, target.vmid!, target.container!, target.remotePath, timeoutMs);
    await writeDockerFile(
      transport,
      target.vmid!,
      target.container!,
      target.remotePath,
      restored,
      dockerInspect!,
      prevPerms,
      { mode: cfg.container.newFileMode, uid: cfg.container.newFileUid, gid: cfg.container.newFileGid },
      cfg.container.nodeTempDir,
      timeoutMs
    );
  } else {
    await transport.writeFile(target.remotePath, restored);
  }

  const vmid =
    target.kind === "pct" || target.kind === "qm" || target.kind === "docker"
      ? target.vmid
      : undefined;

  const record = buildAuditRecord({
    tool: "revert_file",
    host: cfg.ssh.host,
    vmid,
    ...(target.kind === "docker" && {
      container: target.container,
      containerId: dockerInspect?.id || undefined,
    }),
    path: target.remotePath,
    prevSha256: prevHash,
    newSha256: sha256(restored),
    bytes: restored.length,
    // ADR-009 hash anchor: a revert is a write, so it must also explain the drift
    // it produces (host/pct match a forest leaf; qm/docker are fingerprints only).
    beforeHash: currentContent ? contentLeafHash(currentContent) : undefined,
    afterHash: contentLeafHash(restored),
    hashScope: target.remotePath,
    note: `Reverted from backup: ${input.backupPath}`,
  });

  // ADR-006 capture path A: a revert is a write, so it gets a history step too
  // (best-effort; qm targets have no mirror layout and are skipped by recordMutation).
  if (history) {
    record.historyCommitted = await history.recordMutation(
      transport,
      target,
      restored,
      "revert_file",
      record.id,
      timeoutMs
    );
  }

  await audit.append(record);

  return {
    auditId: record.id,
    restoredFrom: input.backupPath,
    bytes: restored.length,
    vmid,
  };
}
