import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { checkDenylist } from "../guardrails/denylist.js";
import { detectHeavyCommand } from "../guardrails/largeChange.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildAuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const PctExecInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container VMID"),
  command: z.string().min(1).describe("Command to run inside the container"),
  timeoutMs: z.number().optional().describe("Optional timeout override in milliseconds"),
});

export type PctExecInput = z.infer<typeof PctExecInputSchema>;

export async function pctExecHandler(
  input: PctExecInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const denyResult = checkDenylist(input.command, cfg.guardrails.commandDenylist);
  if (denyResult.denied) {
    throw new Error(`Command denied: ${denyResult.reason}`);
  }

  const heavy = detectHeavyCommand(input.command);
  const fullCommand = buildPctExecCommand(input.vmid, input.command);
  const result = await transport.exec(fullCommand, input.timeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "pct_exec",
      host: cfg.ssh.host,
      vmid: input.vmid,
      cmd: input.command,
      exitCode: result.exitCode,
      isLargeChange: heavy.isLarge,
      isRevertible: false,
      note: heavy.isLarge ? heavy.reason : undefined,
    })
  );

  return result;
}
