import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { buildQmAgentPingCommand } from "./qmHelpers.js";

export const QmAgentPingInputSchema = z.object({
  vmid: z.number().int().positive().describe("VM ID (qm guest)"),
});

export type QmAgentPingInput = z.infer<typeof QmAgentPingInputSchema>;

export interface AgentStatus {
  available: boolean;
  error?: string;
}

/**
 * Probe whether the QEMU guest agent answers for a VM. `qm agent <vmid> ping`
 * exits 0 on success; any non-zero exit (agent not installed, not enabled, VM
 * stopped) yields `available: false` with the node's stderr as the reason.
 *
 * Shared internally as the `qm_exec` precheck and exposed as a tool so agent
 * coverage can be queried directly.
 */
export async function pingAgent(
  transport: SshTransport,
  vmid: number,
  timeoutMs?: number
): Promise<AgentStatus> {
  const r = await transport.exec(buildQmAgentPingCommand(vmid), timeoutMs);
  if (r.exitCode === 0 && !r.timedOut) {
    return { available: true };
  }
  const reason = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim();
  return { available: false, error: reason || `exit ${r.exitCode}` };
}

export async function qmAgentPingHandler(
  input: QmAgentPingInput,
  transport: SshTransport,
  timeoutMs?: number
): Promise<AgentStatus> {
  return pingAgent(transport, input.vmid, timeoutMs);
}
