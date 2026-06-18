import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerPsCommand, parseDockerPs, type DockerContainer } from "./dockerHelpers.js";
import type { Config } from "../config.js";

export const DockerPsInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
});

export type DockerPsInput = z.infer<typeof DockerPsInputSchema>;

/**
 * `docker_ps` (ADR-008 §2) — structured container listing via `docker ps` run
 * inside the LXC over the existing `pct exec` channel. Read-only, not audited.
 */
export async function dockerPsHandler(
  input: DockerPsInput,
  transport: SshTransport,
  cfg: Config
): Promise<{ vmid: number; containers: DockerContainer[] }> {
  const cmd = buildPctExecCommand(input.vmid, buildDockerPsCommand());
  const result = await transport.exec(cmd, cfg.ssh.commandTimeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ps failed on CT${input.vmid} (exit ${result.exitCode}): ` +
        `${result.stderr.trim() || "is Docker installed and running in this container?"}`
    );
  }
  return { vmid: input.vmid, containers: parseDockerPs(result.stdout) };
}
