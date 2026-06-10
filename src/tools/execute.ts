import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import { checkCommand } from "../guardrails/denylist.js";
import { detectHeavyCommand } from "../guardrails/largeChange.js";
import { timeoutMsToSecs } from "../ssh/command.js";
import { buildAuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const ExecuteInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to run on the Proxmox host"),
  timeoutMs: z.number().optional().describe("Optional timeout override in milliseconds"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required true to run an availability-class (CONFIRM-tier) command, e.g. reboot"),
});

export type ExecuteInput = z.infer<typeof ExecuteInputSchema>;

export async function executeHandler(
  input: ExecuteInput,
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
  const timeoutSecs = timeoutMsToSecs(input.timeoutMs ?? cfg.ssh.commandTimeoutMs);
  const result = await transport.exec(input.command, input.timeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "execute",
      host: cfg.ssh.host,
      cmd: input.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      timeoutSecs,
      confirmGated: confirmGated || undefined,
      isLargeChange: heavy.isLarge,
      isRevertible: false,
      note: heavy.isLarge ? heavy.reason : undefined,
    })
  );

  return result;
}
