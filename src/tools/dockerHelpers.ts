import { shSingleQuote, buildTimeoutWrapper, type WrapperShell } from "../ssh/command.js";

/**
 * Pure Docker command builders + parsers (ADR-008 §2). The Docker layer rides the
 * existing companion-tier `pct exec` plumbing: every function here produces the
 * *inner* docker command (or parses its output) — the handler wraps it with
 * `buildPctExecCommand(vmid, <innerDockerCmd>)` so the daemon socket is never
 * exposed (Option C rejected) and the only free-form caller string that reaches a
 * shell is a server-validated container name or path. File *content* never travels
 * via argv — it moves SFTP + `docker cp` (see dockerFiles.ts).
 *
 * Nothing here does I/O: the whole layer is unit-tested from fixtures.
 */

/**
 * Docker's container-name charset (ADR-008 §1): `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
 * Identity is the *name* (survives recreation), so it is validated before any
 * interpolation. Returns true when safe.
 */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function validateDockerName(name: string): boolean {
  return DOCKER_NAME_RE.test(name);
}

/** Throw a structured error when a name fails the charset (call before building). */
export function assertDockerName(name: string): void {
  if (!validateDockerName(name)) {
    throw new Error(
      `Invalid Docker container name: ${JSON.stringify(name)}. ` +
        `Names must match ${DOCKER_NAME_RE} (Docker's own charset).`
    );
  }
}

// ---------------------------------------------------------------------------
// docker ps
// ---------------------------------------------------------------------------

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  /** com.docker.compose.project label value, when the container belongs to a stack. */
  composeProject?: string;
}

export function buildDockerPsCommand(): string {
  // --no-trunc keeps full ids; one JSON object per line is the pure-parser contract.
  return `docker ps --no-trunc --format '{{json .}}'`;
}

/**
 * Parse `docker ps --format '{{json .}}'` — one JSON object per line. Unknown /
 * malformed lines are skipped rather than aborting the listing (a single weird
 * row must not blind the operator to the rest).
 */
export function parseDockerPs(output: string): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const labels = typeof row.Labels === "string" ? row.Labels : "";
    out.push({
      id: str(row.ID),
      name: str(row.Names),
      image: str(row.Image),
      status: str(row.Status),
      state: str(row.State),
      ports: str(row.Ports),
      ...(composeProjectFromLabels(labels) && {
        composeProject: composeProjectFromLabels(labels),
      }),
    });
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/** The `docker ps` Labels field is a comma-joined `k=v` list. */
function composeProjectFromLabels(labels: string): string | undefined {
  for (const pair of labels.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === "com.docker.compose.project") {
      return pair.slice(eq + 1).trim() || undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// docker inspect — id + mounts in one round trip
// ---------------------------------------------------------------------------

export interface DockerMount {
  type: string; // "bind" | "volume" | "tmpfs" | ...
  source: string; // host/LXC-side path (for binds, the path we can pct_* directly)
  destination: string; // in-container path
  rw: boolean;
}

export interface DockerInspect {
  id: string;
  mounts: DockerMount[];
}

export function buildDockerInspectCommand(container: string): string {
  assertDockerName(container);
  // Id + Mounts in one call: `{{.Id}}` then a space then the JSON mounts array.
  return `docker inspect --format '{{.Id}} {{json .Mounts}}' ${shSingleQuote(container)}`;
}

/**
 * Parse the combined `{{.Id}} {{json .Mounts}}` output: the id is the first
 * whitespace-delimited token, the remainder is the JSON mounts array. A `null`
 * mounts array (`{{json .Mounts}}` on a container with none) parses to `[]`.
 */
export function parseDockerInspect(output: string): DockerInspect {
  const trimmed = output.trim();
  const sp = trimmed.search(/\s/);
  if (sp === -1) {
    // id only, no mounts payload
    return { id: trimmed, mounts: [] };
  }
  const id = trimmed.slice(0, sp);
  const rest = trimmed.slice(sp + 1).trim();
  return { id, mounts: parseDockerMounts(rest) };
}

/**
 * Parse a `{{json .Mounts}}` array. Tolerates `null`/empty (→ `[]`). Each entry
 * maps Type/Source/Destination/RW; non-bind entries are kept (the resolver
 * filters by type) so callers can reason about volumes too.
 */
export function parseDockerMounts(json: string): DockerMount[] {
  const trimmed = json.trim();
  if (!trimmed || trimmed === "null") return [];
  let arr: unknown;
  try {
    arr = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .map((m) => ({
      type: str(m.Type),
      source: str(m.Source),
      destination: str(m.Destination),
      rw: m.RW === undefined ? true : Boolean(m.RW),
    }));
}

export interface BindResolution {
  /** The LXC-side path the container path maps to (Source + remainder). */
  lxcPath: string;
  /** The mount that matched (for diagnostics / read-only refusal). */
  mount: DockerMount;
}

/**
 * Resolve a container path against the container's mounts — the bind-mount fast
 * path (ADR-008 §2). If the path lives on a **bind** mount, return the equivalent
 * LXC-side path so the operation becomes a plain `pct_read_file`/`pct_write_file`
 * (one fewer copy hop). Volumes and unmounted paths return `null` ⇒ the caller
 * takes the `docker cp` slow path.
 *
 * Longest-destination-prefix wins (a nested bind under a broader one is the real
 * backing store). Prefix matching is path-segment-aware: `/config` matches
 * `/config/app.yml` and `/config` itself, never `/configuration`.
 */
export function resolveBindMount(
  mounts: DockerMount[],
  containerPath: string
): BindResolution | null {
  let best: DockerMount | null = null;
  let bestLen = -1;
  for (const m of mounts) {
    if (m.type !== "bind") continue;
    const dest = stripTrailingSlash(m.destination);
    if (!isPathPrefix(dest, containerPath)) continue;
    if (dest.length > bestLen) {
      best = m;
      bestLen = dest.length;
    }
  }
  if (!best) return null;
  const dest = stripTrailingSlash(best.destination);
  // A "/" bind has length 1; slicing it off would eat the path's leading slash,
  // so the remainder is the whole path. Otherwise it is the suffix past the dest.
  const remainder = dest === "/" ? containerPath : containerPath.slice(dest.length); // "" or "/sub/path"
  const source = stripTrailingSlash(best.source);
  const lxcPath = remainder ? source + remainder : source || "/";
  return { lxcPath, mount: best };
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** True when `dir` is `path` itself or a parent directory of it (segment-aware). */
function isPathPrefix(dir: string, path: string): boolean {
  if (dir === "/") return path.startsWith("/");
  return path === dir || path.startsWith(dir + "/");
}

// ---------------------------------------------------------------------------
// docker exec
// ---------------------------------------------------------------------------

export interface DockerExecOptions {
  /** In-container shell. Defaults to "sh" — minimal images often lack bash. */
  shell?: WrapperShell;
  /** Wrap the inner command with coreutils `timeout` inside the container. */
  timeoutSecs?: number;
}

/**
 * Build the inner `docker exec <container> sh -c '<escaped>'` command. The handler
 * wraps the whole string with `buildPctExecCommand(vmid, <this>, { timeoutSecs })`
 * so the node-side `timeout` bounds the wait; `timeoutSecs` here adds an
 * in-container `timeout` for reliable in-guest termination (the three-layer
 * compose the ADR's quoting note warns about).
 */
export function buildDockerExecCommand(
  container: string,
  command: string,
  opts: DockerExecOptions = {}
): string {
  assertDockerName(container);
  const shell = opts.shell ?? "sh";
  const inner =
    opts.timeoutSecs !== undefined
      ? buildTimeoutWrapper(command, opts.timeoutSecs, { shell })
      : `${shell} -c ${shSingleQuote(command)}`;
  return `docker exec ${shSingleQuote(container)} ${inner}`;
}

// ---------------------------------------------------------------------------
// docker logs
// ---------------------------------------------------------------------------

export interface DockerLogsOptions {
  tail: number; // already clamped by the handler
  since?: string; // already validated by the handler (tail_log grammar)
}

export function buildDockerLogsCommand(container: string, opts: DockerLogsOptions): string {
  assertDockerName(container);
  let cmd = `docker logs --tail ${opts.tail}`;
  if (opts.since !== undefined && opts.since !== "") {
    cmd += ` --since ${shSingleQuote(opts.since.trim())}`;
  }
  cmd += ` ${shSingleQuote(container)}`;
  return cmd;
}

// ---------------------------------------------------------------------------
// docker cp — the slow-path relay (LXC temp <-> container)
// ---------------------------------------------------------------------------

/**
 * `docker cp <container>:<path> <lxcTmp>` — copy a file *out* of the container to
 * an LXC-side temp (then the existing `pct pull` flow carries it to the node).
 * The container name is charset-validated, so it can sit unquoted before the
 * colon; the path is single-quoted, and the shell concatenates `name:'<path>'`
 * into the `CONTAINER:SRC` argument Docker expects.
 */
export function buildDockerCpFromContainer(
  container: string,
  containerPath: string,
  lxcTmp: string
): string {
  assertDockerName(container);
  return `docker cp ${container}:${shSingleQuote(containerPath)} ${shSingleQuote(lxcTmp)}`;
}

/** `docker cp <lxcTmp> <container>:<path>` — copy a file *into* the container. */
export function buildDockerCpToContainer(
  lxcTmp: string,
  container: string,
  containerPath: string
): string {
  assertDockerName(container);
  return `docker cp ${shSingleQuote(lxcTmp)} ${container}:${shSingleQuote(containerPath)}`;
}

// ---------------------------------------------------------------------------
// Ownership / mode restoration (slow path, best-effort — ADR-008 §2)
// ---------------------------------------------------------------------------

export interface DockerFilePerms {
  mode: string; // octal, e.g. "644"
  uid: number;
  gid: number;
}

/** `docker exec <c> stat -c '%a %u %g' <path>` — perms before an overwrite. */
export function buildDockerStatCommand(container: string, containerPath: string): string {
  assertDockerName(container);
  return `docker exec ${shSingleQuote(container)} stat -c '%a %u %g' ${shSingleQuote(containerPath)}`;
}

/**
 * Parse `stat -c '%a %u %g'` from inside the container, e.g. "644 0 0". Returns
 * null when the image lacks `stat` (busybox-minus) or the file is new — the
 * caller records a best-effort note and lands the file with the container's
 * default umask (the `docker cp` endpoint preserves no perms by itself).
 */
export function parseDockerStatPerms(output: string): DockerFilePerms | null {
  const m = output.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { mode: m[1] ?? "", uid: parseInt(m[2] ?? "0", 10), gid: parseInt(m[3] ?? "0", 10) };
}

/** `docker exec <c> chown <uid>:<gid> <path>` — restore ownership after a cp-in. */
export function buildDockerChownCommand(
  container: string,
  perms: DockerFilePerms,
  containerPath: string
): string {
  assertDockerName(container);
  return `docker exec ${shSingleQuote(container)} chown ${perms.uid}:${perms.gid} ${shSingleQuote(containerPath)}`;
}

/** `docker exec <c> chmod <mode> <path>` — restore mode after a cp-in. */
export function buildDockerChmodCommand(
  container: string,
  perms: DockerFilePerms,
  containerPath: string
): string {
  assertDockerName(container);
  return `docker exec ${shSingleQuote(container)} chmod ${shSingleQuote(perms.mode)} ${shSingleQuote(containerPath)}`;
}

// ---------------------------------------------------------------------------
// docker compose — stack redeploy (ADR-008 §6)
// ---------------------------------------------------------------------------

/**
 * `docker compose -f <path> up -d` — run on the LXC host (not inside a container)
 * via `pct exec`; the compose file path is the only free-form argument and is
 * single-quoted (the handler also `validatePath`s it first). This is the lighter,
 * usually-better rollback for a Docker host: pair `revert_file` (restore the
 * compose file from backup) with this to roll a stack back in seconds.
 */
export function buildComposeUpCommand(composePath: string): string {
  return `docker compose -f ${shSingleQuote(composePath)} up -d`;
}
