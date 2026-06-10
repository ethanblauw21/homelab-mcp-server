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

/**
 * Build the `pct exec` command string with proper quoting.
 * Produces: pct exec <vmid> -- sh -c '<escaped-cmd>'
 */
export function buildPctExecCommand(vmid: number, cmd: string): string {
  // Escape single quotes in the command for the sh -c wrapper
  const escaped = cmd.replace(/'/g, "'\\''");
  return `pct exec ${vmid} -- sh -c '${escaped}'`;
}
