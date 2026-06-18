import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { checkCommand } from "../guardrails/denylist.js";
import { detectHeavyCommand } from "../guardrails/largeChange.js";
import { buildQmGuestExecCommand, parseAgentExec, type QmExecResult } from "./qmHelpers.js";
import { pingAgent } from "./qmAgentPing.js";
import { timeoutMsToSecs } from "../ssh/command.js";
import { buildAuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const QmExecInputSchema = z.object({
  vmid: z.number().int().positive().describe("VM ID (qm guest)"),
  command: z.string().min(1).describe("Command to run inside the VM via the QEMU guest agent"),
  timeoutMs: z.number().optional().describe("Optional agent wait-timeout override in milliseconds"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required true to run an availability-class (CONFIRM-tier) command inside the guest"),
});

export type QmExecInput = z.infer<typeof QmExecInputSchema>;

/**
 * `qm_exec` — run a command inside a VM via the QEMU guest agent.
 *
 * Order of guards (third consumer of denylist v2 + the confirm gate):
 *  1. Denylist v2 on the inner command (DENY refuses; CONFIRM needs confirm:true)
 *     — a `reboot` inside a VM is availability-affecting too.
 *  2. Agent precheck (ping). Unavailable ⇒ a structured error naming the fix.
 *  3. `qm guest exec` + JSON parse onto an honest ExecResult.
 *
 * Honest limitation: the agent cannot guarantee in-guest termination on timeout
 * (contrast ADR-004's host wrapper). A timed-out result records the guest PID in
 * the audit note; the process may still be running.
 */
export async function qmExecHandler(
  input: QmExecInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<QmExecResult> {
  const verdict = checkCommand(input.command, cfg.guardrails.commandDenylist);
  if (verdict.tier === "deny") {
    throw new Error(`Command denied: ${verdict.reason}`);
  }
  if (verdict.tier === "confirm" && !input.confirm) {
    throw new Error(`Command requires confirmation: ${verdict.reason}. Re-issue with confirm:true.`);
  }
  const confirmGated = verdict.tier === "confirm";

  const timeoutMs = input.timeoutMs ?? cfg.ssh.commandTimeoutMs;

  // Precheck: without a responsive agent there is nothing to exec against.
  const agent = await pingAgent(transport, input.vmid, timeoutMs);
  if (!agent.available) {
    throw new Error(
      `QEMU guest agent is not available on VM ${input.vmid} (${agent.error}). ` +
        `Install and enable qemu-guest-agent in the guest and set 'agent: 1' on the VM; ` +
        `describe_homelab reports agent status per VM.`
    );
  }

  const heavy = detectHeavyCommand(input.command);
  const timeoutSecs = timeoutMsToSecs(timeoutMs);
  const fullCommand = buildQmGuestExecCommand(input.vmid, input.command, { timeoutSecs });
  const raw = await transport.exec(fullCommand, timeoutMs);
  if (raw.exitCode !== 0 && raw.stdout.trim() === "") {
    // `qm guest exec` itself failed (not the in-guest command) — surface it.
    throw new Error(
      `qm guest exec failed on VM ${input.vmid} (exit ${raw.exitCode}): ${raw.stderr.trim()}`
    );
  }
  const result = parseAgentExec(raw.stdout);

  const notes: string[] = [];
  if (result.timedOut) {
    notes.push(
      result.pid !== undefined
        ? `agent timeout; guest pid ${result.pid} may still be running`
        : `agent timeout; guest process may still be running`
    );
  }
  if (result.outTruncated) notes.push("stdout truncated by agent");
  if (heavy.isHeavy && heavy.reason) notes.push(heavy.reason);

  await audit.append(
    buildAuditRecord({
      tool: "qm_exec",
      host: cfg.ssh.host,
      vmid: input.vmid,
      cmd: input.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      timeoutSecs,
      confirmGated: confirmGated || undefined,
      // ADR-008 §4: heavy patterns annotate (isHeavy), never gate.
      isHeavy: heavy.isHeavy || undefined,
      isRevertible: false,
      note: notes.length ? notes.join("; ") : undefined,
    })
  );

  return result;
}
