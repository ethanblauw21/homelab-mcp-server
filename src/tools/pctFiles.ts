import type { SshTransport } from "../ssh/transport.js";

/**
 * Container-file transfer plumbing for `pct_read_file` / `pct_write_file`.
 *
 * Files move via Proxmox's `pct pull`/`pct push` (binary-safe) staged through a
 * node-side `mktemp` temp file that the server reads/writes over SFTP. The only
 * free-form caller string is the file *content*, which travels via SFTP and
 * never through argv — every shell argument here is a validated integer vmid, a
 * server-validated path, a server-generated mktemp output, or a numeric perm.
 */

export interface GuestPerms {
  /** Octal mode string, e.g. "644". */
  mode: string;
  uid: number;
  gid: number;
}

/** Single-quote a string for safe use as one shell argument. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Pure command builders + parsers (unit-tested without a transport)
// ---------------------------------------------------------------------------

export function buildPctStatusCommand(vmid: number): string {
  return `pct status ${vmid}`;
}

/**
 * Parse `pct status <vmid>` output ("status: running") to the bare state.
 * Returns "" if the line is not recognized.
 */
export function parsePctStatus(output: string): string {
  const m = output.match(/status:\s*(\S+)/i);
  return m ? (m[1] ?? "").toLowerCase() : "";
}

export function buildMkTempCommand(tempDir: string): string {
  return `mktemp -p ${shQuote(tempDir)}`;
}

export function buildRmCommand(tmpPath: string): string {
  return `rm -f ${shQuote(tmpPath)}`;
}

export function buildPctPullCommand(vmid: number, remotePath: string, tmpPath: string): string {
  return `pct pull ${vmid} ${shQuote(remotePath)} ${shQuote(tmpPath)}`;
}

export function buildPctPushCommand(
  vmid: number,
  tmpPath: string,
  remotePath: string,
  perms: GuestPerms
): string {
  return (
    `pct push ${vmid} ${shQuote(tmpPath)} ${shQuote(remotePath)} ` +
    `--perms ${shQuote(perms.mode)} --user ${perms.uid} --group ${perms.gid}`
  );
}

export function buildStatCommand(vmid: number, remotePath: string): string {
  // %a = octal mode, %u = uid, %g = gid
  return `pct exec ${vmid} -- stat -c '%a %u %g' ${shQuote(remotePath)}`;
}

/**
 * Parse `stat -c '%a %u %g'` output, e.g. "644 0 0". Returns null if it does not
 * match (caller falls back to new-file defaults rather than guessing).
 */
export function parseStatPerms(output: string): GuestPerms | null {
  const m = output.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { mode: m[1] ?? "", uid: parseInt(m[2] ?? "0", 10), gid: parseInt(m[3] ?? "0", 10) };
}

/**
 * Classify a failed `pct pull`. "not-found" (the file does not exist inside the
 * guest) is the ONLY error that may be reinterpreted as a new-file write per
 * A3.1; everything else is a genuine failure that must be surfaced.
 */
export function classifyPullError(stderr: string): "not-found" | "other" {
  return /no such file|does not exist|not found|cannot stat/i.test(stderr) ? "not-found" : "other";
}

// ---------------------------------------------------------------------------
// I/O helpers (require a transport)
// ---------------------------------------------------------------------------

/**
 * A3.1: refuse early if the container is not running. `pct pull`/`pct push`
 * require a running guest; a stopped guest must never be misread as "new file".
 */
export async function assertContainerRunning(
  transport: SshTransport,
  vmid: number,
  timeoutMs: number
): Promise<void> {
  const res = await transport.exec(buildPctStatusCommand(vmid), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(
      `Container ${vmid} status check failed (exit ${res.exitCode}): ${res.stderr.trim() || "unknown error"}`
    );
  }
  const state = parsePctStatus(res.stdout);
  if (state !== "running") {
    throw new Error(
      `Container ${vmid} is not running (state: ${state || "unknown"}). ` +
        `Start the container, or edit via the Proxmox UI.`
    );
  }
}

async function createNodeTemp(
  transport: SshTransport,
  tempDir: string,
  timeoutMs: number
): Promise<string> {
  const res = await transport.exec(buildMkTempCommand(tempDir), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(`mktemp failed on node (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  const tmp = res.stdout.trim();
  if (!tmp) throw new Error("mktemp returned an empty path");
  return tmp;
}

async function removeNodeTemp(
  transport: SshTransport,
  tmpPath: string,
  timeoutMs: number
): Promise<void> {
  try {
    await transport.exec(buildRmCommand(tmpPath), timeoutMs);
  } catch {
    /* best-effort cleanup; the temp is never the only copy of anything */
  }
}

export interface PullResult {
  /** File bytes, or null when the file does not exist inside the guest. */
  content: Buffer | null;
}

/**
 * Pull a container file: mktemp on the node → `pct pull` → SFTP-read the temp →
 * remove the temp (always, even on failure). Returns `{ content: null }` only
 * when the guest is confirmed running and the pull fails file-not-found.
 */
export async function pullContainerFile(
  transport: SshTransport,
  vmid: number,
  remotePath: string,
  tempDir: string,
  timeoutMs: number
): Promise<PullResult> {
  const tmp = await createNodeTemp(transport, tempDir, timeoutMs);
  try {
    const res = await transport.exec(buildPctPullCommand(vmid, remotePath, tmp), timeoutMs);
    if (res.exitCode !== 0) {
      if (classifyPullError(res.stderr) === "not-found") return { content: null };
      throw new Error(
        `pct pull failed for ${vmid}:${remotePath} (exit ${res.exitCode}): ${res.stderr.trim()}`
      );
    }
    const content = await transport.readFile(tmp);
    return { content };
  } finally {
    await removeNodeTemp(transport, tmp, timeoutMs);
  }
}

/**
 * Stat an existing container file to preserve its mode/owner on push.
 * Returns null when the file does not exist or stat output is unrecognized.
 */
export async function statContainerPerms(
  transport: SshTransport,
  vmid: number,
  remotePath: string,
  timeoutMs: number
): Promise<GuestPerms | null> {
  const res = await transport.exec(buildStatCommand(vmid, remotePath), timeoutMs);
  if (res.exitCode !== 0) return null;
  return parseStatPerms(res.stdout);
}

/**
 * Push content into a container file: SFTP-write the bytes to a node temp →
 * `pct push` with explicit perms/owner → remove the temp (always).
 */
export async function pushContainerFile(
  transport: SshTransport,
  vmid: number,
  remotePath: string,
  content: Buffer,
  perms: GuestPerms,
  tempDir: string,
  timeoutMs: number
): Promise<void> {
  const tmp = await createNodeTemp(transport, tempDir, timeoutMs);
  try {
    await transport.writeFile(tmp, content);
    const res = await transport.exec(
      buildPctPushCommand(vmid, tmp, remotePath, perms),
      timeoutMs
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `pct push failed for ${vmid}:${remotePath} (exit ${res.exitCode}): ${res.stderr.trim()}`
      );
    }
  } finally {
    await removeNodeTemp(transport, tmp, timeoutMs);
  }
}
