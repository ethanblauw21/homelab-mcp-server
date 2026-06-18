import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import { checkCommand } from "../guardrails/denylist.js";
import { detectHeavyCommand } from "../guardrails/largeChange.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerExecCommand, assertDockerName } from "./dockerHelpers.js";
import { timeoutMsToSecs } from "../ssh/command.js";
import { buildAuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

export const DockerExecInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name"),
  command: z.string().min(1).describe("Command to run inside the Docker container"),
  timeoutMs: z.number().optional().describe("Optional timeout override in milliseconds"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required true to run an availability-class (CONFIRM-tier) command inside the container"),
});

export type DockerExecInput = z.infer<typeof DockerExecInputSchema>;

/**
 * `docker_exec` (ADR-008 §2) — the fourth consumer of denylist v2 + the confirm
 * gate (after execute/pct_exec/qm_exec; every exec path shares one guardrail).
 *
 * `docker exec <container> sh -c '<escaped>'` runs inside the LXC via `pct exec`;
 * the daemon socket is never exposed. The denylist screens the *inner* command,
 * and ADR-004's `timeout` wrapper composes inside the container for reliable
 * in-guest termination. Heavy patterns annotate (`isHeavy`), never gate (§4).
 */
export async function dockerExecHandler(
  input: DockerExecInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<ExecResult> {
  assertDockerName(input.container);

  const verdict = checkCommand(input.command, cfg.guardrails.commandDenylist);
  if (verdict.tier === "deny") {
    throw new Error(`Command denied: ${verdict.reason}`);
  }
  if (verdict.tier === "confirm" && !input.confirm) {
    throw new Error(`Command requires confirmation: ${verdict.reason}. Re-issue with confirm:true.`);
  }
  const confirmGated = verdict.tier === "confirm";

  const heavy = detectHeavyCommand(input.command);
  const timeoutMs = input.timeoutMs ?? cfg.ssh.commandTimeoutMs;
  const timeoutSecs = timeoutMsToSecs(timeoutMs);

  // In-container timeout for reliable in-guest termination; the transport adds the
  // node-side host timeout around the whole `pct exec`.
  const dockerCmd = buildDockerExecCommand(input.container, input.command, { timeoutSecs });
  const fullCommand = buildPctExecCommand(input.vmid, dockerCmd);
  const result = await transport.exec(fullCommand, timeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "docker_exec",
      host: cfg.ssh.host,
      vmid: input.vmid,
      container: input.container,
      cmd: input.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      timeoutSecs,
      confirmGated: confirmGated || undefined,
      isHeavy: heavy.isHeavy || undefined,
      isRevertible: false,
      note: heavy.isHeavy ? heavy.reason : undefined,
    })
  );

  return result;
}
