import type { SshTransport } from "../ssh/transport.js";
import type { BackupTarget } from "../backup/store.js";
import type { Config } from "../config.js";
import { assertContainerRunning, pullContainerFile } from "./pctFiles.js";
import { resolveDockerContainer, readDockerFile } from "./dockerFiles.js";

/**
 * Read the CURRENT live bytes of a backup target, per kind (ADR-014 §1). Shared by
 * `diff_config` (which diffs "what a revert would change right now") and
 * `list_backups` (which hashes the live file to decide honest revertibility).
 *
 * Returns `null` when the file does not exist (a missing file is empty content,
 * not an error). Hard failures — a stopped guest, a missing vmid/container, an
 * unreachable node — THROW, so `diff_config` surfaces them; `list_backups` is
 * best-effort and wraps this call in a try/catch, degrading an unreadable file to
 * "current hash unknown" (deltas then report non-revertible, the safe direction).
 *
 * `qm` targets are not read here (a VM exposes no descriptor-stable filesystem the
 * way `pct` does, and the agent read needs a separate precheck) → `null`.
 */
export async function readCurrentForTarget(
  transport: SshTransport,
  target: BackupTarget,
  cfg: Config
): Promise<Buffer | null> {
  const timeoutMs = cfg.ssh.commandTimeoutMs;

  if (target.kind === "pct") {
    if (target.vmid === undefined) {
      throw new Error("Container backup is missing its vmid; cannot read current content.");
    }
    await assertContainerRunning(transport, target.vmid, timeoutMs);
    const { content } = await pullContainerFile(
      transport,
      target.vmid,
      target.remotePath,
      cfg.container.nodeTempDir,
      timeoutMs
    );
    return content ?? null;
  }

  if (target.kind === "docker") {
    if (target.vmid === undefined || !target.container) {
      throw new Error("Docker backup is missing its vmid/container; cannot read current content.");
    }
    await assertContainerRunning(transport, target.vmid, timeoutMs);
    const inspect = await resolveDockerContainer(transport, target.vmid, target.container, timeoutMs);
    const { content } = await readDockerFile(
      transport,
      target.vmid,
      target.container,
      target.remotePath,
      inspect,
      cfg.container.nodeTempDir,
      timeoutMs
    );
    return content ?? null;
  }

  if (target.kind === "host") {
    try {
      return await transport.readFile(target.remotePath);
    } catch {
      return null; // file may not exist — treat as empty
    }
  }

  // qm / unknown — not read here.
  return null;
}
