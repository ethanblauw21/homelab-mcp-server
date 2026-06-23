/**
 * Guest lifecycle tools (ADR-007 §2) — `guest_start` / `guest_stop` /
 * `guest_restart`. First-class operate-tier tools that previously required raw
 * `execute` (root). They run through `NodeOps`, so at observe/operate they ride the
 * API backend and Proxmox RBAC is the real enforcement; at companion+ they may ride
 * SSH. The guest type is resolved from `listGuests()` (no separate `pct list` probe).
 *
 * `guest_stop` is confirm-gated: a hard stop is a power-pull. `guest_restart` uses
 * the API reboot (graceful shutdown+start). All three are audited; the audit note
 * records the backend kind and the returned task ref.
 */
import { z } from "zod";
import type { NodeOps, GuestType } from "../node/nodeOps.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord, type AuditTool } from "../audit/record.js";

export const GuestStartInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM)"),
});
export const GuestRestartInputSchema = GuestStartInputSchema;
export const GuestStopInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM)"),
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true. A stop is an immediate power-off; in-guest processes are not shut down gracefully."),
});

export type GuestStartInput = z.infer<typeof GuestStartInputSchema>;
export type GuestStopInput = z.infer<typeof GuestStopInputSchema>;
export type GuestRestartInput = z.infer<typeof GuestRestartInputSchema>;

async function resolveType(node: NodeOps, vmid: number): Promise<GuestType> {
  const guests = await node.listGuests();
  const g = guests.find((x) => x.vmid === vmid);
  if (!g) {
    throw new Error(`No guest with vmid ${vmid} found on this node.`);
  }
  return g.type;
}

async function record(
  audit: AuditLog,
  cfg: Config,
  tool: AuditTool,
  vmid: number,
  note: string,
  rootTier: boolean
): Promise<void> {
  await audit.append(
    buildAuditRecord({
      tool,
      host: cfg.ssh.host,
      vmid,
      isLargeChange: tool !== "guest_start",
      ...(rootTier ? { rootTier: true } : {}),
      note,
    })
  );
}

export async function guestStartHandler(
  input: GuestStartInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config,
  rootTier = false
): Promise<{ vmid: number; guestType: GuestType; task: string; alreadyRunning?: boolean }> {
  // ADR-023 §E2 — start is idempotent. Resolve the guest (and its run-state) from
  // the single listGuests() call; if it is already running, return a clean no-op
  // instead of calling startGuest and surfacing the backend's raw 500 "already
  // running" error.
  const guests = await node.listGuests();
  const g = guests.find((x) => x.vmid === input.vmid);
  if (!g) {
    throw new Error(`No guest with vmid ${input.vmid} found on this node.`);
  }
  if (g.status === "running") {
    await record(audit, cfg, "guest_start", input.vmid, `guest_start no-op: ${g.type} ${input.vmid} already running`, rootTier);
    return { vmid: input.vmid, guestType: g.type, task: "", alreadyRunning: true };
  }
  const ref = await node.startGuest(input.vmid, g.type);
  await record(audit, cfg, "guest_start", input.vmid, `Started ${g.type} ${input.vmid} via ${node.kind} (${ref.upid})`, rootTier);
  return { vmid: input.vmid, guestType: g.type, task: ref.upid, alreadyRunning: false };
}

export async function guestStopHandler(
  input: GuestStopInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config,
  rootTier = false
): Promise<{ vmid: number; guestType: GuestType; task: string }> {
  if (!input.confirm) {
    throw new Error(
      `Refusing guest_stop on ${input.vmid} without confirm: true. A stop is an immediate ` +
        "power-off (not a graceful shutdown). Re-issue with confirm: true, or use guest_restart for a graceful cycle."
    );
  }
  const type = await resolveType(node, input.vmid);
  const ref = await node.stopGuest(input.vmid, type);
  await record(audit, cfg, "guest_stop", input.vmid, `Stopped ${type} ${input.vmid} via ${node.kind} (${ref.upid})`, rootTier);
  return { vmid: input.vmid, guestType: type, task: ref.upid };
}

export async function guestRestartHandler(
  input: GuestRestartInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config,
  rootTier = false
): Promise<{ vmid: number; guestType: GuestType; task: string }> {
  const type = await resolveType(node, input.vmid);
  const ref = await node.rebootGuest(input.vmid, type);
  await record(audit, cfg, "guest_restart", input.vmid, `Rebooted ${type} ${input.vmid} via ${node.kind} (${ref.upid})`, rootTier);
  return { vmid: input.vmid, guestType: type, task: ref.upid };
}
