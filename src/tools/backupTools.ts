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
import { RollbackBreaker, rollbackTargetKey, breakerRefusal } from "../guardrails/rollbackBreaker.js";
import {
  generateBackupNote,
  isMcpArchive,
  planArchiveEviction,
  planPostCreateEviction,
  checkBackupHeadroom,
  backupFailureHint,
  formatBytes,
  assertStorageName,
  volidStorage,
  type ArchiveInfo,
} from "./backups.js";

/** Injectable sleep so the vzdump task poll is deterministic under test. */
export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ADR-023 #9 / ADR-027 — poll a vzdump task to its terminal state (API path only).
 * Three outcomes, kept distinct: `ok`, `failed` (the task stopped with a non-OK
 * exit status), and `pending` (the wait ran out while the task was still running —
 * an UNKNOWN outcome, not a failure; vzdump carries on without us). A poll that
 * throws (a network blip) is retried until the deadline. The loop is bounded by
 * whole polls (timeout / interval) rather than a wall clock so an injected no-op
 * `sleep` makes the test deterministic.
 */
async function waitForBackupTask(
  node: NodeOps,
  upid: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: Sleep
): Promise<{ state: "ok" | "failed" | "pending"; exitstatus: string }> {
  const interval = Math.max(1, pollIntervalMs);
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / interval));
  let lastError: string | undefined;
  for (let i = 0; i < maxPolls; i++) {
    try {
      const st = await node.taskStatus!(upid);
      if (st.status === "stopped") {
        const exitstatus = st.exitstatus ?? "unknown";
        return { state: exitstatus === "OK" ? "ok" : "failed", exitstatus };
      }
      lastError = undefined;
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (i < maxPolls - 1) await sleep(interval);
  }
  return {
    state: "pending",
    exitstatus: `still running after ${timeoutMs}ms` + (lastError ? ` (last status poll failed: ${lastError})` : ""),
  };
}

async function resolveType(node: NodeOps, vmid: number): Promise<GuestType> {
  const guests = await node.listGuests();
  const g = guests.find((x) => x.vmid === vmid);
  if (!g) throw new Error(`No guest with vmid ${vmid} found on this node.`);
  return g.type;
}

// ---------------------------------------------------------------------------
// guest_backup
// ---------------------------------------------------------------------------

/** Per-call wait ceiling: 6 h. Past that, poll guest_backup_list instead. */
const MAX_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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
  storage: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Node storage to write the archive to — MUST have the `backup` content type. " +
        "Overrides config NODE_BACKUP_STORAGE; the default `local` usually carries " +
        "import/vztmpl/iso (NOT backup), so vzdump fails 'wrong content type' there."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(MAX_BACKUP_TIMEOUT_MS)
    .optional()
    .describe(
      "How long to wait for vzdump (default config BACKUP_TASK_TIMEOUT_MS, 30 min). On the API path, " +
        "outliving it returns status 'pending' — the backup keeps running; it is NOT a failure. Raise it for big guests."
    ),
  evictBeforeCreate: z
    .boolean()
    .default(false)
    .describe(
      "Old, unsafe order: delete the previous mcp- archive BEFORE vzdump runs. Only for a storage that " +
        "cannot hold one extra archive; if vzdump then fails the guest has no mcp- archive at all."
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true. vzdump is heavy and suspend/stop modes interrupt the guest's service."),
});

export type GuestBackupInput = z.infer<typeof GuestBackupInputSchema>;

export interface GuestBackupResult {
  vmid: number;
  guestType: GuestType;
  mode: string;
  note: string;
  task: string;
  storage: string;
  /** "completed": vzdump finished OK. "pending": still running when the wait ended (outcome unknown). */
  status: "completed" | "pending";
  taskStatus: string;
  evicted: string[];
  volid: string | null;
  warnings: string[];
  /** Eviction that would have run on success; held back because the outcome is not known yet. */
  pendingEviction?: string[];
  evictionErrors?: string[];
  nextSteps?: string[];
}

export async function guestBackupHandler(
  input: GuestBackupInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config,
  now: Date = new Date(),
  sleep: Sleep = defaultSleep
): Promise<GuestBackupResult> {
  if (!input.confirm) {
    throw new Error(
      `Refusing guest_backup on ${input.vmid} without confirm: true. vzdump is a heavy, ` +
        "minutes-scale operation, and suspend/stop modes interrupt the guest. Re-issue with confirm: true."
    );
  }
  const storage = input.storage ?? cfg.backup.nodeBackupStorage;
  assertStorageName(storage);
  const type = await resolveType(node, input.vmid);
  const cap = cfg.backup.guestArchivePerGuestCap;
  const timeoutMs = input.timeoutMs ?? cfg.backup.taskTimeoutMs;
  const warnings: string[] = [];
  const evicted: string[] = [];
  const evictionErrors: string[] = [];

  const toInfo = (list: Awaited<ReturnType<NodeOps["listBackupArchives"]>>): ArchiveInfo[] =>
    list.map((a) => ({ ...a, mcpManaged: isMcpArchive(a.notes) }));
  const evict = async (volids: string[]): Promise<void> => {
    for (const volid of volids) {
      try {
        await node.deleteBackupArchive(storage, volid);
        evicted.push(volid);
      } catch (err) {
        evictionErrors.push(`${volid}: ${(err as Error).message}`);
      }
    }
  };

  // ADR-027 — retention runs AFTER the new archive is confirmed (ops finding
  // 2026-10-17: evicting first left CT 101 with no mcp- archive for the 14 minutes
  // vzdump ran). That briefly holds cap+1 archives, so check the storage has room
  // for one more; a storage that cannot is refused here, before anything changes,
  // unless the caller deliberately opts into the old order.
  const before = toInfo(await node.listBackupArchives(storage, input.vmid));
  const plannedIfFull = planArchiveEviction(before, cap);
  if (input.evictBeforeCreate) {
    await evict(planArchiveEviction(before, cap));
    if (evictionErrors.length > 0) {
      throw new Error(`guest_backup of ${input.vmid}: pre-create eviction failed (${evictionErrors.join("; ")}); nothing was created.`);
    }
    warnings.push("evictBeforeCreate: the previous mcp- archive was deleted before vzdump ran.");
  } else if (plannedIfFull.length > 0) {
    let avail: number | undefined;
    try {
      avail = (await node.storageStatus()).find((s) => s.storage === storage)?.availBytes;
    } catch {
      avail = undefined;
    }
    const room = checkBackupHeadroom(before, avail);
    if (room.verdict === "insufficient") {
      throw new Error(
        `Refusing guest_backup of ${input.vmid}: storage "${storage}" has ${formatBytes(room.availBytes!)} free, but the ` +
          `last archive of this guest was ${formatBytes(room.estimateBytes!)}. The new archive is written BEFORE the old ` +
          `mcp- archive (${plannedIfFull.join(", ")}) is evicted, so the storage must hold one extra archive. Free space ` +
          "on the storage, pick another storage, or re-issue with evictBeforeCreate: true (no rollback point while vzdump runs). " +
          "Nothing was deleted or created."
      );
    }
    if (room.verdict === "unknown") {
      warnings.push(
        `Could not confirm "${storage}" has room for one extra archive (no size estimate or storage figure); ` +
          "the old mcp- archive is evicted only after the new one succeeds."
      );
    }
  }

  const note = generateBackupNote(now, input.note);
  const auditBase = { tool: "guest_backup" as const, host: cfg.ssh.host, vmid: input.vmid };
  const what = `vzdump (${input.mode}) of ${type} ${input.vmid} to ${storage}`;

  let ref: { upid: string };
  try {
    ref = await node.createBackup(input.vmid, type, { mode: input.mode, storage, notes: note, timeoutMs });
  } catch (err) {
    // SSH path: vzdump blocks and throws on a non-zero exit (including a node-side
    // `timeout` kill, which really does stop vzdump). Nothing is evicted.
    const msg = (err as Error).message;
    await audit.append(buildAuditRecord({ ...auditBase, isLargeChange: false, failed: true, note: `${what} FAILED: ${msg}` }));
    const hint = backupFailureHint(msg, storage);
    throw new Error(`guest_backup of ${input.vmid} failed: ${msg}.${hint ? ` ${hint}` : ""} No archive was evicted.`);
  }

  // ADR-023 #9 — the API path returns a UPID before vzdump finishes, so a task
  // that fails async would read as success. Poll it. The SSH backend blocks and
  // throws on failure, and may omit `taskStatus`, in which case the poll is skipped.
  let taskStatus = "OK";
  if (node.kind === "api" && typeof node.taskStatus === "function") {
    const outcome = await waitForBackupTask(node, ref.upid, timeoutMs, cfg.backup.taskPollIntervalMs, sleep);
    if (outcome.state === "failed") {
      await audit.append(
        buildAuditRecord({ ...auditBase, isLargeChange: false, failed: true, note: `${what} FAILED: ${outcome.exitstatus}; UPID ${ref.upid}` })
      );
      const hint = backupFailureHint(outcome.exitstatus, storage);
      throw new Error(`guest_backup of ${input.vmid} failed: ${outcome.exitstatus}.${hint ? ` ${hint}` : ""} No archive was evicted.`);
    }
    if (outcome.state === "pending") {
      // ADR-027 — a timeout is not a failure. Evict nothing (the outcome is not
      // known), audit it as pending, and tell the caller how to find out.
      await audit.append(
        buildAuditRecord({
          ...auditBase,
          isLargeChange: true,
          pending: true,
          note: `${what} PENDING: ${outcome.exitstatus}; UPID ${ref.upid}; note "${note}"; retention deferred`,
        })
      );
      return {
        vmid: input.vmid,
        guestType: type,
        mode: input.mode,
        note,
        task: ref.upid,
        storage,
        status: "pending",
        taskStatus: outcome.exitstatus,
        evicted,
        volid: null,
        warnings,
        ...(plannedIfFull.length > 0 && !input.evictBeforeCreate && { pendingEviction: plannedIfFull }),
        nextSteps: [
          `vzdump is still running on the node (UPID ${ref.upid}); this is not a failure.`,
          `guest_backup_list { vmid: ${input.vmid}, storage: "${storage}" } shows the archive with note "${note}" once it finishes.`,
          `While it runs the guest carries a backup lock (describe_guest / \`pct config ${input.vmid}\` shows "lock: backup").`,
          "Retention was deferred: the extra mcp- archive is evicted by the next successful guest_backup of this guest.",
          `Next time pass timeoutMs (e.g. ${Math.min(MAX_BACKUP_TIMEOUT_MS, timeoutMs * 2)}) to wait it out.`,
        ],
      };
    }
    taskStatus = outcome.exitstatus;
  }

  // H9/F9 — resolve the created archive's VOLID. vzdump names the file in the
  // node's LOCAL timezone, so re-list and match our exact (second-precision,
  // unique) note. ADR-027: retention needs this — an unresolved volid means the
  // new archive is not confirmed, so nothing is evicted.
  let volid: string | null = null;
  let after: ArchiveInfo[] = [];
  try {
    after = toInfo(await node.listBackupArchives(storage, input.vmid));
    const mine = after
      .filter((a) => a.notes !== undefined && a.notes.trim() === note)
      .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
    volid = mine[0]?.volid ?? null;
  } catch {
    /* volid stays null */
  }

  if (volid !== null) {
    await evict(planPostCreateEviction(after, volid, cap));
  } else if (!input.evictBeforeCreate && plannedIfFull.length > 0) {
    warnings.push(
      `Could not find the new archive (note "${note}") in the "${storage}" listing, so retention was skipped: ` +
        "the old mcp- archive is kept. guest_backup_list shows both."
    );
  }

  await audit.append(
    buildAuditRecord({
      ...auditBase,
      isLargeChange: true,
      note:
        `${what} via ${node.kind}; note "${note}"` +
        (volid ? `; volid ${volid}` : "") +
        (evicted.length ? `; evicted ${evicted.join(", ")}` : "") +
        (evictionErrors.length ? `; eviction failed for ${evictionErrors.join("; ")}` : ""),
    })
  );

  return {
    vmid: input.vmid,
    guestType: type,
    mode: input.mode,
    note,
    task: ref.upid,
    storage,
    status: "completed",
    taskStatus,
    evicted,
    volid,
    warnings,
    ...(evictionErrors.length > 0 && { evictionErrors }),
  };
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
  overrideCircuitBreaker: z
    .boolean()
    .optional()
    .describe(
      "ADR-021: bypass the rollback circuit breaker for this one call (a deliberate, audited act, distinct from confirm)."
    ),
});

export type GuestBackupRestoreInput = z.infer<typeof GuestBackupRestoreInputSchema>;

export async function guestBackupRestoreHandler(
  input: GuestBackupRestoreInput,
  node: NodeOps,
  audit: AuditLog,
  cfg: Config,
  breaker?: RollbackBreaker
): Promise<{ vmid: number; guestType: GuestType; archive: string; restarted: boolean }> {
  if (!input.confirm) {
    throw new Error(
      "Refusing guest_backup_restore without confirm: true. A restore REPLACES THE ENTIRE GUEST " +
        "(disk, config) with the archive's contents — everything since the archive is lost. Re-issue with confirm: true."
    );
  }

  // ADR-021 — rollback circuit breaker, keyed on the guest. The heaviest rollback
  // verb, so a loop here is the costliest; refuse (audited) past the window limit
  // unless the caller deliberately overrides.
  const breakerKey = rollbackTargetKey({ kind: "guest", vmid: input.vmid });
  if (breaker && !input.overrideCircuitBreaker) {
    const verdict = breaker.check(breakerKey, Date.now());
    if (verdict.tripped) {
      const { message, circuitBreaker } = breakerRefusal(breakerKey, verdict);
      await audit.append(
        buildAuditRecord({
          tool: "guest_backup_restore",
          host: cfg.ssh.host,
          vmid: input.vmid,
          refused: true,
          circuitBreaker,
          note: message,
        })
      );
      throw new Error(message);
    }
  }

  // H3/F8 — search the storage NAMED BY THE VOLID, not the config default. The
  // archive volid (`<storage>:backup/<file>`) already encodes where it lives; an
  // archive `guest_backup` wrote to a backup-content store (e.g. media-backup) was
  // unfindable when restore hardcoded `cfg.backup.nodeBackupStorage` ("local").
  const storage = volidStorage(input.archive);
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
      ...(input.overrideCircuitBreaker && { circuitBreakerOverridden: true }),
      note:
        `Restored ${type} ${input.vmid} from ${input.archive} via ${node.kind}; ` +
        `prior run-state: ${wasRunning ? "running (restarted)" : "stopped"}.`,
    })
  );

  return { vmid: input.vmid, guestType: type, archive: input.archive, restarted: wasRunning };
}

// ---------------------------------------------------------------------------
// guest_backup_list (H9/F9 — the missing inventory verb)
// ---------------------------------------------------------------------------

export const GuestBackupListInputSchema = z.object({
  vmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Filter archives to one guest. Omit to list every guest's archives on the storage."),
  storage: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Node storage to list (must carry the `backup` content type). Defaults to NODE_BACKUP_STORAGE; " +
        "pass the storage you backed up to (e.g. the one guest_backup returned in its volid)."
    ),
  includeForeign: z
    .boolean()
    .default(false)
    .describe("Also list human-made (non-mcp-) archives. Default false — only server-managed mcp- archives."),
});

export type GuestBackupListInput = z.infer<typeof GuestBackupListInputSchema>;

export interface ListedArchive {
  volid: string;
  vmid: number;
  ctime?: number;
  sizeBytes?: number;
  notes?: string;
  mcpManaged: boolean;
}

/**
 * `guest_backup_list` (H9/F9) — read-only inventory of vzdump archives, the verb
 * the third dogfooding pass found missing: `guest_backup` returned a UPID + note
 * but no volid, and there was no way to recover the volid to feed `guest_backup_restore`
 * (the filename is in node-local time, so it isn't reconstructable from the UTC note).
 * Lists a storage's archives (optionally for one guest), newest-first, flagging which
 * are server-managed (`mcp-`). Defaults to mcp- only — `includeForeign` shows human
 * archives too (which restore still refuses). Read-only, not audited.
 */
export async function guestBackupListHandler(
  input: GuestBackupListInput,
  node: NodeOps,
  cfg: Config
): Promise<{ storage: string; vmid?: number; archives: ListedArchive[] }> {
  const storage = input.storage ?? cfg.backup.nodeBackupStorage;
  assertStorageName(storage);
  const raw = await node.listBackupArchives(storage, input.vmid);
  const archives: ListedArchive[] = raw
    .map((a) => ({
      volid: a.volid,
      vmid: a.vmid,
      ctime: a.ctime,
      sizeBytes: a.sizeBytes,
      notes: a.notes,
      mcpManaged: isMcpArchive(a.notes),
    }))
    .filter((a) => input.includeForeign || a.mcpManaged)
    .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
  return { storage, vmid: input.vmid, archives };
}
