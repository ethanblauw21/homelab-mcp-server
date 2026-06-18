/**
 * `compose_redeploy` (ADR-008 §6) — the lighter, usually-better rollback for a
 * Docker host: `docker compose -f <path> up -d` inside the LXC (via `pct exec`).
 *
 * Combined with the pipeline now protecting compose files (pct_write_file /
 * docker_write_file + config_sweep), **`revert_file` + `compose_redeploy` is the
 * stack-level rollback story**: revert the compose file from a backup, redeploy,
 * done — seconds, not the minutes a vzdump restore costs, and no snapshot needed.
 * Image-tag pinning in compose files is the operator practice that makes this
 * deterministic.
 *
 * Companion tier, confirm-gated (a redeploy disrupts running services), audited.
 */
import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildComposeUpCommand } from "./dockerHelpers.js";

export const ComposeRedeployInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  composePath: z.string().min(1).describe("Absolute path to the compose file inside the LXC (e.g. /opt/stack/docker-compose.yml)"),
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true. A redeploy recreates the stack's containers and disrupts running services."),
});

export type ComposeRedeployInput = z.infer<typeof ComposeRedeployInputSchema>;

export async function composeRedeployHandler(
  input: ComposeRedeployInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<ExecResult> {
  if (!input.confirm) {
    throw new Error(
      `Refusing compose_redeploy on ${input.vmid} without confirm: true. A redeploy recreates the ` +
        "stack's containers and disrupts running services. Re-issue with confirm: true."
    );
  }
  const pathCheck = validatePath(input.composePath, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathCheck.valid) {
    throw new Error(`Invalid compose file path: ${pathCheck.reason}`);
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const inner = buildComposeUpCommand(input.composePath);
  const fullCommand = buildPctExecCommand(input.vmid, inner);
  const result = await transport.exec(fullCommand, timeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "compose_redeploy",
      host: cfg.ssh.host,
      vmid: input.vmid,
      path: input.composePath,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      isLargeChange: true,
      isRevertible: false,
      note: `docker compose up -d (${input.composePath}) in ${input.vmid}`,
    })
  );

  return result;
}
