import { shSingleQuote, buildTimeoutWrapper, type WrapperShell } from "../ssh/command.js";

export interface PctContainer {
  vmid: number;
  status: string;
  lock: string;
  name: string;
}

/**
 * Parse the tabular output of `pct list`.
 * Header line: "VMID       Status     Lock         Name"
 */
export function parsePctList(output: string): PctContainer[] {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const dataLines = lines.filter((l) => /^\d/.test(l));
  return dataLines.map((line) => {
    const parts = line.split(/\s+/);
    // pct list columns: VMID Status [Lock] Name
    // When Lock is empty the field is absent in the whitespace-split result (3 tokens).
    // When Lock is present there are 4 tokens.
    if (parts.length >= 4) {
      return {
        vmid: parseInt(parts[0] ?? "0"),
        status: parts[1] ?? "",
        lock: parts[2] ?? "",
        name: parts[3] ?? "",
      };
    }
    return {
      vmid: parseInt(parts[0] ?? "0"),
      status: parts[1] ?? "",
      lock: "",
      name: parts[2] ?? "",
    };
  });
}

export interface PctExecCommandOptions {
  /**
   * In-container shell. Defaults to "bash" (A4.1): standard LXC templates ship
   * bash, and wrapping in `sh` (dash on Debian) silently breaks bashisms.
   * Pass "sh" for minimal guests (e.g. Alpine) that lack bash.
   */
  shell?: WrapperShell;
  /**
   * When set, the command is wrapped with coreutils `timeout` *inside* the
   * container so in-guest termination is reliable (the host-side wrapper alone
   * may not propagate signals through `pct exec`). See ADR-004 §2.
   */
  timeoutSecs?: number;
}

/**
 * Build the `pct exec` command string with proper quoting.
 * Produces: pct exec <vmid> -- bash -c '<escaped-cmd>'
 * or, when timeoutSecs is set:
 *           pct exec <vmid> -- timeout --signal=TERM --kill-after=5 <secs> bash -c '<escaped-cmd>'
 */
export function buildPctExecCommand(
  vmid: number,
  cmd: string,
  opts: PctExecCommandOptions = {}
): string {
  const shell = opts.shell ?? "bash";
  const inner =
    opts.timeoutSecs !== undefined
      ? buildTimeoutWrapper(cmd, opts.timeoutSecs, { shell })
      : `${shell} -c ${shSingleQuote(cmd)}`;
  return `pct exec ${vmid} -- ${inner}`;
}
