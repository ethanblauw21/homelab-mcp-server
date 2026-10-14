/**
 * Test kit for the ADR-025 handler tests (not imported by production code). Lives
 * outside a *.test.ts file so test files can share it without re-running suites —
 * the same placement as `ssh/fakeTransport.ts`.
 */
import path from "path";
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import type { ContainerIdentity } from "./dockerUpdate.js";

const D = (c: string): string => "sha256:" + c.repeat(64).slice(0, 64);
const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

/** Scripted transport: first matching rule answers; every command is recorded. */
export class ScriptTransport implements SshTransport {
  readonly commands: string[] = [];
  private rules: Array<{ match: RegExp | ((cmd: string) => boolean); reply: (cmd: string) => ExecResult }> = [];
  on(match: RegExp | ((cmd: string) => boolean), reply: ExecResult | ((cmd: string) => ExecResult)): this {
    this.rules.unshift({ match, reply: typeof reply === "function" ? reply : () => reply });
    return this;
  }
  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    for (const r of this.rules) {
      const hit = typeof r.match === "function" ? r.match(command) : r.match.test(command);
      if (hit) return r.reply(command);
    }
    return ok();
  }
  async stat(): Promise<never> { throw new Error("no fs"); }
  async readFile(): Promise<never> { throw new Error("no fs"); }
  async writeFile(): Promise<void> {}
  async list(): Promise<never> { throw new Error("no fs"); }
  async close(): Promise<void> {}
}

export function identityRow(c: Partial<ContainerIdentity> & { name: string }): string {
  return [
    "/" + c.name,
    c.id ?? c.name.padEnd(64, "0").slice(0, 64),
    c.ref ?? "nginx:latest",
    c.imageId ?? D("1"),
    c.state ?? "running",
    c.composeProject ?? "",
    c.composeService ?? "",
    c.composeConfigFiles ?? "",
    c.watchtowerLabel ?? "",
    c.diunLabel ?? "",
    c.diunWatchRepoLabel ?? "",
    c.networkMode ?? "bridge",
  ].join("\t");
}

export function makeConfig(tmpDir: string, docker: Partial<Config["docker"]> = {}): Config {
  return {
    ssh: { host: "h", commandTimeoutMs: 5000 },
    audit: { logPath: path.join(tmpDir, "audit.jsonl") },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: ["/proc", "/sys", "/dev"] },
    docker: { updatePollIntervalMs: 1, ...docker },
  } as unknown as Config;
}
