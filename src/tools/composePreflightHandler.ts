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
  buildContainerIdentityCommand,
  configFilesInclude,
  parseContainerIdentities,
  type ContainerIdentity,
} from "./dockerUpdate.js";
import {
  parseCompose,
  groupByNetns,
  analyzeCompose,
  parseSsListeners,
  parseProcNetTcpPorts,
  buildAttributedListenerProbe,
  parseAttributedListeners,
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

interface BoundPortProbe {
  bound: BoundPort[];
  ownProjects: string[];
  netnsAllOwn: boolean;
}

/**
 * Best-effort bound-port probe. ADR-027: first the attributed probe — from the LXC,
 * `nsenter` into the netns provider's namespace (or the LXC's own when there is no
 * shared provider), list listeners, and map each pid to its Docker container and
 * that container's compose project — so a port held by this stack's own running
 * instance is told apart from a real conflict. If that tooling is missing, falls
 * back to the original probe: `ss -tlnp` inside the provider's container, else
 * `/proc/net/tcp*`. Any failure ⇒ null (the report then marks
 * boundPortsChecked:false — over-reporting "not checked" is the safe failure).
 */
async function probeBoundPorts(
  transport: SshTransport,
  vmid: number,
  composePath: string,
  model: ComposeModel,
  cfg: Config
): Promise<BoundPortProbe | null> {
  // Pick the dominant netns provider (the tailscale role): the service others attach to.
  const groups = groupByNetns(model);
  const provider =
    groups
      .filter((g) => g.provider !== null && g.dependents.length > 0)
      .sort((a, b) => b.dependents.length - a.dependents.length)[0]?.provider ?? null;

  // Which projects already run from this file, and which container is the provider.
  let running: ContainerIdentity[] = [];
  try {
    const scan = await transport.exec(buildPctExecCommand(vmid, buildContainerIdentityCommand()), cfg.ssh.commandTimeoutMs);
    if (scan.exitCode === 0) running = parseContainerIdentities(scan.stdout);
  } catch {
    running = [];
  }
  const ownProjects = [
    ...new Set(running.filter((c) => configFilesInclude(c.composeConfigFiles, composePath)).map((c) => c.composeProject)),
  ].filter((p) => p !== "");
  const providerContainer =
    provider === null
      ? undefined
      : running.find((c) => c.composeService === provider && ownProjects.includes(c.composeProject)) ??
        running.find((c) => c.name === provider);
  const netnsAllOwn = providerContainer !== undefined && ownProjects.length > 0 && netnsMembers(providerContainer, running).every((c) => ownProjects.includes(c.composeProject));

  // 1) Attributed probe from the LXC.
  if (provider === null || providerContainer !== undefined) {
    const target = providerContainer?.name ?? null;
    if (target !== null) assertDockerName(target); // charset-guard before interpolation
    try {
      const res = await transport.exec(buildPctExecCommand(vmid, buildAttributedListenerProbe(target)), cfg.ssh.commandTimeoutMs);
      if (res.exitCode === 0 && res.stdout.trim()) {
        const ids = running.map((c) => ({ id: c.id, name: c.name, project: c.composeProject }));
        return { bound: parseAttributedListeners(res.stdout, ids), ownProjects, netnsAllOwn: provider !== null && netnsAllOwn };
      }
    } catch {
      /* fall through to the in-container probe */
    }
  }

  // 2) Original probe: inside the provider's container (or the LXC's own netns).
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
    const bound = /LISTEN|users:\(|^State\b/im.test(out) ? parseSsListeners(out) : parseProcNetTcpPorts(out).map((port) => ({ port }));
    return { bound, ownProjects, netnsAllOwn: provider !== null && netnsAllOwn };
  } catch {
    return null;
  }
}

/** The running containers sharing `provider`'s network namespace, provider included. */
function netnsMembers(provider: ContainerIdentity, running: ContainerIdentity[]): ContainerIdentity[] {
  return running.filter((c) => {
    if (c.id === provider.id) return true;
    const m = /^container:(.+)$/.exec(c.networkMode);
    return m !== null && (m[1] === provider.id || m[1] === provider.name);
  });
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

  let probe: BoundPortProbe | null = null;
  if (input.checkBoundPorts) {
    probe = await probeBoundPorts(transport, input.vmid, input.composePath, nextModel, cfg);
  }

  return analyzeCompose(nextModel, {
    prev: prevModel,
    bound: probe?.bound,
    boundPortsChecked: input.checkBoundPorts && probe !== null,
    ownProjects: probe?.ownProjects,
    netnsAllOwn: probe?.netnsAllOwn,
  });
}
