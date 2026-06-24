import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";
import { buildAuditRecord } from "../audit/record.js";
import { RollbackBreaker, rollbackTargetKey, breakerRefusal } from "../guardrails/rollbackBreaker.js";
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
  buildGuestConfigCommand,
  enrichSnapshotFailure,
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

/** Real-clock sleep; injected as a no-op in unit tests so polls don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ADR-023 B5 — poll `status` until the guest is running or the bounded deadline,
 * returning the last observed state. Used after a post-rollback restart instead of
 * trusting the start command's exit code: an SSH-routed `pct/qm start` can return
 * `exitCode: null` (the wait times out) even though the guest comes up cleanly, and
 * the old code mis-reported that as a restart failure. Run-state is the ground truth.
 * The first probe happens immediately (a fast restart returns with zero sleeps);
 * `waited` accrues by `pollIntervalMs` so no wall-clock dependency is needed.
 */
async function waitForGuestRunning(
  transport: SshTransport,
  type: GuestType,
  vmid: number,
  timeoutMs: number,
  pollIntervalMs: number,
  maxWaitMs: number,
  sleep: Sleep
): Promise<string> {
  let state = await guestState(transport, type, vmid, timeoutMs);
  let waited = 0;
  while (state !== "running" && waited < maxWaitMs) {
    await sleep(pollIntervalMs);
    waited += pollIntervalMs;
    state = await guestState(transport, type, vmid, timeoutMs);
  }
  return state;
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
  // #15 — a "snapshot feature is not available" failure is structural (device
  // passthrough, a bind mount, dir-typed storage). Fetch the guest config and
  // enrich the error with the likely cause + the vzdump (guest_backup) fallback,
  // instead of surfacing an opaque CLI message. The diagnostic fetch is
  // best-effort: a failed config read degrades to the plain (un-diagnosed) hint.
  if (createRes.exitCode !== 0) {
    let configText: string | null = null;
    try {
      const cfgRes = await transport.exec(buildGuestConfigCommand(type, input.vmid), timeoutMs);
      if (cfgRes.exitCode === 0) configText = cfgRes.stdout;
    } catch {
      /* diagnosis is best-effort; fall through with configText = null */
    }
    throw new Error(enrichSnapshotFailure(createRes.stderr, type, input.vmid, configText));
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
  overrideCircuitBreaker: z
    .boolean()
    .optional()
    .describe(
      "ADR-021: bypass the rollback circuit breaker for this one call (a deliberate, audited act, distinct from confirm)."
    ),
});

export type SnapshotRollbackInput = z.infer<typeof SnapshotRollbackInputSchema>;

export async function snapshotRollbackHandler(
  input: SnapshotRollbackInput,
  transport: SshTransport,
  audit: AuditLog,
  cfg: Config,
  breaker?: RollbackBreaker,
  sleep: Sleep = defaultSleep
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

  // ADR-021 — rollback circuit breaker, keyed on the guest. Refuse (audited) a
  // thrash loop of rollbacks against one guest unless deliberately overridden.
  const breakerKey = rollbackTargetKey({ kind: "guest", vmid: input.vmid });
  if (breaker && !input.overrideCircuitBreaker) {
    const verdict = breaker.check(breakerKey, Date.now());
    if (verdict.tripped) {
      const { message, circuitBreaker } = breakerRefusal(breakerKey, verdict);
      await audit.append(
        buildAuditRecord({
          tool: "snapshot_rollback",
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
    // ADR-023 B5 — issue the start, then VERIFY by polling run-state rather than
    // trusting startRes.exitCode. An SSH-routed start frequently returns
    // exitCode:null (the node-side wait times out) while the guest comes up fine;
    // the old code reported that as a false "failed to restart". Only the guest's
    // own status is ground truth — fail only if it is genuinely still not running.
    await transport.exec(buildGuestStartCommand(type, input.vmid), timeoutMs);
    const finalState = await waitForGuestRunning(
      transport,
      type,
      input.vmid,
      timeoutMs,
      cfg.snapshot.restartPollIntervalMs ?? 2_000,
      cfg.snapshot.restartTimeoutMs ?? 60_000,
      sleep
    );
    if (finalState !== "running") {
      throw new Error(
        `Rolled back ${type} ${input.vmid}, but it did not return to running within ` +
          `${cfg.snapshot.restartTimeoutMs ?? 60_000}ms (current state: ${finalState || "unknown"}). ` +
          "The rollback itself succeeded; start the guest manually or investigate."
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
    ...(input.overrideCircuitBreaker && { circuitBreakerOverridden: true }),
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
