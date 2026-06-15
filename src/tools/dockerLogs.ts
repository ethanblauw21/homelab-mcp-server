import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerLogsCommand, assertDockerName } from "./dockerHelpers.js";
import { clampLines, validateSince } from "./tailLog.js";
import { redactString } from "../guardrails/redaction.js";
import type { Config } from "../config.js";

export const DockerLogsInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name"),
  tail: z.number().int().positive().optional().describe("Number of trailing log lines (clamped to the cap)"),
  since: z
    .string()
    .optional()
    .describe('Time filter: ISO timestamp or relative like "30 min ago"'),
});

export type DockerLogsInput = z.infer<typeof DockerLogsInputSchema>;

export interface DockerLogsResult {
  vmid: number;
  container: string;
  lines: number;
  content: string;
}

/**
 * `docker_logs` (ADR-008 §2) — `docker logs --tail N [--since X]` inside the LXC.
 * Joins `tail_log` as a **mandatory-redaction** output: container logs leak API
 * keys and tokens constantly, so the result (and any error text) always passes
 * through the ADR-002 redaction module. `tail` is clamped to the shared cap and
 * `since` reuses `tail_log`'s validated grammar — nothing free-form is
 * interpolated. Read-only, not audited.
 */
export async function dockerLogsHandler(
  input: DockerLogsInput,
  transport: SshTransport,
  cfg: Config
): Promise<DockerLogsResult> {
  assertDockerName(input.container);

  const lines = clampLines(input.tail, cfg.tools.tailLinesCap);
  if (input.since !== undefined && input.since !== "" && !validateSince(input.since)) {
    throw new Error(
      `Invalid \`since\`: ${JSON.stringify(input.since)}. Use an ISO timestamp or "<n> min|hour|day ago".`
    );
  }

  const dockerCmd = buildDockerLogsCommand(input.container, {
    tail: lines,
    since: input.since,
  });
  const fullCommand = buildPctExecCommand(input.vmid, dockerCmd);
  const result = await transport.exec(fullCommand, cfg.health.probeTimeoutMs);
  if (result.exitCode !== 0) {
    const reason = redactString(
      result.stderr.trim() || `exit ${result.exitCode}`,
      cfg.census.redactionExtraKeys
    ).value;
    throw new Error(`docker_logs failed for ${input.container} on CT${input.vmid}: ${reason}`);
  }

  // `docker logs` interleaves stdout + stderr of the container; both can leak.
  const merged = result.stdout + (result.stderr ? result.stderr : "");
  const content = redactString(merged, cfg.census.redactionExtraKeys).value;

  return { vmid: input.vmid, container: input.container, lines, content };
}
