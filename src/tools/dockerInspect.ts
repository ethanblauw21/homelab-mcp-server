import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import {
  assertDockerName,
  buildContainerInspectCommand,
  parseContainerInspect,
  projectInspectFields,
  type ContainerInspect,
} from "./dockerHelpers.js";
import type { Config } from "../config.js";

export const DockerInspectInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name"),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Narrow the projection to these top-level fields (e.g. [\"image\",\"mounts\"]) to cut tokens; " +
        "id and name are always included. Omit for the full structured view."
    ),
});

export type DockerInspectInput = z.infer<typeof DockerInspectInputSchema>;

export interface DockerInspectResult {
  vmid: number;
  container: string;
  inspect: Partial<ContainerInspect>;
}

/**
 * `docker_inspect` (ADR-016 §1) — structured, secret-aware single-container view
 * via `docker inspect` run inside the LXC over the existing `pct exec` channel.
 * Read-only, not audited (sibling of `docker_ps`/`docker_logs`). The env block
 * keeps names but redacts secret values through the shared ADR-002 module (on the
 * **parsed** env map, never JSON-escaped text); `fields?` narrows the projection.
 */
export async function dockerInspectHandler(
  input: DockerInspectInput,
  transport: SshTransport,
  cfg: Config
): Promise<DockerInspectResult> {
  assertDockerName(input.container);
  const cmd = buildPctExecCommand(input.vmid, buildContainerInspectCommand(input.container));
  const result = await transport.exec(cmd, cfg.ssh.commandTimeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker inspect failed for ${input.container} on CT${input.vmid} (exit ${result.exitCode}): ` +
        `${result.stderr.trim() || "container not found?"}`
    );
  }
  const view = parseContainerInspect(result.stdout, cfg.census.redactionExtraKeys);
  return {
    vmid: input.vmid,
    container: input.container,
    inspect: projectInspectFields(view, input.fields),
  };
}
