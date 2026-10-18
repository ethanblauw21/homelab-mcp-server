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
 *
 * ADR-027 — a project started with `--env-file` elsewhere (not a sibling .env)
 * needs the same flags again, or interpolation fails. They come from `envFiles`
 * when given, else from the `environment_file` label of the project's existing
 * containers. Paths only: compose reads the files on the node, the server never does.
 */
import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { buildComposeUpCommand, parseEnvFileLabel } from "./dockerHelpers.js";
import { buildContainerIdentityCommand, configFilesInclude, parseContainerIdentities } from "./dockerUpdate.js";

export const ComposeRedeployInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  composePath: z.string().min(1).describe("Absolute path to the compose file inside the LXC (e.g. /opt/stack/docker-compose.yml)"),
  envFiles: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Absolute --env-file paths inside the LXC. Default: the environment_file label of the project's existing " +
        "containers (compose_discover shows it). Pass [] to use only compose's default sibling .env."
    ),
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
): Promise<ExecResult & { envFiles: string[]; warnings?: string[] }> {
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
  const warnings: string[] = [];
  let envFiles: string[];
  if (input.envFiles !== undefined) {
    const bad = input.envFiles.filter((f) => f.includes(",") || parseEnvFileLabel(f).files.length !== 1);
    if (bad.length > 0) throw new Error(`Invalid envFiles entr${bad.length > 1 ? "ies" : "y"}: ${bad.map((b) => JSON.stringify(b)).join(", ")} (absolute paths only).`);
    envFiles = [...new Set(input.envFiles)];
  } else {
    envFiles = await recordedEnvFiles(transport, input.vmid, input.composePath, timeoutMs, warnings);
  }
  const inner = buildComposeUpCommand(input.composePath, envFiles);
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
      note:
        `docker compose up -d (${input.composePath}) in ${input.vmid}` +
        (envFiles.length > 0 ? `; --env-file ${envFiles.join(", ")}` : ""),
    })
  );

  return { ...result, envFiles, ...(warnings.length > 0 && { warnings }) };
}

/**
 * The --env-file paths the project was last started with, read from the
 * `environment_file` label of its containers (running or stopped). Best-effort:
 * a failed scan or no matching container means compose's default sibling .env.
 */
async function recordedEnvFiles(
  transport: SshTransport,
  vmid: number,
  composePath: string,
  timeoutMs: number,
  warnings: string[]
): Promise<string[]> {
  const scan = await transport.exec(buildPctExecCommand(vmid, buildContainerIdentityCommand(true)), timeoutMs);
  if (scan.exitCode !== 0) {
    warnings.push("Could not read the project's containers to find its env files; using compose's default .env only.");
    return [];
  }
  const labels = new Set(
    parseContainerIdentities(scan.stdout)
      .filter((c) => configFilesInclude(c.composeConfigFiles, composePath))
      .map((c) => c.composeEnvFiles)
  );
  if (labels.size > 1) {
    warnings.push(
      `The project's containers disagree on environment_file (${[...labels].map((l) => JSON.stringify(l)).join(" vs ")}); ` +
        "using none. Pass envFiles explicitly."
    );
    return [];
  }
  const parsed = parseEnvFileLabel([...labels][0]);
  for (const r of parsed.rejected) warnings.push(`Ignored environment_file entry ${JSON.stringify(r)} (not a plain absolute path).`);
  return parsed.files;
}
