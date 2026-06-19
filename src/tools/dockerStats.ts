import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerStatsCommand, parseDockerStats, type DockerStat } from "./dockerHelpers.js";
import type { Config } from "../config.js";

export const DockerStatsInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
});

export type DockerStatsInput = z.infer<typeof DockerStatsInputSchema>;

export interface DockerStatsResult {
  vmid: number;
  stats: DockerStat[];
}

/**
 * `docker_stats` (ADR-016 §2) — a point-in-time resource snapshot via
 * `docker stats --no-stream` inside the LXC (one sample, never a live feed —
 * streaming stays deferred per ADR-008 Option D). Results are sorted by memory
 * used descending. Read-only, not audited; heavier than `docker_ps` (samples
 * every container), hence opt-in by tool choice.
 */
export async function dockerStatsHandler(
  input: DockerStatsInput,
  transport: SshTransport,
  cfg: Config
): Promise<DockerStatsResult> {
  const cmd = buildPctExecCommand(input.vmid, buildDockerStatsCommand());
  const result = await transport.exec(cmd, cfg.ssh.commandTimeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker stats failed on CT${input.vmid} (exit ${result.exitCode}): ` +
        `${result.stderr.trim() || "is Docker installed and running in this container?"}`
    );
  }
  return { vmid: input.vmid, stats: parseDockerStats(result.stdout) };
}
