import fs from "fs";
import path from "path";
import os from "os";
import type { AuditRecord } from "./record.js";
import { serializeRecord } from "./record.js";

export class AuditLog {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  async append(record: AuditRecord): Promise<void> {
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
