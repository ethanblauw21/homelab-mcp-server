export interface ExecResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit code, or `null` when the command was terminated by a signal.
   * Never coerced to 0 — a signal-killed command must not report success
   * (ADR-004 §3).
   */
  exitCode: number | null;
  /** Signal name (e.g. "SIGTERM") when ssh2 reports a signal termination. */
  signal?: string;
  /** True when the node-enforced `timeout` wrapper killed the command (exit 124). */
  timedOut?: boolean;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: Date;
  permissions: string;
}

export interface FileStat {
  size: number;
}

/** Optional byte window for a partial read (ADR-004 §4 `offset`/`maxBytes`). */
export interface ReadFileOptions {
  start?: number;
  length?: number;
}

export interface SshTransport {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  stat(remotePath: string): Promise<FileStat>;
  readFile(remotePath: string, opts?: ReadFileOptions): Promise<Buffer>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  list(remotePath: string): Promise<FileEntry[]>;
  close(): Promise<void>;
}
