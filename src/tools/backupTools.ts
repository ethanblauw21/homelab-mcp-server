/**
 * Outcome-level rollback tools (ADR-008 §6) — `guest_backup` / `guest_backup_restore`.
 *
 * These are the rollback path for guests that **cannot snapshot** (device
 * passthrough / dir storage — see the census `snapshotCapable` heuristic). They
 * wrap vzdump, which works with passthrough (suspend/stop modes). ADR-003 rejected
 * vzdump *as the snapshot mechanism* (minutes-scale, heavy); as the fallback where
 * snapshots are impossible it is exactly right, and that distinction is recorded.
 *
 * **Tier (snapshot-tier unification, ADR-008 §6 resolution):** companion, NOT
 * operate. Although vzdump is API-expressible (and rides the API backend when
 * configured — "SSH-CLI + API both"), the guardrails that make these safe — the
 * `mcp-` archive-ownership boundary, per-guest retention eviction, and the confirm
 * gate — are **MCP-server tripwires with no Proxmox-RBAC equivalent**. Placing a
 * destructive whole-guest restore at operate would put it behind RBAC that is blind
 * to the `mcp-` tag, splitting the guardrail story. Unifying every service-affecting
 * guest verb (snapshot_*, guest_backup*, compose_redeploy) at companion/MCP keeps
 * ONE enforcement story. The transport still follows the tool (API where it can,
 * SSH otherwise); only the tier floor is fixed at companion.
 */
import { z } from "zod";
import type { NodeOps, GuestType } from "../node/nodeOps.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { generateBackupNote, isMcpArchive, planArchiveEviction, type ArchiveInfo } from "./backups.js";

async function resolveType(node: NodeOps, vmid: number): Promise<GuestType> {
  const guests = await node.listGuests();
  const g = guests.find((x) => x.vmid === vmid);
  if (!g) throw new Error(`No guest with vmid ${vmid} found on this node.`);
  return g.type;
}

// ---------------------------------------------------------------------------
// guest_backup
// ---------------------------------------------------------------------------

export const GuestBackupInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID (LXC container or VM) to back up"),
  mode: z
    .enum(["snapshot", "suspend", "stop"])
    .default("snapshot")
    .describe(
      "vzdump mode. 'snapshot' is least disruptive but needs snapshot-capable storage; " +
        "'suspend'/'stop' are the fallback for snapshot-incapable guests (they interrupt service)."
    ),
  note: z.string().optional().describe("Optional human note appended to the mcp- archive notes"),
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true. vzdump is heavy and suspend/stop modes interrupt the guest's service."),
});

export type GuestBackupInput = z.infer<typeof GuestBackupInputSchema>;

export async function guestBackupHandler(
  input: GuestBackupInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config,
  now: Date = new Date()
): Promise<{ vmid: number; guestType: GuestType; mode: string; note: string; task: string; evicted: string[] }> {
  if (!input.confirm) {
    throw new Error(
      `Refusing guest_backup on ${input.vmid} without confirm: true. vzdump is a heavy, ` +
        "minutes-scale operation, and suspend/stop modes interrupt the guest. Re-issue with confirm: true."
    );
  }
  const storage = cfg.backup.nodeBackupStorage;
  const type = await resolveType(node, input.vmid);

  // Retention BEFORE create: evict oldest mcp- archives so the post-create count
  // stays within cap. Human-made archives (no mcp- note) are never touched.
  const existing = await node.listBackupArchives(storage, input.vmid);
  const archives: ArchiveInfo[] = existing.map((a) => ({ ...a, mcpManaged: isMcpArchive(a.notes) }));
  const evicted: string[] = [];
  for (const volid of planArchiveEviction(archives, cfg.backup.guestArchivePerGuestCap)) {
    await node.deleteBackupArchive(storage, volid);
    evicted.push(volid);
  }

  const note = generateBackupNote(now, input.note);
  const ref = await node.createBackup(input.vmid, type, { mode: input.mode, storage, notes: note });

  await audit.append(
    buildAuditRecord({
      tool: "guest_backup",
      host: cfg.ssh.host,
      vmid: input.vmid,
      isLargeChange: true,
      note:
        `vzdump (${input.mode}) of ${type} ${input.vmid} to ${storage} via ${node.kind}; note "${note}"` +
        (evicted.length ? `; evicted ${evicted.join(", ")}` : ""),
    })
  );

  return { vmid: input.vmid, guestType: type, mode: input.mode, note, task: ref.upid, evicted };
}

// ---------------------------------------------------------------------------
// guest_backup_restore (the heaviest hammer — confirm + mcp- + run-state gated)
// ---------------------------------------------------------------------------

export const GuestBackupRestoreInputSchema = z.object({
  vmid: z.number().int().positive().describe("Guest ID to restore (will be OVERWRITTEN from the archive)"),
  archive: z.string().min(1).describe("Archive volid to restore (must be a server-managed mcp- archive)"),
  confirm: z.boolean().describe("Must be true. Restore REPLACES the entire guest from the archive."),
  stopIfRunning: z
    .boolean()
    .default(false)
    .describe("If the guest is running, stop it, restore, then restart it. If false, a running guest is refused."),
});

export type GuestBackupRestoreInput = z.infer<typeof GuestBackupRestoreInputSchema>;

export async function guestBackupRestoreHandler(
  input: GuestBackupRestoreInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config
): Promise<{ vmid: number; guestType: GuestType; archive: string; restarted: boolean }> {
  if (!input.confirm) {
    throw new Error(
      "Refusing guest_backup_restore without confirm: true. A restore REPLACES THE ENTIRE GUEST " +
        "(disk, config) with the archive's contents — everything since the archive is lost. Re-issue with confirm: true."
    );
  }
  const storage = cfg.backup.nodeBackupStorage;
  const type = await resolveType(node, input.vmid);

  // Ownership boundary (mirrors snapshot_rollback): only mcp- archives are
  // restorable, and the archive must actually exist for this vmid.
  const archives = await node.listBackupArchives(storage, input.vmid);
  const target = archives.find((a) => a.volid === input.archive);
  if (!target) {
    throw new Error(
      `Archive ${JSON.stringify(input.archive)} not found for guest ${input.vmid} on ${storage}.`
    );
  }
  if (!isMcpArchive(target.notes)) {
    throw new Error(
      `Refusing to restore from ${JSON.stringify(input.archive)}: only server-managed (mcp-) archives may be ` +
        "restored. Restore a human-made archive manually via the Proxmox UI."
    );
  }

  const wasRunning = (await node.guestStatus(input.vmid, type)).status === "running";
  if (wasRunning && !input.stopIfRunning) {
    throw new Error(
      `Guest ${input.vmid} is running. Restore requires it stopped. ` +
        "Re-issue with stopIfRunning: true to stop, restore, and restart it."
    );
  }
  if (wasRunning) {
    await node.stopGuest(input.vmid, type);
  }

  await node.restoreBackup(input.vmid, type, input.archive);

  if (wasRunning) {
    await node.startGuest(input.vmid, type);
  }

  await audit.append(
    buildAuditRecord({
      tool: "guest_backup_restore",
      host: cfg.ssh.host,
      vmid: input.vmid,
      isLargeChange: true,
      note:
        `Restored ${type} ${input.vmid} from ${input.archive} via ${node.kind}; ` +
        `prior run-state: ${wasRunning ? "running (restarted)" : "stopped"}.`,
    })
  );

  return { vmid: input.vmid, guestType: type, archive: input.archive, restarted: wasRunning };
}
