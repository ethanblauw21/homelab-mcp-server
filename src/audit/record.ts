import crypto from "crypto";
import { randomUUID } from "crypto";
import { redactSecrets } from "./redact.js";

export type AuditTool =
  | "execute"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_directory"
  | "pct_exec"
  | "pct_list"
  | "revert_file"
  | "pct_read_file"
  | "pct_write_file"
  | "pct_edit_file"
  | "snapshot_create"
  | "snapshot_list"
  | "snapshot_rollback"
  | "snapshot_delete"
  | "qm_exec"
  | "qm_read_file"
  | "qm_write_file"
  | "qm_edit_file"
  | "docker_exec"
  | "docker_read_file"
  | "docker_write_file"
  | "docker_edit_file"
  | "config_sweep"
  | "guest_start"
  | "guest_stop"
  | "guest_restart"
  | "guest_backup"
  | "guest_backup_restore"
  | "compose_redeploy"
  | "compute_tree"
  | "verify_integrity"
  | "accept_truth";

export interface AuditRecord {
  id: string;
  ts: string;
  tool: AuditTool;
  host?: string;
  vmid?: number;
  // ADR-008 — Docker tools record the container *name* (the stable identity used
  // for the backup descriptor) and the container *id* at time-of-write (for
  // forensics: names survive recreation, ids do not).
  container?: string;
  containerId?: string;
  path?: string;
  prevBackup?: string;
  prevSha256?: string;
  newSha256?: string;
  bytes?: number;
  cmd?: string;
  // null when the command was signal-terminated; never coerced to 0 (ADR-004 §3).
  exitCode?: number | null;
  signal?: string;
  timedOut?: boolean;
  // Node-side `timeout` wrapper seconds; `cmd` records the *original* command,
  // this records the wrapper parameter (ADR-004 Compatibility note).
  timeoutSecs?: number;
  // Set when a CONFIRM-tier command ran because the caller passed confirm:true.
  confirmGated?: boolean;
  // ADR-007 §4 — set on every record produced by a root-tier tool while the root
  // acknowledgment flag is enabled, making root-tier operation attributable.
  rootTier?: boolean;
  isLargeChange?: boolean;
  // ADR-008 §4 — heavy-pattern annotation for exec tools (curl/wget/tar/rsync/…).
  // Distinct from isLargeChange (large *file writes*): a heavy command is worth
  // noting but is NOT a large change and NEVER gates. Separating the two keeps the
  // `largeOnly` audit query meaningful (it surfaces large writes, not network ops).
  isHeavy?: boolean;
  isRevertible?: boolean;
  // ADR-006 — whether the config-history mirror captured this change. Best-effort:
  // false means git was absent/failed (the write itself still succeeded), the
  // mutation target has no mirror layout (qm), or the subsystem is disabled.
  historyCommitted?: boolean;
  // ADR-009 — hash-anchored audit. The write family populates beforeHash/afterHash
  // with the L3 subtree hash of `hashScope` before and after the op, enabling the
  // structure↔cause pivot (find the tool call whose afterHash produced a drifted
  // leaf). Exec tools (execute/pct_exec/qm_exec/docker_exec) take an OPTIONAL scope:
  // with one they hash before/after; without one they record hashScope:"unknown"
  // (a queryable marker, not prose) and skip hashing — the next verify_integrity
  // catches any change as drift anyway.
  beforeHash?: string;
  afterHash?: string;
  hashScope?: string;
  note?: string;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function buildAuditRecord(fields: Omit<AuditRecord, "id" | "ts">): AuditRecord {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...fields,
    ...(fields.cmd !== undefined && { cmd: redactSecrets(fields.cmd) }),
    ...(fields.note !== undefined && { note: redactSecrets(fields.note) }),
  };
}

export function serializeRecord(record: AuditRecord): string {
  return JSON.stringify(record) + "\n";
}
