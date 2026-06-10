export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: Date;
  permissions: string;
}

export interface SshTransport {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  readFile(remotePath: string): Promise<Buffer>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  list(remotePath: string): Promise<FileEntry[]>;
  close(): Promise<void>;
}
