import fs from "fs";
import path from "path";
import os from "os";
import type { AuditRecord } from "./record.js";
import { serializeRecord } from "./record.js";

/**
 * A best-effort sink that mirrors each appended record into a derived store
 * (ADR-022: the `audit.db` projection). `extras` carries data NOT serialized to
 * the JSONL system of record — notably the redacted diff-on-write output, which
 * lives only in the projection. Implemented by `AuditDb`.
 */
export interface AuditProjector {
  project(record: AuditRecord, extras?: { diff?: string | null }): void;
}

export class AuditLog {
  private readonly logPath: string;
  private projector?: AuditProjector;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  /**
   * Attach a derived-store projector (ADR-022). Wired in `index.ts` next to the
   * append, mirroring how `healthSink`/`driftSink` (ADR-010) persist alongside
   * the agent path — handlers never import the DB layer.
   */
  setProjector(projector: AuditProjector): void {
    this.projector = projector;
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  /**
   * Append to the JSONL system of record, then mirror into the projection (if
   * attached). `extras` (e.g. the redacted diff) reaches ONLY the projector — it
   * is never serialized to the JSONL, preserving ADR-004's plain-text trail. The
   * projector is best-effort and fail-soft: a derived-store error is logged to
   * stderr and swallowed, NEVER failing the audit append (the JSONL already
   * succeeded — same doctrine as ADR-006's `historyCommitted`).
   */
  async append(record: AuditRecord, extras?: { diff?: string | null }): Promise<void> {
    this.ensureDir();
    const line = serializeRecord(record);
    // Atomic append: write to a temp file, then rename-append via O_APPEND flag.
    // O_APPEND is atomic at the kernel level for small writes on Linux.
    const fd = fs.openSync(this.logPath, "a");
    try {
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
    if (this.projector) {
      try {
        this.projector.project(record, extras);
      } catch (err) {
        process.stderr.write(
          `[audit.db] projection failed for ${record.id}: ${(err as Error).message}\n`
        );
      }
    }
  }

  readAll(): AuditRecord[] {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs.readFileSync(this.logPath, "utf8").split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l) as AuditRecord);
  }

  // For tests: write to a temp path then atomically move to final location
  static async appendAtomic(logPath: string, record: AuditRecord): Promise<void> {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const tmp = path.join(os.tmpdir(), `audit-${record.id}.jsonl`);
    fs.writeFileSync(tmp, serializeRecord(record));
    // O_APPEND for the final write
    const fd = fs.openSync(logPath, "a");
    try {
      fs.writeSync(fd, fs.readFileSync(tmp));
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(tmp);
    }
  }
}
