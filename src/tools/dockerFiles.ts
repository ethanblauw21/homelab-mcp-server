import type { SshTransport } from "../ssh/transport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import {
  buildMkTempCommand,
  buildRmCommand,
  pullContainerFile,
  pushContainerFile,
  statContainerPerms,
  type GuestPerms,
} from "./pctFiles.js";
import {
  buildDockerInspectCommand,
  parseDockerInspect,
  resolveBindMount,
  buildDockerCpFromContainer,
  buildDockerCpToContainer,
  buildDockerStatCommand,
  parseDockerStatPerms,
  buildDockerChownCommand,
  buildDockerChmodCommand,
  assertDockerName,
  type DockerInspect,
  type DockerFilePerms,
} from "./dockerHelpers.js";

/**
 * Docker container-file transfer plumbing (ADR-008 §2). Two paths, both riding
 * the existing `pct exec` channel (the daemon socket is never exposed):
 *
 *   - **Bind-mount fast path:** if the container path lives on a bind mount, the
 *     file already exists in the LXC filesystem at the mount source, so the op
 *     degrades to a plain `pct pull`/`pct push` on that LXC-side path — one fewer
 *     copy hop, exactly what the dogfooding session did by hand.
 *   - **`docker cp` slow path:** otherwise relay through an LXC-side temp:
 *     read  = `docker cp <c>:<path> <lxcTmp>` → `pct pull` → SFTP-read;
 *     write = SFTP-write → `pct push` → `docker cp <lxcTmp> <c>:<path>`, then
 *     best-effort ownership/mode restoration (the cp endpoint preserves neither).
 *
 * Temps are cleaned in `finally` at both layers; the local backup is written
 * before any push, so a leaked temp is never the only copy. File *content* moves
 * SFTP + `docker cp`, never through argv.
 */

const NOT_FOUND_RE = /no such file|does not exist|not found|cannot stat|could not find/i;

/** Run a command inside the LXC and return its result (no extra wrapping). */
async function lxcExec(
  transport: SshTransport,
  vmid: number,
  inner: string,
  timeoutMs: number
) {
  return transport.exec(buildPctExecCommand(vmid, inner), timeoutMs);
}

/**
 * Resolve a container's id + mounts via `docker inspect` (run inside the LXC).
 * Throws a clear error when the container does not exist — names are the caller's
 * stable identity, so a typo should fail loudly rather than silently slow-path.
 */
export async function resolveDockerContainer(
  transport: SshTransport,
  vmid: number,
  container: string,
  timeoutMs: number
): Promise<DockerInspect> {
  assertDockerName(container);
  const res = await lxcExec(transport, vmid, buildDockerInspectCommand(container), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(
      `docker inspect failed for ${container} on CT${vmid} (exit ${res.exitCode}): ` +
        `${res.stderr.trim() || "container not found?"}`
    );
  }
  return parseDockerInspect(res.stdout);
}

async function makeLxcTemp(
  transport: SshTransport,
  vmid: number,
  tempDir: string,
  timeoutMs: number
): Promise<string> {
  const res = await lxcExec(transport, vmid, buildMkTempCommand(tempDir), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(`mktemp failed inside CT${vmid} (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  const tmp = res.stdout.trim();
  if (!tmp) throw new Error(`mktemp returned an empty path inside CT${vmid}`);
  return tmp;
}

async function removeLxcTemp(
  transport: SshTransport,
  vmid: number,
  tmpPath: string,
  timeoutMs: number
): Promise<void> {
  try {
    await lxcExec(transport, vmid, buildRmCommand(tmpPath), timeoutMs);
  } catch {
    /* best-effort: the LXC temp is never the only copy of anything */
  }
}

export interface DockerReadResult {
  /** File bytes, or null when the file does not exist inside the container. */
  content: Buffer | null;
  /** True when the bind-mount fast path was taken (informs the response/audit note). */
  viaBindMount: boolean;
  /** The LXC-side path used (bind path only). */
  lxcPath?: string;
}

/**
 * Read a container file. Takes a pre-resolved `inspect` so the handler controls
 * the single inspect round trip (it also needs the id for the audit record).
 */
export async function readDockerFile(
  transport: SshTransport,
  vmid: number,
  container: string,
  containerPath: string,
  inspect: DockerInspect,
  tempDir: string,
  timeoutMs: number
): Promise<DockerReadResult> {
  const bind = resolveBindMount(inspect.mounts, containerPath);
  if (bind) {
    // Fast path: the file lives in the LXC fs — pull it directly.
    const { content } = await pullContainerFile(
      transport,
      vmid,
      bind.lxcPath,
      tempDir,
      timeoutMs
    );
    return { content, viaBindMount: true, lxcPath: bind.lxcPath };
  }

  // Slow path: docker cp out to an LXC temp, then the existing pull flow.
  const lxcTmp = await makeLxcTemp(transport, vmid, tempDir, timeoutMs);
  try {
    const cp = await lxcExec(
      transport,
      vmid,
      buildDockerCpFromContainer(container, containerPath, lxcTmp),
      timeoutMs
    );
    if (cp.exitCode !== 0) {
      if (NOT_FOUND_RE.test(cp.stderr)) return { content: null, viaBindMount: false };
      throw new Error(
        `docker cp out of ${container}:${containerPath} failed (exit ${cp.exitCode}): ${cp.stderr.trim()}`
      );
    }
    const { content } = await pullContainerFile(transport, vmid, lxcTmp, tempDir, timeoutMs);
    return { content, viaBindMount: false };
  } finally {
    await removeLxcTemp(transport, vmid, lxcTmp, timeoutMs);
  }
}

/**
 * Stat a container file's perms for the slow path (best-effort: returns null when
 * the image lacks `stat` or the file is new — the caller records a note and lands
 * the file with the container's default umask).
 */
export async function statDockerPerms(
  transport: SshTransport,
  vmid: number,
  container: string,
  containerPath: string,
  timeoutMs: number
): Promise<DockerFilePerms | null> {
  const res = await lxcExec(
    transport,
    vmid,
    buildDockerStatCommand(container, containerPath),
    timeoutMs
  );
  if (res.exitCode !== 0) return null;
  return parseDockerStatPerms(res.stdout);
}

export interface DockerWriteResult {
  viaBindMount: boolean;
  lxcPath?: string;
  /** Set on the slow path when ownership/mode could not be restored. */
  note?: string;
}

/**
 * Write a container file. `prevPerms` (slow path) is the result of `statDockerPerms`
 * captured *before* the write; null/undefined means new-file or stat-less image,
 * in which case the file lands with the container's default umask and a note is set.
 * For the bind-mount fast path, perms follow the LXC-side file like `pct_write_file`.
 */
export async function writeDockerFile(
  transport: SshTransport,
  vmid: number,
  container: string,
  containerPath: string,
  content: Buffer,
  inspect: DockerInspect,
  prevPerms: DockerFilePerms | null,
  newFileDefaults: GuestPerms,
  tempDir: string,
  timeoutMs: number
): Promise<DockerWriteResult> {
  const bind = resolveBindMount(inspect.mounts, containerPath);
  if (bind) {
    // Fast path: push straight to the LXC-side file with perm preservation.
    const perms =
      (await statContainerPerms(transport, vmid, bind.lxcPath, timeoutMs)) ?? newFileDefaults;
    await pushContainerFile(transport, vmid, bind.lxcPath, content, perms, tempDir, timeoutMs);
    return { viaBindMount: true, lxcPath: bind.lxcPath };
  }

  // Slow path: SFTP → pct push → docker cp into the container.
  const lxcTmp = await makeLxcTemp(transport, vmid, tempDir, timeoutMs);
  try {
    // The LXC temp perms are irrelevant (it is discarded); push with tight defaults.
    await pushContainerFile(
      transport,
      vmid,
      lxcTmp,
      content,
      { mode: "600", uid: 0, gid: 0 },
      tempDir,
      timeoutMs
    );
    const cp = await lxcExec(
      transport,
      vmid,
      buildDockerCpToContainer(lxcTmp, container, containerPath),
      timeoutMs
    );
    if (cp.exitCode !== 0) {
      throw new Error(
        `docker cp into ${container}:${containerPath} failed (exit ${cp.exitCode}): ${cp.stderr.trim()}`
      );
    }
    // Best-effort ownership/mode restoration (the cp endpoint preserves neither).
    let note: string | undefined;
    if (prevPerms) {
      const chown = await lxcExec(
        transport,
        vmid,
        buildDockerChownCommand(container, prevPerms, containerPath),
        timeoutMs
      );
      const chmod = await lxcExec(
        transport,
        vmid,
        buildDockerChmodCommand(container, prevPerms, containerPath),
        timeoutMs
      );
      if (chown.exitCode !== 0 || chmod.exitCode !== 0) {
        note = "ownership/mode restoration was best-effort and may not have applied (stat-less image?)";
      }
    } else {
      note = "no prior perms captured — file landed with the container's default umask";
    }
    return { viaBindMount: false, note };
  } finally {
    await removeLxcTemp(transport, vmid, lxcTmp, timeoutMs);
  }
}
