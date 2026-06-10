import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { parsePctList } from "./pctHelpers.js";
import {
  type GuestType,
  type SnapshotInfo,
  isMcpSnapshot,
  generateSnapshotName,
  parseSnapshotList,
  parseGuestStatus,
  planSnapshotEviction,
  buildGuestStatusCommand,
  buildGuestStopCommand,
  buildGuestStartCommand,
  buildSnapshotListCommand,
  buildSnapshotCreateCommand,
  buildSnapshotRollbackCommand,
  buildSnapshotDeleteCommand,
} from "./snapshots.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** vmid present in `pct list` ⇒ container, otherwise a VM. */
async function detectGuestType(
  transport: SshTransport,
  vmid: number,
  timeoutMs: number
): Promise<GuestType> {
  const res = await transport.exec("pct list", timeoutMs);
  if (res.exitCode === 0) {
    const containers = parsePctList(res.stdout);
    if (containers.some((c) => c.vmid === vmid)) return "pct";
  }
  return "qm";
}

async function listSnapshots(
  transport: SshTransport,
  type: GuestType,
  vmid: number,
  timeoutMs: number
): Promise<SnapshotInfo[]> {
  const res = await transport.exec(buildSnapshotListCommand(type, vmid), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(`listsnapshot failed for ${type} ${vmid} (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return parseSnapshotList(res.stdout);
}

async function guestState(
  transport: SshTransport,
  type: GuestType,
  vmid: number,
  timeoutMs: number
): Promise<string> {
  const res = await transport.exec(buildGuestStatusCommand(type, vmid), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(`status check failed for ${type} ${vmid} (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return parseGuestStatus(res.stdout);
}

// ---------------------------------------------------------------------------
// snapshot_create
// ---------------------------------------------------------------------------

export const SnapshotCreateInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM)"),
  note: z.string().optional().describe("Optional description recorded on the snapshot and in the audit log"),
});

export type SnapshotCreateInput = z.infer<typeof SnapshotCreateInputSchema>;

export async function snapshotCreateHandler(
  input: SnapshotCreateInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config,
  now: Date = new Date()
): Promise<{ name: string; guestType: GuestType; evicted: string[] }> {
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const type = await detectGuestType(transport, input.vmid, timeoutMs);

  // Retention BEFORE creation: count mcp- snapshots and evict oldest to make
  // room. Non-mcp snapshots are never counted or touched.
  const existing = await listSnapshots(transport, type, input.vmid, timeoutMs);
  const mcpNames = existing.filter((s) => s.mcpManaged).map((s) => s.name);
  const evicted: string[] = [];
  for (const name of planSnapshotEviction(mcpNames, cfg.snapshot.perGuestCap)) {
    const res = await transport.exec(buildSnapshotDeleteCommand(type, input.vmid, name), timeoutMs);
    if (res.exitCode !== 0) {
      throw new Error(`Retention eviction of ${name} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
    }
    evicted.push(name);
  }

  const name = generateSnapshotName(now);
  const createRes = await transport.exec(
    buildSnapshotCreateCommand(type, input.vmid, name, {
      description: input.note,
      vmstate: cfg.snapshot.vmstate,
    }),
    timeoutMs
  );
  // Surface storage-driver errors verbatim (directory storage refuses snapshots).
  if (createRes.exitCode !== 0) {
    throw new Error(`snapshot create failed (exit ${createRes.exitCode}): ${createRes.stderr.trim()}`);
  }

  const record = buildAuditRecord({
    tool: "snapshot_create",
    host: cfg.ssh.host,
    vmid: input.vmid,
    note:
      `Created snapshot ${name} (${type})` +
      (evicted.length ? `; evicted ${evicted.join(", ")}` : "") +
      (input.note ? ` — ${input.note}` : ""),
  });
  await audit.append(record);

  return { name, guestType: type, evicted };
}

// ---------------------------------------------------------------------------
// snapshot_list
// ---------------------------------------------------------------------------

export const SnapshotListInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM)"),
});

export type SnapshotListInput = z.infer<typeof SnapshotListInputSchema>;

export async function snapshotListHandler(
  input: SnapshotListInput,
  transport: SshTransport,
  cfg: Config
): Promise<{ guestType: GuestType; snapshots: SnapshotInfo[] }> {
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const type = await detectGuestType(transport, input.vmid, timeoutMs);
  const snapshots = await listSnapshots(transport, type, input.vmid, timeoutMs);
  return { guestType: type, snapshots };
}

// ---------------------------------------------------------------------------
// snapshot_rollback (confirm-gated, destructive)
// ---------------------------------------------------------------------------

export const SnapshotRollbackInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM)"),
  name: z.string().min(1).describe("Snapshot name to roll back to (must be an mcp-* snapshot)"),
  confirm: z.boolean().describe("Must be true. Rollback discards ALL guest state since the snapshot."),
  stopIfRunning: z
    .boolean()
    .default(false)
    .describe("If the guest is running, stop it, roll back, then restart it. If false, a running guest is refused."),
});

export type SnapshotRollbackInput = z.infer<typeof SnapshotRollbackInputSchema>;

export async function snapshotRollbackHandler(
  input: SnapshotRollbackInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<{ name: string; guestType: GuestType; restarted: boolean }> {
  if (!input.confirm) {
    throw new Error(
      "Refusing snapshot_rollback without confirm: true. Rollback DISCARDS ALL guest state " +
        "(files, processes, data) created since the snapshot was taken. Re-issue with confirm: true to proceed."
    );
  }
  if (!isMcpSnapshot(input.name)) {
    throw new Error(
      `Refusing to roll back to "${input.name}": only server-managed (mcp-*) snapshots may be rolled back. ` +
        "Roll back to a user snapshot manually via the Proxmox UI."
    );
  }

  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const type = await detectGuestType(transport, input.vmid, timeoutMs);

  const state = await guestState(transport, type, input.vmid, timeoutMs);
  const wasRunning = state === "running";
  if (wasRunning && !input.stopIfRunning) {
    throw new Error(
      `Guest ${input.vmid} is running. Rollback requires the guest to be stopped. ` +
        "Re-issue with stopIfRunning: true to stop, roll back, and restart it."
    );
  }

  if (wasRunning) {
    const stopRes = await transport.exec(buildGuestStopCommand(type, input.vmid), timeoutMs);
    if (stopRes.exitCode !== 0) {
      throw new Error(`Failed to stop guest ${input.vmid} (exit ${stopRes.exitCode}): ${stopRes.stderr.trim()}`);
    }
  }

  const rbRes = await transport.exec(buildSnapshotRollbackCommand(type, input.vmid, input.name), timeoutMs);
  if (rbRes.exitCode !== 0) {
    throw new Error(`rollback failed (exit ${rbRes.exitCode}): ${rbRes.stderr.trim()}`);
  }

  if (wasRunning) {
    const startRes = await transport.exec(buildGuestStartCommand(type, input.vmid), timeoutMs);
    if (startRes.exitCode !== 0) {
      throw new Error(
        `Rolled back, but failed to restart guest ${input.vmid} (exit ${startRes.exitCode}): ${startRes.stderr.trim()}`
      );
    }
  }

  // A3.2: for VMs without vmstate, rollback is disk-only — record that.
  const vmstateNote =
    type === "qm" && !cfg.snapshot.vmstate
      ? " VM rollback is disk-only (no RAM state): the guest resumes as if from power loss, not from the moment of the snapshot."
      : "";
  const record = buildAuditRecord({
    tool: "snapshot_rollback",
    host: cfg.ssh.host,
    vmid: input.vmid,
    isLargeChange: true,
    note:
      `Rolled back ${type} ${input.vmid} to snapshot ${input.name}; ` +
      `prior run-state: ${wasRunning ? "running (restarted)" : state || "stopped"}.` +
      vmstateNote,
  });
  await audit.append(record);

  return { name: input.name, guestType: type, restarted: wasRunning };
}

// ---------------------------------------------------------------------------
// snapshot_delete
// ---------------------------------------------------------------------------

export const SnapshotDeleteInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM)"),
  name: z.string().min(1).describe("Snapshot name to delete (must be an mcp-* snapshot)"),
});

export type SnapshotDeleteInput = z.infer<typeof SnapshotDeleteInputSchema>;

export async function snapshotDeleteHandler(
  input: SnapshotDeleteInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config
): Promise<{ name: string; guestType: GuestType }> {
  if (!isMcpSnapshot(input.name)) {
    throw new Error(
      `Refusing to delete "${input.name}": only server-managed (mcp-*) snapshots may be deleted.`
    );
  }
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  const type = await detectGuestType(transport, input.vmid, timeoutMs);

  const res = await transport.exec(buildSnapshotDeleteCommand(type, input.vmid, input.name), timeoutMs);
  if (res.exitCode !== 0) {
    throw new Error(`snapshot delete failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }

  const record = buildAuditRecord({
    tool: "snapshot_delete",
    host: cfg.ssh.host,
    vmid: input.vmid,
    note: `Deleted snapshot ${input.name} (${type})`,
  });
  await audit.append(record);

  return { name: input.name, guestType: type };
}
