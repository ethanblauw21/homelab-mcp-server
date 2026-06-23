/**
 * systemd front door (ADR-020 §1) — `service_status` / `service_logs` /
 * `service_restart`. The structured replacement for hand-rolled `systemctl`/
 * `journalctl` strings funneled through `execute`/`pct_exec`. The payoff is the
 * clean, parse-free audit object (`{tool:"service_restart", unit, vmid}`) the
 * ADR-010 UI and ADR-015 metrics want — a free-form `execute` string can never be.
 *
 * **Tier follows the target kind for ALL THREE** (`assertTargetTier`, like
 * `diff_config`/`revert_file`): a host unit ⇒ root (like `execute`), an LXC unit
 * (`vmid` set) ⇒ companion (like `pct_exec`). The trio shares ONE tier story by
 * design — even read-only `service_status`/`service_logs` on a host unit require
 * root, deliberately stricter than `tail_log` (which reads host journals at
 * companion); the uniform rule is the simpler invariant. Reach for `tail_log` if
 * a companion-tier host journal read is what you want.
 */
import { z } from "zod";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import {
  buildServiceStatusCommand,
  buildServiceRestartCommand,
  parseServiceShow,
  type ServiceStatus,
} from "./serviceHelpers.js";
import { tailLogHandler, type TailLogResult } from "./tailLog.js";
import { assertTargetTier, type Tier } from "../tiers/registry.js";

/** Resolve the target-kind tier guard for a service op: host vs LXC. */
function assertServiceTier(tool: string, vmid: number | undefined, tier: Tier): void {
  assertTargetTier(tool, vmid !== undefined ? "pct" : "host", tier);
}

/** Wrap an inner systemctl command for the host or inside an LXC. */
function routeCommand(inner: string, vmid: number | undefined): string {
  return vmid !== undefined ? buildPctExecCommand(vmid, inner) : inner;
}

// ---------------------------------------------------------------------------
// service_status
// ---------------------------------------------------------------------------

export const ServiceStatusInputSchema = z.object({
  unit: z.string().min(1).describe("systemd unit name (charset-validated, e.g. nginx, docker.service)"),
  vmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("LXC container VMID to target a unit inside the guest; omit for a host unit (root tier)"),
});

export type ServiceStatusInput = z.infer<typeof ServiceStatusInputSchema>;

export interface ServiceStatusResult extends ServiceStatus {
  unit: string;
  vmid?: number;
}

/**
 * `service_status` — parsed `{active, sub, enabled, since, mainPid}` from
 * `systemctl show` (key=value, no `is-active` string-matching). Read-only, not audited.
 */
export async function serviceStatusHandler(
  input: ServiceStatusInput,
  transport: SshTransport,
  cfg: Config,
  tier: Tier
): Promise<ServiceStatusResult> {
  assertServiceTier("service_status", input.vmid, tier);
  const inner = buildServiceStatusCommand(input.unit);
  const r = await transport.exec(routeCommand(inner, input.vmid), cfg.ssh.commandTimeoutMs);
  // `systemctl show` exits 0 even for an unknown unit (it prints defaults), so a
  // non-zero exit is a real failure (e.g. pct exec into a stopped guest).
  if (r.exitCode !== 0) {
    throw new Error(
      `service_status failed (exit ${r.exitCode}): ${r.stderr.trim() || "no output"}`
    );
  }
  return {
    unit: input.unit,
    ...(input.vmid !== undefined ? { vmid: input.vmid } : {}),
    ...parseServiceShow(r.stdout),
  };
}

// ---------------------------------------------------------------------------
// service_logs — tail_log with a unit-only contract
// ---------------------------------------------------------------------------

export const ServiceLogsInputSchema = z.object({
  unit: z.string().min(1).describe("systemd unit name whose journal to tail (charset-validated)"),
  vmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("LXC container VMID to target a unit inside the guest; omit for a host unit (root tier)"),
  lines: z.number().int().positive().optional().describe("trailing journal lines (clamped to the cap)"),
  since: z
    .string()
    .optional()
    .describe('time filter: ISO timestamp or relative like "30 min ago"'),
});

export type ServiceLogsInput = z.infer<typeof ServiceLogsInputSchema>;

export interface ServiceLogsResult {
  unit: string;
  vmid?: number;
  lines: number;
  content: string;
}

/**
 * `service_logs` — bounded, ALWAYS-redacted journal tail. Literally `tail_log`
 * with a `unit`-only contract: it delegates to `tailLogHandler`, inheriting the
 * `since` grammar, the line cap, and the mandatory ADR-002 redaction pass. No new
 * log path, no new redaction surface.
 */
export async function serviceLogsHandler(
  input: ServiceLogsInput,
  transport: SshTransport,
  cfg: Config,
  tier: Tier
): Promise<ServiceLogsResult> {
  assertServiceTier("service_logs", input.vmid, tier);
  const target: TailLogResult["target"] =
    input.vmid !== undefined ? { kind: "pct", vmid: input.vmid } : { kind: "host" };
  const r = await tailLogHandler(
    { target, unit: input.unit, lines: input.lines, since: input.since },
    transport,
    cfg
  );
  return {
    unit: input.unit,
    ...(input.vmid !== undefined ? { vmid: input.vmid } : {}),
    lines: r.lines,
    content: r.content,
  };
}

// ---------------------------------------------------------------------------
// service_restart — the one mutation (confirm-gated, audited)
// ---------------------------------------------------------------------------

export const ServiceRestartInputSchema = z.object({
  unit: z.string().min(1).describe("systemd unit name to restart (charset-validated)"),
  vmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("LXC container VMID to target a unit inside the guest; omit for a host unit (root tier)"),
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true. A restart interrupts the running service."),
});

export type ServiceRestartInput = z.infer<typeof ServiceRestartInputSchema>;

/**
 * `service_restart` — confirm-gated mutation, full ADR-004 audit row with honest
 * `ExecResult` exit semantics propagated. The clean audit object is the point.
 */
export async function serviceRestartHandler(
  input: ServiceRestartInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config,
  tier: Tier
): Promise<ExecResult> {
  assertServiceTier("service_restart", input.vmid, tier);
  if (!input.confirm) {
    throw new Error(
      `Refusing service_restart of '${input.unit}'${input.vmid !== undefined ? ` in ${input.vmid}` : ""} ` +
        "without confirm: true. A restart interrupts the running service. Re-issue with confirm: true."
    );
  }
  const inner = buildServiceRestartCommand(input.unit);
  const result = await transport.exec(routeCommand(inner, input.vmid), cfg.ssh.commandTimeoutMs);

  await audit.append(
    buildAuditRecord({
      tool: "service_restart",
      host: cfg.ssh.host,
      ...(input.vmid !== undefined ? { vmid: input.vmid } : {}),
      // The structured, parse-free record a free-form `execute` string can't be.
      cmd: `systemctl restart ${input.unit}`,
      hashScope: "unknown", // a restart can change runtime state arbitrarily.
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      confirmGated: true,
      isRevertible: false,
      note: `service_restart ${input.unit}${input.vmid !== undefined ? ` (CT${input.vmid})` : " (host)"}`,
    })
  );

  return result;
}
