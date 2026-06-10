import crypto from "crypto";
import { randomUUID } from "crypto";
import { redactSecrets } from "./redact.js";

export type AuditTool =
  | "execute"
  | "read_file"
  | "write_file"
  | "list_directory"
  | "pct_exec"
  | "pct_list"
  | "revert_file"
  | "pct_read_file"
  | "pct_write_file"
  | "snapshot_create"
  | "snapshot_list"
  | "snapshot_rollback"
  | "snapshot_delete"
  | "qm_exec"
  | "qm_read_file"
  | "qm_write_file";

export interface AuditRecord {
  id: string;
  ts: string;
  tool: AuditTool;
  host?: string;
  vmid?: number;
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
  isLargeChange?: boolean;
  isRevertible?: boolean;
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
