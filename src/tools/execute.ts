import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { checkDenylist } from "../guardrails/denylist.js";
import { detectHeavyCommand } from "../guardrails/largeChange.js";
import { buildAuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const ExecuteInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to run on the Proxmox host"),
  timeoutMs: z.number().optional().describe("Optional timeout override in milliseconds"),
});

export type ExecuteInput = z.infer<typeof ExecuteInputSchema>;

export async function executeHandler(
  input: ExecuteInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const denyResult = checkDenylist(input.command, cfg.guardrails.commandDenylist);
  if (denyResult.denied) {
    throw new Error(`Command denied: ${denyResult.reason}`);
  }

  const heavy = detectHeavyCommand(input.command);
  const result = await transport.exec(input.command, input.timeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "execute",
      host: cfg.ssh.host,
      cmd: input.command,
      exitCode: result.exitCode,
      isLargeChange: heavy.isLarge,
      isRevertible: false,
      note: heavy.isLarge ? heavy.reason : undefined,
    })
  );

  return result;
}
