import { spawn } from "child_process";

/**
 * Thin wrapper around system `git` for the config-history repo (ADR-006 §5).
 *
 * Design rules (all load-bearing):
 *  - **Spawn with argv arrays, never a shell string.** No `shell: true`, no
 *    string interpolation — paths and messages travel as discrete args, so a
 *    file path or commit message can never be parsed as git options/shell.
 *  - **Explicit `-C <repo>`** on every invocation; the engine never relies on
 *    process cwd.
 *  - **Serialized queue.** git's index lock plus concurrent tool calls would
 *    otherwise race; every run is chained onto a single in-process promise.
 *  - **Graceful absence.** `detectVersion()` probes `git --version`; if git is
 *    absent the whole feature is disabled, not broken (the caller skips history
 *    and unregisters `config_sweep`).
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

export class GitEngine {
  private readonly gitPath: string;
  private readonly repoDir: string;
  // Single promise chain that serializes all git invocations.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(repoDir: string, gitPath = "git") {
    this.repoDir = repoDir;
    this.gitPath = gitPath;
  }

  /** Spawn git with the given args; resolves to the captured result (never rejects on non-zero exit). */
  private spawnGit(args: string[], cwd?: string): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => reject(err));
      child.on("close", (code, signal) => {
        resolve({ stdout, stderr, exitCode: code, signal: signal ?? null });
      });
    });
  }

  /** Enqueue a git invocation against the repo (`-C <repo>`), serialized. */
  run(args: string[]): Promise<GitResult> {
    const task = this.queue.then(() => this.spawnGit(["-C", this.repoDir, ...args]));
    // Keep the chain alive even if this task rejects, so one failure does not
    // wedge the queue for every later call.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Run git WITHOUT `-C` (for `git init <dir>` / `git --version`, which take no
   * repo). Still serialized through the same queue.
   */
  runRaw(args: string[], cwd?: string): Promise<GitResult> {
    const task = this.queue.then(() => this.spawnGit(args, cwd));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Probe `git --version`. Returns the version string when git is present and
   * runnable, or null when it is absent / unspawnable (ENOENT etc.).
   */
  async detectVersion(): Promise<string | null> {
    try {
      const r = await this.runRaw(["--version"]);
      if (r.exitCode === 0) return r.stdout.trim();
      return null;
    } catch {
      return null;
    }
  }
}
