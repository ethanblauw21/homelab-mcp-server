import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import { checkCommand } from "../guardrails/denylist.js";
import { detectHeavyCommand } from "../guardrails/largeChange.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { timeoutMsToSecs } from "../ssh/command.js";
import { buildAuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const PctExecInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container VMID"),
  command: z.string().min(1).describe("Command to run inside the container"),
  timeoutMs: z.number().optional().describe("Optional timeout override in milliseconds"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required true to run an availability-class (CONFIRM-tier) command inside the guest"),
});

export type PctExecInput = z.infer<typeof PctExecInputSchema>;

export async function pctExecHandler(
  input: PctExecInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<ExecResult> {
  const verdict = checkCommand(input.command, cfg.guardrails.commandDenylist);
  if (verdict.tier === "deny") {
    throw new Error(`Command denied: ${verdict.reason}`);
  }
  if (verdict.tier === "confirm" && !input.confirm) {
    throw new Error(`Command requires confirmation: ${verdict.reason}. Re-issue with confirm:true.`);
  }
  const confirmGated = verdict.tier === "confirm";

  const heavy = detectHeavyCommand(input.command);
  // The same timeout is enforced both inside the container (here) and on the host
  // (Ssh2Transport wraps the outer `pct exec`), per ADR-004 §2.
  const timeoutSecs = timeoutMsToSecs(input.timeoutMs ?? cfg.ssh.commandTimeoutMs);
  const fullCommand = buildPctExecCommand(input.vmid, input.command, { timeoutSecs });
  const result = await transport.exec(fullCommand, input.timeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "pct_exec",
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
      note: heavy.isHeavy ? heavy.reason : undefined,
    })
  );

  return result;
}
