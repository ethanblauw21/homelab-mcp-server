import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildDockerPsCommand, parseComposeProjects, type ComposeProject } from "./dockerHelpers.js";
import type { Config } from "../config.js";

export const ComposeDiscoverInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
});

export type ComposeDiscoverInput = z.infer<typeof ComposeDiscoverInputSchema>;

export interface ComposeDiscoverResult {
  vmid: number;
  projects: ComposeProject[];
  /** Honest-limit reminder surfaced in the output (ADR-016 §3). */
  note: string;
}

/**
 * `compose_discover` (ADR-016 §3) — read-only compose project map built from the
 * running containers' compose labels (`docker ps` inside the LXC). Produces the
 * `configFile` path that `compose_redeploy`/`compose_preflight` require, making
 * that pair self-serviceable instead of dependent on out-of-band knowledge.
 * Read-only, not audited. Sees only RUNNING containers' labels — a fully-`down`
 * project exposes nothing to discover.
 */
export async function composeDiscoverHandler(
  input: ComposeDiscoverInput,
  transport: SshTransport,
  cfg: Config
): Promise<ComposeDiscoverResult> {
  const cmd = buildPctExecCommand(input.vmid, buildDockerPsCommand());
  const result = await transport.exec(cmd, cfg.ssh.commandTimeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ps failed on CT${input.vmid} (exit ${result.exitCode}): ` +
        `${result.stderr.trim() || "is Docker installed and running in this container?"}`
    );
  }
  return {
    vmid: input.vmid,
    projects: parseComposeProjects(result.stdout),
    note: "Discovered from running containers' compose labels only; a fully-stopped (down) project is not visible.",
  };
}
