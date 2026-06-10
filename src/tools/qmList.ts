import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { parseQmList, type QmRow } from "./censusParsers.js";

export const QmListInputSchema = z.object({});

/**
 * `qm_list` — structured `qm list` (VMID NAME STATUS MEM BOOTDISK PID).
 * The pure parser is shared with the census (`parseQmList`).
 */
export async function qmListHandler(
  _input: z.infer<typeof QmListInputSchema>,
  transport: SshTransport
): Promise<{ vms: QmRow[] }> {
  const result = await transport.exec("qm list");
  if (result.exitCode !== 0) {
    throw new Error(`qm list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return { vms: parseQmList(result.stdout) };
}
