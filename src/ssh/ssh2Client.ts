import { Client, SFTPWrapper } from "ssh2";
import { readFileSync } from "fs";
import type { ExecResult, FileEntry, SshTransport } from "./transport.js";
import type { Config } from "../config.js";
import { computeFingerprint, decideHostKey, KnownHostsStore } from "./hostKey.js";

export class Ssh2Transport implements SshTransport {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  // Single in-flight connect promise so concurrent callers all wait on the same attempt
  private connectingPromise: Promise<void> | null = null;
  private readonly cfg: Config["ssh"];
  private readonly knownHosts: KnownHostsStore;

  constructor(cfg: Config["ssh"]) {
    this.cfg = cfg;
    this.knownHosts = new KnownHostsStore(cfg.knownHostsPath);
  }

  /**
   * Build the ssh2 hostVerifier. Always supplied (fail-closed by default).
   * Note: all diagnostics go to STDERR — stdout is the MCP stdio channel.
   */
  private makeHostVerifier(): (key: Buffer) => boolean {
    const hostPort = `${this.cfg.host}:${this.cfg.port}`;
    return (key: Buffer): boolean => {
      if (this.cfg.skipHostVerification) {
        console.error(
          `[ssh] WARNING: host key verification SKIPPED for ${hostPort} (skipHostVerification=true)`
        );
        return true;
      }
      const presented = computeFingerprint(key);
      const decision = decideHostKey({
        presented,
        pinned: this.cfg.hostKeyFingerprint,
        stored: this.knownHosts.get(hostPort),
        hostPort,
      });
      if (decision.accept) {
        if (decision.persist) {
          this.knownHosts.set(decision.persist.hostPort, decision.persist.fingerprint);
          console.error(
            `[ssh] WARNING: ${hostPort} host key pinned on first use: ${presented}. ` +
              `Verify this out of band (e.g. \`ssh-keyscan -t ed25519 ${this.cfg.host} | ssh-keygen -lf -\`).`
          );
        }
        return true;
      }
      console.error(`[ssh] host key verification FAILED for ${hostPort}:\n${decision.reason}`);
      return false;
    };
  }

  private connect(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise((resolve, reject) => {
      const client = new Client();
      client.on("ready", () => {
        this.client = client;
        this.connectingPromise = null;
        resolve();
      });
      client.on("error", (err) => {
        this.connectingPromise = null;
        reject(err);
      });
      client.on("close", () => {
        this.client = null;
        this.sftp = null;
      });

      const connectCfg: Parameters<Client["connect"]>[0] = {
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        privateKey: readFileSync(this.cfg.privateKeyPath),
        keepaliveInterval: this.cfg.keepaliveInterval,
        // Always verify (fail-closed) unless explicitly skipped; see makeHostVerifier.
        hostVerifier: this.makeHostVerifier(),
      };
      client.connect(connectCfg);
    });

    return this.connectingPromise;
  }

  private async ensureConnected(): Promise<Client> {
    await this.connect();
    return this.client!;
  }

  private async getSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp;
    const client = await this.ensureConnected();
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        this.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    const client = await this.ensureConnected();
    const timeout = timeoutMs ?? this.cfg.commandTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Command timed out after ${timeout}ms`)),
        timeout
      );

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.on("close", (exitCode: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
        });
        stream.on("error", (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on("close", resolve);
      stream.on("error", reject);
      stream.end(content);
    });
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        resolve(
          list.map((item) => ({
            name: item.filename,
            type: item.attrs.isDirectory()
              ? "directory"
              : item.attrs.isSymbolicLink()
              ? "symlink"
              : item.attrs.isFile()
              ? "file"
              : "other",
            size: item.attrs.size,
            modified: new Date(item.attrs.mtime * 1000),
            permissions: item.longname.substring(0, 10),
          }))
        );
      });
    });
  }

  async close(): Promise<void> {
    this.sftp = null;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
