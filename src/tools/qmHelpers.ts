/**
 * Pure helpers for VM tools (ADR-005 Part 1).
 *
 * VMs have no hypervisor-level exec like `pct exec`; command execution goes
 * through the QEMU guest agent, which must be installed and enabled per guest.
 * `qm guest exec` runs synchronously and prints a JSON status blob from the
 * agent; `parseAgentExec` maps that onto the ADR-004 `ExecResult` shape.
 *
 * Honest limitation (ADR-005 §Security): the agent's `--timeout` bounds how long
 * `qm` WAITS, but — unlike ADR-004's coreutils `timeout` wrapper on the host — it
 * cannot guarantee the in-guest process is terminated. A not-exited result is
 * surfaced as `timedOut: true` with the guest PID (when the agent reports one)
 * recorded in the audit note; the process may still be running in the guest.
 *
 * No I/O. The only caller-controlled string that reaches a shell is single-quote
 * escaped here; vmid/secs are integer-validated upstream.
 */
import { shSingleQuote, type WrapperShell } from "../ssh/command.js";
import type { ExecResult } from "../ssh/transport.js";

/** `ExecResult` plus the agent-specific fields the guest agent reports. */
export interface QmExecResult extends ExecResult {
  /** True when the agent flagged stdout as truncated to its size limit. */
  outTruncated?: boolean;
  /** True when the agent flagged stderr as truncated to its size limit. */
  errTruncated?: boolean;
  /** Guest-side PID reported by the agent (useful when timedOut). */
  pid?: number;
}

/** Build `qm agent <vmid> ping` — the agent-availability precheck. */
export function buildQmAgentPingCommand(vmid: number): string {
  return `qm agent ${vmid} ping`;
}

export interface QmGuestExecOptions {
  /**
   * In-guest shell. Defaults to "sh": unlike LXC templates (ADR-004 A4.1 picks
   * bash), a VM can be any OS, so the portable POSIX shell is the safe default.
   */
  shell?: WrapperShell;
  /**
   * Agent wait timeout in whole seconds. Bounds how long `qm` blocks waiting for
   * the command; does NOT guarantee in-guest termination (see file header).
   */
  timeoutSecs?: number;
}

/**
 * Build the `qm guest exec` command string.
 * Produces: qm guest exec <vmid> [--timeout <secs>] -- <shell> -c '<escaped-cmd>'
 *
 * Everything after `--` is passed as separate argv to the agent, so the single
 * escaped token becomes one `sh -c` argument inside the guest.
 */
export function buildQmGuestExecCommand(
  vmid: number,
  cmd: string,
  opts: QmGuestExecOptions = {}
): string {
  const shell = opts.shell ?? "sh";
  const timeout = opts.timeoutSecs !== undefined ? `--timeout ${opts.timeoutSecs} ` : "";
  return `qm guest exec ${vmid} ${timeout}-- ${shell} -c ${shSingleQuote(cmd)}`;
}

function truncateForError(s: string, max = 200): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Parse the JSON status blob printed by `qm guest exec` onto an `ExecResult`.
 *
 * Mapping (ADR-005 Part 1):
 *  - `exited` truthy + numeric `exitcode` ⇒ that exit code.
 *  - `exited` truthy + numeric `signal` (no exitcode) ⇒ `exitCode: null`,
 *    `signal` recorded — never coerced to 0 (ADR-004 §3).
 *  - `exited` falsy ⇒ `timedOut: true`, `exitCode: null`, `pid` carried.
 *  - `out-truncated` / `err-truncated` surface as result fields.
 *
 * Malformed JSON or a non-object payload throws a structured error rather than
 * being silently treated as success.
 */
export function parseAgentExec(stdout: string): QmExecResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`qm guest agent returned unparseable JSON: ${truncateForError(stdout)}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `qm guest agent returned an unexpected (non-object) payload: ${truncateForError(stdout)}`
    );
  }

  const obj = data as Record<string, unknown>;
  const stdoutData = typeof obj["out-data"] === "string" ? (obj["out-data"] as string) : "";
  const stderrData = typeof obj["err-data"] === "string" ? (obj["err-data"] as string) : "";
  const outTruncated = obj["out-truncated"] === true ? true : undefined;
  const errTruncated = obj["err-truncated"] === true ? true : undefined;
  const pid = typeof obj["pid"] === "number" ? (obj["pid"] as number) : undefined;

  const exited = obj["exited"] === 1 || obj["exited"] === true;
  if (!exited) {
    return {
      stdout: stdoutData,
      stderr: stderrData,
      exitCode: null,
      timedOut: true,
      outTruncated,
      errTruncated,
      pid,
    };
  }

  if (typeof obj["exitcode"] === "number") {
    return {
      stdout: stdoutData,
      stderr: stderrData,
      exitCode: obj["exitcode"] as number,
      outTruncated,
      errTruncated,
      pid,
    };
  }

  // Exited but no numeric exitcode — a signal kill. Keep exitCode null (ADR-004 §3).
  const signal =
    typeof obj["signal"] === "number" ? `signal ${obj["signal"] as number}` : undefined;
  return {
    stdout: stdoutData,
    stderr: stderrData,
    exitCode: null,
    signal,
    outTruncated,
    errTruncated,
    pid,
  };
}
