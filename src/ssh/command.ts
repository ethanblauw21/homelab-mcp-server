/**
 * Pure command-construction helpers shared by the transport and the pct tools.
 *
 * No I/O. The only caller-controlled string that ever reaches a shell is wrapped
 * here with single-quote escaping; everything else (vmid, secs) is integer-validated
 * upstream.
 */

/**
 * POSIX single-quote a string for safe inclusion in a shell command.
 * Wraps in single quotes and escapes embedded single quotes via the
 * close-quote / escaped-quote / reopen-quote idiom (`'\''`).
 */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export type WrapperShell = "bash" | "sh";

export interface TimeoutWrapperOptions {
  /**
   * Inner shell. Defaults to "bash": on Debian (Proxmox host + most LXC
   * templates) `sh` is dash, which silently drops bashisms. Pass "sh" only for
   * minimal guests (e.g. Alpine) that lack bash.
   */
  shell?: WrapperShell;
  /** Grace period (seconds) between TERM and the follow-up KILL. */
  killAfterSecs?: number;
}

/**
 * Wrap a command so the *remote node* enforces the timeout (client timers cannot
 * reliably kill a remote process). Produces:
 *
 *   timeout --signal=TERM --kill-after=<grace> <secs> <shell> -c '<escaped cmd>'
 *
 * coreutils `timeout` exits 124 on expiry — the transport maps that to
 * `{ timedOut: true }` rather than surfacing a bare 124.
 */
export function buildTimeoutWrapper(
  command: string,
  secs: number,
  opts: TimeoutWrapperOptions = {}
): string {
  const shell = opts.shell ?? "bash";
  const killAfter = opts.killAfterSecs ?? 5;
  return `timeout --signal=TERM --kill-after=${killAfter} ${secs} ${shell} -c ${shSingleQuote(
    command
  )}`;
}

/** coreutils `timeout` exit status when the command was killed on expiry. */
export const TIMEOUT_EXIT_CODE = 124;

/** Convert a millisecond timeout to whole seconds for the `timeout` wrapper (min 1). */
export function timeoutMsToSecs(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}
