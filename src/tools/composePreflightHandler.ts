/**
 * `compose_preflight` (ADR-012) — the thin I/O shell over the pure analyzer in
 * `composePreflight.ts`. It only ever READS: it pulls the proposed/on-disk compose
 * file (ADR-008 `pct pull` path) and runs a read-only bound-port probe, then hands
 * plain structured data to `analyzeCompose`. **No audit record, no backup, no node
 * mutation** — the same read-only class as `diff_config` / `query_audit`.
 *
 * Companion tier (it reaches inside an LXC via `pct exec`/`pct pull`, exactly the
 * Docker family's plumbing — an observe-tier API token cannot do this; ADR-012 §5).
 */
import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { validatePath } from "../guardrails/pathValidation.js";
import { assertContainerRunning, pullContainerFile } from "./pctFiles.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { assertDockerName } from "./dockerHelpers.js";
import {
  parseCompose,
  groupByNetns,
  analyzeCompose,
  parseSsListeners,
  parseProcNetTcpPorts,
  ComposeParseError,
  type ComposeModel,
  type BoundPort,
  type PreflightReport,
} from "./composePreflight.js";

export const ComposePreflightInputSchema = z
  .object({
    vmid: z.number().int().positive().describe("LXC container ID hosting the Docker daemon (ADR-008 topology)."),
    composePath: z
      .string()
      .min(1)
      .describe("Absolute path to the compose file inside the LXC (e.g. /opt/stack/docker-compose.yml)."),
    composeContent: z
      .string()
      .optional()
      .describe(
        "OPTIONAL proposed compose content to analyze instead of reading composePath. When supplied, the on-disk " +
          "file at composePath is read as the 'previous' version so the recreate check is precise (proposed vs on-disk)."
      ),
    checkBoundPorts: z
      .boolean()
      .default(true)
      .describe("Cross-check declared ports against ports actually bound in the guest (read-only probe). Default true."),
  })
  .describe("Statically analyze a proposed compose change for deploy hazards. Read-only, not audited.");

export type ComposePreflightInput = z.infer<typeof ComposePreflightInputSchema>;

/** Read a compose file's text from inside the LXC; returns undefined when absent. */
async function readComposeText(
  transport: SshTransport,
  vmid: number,
  remotePath: string,
  cfg: Config
): Promise<string | undefined> {
  const { content } = await pullContainerFile(
    transport,
    vmid,
    remotePath,
    cfg.container.nodeTempDir,
    cfg.ssh.commandTimeoutMs
  );
  return content ? content.toString("utf8") : undefined;
}

/**
 * Best-effort bound-port probe. Prefers `ss -tlnp` (gives holder names) inside the
 * netns owner's container; falls back to `/proc/net/tcp*`. When no shared provider
 * exists, probes the LXC's own net namespace. Any failure ⇒ null (the report then
 * marks boundPortsChecked:false — over-reporting "not checked" is the safe failure).
 */
async function probeBoundPorts(
  transport: SshTransport,
  vmid: number,
  model: ComposeModel,
  cfg: Config
): Promise<BoundPort[] | null> {
  // Pick the dominant netns provider (the tailscale role): the service others attach to.
  const groups = groupByNetns(model);
  const provider =
    groups
      .filter((g) => g.provider !== null && g.dependents.length > 0)
      .sort((a, b) => b.dependents.length - a.dependents.length)[0]?.provider ?? null;

  const listenerProbe = "ss -tlnp 2>/dev/null || cat /proc/net/tcp /proc/net/tcp6 2>/dev/null";
  let inner: string;
  if (provider !== null) {
    assertDockerName(provider); // charset-guard before interpolation
    inner = `docker exec ${provider} sh -c ${shQuote(listenerProbe)}`;
  } else {
    inner = `sh -c ${shQuote(listenerProbe)}`;
  }
  const cmd = buildPctExecCommand(vmid, inner);
  try {
    const res = await transport.exec(cmd, cfg.ssh.commandTimeoutMs);
    const out = (res.stdout ?? "").trim();
    if (!out) return null;
    if (/LISTEN|users:\(|^State\b/im.test(out)) return parseSsListeners(out);
    return parseProcNetTcpPorts(out).map((port) => ({ port }));
  } catch {
    return null;
  }
}

/** Local single-quote escaper (mirrors ssh/command.ts shSingleQuote, kept local to avoid a cycle). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function composePreflightHandler(
  input: ComposePreflightInput,
  transport: SshTransport,
  cfg: Config
): Promise<PreflightReport> {
  const pathCheck = validatePath(input.composePath, {
    allowlist: cfg.guardrails.pathAllowlist,
    denylist: cfg.guardrails.pathDenylist,
  });
  if (!pathCheck.valid) {
    throw new Error(`Invalid compose file path: ${pathCheck.reason}`);
  }

  await assertContainerRunning(transport, input.vmid, cfg.ssh.commandTimeoutMs);

  // The proposed compose: supplied content, or the file as it is on disk now.
  let nextText: string | undefined;
  let prevModel: ComposeModel | undefined;
  if (input.composeContent !== undefined) {
    nextText = input.composeContent;
    // On-disk file becomes the "previous" version, so the recreate check is precise.
    const onDisk = await readComposeText(transport, input.vmid, input.composePath, cfg);
    if (onDisk !== undefined) {
      try {
        prevModel = parseCompose(onDisk);
      } catch {
        // A malformed on-disk file just means we lose the precise recreate diff;
        // the conservative (no-prev) check still runs.
        prevModel = undefined;
      }
    }
  } else {
    nextText = await readComposeText(transport, input.vmid, input.composePath, cfg);
    if (nextText === undefined) {
      throw new Error(
        `compose_preflight: no file at ${input.composePath} in container ${input.vmid}, and no composeContent supplied.`
      );
    }
  }

  let nextModel: ComposeModel;
  try {
    nextModel = parseCompose(nextText);
  } catch (err) {
    if (err instanceof ComposeParseError) {
      throw new Error(`compose_preflight: ${err.message} (${input.composePath}).`);
    }
    throw err;
  }

  let bound: BoundPort[] | null = null;
  if (input.checkBoundPorts) {
    bound = await probeBoundPorts(transport, input.vmid, nextModel, cfg);
  }

  return analyzeCompose(nextModel, {
    prev: prevModel,
    bound: bound ?? undefined,
    boundPortsChecked: input.checkBoundPorts && bound !== null,
  });
}
