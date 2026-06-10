import { Client, SFTPWrapper } from "ssh2";
import { readFileSync } from "fs";
import type { ExecResult, FileEntry, FileStat, ReadFileOptions, SshTransport } from "./transport.js";
import type { Config } from "../config.js";
import { computeFingerprint, decideHostKey, KnownHostsStore } from "./hostKey.js";
import { buildTimeoutWrapper, timeoutMsToSecs, TIMEOUT_EXIT_CODE } from "./command.js";

const RECONNECT_BACKOFF_CAP_MS = 60_000;
const MAX_CONNECT_ATTEMPTS = 5;

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

    this.connectingPromise = this.connectWithBackoff().then(
      () => {
        this.connectingPromise = null;
      },
      (err) => {
        this.connectingPromise = null;
        throw err;
      }
    );

    return this.connectingPromise;
  }

  /**
   * Exponential backoff with jitter (item 8 — `reconnectDelay` is now honored).
   * Delay starts at `reconnectDelay`, doubles each attempt, caps at 60s, and is
   * jittered to avoid thundering-herd reconnects. Resets implicitly on success.
   */
  private async connectWithBackoff(): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const base = Math.min(
          this.cfg.reconnectDelay * 2 ** (attempt - 1),
          RECONNECT_BACKOFF_CAP_MS
        );
        const jittered = base * (0.5 + Math.random() * 0.5); // 50–100% of base
        console.error(
          `[ssh] reconnect attempt ${attempt + 1}/${MAX_CONNECT_ATTEMPTS} to ` +
            `${this.cfg.host}:${this.cfg.port} in ${Math.round(jittered)}ms`
        );
        await this.sleep(jittered);
      }
      try {
        await this.attemptConnectOnce();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private attemptConnectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      client.on("ready", () => {
        this.client = client;
        resolve();
      });
      client.on("error", (err) => {
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

    // Enforcement lives on the node: a client timer cannot reliably kill a
    // remote process (ADR-004 §2). coreutils `timeout` sends TERM then KILL.
    const secs = timeoutMsToSecs(timeout);
    const wrapped = buildTimeoutWrapper(command, secs);
    // Client-side backstop only for a wedged connection: effective + grace.
    const backstopMs = timeout + this.cfg.commandTimeoutGraceMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The connection itself is unresponsive — drop it and force a reconnect.
        this.sftp = null;
        if (this.client) {
          this.client.end();
          this.client = null;
        }
        reject(
          new Error(
            `Connection backstop fired after ${backstopMs}ms (node-side timeout ` +
              `was ${secs}s); connection dropped and marked for reconnect`
          )
        );
      }, backstopMs);

      client.exec(wrapped, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        // ssh2 emits (code, signalName); code is null on signal termination.
        stream.on("close", (exitCode: number | null, signal?: string) => {
          clearTimeout(timer);
          const timedOut = exitCode === TIMEOUT_EXIT_CODE;
          resolve({
            stdout,
            stderr,
            exitCode, // never coerced — null preserved for signal kills
            ...(signal ? { signal } : {}),
            ...(timedOut ? { timedOut: true } : {}),
          });
        });
        stream.on("error", (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    });
  }

  async stat(remotePath: string): Promise<FileStat> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        resolve({ size: stats.size });
      });
    });
  }

  async readFile(remotePath: string, opts?: ReadFileOptions): Promise<Buffer> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const streamOpts: { start?: number; end?: number } = {};
      if (opts?.start !== undefined) streamOpts.start = opts.start;
      if (opts?.length !== undefined) {
        const start = opts.start ?? 0;
        // createReadStream `end` is inclusive.
        streamOpts.end = start + opts.length - 1;
      }
      const stream = sftp.createReadStream(remotePath, streamOpts);
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
