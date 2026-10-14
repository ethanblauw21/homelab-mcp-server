/**
 * `docker_restart` (ADR-025 §1) — restart one named Docker container inside an
 * LXC, without handing the model a shell. The `service_restart` shape one layer
 * down: companion tier, confirm-gated, charset-validated name, structured audit
 * row with honest exit semantics.
 *
 * The one Docker-specific hazard is the shared network namespace: containers whose
 * `NetworkMode` is `container:<this>` (compose `network_mode: service:<this>`)
 * lose networking when the provider restarts. `netnsDependents` decides what to do
 * about them — refuse (default), restart them after the provider, or proceed and
 * warn. A restart does NOT apply compose-file changes (that is compose_redeploy /
 * compose_update).
 */
import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { assertDockerName } from "./dockerHelpers.js";
import {
  buildContainerIdentityCommand,
  buildDockerRestartCommand,
  findNetnsDependents,
  parseContainerIdentities,
} from "./dockerUpdate.js";

export const DockerRestartInputSchema = z.object({
  vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon"),
  container: z.string().min(1).describe("Docker container name to restart"),
  timeoutSec: z
    .number()
    .int()
    .min(0)
    .max(300)
    .optional()
    .describe("Seconds to wait for a graceful stop before killing (docker restart -t). Default: Docker's (10)."),
  netnsDependents: z
    .enum(["refuse", "restart", "ignore"])
    .default("refuse")
    .describe(
      "Containers sharing this one's network namespace lose networking when it restarts. " +
        "refuse (default): refuse and name them; restart: restart them after this one; ignore: proceed and warn."
    ),
  confirm: z.boolean().default(false).describe("Must be true. A restart interrupts the running container."),
});

export type DockerRestartInput = z.infer<typeof DockerRestartInputSchema>;

export interface DockerRestartResult {
  vmid: number;
  restarted: string[];
  exitCode: number | null;
  timedOut?: boolean;
  stderr: string;
  durationMs: number;
  warnings: string[];
}

export async function dockerRestartHandler(
  input: DockerRestartInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config,
  now: () => number = Date.now
): Promise<DockerRestartResult> {
  assertDockerName(input.container);
  if (!input.confirm) {
    throw new Error(
      `Refusing docker_restart of '${input.container}' in ${input.vmid} without confirm: true. ` +
        "A restart interrupts the running container. Re-issue with confirm: true."
    );
  }
  const timeoutMs = cfg.ssh.commandTimeoutMs;

  // Netns-provider guard: who lives in this container's network namespace?
  const scan = await transport.exec(buildPctExecCommand(input.vmid, buildContainerIdentityCommand()), timeoutMs);
  if (scan.exitCode !== 0) {
    throw new Error(
      `docker inspect failed on CT${input.vmid} (exit ${scan.exitCode}): ` +
        `${scan.stderr.trim() || "is Docker installed and running in this container?"}`
    );
  }
  const running = parseContainerIdentities(scan.stdout);
  const target = running.find((c) => c.name === input.container);
  const dependents = target ? findNetnsDependents(target, running).map((c) => c.name) : [];
  const warnings: string[] = [];
  if (!target) warnings.push(`'${input.container}' is not running; docker restart will start it.`);
  if (dependents.length > 0) {
    if (input.netnsDependents === "refuse") {
      throw new Error(
        `Refusing docker_restart of '${input.container}': it provides the network namespace for ` +
          `${dependents.join(", ")}, which lose networking when it restarts. Re-issue with ` +
          `netnsDependents: "restart" to restart them after it, or "ignore" to proceed anyway.`
      );
    }
    if (input.netnsDependents === "ignore") {
      warnings.push(
        `Network-namespace dependents NOT restarted and likely without networking: ${dependents.join(", ")}.`
      );
    }
  }

  const order = [input.container, ...(input.netnsDependents === "restart" ? dependents : [])];
  // Each container may take up to its stop timeout + start; give the node-side
  // wrapper room for all of them on top of the ordinary command timeout.
  const perContainerMs = ((input.timeoutSec ?? 10) + 20) * 1000;
  const restartTimeoutMs = Math.max(timeoutMs, perContainerMs * order.length);
  const started = now();
  const restarted: string[] = [];
  let last = await transport.exec(
    buildPctExecCommand(input.vmid, buildDockerRestartCommand([input.container], input.timeoutSec)),
    restartTimeoutMs
  );
  if (last.exitCode === 0) {
    restarted.push(input.container);
    if (order.length > 1) {
      last = await transport.exec(
        buildPctExecCommand(input.vmid, buildDockerRestartCommand(order.slice(1), input.timeoutSec)),
        restartTimeoutMs
      );
      if (last.exitCode === 0) restarted.push(...order.slice(1));
      else warnings.push(`Restarting dependents failed (exit ${last.exitCode}); check ${order.slice(1).join(", ")}.`);
    }
  }
  const durationMs = now() - started;

  await audit.append(
    buildAuditRecord({
      tool: "docker_restart",
      host: cfg.ssh.host,
      vmid: input.vmid,
      container: input.container,
      ...(target && { containerId: target.id }),
      cmd: `docker restart ${order.join(" ")}`,
      hashScope: "unknown", // a restart can change runtime state arbitrarily.
      exitCode: last.exitCode,
      signal: last.signal,
      timedOut: last.timedOut,
      confirmGated: true,
      isRevertible: false,
      note:
        `docker_restart ${input.container} (CT${input.vmid}); restarted: ${restarted.join(", ") || "none"}` +
        (dependents.length > 0 ? `; netns dependents (${input.netnsDependents}): ${dependents.join(", ")}` : ""),
    })
  );

  return {
    vmid: input.vmid,
    restarted,
    exitCode: last.exitCode,
    ...(last.timedOut && { timedOut: true }),
    stderr: last.stderr,
    durationMs,
    warnings,
  };
}
