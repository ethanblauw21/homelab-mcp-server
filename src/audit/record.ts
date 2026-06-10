import crypto from "crypto";
import { randomUUID } from "crypto";

export type AuditTool =
  | "execute"
  | "read_file"
  | "write_file"
  | "list_directory"
  | "pct_exec"
  | "pct_list"
  | "revert_file";

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
  exitCode?: number;
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
  };
}

export function serializeRecord(record: AuditRecord): string {
  return JSON.stringify(record) + "\n";
}
