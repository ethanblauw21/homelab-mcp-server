import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { SshTransport } from "../ssh/transport.js";
import type { BackupTarget } from "../backup/store.js";
import type { Config } from "../config.js";
import { shQuote, parseStatPerms, buildStatCommand, type GuestPerms } from "../tools/pctFiles.js";
import { GitEngine } from "./gitEngine.js";
import { mirrorMappingForTarget, isHistoryTarget } from "./paths.js";
import { mutationCommitMessage } from "./commitMessage.js";
import {
  parseManifest,
  serializeManifest,
  emptyManifest,
  type Manifest,
  type FileMeta,
} from "./manifest.js";

/**
 * Orchestrates the ADR-006 config-history mirror repo: bootstrap, the best-effort
 * mutation-commit step, the lower-level mirror primitives `config_sweep` builds
 * on, and the tri-mode push. All git work routes through a single serialized
 * `GitEngine`.
 *
 * The whole subsystem is **optional and fail-soft**: if git is absent (or init
 * fails) `enabled` stays false, every operation no-ops, and the caller leaves
 * `config_sweep` unregistered and marks writes `historyCommitted: false`.
 */
export class ConfigHistory {
  readonly git: GitEngine;
  private readonly cfg: Config["history"];
  private readonly repoDir: string;
  private _enabled = false;
  private warnedNoRemote = false;

  constructor(cfg: Config["history"], git?: GitEngine) {
    this.cfg = cfg;
    this.repoDir = cfg.configHistoryDir;
    this.git = git ?? new GitEngine(this.repoDir);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /**
   * Detect git and initialize the mirror repo on first use. Idempotent: a second
   * call against an existing repo is a no-op beyond re-confirming config. On any
   * failure the subsystem stays disabled and logs one line to stderr.
   */
  async init(): Promise<void> {
    const version = await this.git.detectVersion();
    if (!version) {
      console.error(
        "[config-history] git not found on PATH — config history disabled. " +
          "Install git to enable mutation commits and config_sweep."
      );
      this._enabled = false;
      return;
    }
    try {
      fs.mkdirSync(this.repoDir, { recursive: true });
      if (!fs.existsSync(path.join(this.repoDir, ".git"))) {
        const init = await this.git.runRaw(["init"], this.repoDir);
        if (init.exitCode !== 0) {
          throw new Error(`git init failed: ${init.stderr.trim()}`);
        }
        // Repo-local identity only — never touch the user's global git config.
        await this.git.run(["config", "user.name", "claude-mcp"]);
        await this.git.run(["config", "user.email", "claude-mcp@localhost"]);
        // Don't sign history commits or prompt for a signature.
        await this.git.run(["config", "commit.gpgsign", "false"]);
        // Byte-faithful storage: disable all autocrlf / text normalization so a
        // restored config matches the bytes that were captured (Windows host).
        await this.git.run(["config", "core.autocrlf", "false"]);
        fs.writeFileSync(path.join(this.repoDir, ".gitattributes"), "* -text\n");
      }
      this._enabled = true;
    } catch (err) {
      console.error(
        `[config-history] failed to initialize mirror repo (${describeErr(err)}) — disabled.`
      );
      this._enabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Mutation-commit step (capture path A)
  // -------------------------------------------------------------------------

  /**
   * After a successful write/revert, append one history step. **Best-effort and
   * never throws** — the blob backup (the operational revert path) has already
   * succeeded by this point, so a git failure is logged and reported via the
   * returned `false` (which the caller records as `historyCommitted`). History
   * is the archaeology layer, not a gate.
   *
   * Returns true when the change is captured in the repo (committed, or already
   * identical), false when disabled / a non-history target / any failure.
   */
  async recordMutation(
    transport: SshTransport,
    target: BackupTarget,
    content: Buffer,
    tool: string,
    auditId: string,
    timeoutMs: number
  ): Promise<boolean> {
    if (!this._enabled) return false;
    if (!isHistoryTarget(target)) return false; // qm has no mirror layout
    try {
      const mapping = mirrorMappingForTarget(target);
      this.writeMirrorContent(mapping.repoRelPath, content);

      const perms = await this.statPerms(transport, target, timeoutMs);
      if (perms) {
        const manifest = this.readManifest(mapping.manifestKey);
        manifest.files[mapping.fileKey] = permsToMeta(perms);
        this.writeManifest(mapping.manifestKey, manifest);
      }

      const committed = await this.commit(mutationCommitMessage(tool, target, auditId));
      if (committed) await this.push();
      return committed;
    } catch (err) {
      console.error(`[config-history] mutation commit failed (${describeErr(err)}); write unaffected.`);
      return false;
    }
  }

  /** Best-effort stat of a just-written file for its manifest entry. */
  private async statPerms(
    transport: SshTransport,
    target: BackupTarget,
    timeoutMs: number
  ): Promise<GuestPerms | null> {
    try {
      const cmd =
        target.kind === "pct"
          ? buildStatCommand(target.vmid as number, target.remotePath)
          : `stat -c '%a %u %g' ${shQuote(target.remotePath)}`;
      const res = await transport.exec(cmd, timeoutMs);
      if (res.exitCode !== 0) return null;
      return parseStatPerms(res.stdout);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Mirror primitives (used by config_sweep)
  // -------------------------------------------------------------------------

  /** Absolute on-disk path of a repo-relative mirror file. */
  mirrorAbsPath(repoRelPath: string): string {
    const abs = path.resolve(this.repoDir, repoRelPath);
    const root = path.resolve(this.repoDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`mirror path escapes the repo root: ${repoRelPath}`);
    }
    return abs;
  }

  writeMirrorContent(repoRelPath: string, content: Buffer): void {
    const abs = this.mirrorAbsPath(repoRelPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  removeMirrorContent(repoRelPath: string): void {
    const abs = this.mirrorAbsPath(repoRelPath);
    if (fs.existsSync(abs)) fs.rmSync(abs);
  }

  /** sha256 of a mirror file's bytes, or null when the mirror has no such file. */
  hashMirrorFile(repoRelPath: string): string | null {
    const abs = this.mirrorAbsPath(repoRelPath);
    if (!fs.existsSync(abs)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  }

  /** Repo-relative POSIX paths of all content files under a prefix (skips .git + manifests). */
  listMirrorFiles(repoRelPrefix: string): string[] {
    const root = this.mirrorAbsPath(repoRelPrefix);
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const rel = path.relative(this.repoDir, full).split(path.sep).join("/");
          out.push(rel);
        }
      }
    };
    walk(root);
    return out;
  }

  readManifest(manifestKey: string): Manifest {
    const abs = this.manifestAbsPath(manifestKey);
    if (!fs.existsSync(abs)) return emptyManifest();
    return parseManifest(fs.readFileSync(abs, "utf8"));
  }

  writeManifest(manifestKey: string, manifest: Manifest): void {
    const abs = this.manifestAbsPath(manifestKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, serializeManifest(manifest));
  }

  private manifestAbsPath(manifestKey: string): string {
    return this.mirrorAbsPath(`manifests/${manifestKey}.json`);
  }

  // -------------------------------------------------------------------------
  // Commit + push
  // -------------------------------------------------------------------------

  /**
   * Stage everything and commit. Returns true when the desired state is in the
   * repo — either a new commit was made, or the working tree was already clean
   * (identical content; nothing to capture). Returns false on a git error.
   */
  async commit(message: string): Promise<boolean> {
    if (!this._enabled) return false;
    const add = await this.git.run(["add", "-A"]);
    if (add.exitCode !== 0) return false;
    const staged = await this.git.run(["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) return true; // nothing staged — state already current
    const c = await this.git.run(["commit", "-m", message]);
    return c.exitCode === 0;
  }

  /**
   * Push after a commit, **best-effort** (a failure is logged and retried on the
   * next commit; the local repo stays the source of truth). local-only never
   * pushes. push-lan / push-encrypted both `git push` to the configured remote —
   * the only difference is the remote URL's transport, which git handles.
   */
  async push(): Promise<void> {
    if (this.cfg.pushMode === "local-only") return;
    if (!this.cfg.remote) {
      if (!this.warnedNoRemote) {
        console.error(
          `[config-history] push mode "${this.cfg.pushMode}" set but GIT_HISTORY_REMOTE is empty — not pushing.`
        );
        this.warnedNoRemote = true;
      }
      return;
    }
    try {
      await this.ensureRemote("history", this.cfg.remote);
      const r = await this.git.run(["push", "history", "HEAD"]);
      if (r.exitCode !== 0) {
        console.error(
          `[config-history] push to "history" failed (will retry next commit): ${r.stderr.trim()}`
        );
      }
    } catch (err) {
      console.error(`[config-history] push error (will retry next commit): ${describeErr(err)}`);
    }
  }

  private async ensureRemote(name: string, url: string): Promise<void> {
    const get = await this.git.run(["remote", "get-url", name]);
    if (get.exitCode !== 0) {
      await this.git.run(["remote", "add", name, url]);
    } else if (get.stdout.trim() !== url) {
      await this.git.run(["remote", "set-url", name, url]);
    }
  }
}

function permsToMeta(p: GuestPerms): FileMeta {
  return { mode: p.mode, uid: p.uid, gid: p.gid };
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
