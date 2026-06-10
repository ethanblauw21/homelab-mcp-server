import type {
  ExecResult,
  FileEntry,
  FileStat,
  ReadFileOptions,
  SshTransport,
} from "./transport.js";

export interface FakeTransportOptions {
  execResults?: Map<string, ExecResult>;
  files?: Map<string, Buffer>;
  directories?: Map<string, FileEntry[]>;
  execDelay?: number;
}

export class FakeTransport implements SshTransport {
  private files: Map<string, Buffer>;
  private directories: Map<string, FileEntry[]>;
  private execResults: Map<string, ExecResult>;
  private execDelay: number;
  closed = false;

  constructor(opts: FakeTransportOptions = {}) {
    this.files = opts.files ?? new Map();
    this.directories = opts.directories ?? new Map();
    this.execResults = opts.execResults ?? new Map();
    this.execDelay = opts.execDelay ?? 0;
  }

  async exec(command: string, _timeoutMs?: number): Promise<ExecResult> {
    if (this.execDelay > 0) {
      await new Promise((r) => setTimeout(r, this.execDelay));
    }
    return this.execResults.get(command) ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  async stat(remotePath: string): Promise<FileStat> {
    const content = this.files.get(remotePath);
    if (!content) throw new Error(`File not found: ${remotePath}`);
    return { size: content.length };
  }

  async readFile(remotePath: string, opts?: ReadFileOptions): Promise<Buffer> {
    const content = this.files.get(remotePath);
    if (!content) throw new Error(`File not found: ${remotePath}`);
    if (opts?.start !== undefined || opts?.length !== undefined) {
      const start = opts.start ?? 0;
      const end = opts.length !== undefined ? start + opts.length : content.length;
      return content.subarray(start, end);
    }
    return content;
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    this.files.set(remotePath, content);
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const entries = this.directories.get(remotePath);
    if (!entries) throw new Error(`Directory not found: ${remotePath}`);
    return entries;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  setFile(path: string, content: string | Buffer): void {
    this.files.set(path, typeof content === "string" ? Buffer.from(content) : content);
  }

  setExecResult(command: string, result: ExecResult): void {
    this.execResults.set(command, result);
  }
}
