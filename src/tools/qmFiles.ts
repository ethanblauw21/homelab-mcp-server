import type { SshTransport } from "../ssh/transport.js";
import { shQuote } from "./pctFiles.js";
import { pingAgent } from "./qmAgentPing.js";

/**
 * VM-file transfer plumbing for `qm_read_file` / `qm_write_file` (ADR-005
 * stretch). Files move through the **QEMU guest agent** file endpoints
 * (`pvesh .../agent/file-read|file-write`), not SSH — a VM has no
 * hypervisor-level filesystem access the way an LXC container does via `pct`.
 *
 * Two honest limitations follow from going through the agent (contrast the
 * binary-safe `pct pull`/`pct push` staging used for containers):
 *
 *  - **Text-oriented.** `agent/file-read` returns the content as a (UTF-8)
 *    string and `agent/file-write` is bounded to a small payload; binary files
 *    are lossy/refused. These tools are for config files, not blobs.
 *  - **No perm preservation.** The guest-agent write endpoint takes no
 *    mode/owner; a written file lands with the guest's default umask. (Container
 *    pushes preserve perms; VM writes cannot.)
 *
 * Every shell argument here is a validated integer vmid, a server-resolved node
 * name, a server-validated path, or base64 (ASCII) content — never raw bytes on
 * argv.
 */

const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;

// ---------------------------------------------------------------------------
// Pure command builders + parsers (unit-tested without a transport)
// ---------------------------------------------------------------------------

/** `pvesh` addresses the agent API under a concrete node name; build that path. */
function agentApiPath(node: string, vmid: number, op: "file-read" | "file-write"): string {
  return `/nodes/${node}/qemu/${vmid}/agent/${op}`;
}

export function buildAgentFileReadCommand(node: string, vmid: number, path: string): string {
  return (
    `pvesh get ${shQuote(agentApiPath(node, vmid, "file-read"))} ` +
    `--file ${shQuote(path)} --output-format json`
  );
}

/**
 * `--encode 0` tells PVE the `--content` value is ALREADY base64 (the QGA always
 * wants base64); we base64 locally so binary/newlines never hit argv as raw
 * bytes. Passing raw content with the default `--encode 1` would be unsafe.
 */
export function buildAgentFileWriteCommand(
  node: string,
  vmid: number,
  path: string,
  contentB64: string
): string {
  return (
    `pvesh create ${shQuote(agentApiPath(node, vmid, "file-write"))} ` +
    `--file ${shQuote(path)} --content ${shQuote(contentB64)} --encode 0`
  );
}

export interface AgentFileRead {
  content: Buffer;
  truncated: boolean;
}

/**
 * Parse `pvesh get .../agent/file-read --output-format json`, shaped
 * `{ "content": "<text>", "truncated": <0|1|bool> }`. Content is interpreted as
 * UTF-8 (the agent endpoint is text-oriented — see file header). Throws a
 * structured error on malformed/non-object JSON rather than guessing.
 */
export function parseAgentFileRead(stdout: string): AgentFileRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`agent file-read returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`agent file-read returned a non-object: ${stdout.slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const content = typeof obj.content === "string" ? obj.content : "";
  const truncated = obj.truncated === true || obj.truncated === 1 || obj.truncated === "1";
  return { content: Buffer.from(content, "utf8"), truncated };
}

/**
 * Classify a failed agent file op. "not-found" (the path does not exist inside
 * the guest) is the only error a write may reinterpret as a new-file create;
 * everything else is surfaced.
 */
export function classifyAgentFileError(stderr: string): "not-found" | "other" {
  return /no such file|does not exist|not found|cannot stat|failed to open/i.test(stderr)
    ? "not-found"
    : "other";
}

// ---------------------------------------------------------------------------
// I/O helpers (require a transport)
// ---------------------------------------------------------------------------

/**
 * Resolve the PVE node name for `pvesh` paths. Proxmox pins the node name to the
 * host's `hostname`, so that is the authoritative source. Validated against a
 * hostname charset before it is interpolated into any command.
 */
export async function resolveNodeName(transport: SshTransport, timeoutMs?: number): Promise<string> {
  const r = await transport.exec("hostname", timeoutMs);
  if (r.exitCode !== 0) {
    throw new Error(`Failed to resolve node name (hostname exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
  const node = r.stdout.trim();
  if (!NODE_NAME_RE.test(node)) {
    throw new Error(`Resolved node name is not a valid hostname: ${JSON.stringify(node)}`);
  }
  return node;
}

/**
 * Refuse early when the guest agent is not answering — a VM file op has nothing
 * to talk to without it. Fix-naming error mirrors `qm_exec`.
 */
export async function assertAgentAvailable(
  transport: SshTransport,
  vmid: number,
  timeoutMs?: number
): Promise<void> {
  const agent = await pingAgent(transport, vmid, timeoutMs);
  if (!agent.available) {
    throw new Error(
      `QEMU guest agent is not available on VM ${vmid} (${agent.error}). ` +
        `Install and enable qemu-guest-agent in the guest and set 'agent: 1' on the VM; ` +
        `describe_homelab reports agent status per VM.`
    );
  }
}

export interface VmFileRead {
  /** File bytes, or null when the file does not exist inside the guest. */
  content: Buffer | null;
  truncated: boolean;
}

/**
 * Read a VM file via the guest agent. Returns `{ content: null }` only when the
 * read fails file-not-found; any other failure throws.
 */
export async function readVmFile(
  transport: SshTransport,
  node: string,
  vmid: number,
  path: string,
  timeoutMs?: number
): Promise<VmFileRead> {
  const r = await transport.exec(buildAgentFileReadCommand(node, vmid, path), timeoutMs);
  if (r.exitCode !== 0) {
    if (classifyAgentFileError(r.stderr) === "not-found") return { content: null, truncated: false };
    throw new Error(
      `agent file-read failed for VM ${vmid}:${path} (exit ${r.exitCode}): ${r.stderr.trim()}`
    );
  }
  const parsed = parseAgentFileRead(r.stdout);
  return { content: parsed.content, truncated: parsed.truncated };
}

/** Write a VM file via the guest agent (content base64-encoded locally). */
export async function writeVmFile(
  transport: SshTransport,
  node: string,
  vmid: number,
  path: string,
  content: Buffer,
  timeoutMs?: number
): Promise<void> {
  const b64 = content.toString("base64");
  const r = await transport.exec(buildAgentFileWriteCommand(node, vmid, path, b64), timeoutMs);
  if (r.exitCode !== 0) {
    throw new Error(
      `agent file-write failed for VM ${vmid}:${path} (exit ${r.exitCode}): ${r.stderr.trim()}`
    );
  }
}
