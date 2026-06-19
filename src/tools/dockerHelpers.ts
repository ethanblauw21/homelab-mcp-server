import { shSingleQuote, buildTimeoutWrapper, type WrapperShell } from "../ssh/command.js";
import { redactRecord } from "../guardrails/redaction.js";

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
 * The host-visible path of a Docker **local-driver named volume** (ADR-016 §4):
 * `/var/lib/docker/volumes/<name>/_data[/...]`. A named volume on the default
 * `local` driver materializes here in the LXC filesystem, so a read of a file
 * inside it can take the same direct `pct pull` fast path as a bind — the
 * dogfooding gap where a linuxserver `/config` named volume fell to the slow
 * `docker cp` relay. A volume on a non-local driver (NFS/cluster) has a `Source`
 * that does NOT match this shape and correctly stays on the slow path.
 */
const LOCAL_VOLUME_SOURCE_RE = /^\/var\/lib\/docker\/volumes\/[^/]+\/_data(\/|$)/;

/**
 * Is this mount's `Source` directly readable in the LXC filesystem? True for
 * every **bind** (the source IS an LXC path) and for a **local-driver named
 * volume** whose source is under `/var/lib/docker/volumes/<name>/_data`. Anything
 * else (tmpfs, overlay-only, a non-local volume driver) is not host-visible and
 * must use the `docker cp` relay.
 */
export function isHostVisibleMount(m: DockerMount): boolean {
  if (m.type === "bind") return true;
  if (m.type === "volume") return LOCAL_VOLUME_SOURCE_RE.test(m.source);
  return false;
}

/**
 * Resolve a container path against the container's mounts — the host-visible
 * fast path (ADR-008 §2, broadened by ADR-016 §4). If the path lives on a
 * **bind** or a **local-driver named volume**, return the equivalent LXC-side
 * path so the operation becomes a plain `pct_read_file`/`pct_write_file` (one
 * fewer copy hop). tmpfs/overlay/non-local-driver mounts and unmounted paths
 * return `null` ⇒ the caller takes the `docker cp` slow path.
 *
 * Longest-destination-prefix wins (a nested mount under a broader one is the
 * real backing store). Prefix matching is path-segment-aware: `/config` matches
 * `/config/app.yml` and `/config` itself, never `/configuration`.
 */
export function resolveBindMount(
  mounts: DockerMount[],
  containerPath: string
): BindResolution | null {
  let best: DockerMount | null = null;
  let bestLen = -1;
  for (const m of mounts) {
    if (!isHostVisibleMount(m)) continue;
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

// ---------------------------------------------------------------------------
// docker_inspect — structured, secret-aware single-container projection (ADR-016 §1)
// ---------------------------------------------------------------------------

/** A structured published-port mapping, e.g. 0.0.0.0:8080 -> 8080/tcp. */
export interface DockerPortMap {
  /** "<port>/<proto>", e.g. "8080/tcp" — the container-side exposed port. */
  containerPort: string;
  hostIp: string;
  hostPort: string;
}

/**
 * The `docker_inspect` projection (ADR-016 §1): the operator-relevant slice of a
 * `docker inspect <container>` JSON object, secret-aware. The `env` map keeps
 * names but redacts secret values via the shared ADR-002 `redactRecord` (benign
 * config like TZ/PUID stays readable — exactly the dogfooding instinct). NOTE on
 * the pin: container inspect exposes the resolved content-addressed `imageId`
 * (`.Image`, a `sha256:` digest) but NOT the registry `RepoDigest` (`repo@sha256`,
 * which lives on the *image* object) without a second round trip — `imageId` is
 * the equivalent container-level pin and is what we surface.
 */
export interface ContainerInspect {
  id: string;
  /** Container name, leading "/" stripped. */
  name: string;
  /** The image reference the container was created from (`.Config.Image`). */
  image: string;
  /** Resolved content-addressed image id (`.Image`, `sha256:…`) — the pin. */
  imageId: string;
  /** `.State.Status`, e.g. "running" | "exited". */
  status: string;
  /** `.State.Health.Status` when a healthcheck is defined, else undefined. */
  health?: string;
  /** `.HostConfig.RestartPolicy.Name` (+ retry count when relevant). */
  restartPolicy: string;
  /** Attached network names (`.NetworkSettings.Networks` keys). */
  networks: string[];
  /** Mounts, reusing the shared mount parse (bind/volume/tmpfs). */
  mounts: DockerMount[];
  /** Published host ports. */
  ports: DockerPortMap[];
  /** `com.docker.compose.project` label, when part of a stack. */
  composeProject?: string;
  /** `com.docker.compose.project.config_files` label — the compose file path. */
  composeConfigFiles?: string;
  /** Env names → values, secret values redacted by the shared module. */
  env: Record<string, string>;
  /** Count of env values the redactor masked (transparency). */
  envRedactedCount: number;
}

/**
 * `docker inspect <container>` — the FULL JSON (no `--format`), so the pure parser
 * does the projection. One round trip; the handler routes env through redaction.
 */
export function buildContainerInspectCommand(container: string): string {
  assertDockerName(container);
  return `docker inspect ${shSingleQuote(container)}`;
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** Parse the `["KEY=val", …]` env array into a `{KEY: val}` map (first `=` splits). */
function parseEnvArray(env: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(env)) return out;
  for (const e of env) {
    if (typeof e !== "string") continue;
    const eq = e.indexOf("=");
    if (eq === -1) {
      out[e] = "";
      continue;
    }
    out[e.slice(0, eq)] = e.slice(eq + 1);
  }
  return out;
}

/** Flatten `.NetworkSettings.Ports` ({"8080/tcp":[{HostIp,HostPort}], "53/udp":null}). */
function parsePortMap(ports: unknown): DockerPortMap[] {
  const out: DockerPortMap[] = [];
  const obj = asObj(ports);
  for (const [containerPort, bindings] of Object.entries(obj)) {
    if (!Array.isArray(bindings)) continue; // null ⇒ exposed but not published
    for (const b of bindings) {
      const bo = asObj(b);
      out.push({
        containerPort,
        hostIp: str(bo.HostIp),
        hostPort: str(bo.HostPort),
      });
    }
  }
  return out;
}

/**
 * Parse `docker inspect <container>` output (a JSON array; first element used) into
 * the secret-aware `ContainerInspect` projection. The env map is run through
 * `redactRecord` with the caller's `extraKeys` — the dimension-C directive: env
 * redaction operates on the **parsed map**, never on JSON-escaped text. Throws on
 * empty/invalid JSON or an empty array (no such container).
 */
export function parseContainerInspect(output: string, extraKeys: string[] = []): ContainerInspect {
  let arr: unknown;
  try {
    arr = JSON.parse(output.trim());
  } catch {
    throw new Error("docker inspect did not return valid JSON");
  }
  const root = Array.isArray(arr) ? arr[0] : arr;
  const o = asObj(root);
  if (Object.keys(o).length === 0) {
    throw new Error("docker inspect returned an empty result (no such container?)");
  }
  const config = asObj(o.Config);
  const state = asObj(o.State);
  const hostConfig = asObj(o.HostConfig);
  const netSettings = asObj(o.NetworkSettings);
  const labels = asObj(config.Labels);

  const health = asObj(state.Health);
  const restart = asObj(hostConfig.RestartPolicy);
  const restartName = str(restart.Name) || "no";
  const maxRetry =
    typeof restart.MaximumRetryCount === "number" ? restart.MaximumRetryCount : 0;

  const envRaw = parseEnvArray(config.Env);
  const redactedEnv = redactRecord(envRaw, extraKeys);

  const project = labels["com.docker.compose.project"];
  const configFiles = labels["com.docker.compose.project.config_files"];

  return {
    id: str(o.Id),
    name: str(o.Name).replace(/^\//, ""),
    image: str(config.Image),
    imageId: str(o.Image),
    status: str(state.Status),
    ...(typeof health.Status === "string" && health.Status
      ? { health: str(health.Status) }
      : {}),
    restartPolicy: restartName === "on-failure" && maxRetry > 0
      ? `on-failure:${maxRetry}`
      : restartName,
    networks: Object.keys(asObj(netSettings.Networks)),
    mounts: parseDockerMounts(JSON.stringify(o.Mounts ?? [])),
    ports: parsePortMap(netSettings.Ports),
    ...(typeof project === "string" && project ? { composeProject: project } : {}),
    ...(typeof configFiles === "string" && configFiles
      ? { composeConfigFiles: configFiles }
      : {}),
    env: redactedEnv.value,
    envRedactedCount: redactedEnv.redactedCount,
  };
}

/**
 * Narrow a `ContainerInspect` to a requested subset of top-level fields (the
 * `fields?` token-saver — e.g. `["image","mounts"]`). Unknown field names are
 * ignored; an empty/undefined list returns the full view. `id` and `name` are
 * always kept so a narrowed result is still self-identifying.
 */
export function projectInspectFields(
  view: ContainerInspect,
  fields?: string[]
): Partial<ContainerInspect> {
  if (!fields || fields.length === 0) return view;
  const keep = new Set<string>(["id", "name", ...fields]);
  const src = view as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(view)) {
    if (keep.has(k)) out[k] = src[k];
  }
  return out as Partial<ContainerInspect>;
}

// ---------------------------------------------------------------------------
// docker_stats — point-in-time resource snapshot (ADR-016 §2)
// ---------------------------------------------------------------------------

export interface DockerStat {
  name: string;
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPct: number;
  netIO: string;
  blockIO: string;
}

/** Single sample, never a live feed (ADR-016 scope: no streaming). */
export function buildDockerStatsCommand(): string {
  return `docker stats --no-stream --format '{{json .}}'`;
}

/** "12.34%" → 12.34; non-numeric → 0. */
function parsePercent(s: unknown): number {
  const n = parseFloat(String(s ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, kib: 1024,
  mb: 1e6, mib: 1024 ** 2,
  gb: 1e9, gib: 1024 ** 3,
  tb: 1e12, tib: 1024 ** 4,
};

/**
 * Parse a docker-stats size token ("100MiB", "2.5GB", "0B") to bytes. Tolerates
 * binary (MiB/GiB) and decimal (MB/GB) suffixes; an unrecognized token → 0.
 */
export function parseDockerSize(token: string): number {
  const m = token.trim().match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
  if (!m) return 0;
  const value = parseFloat(m[1] ?? "");
  if (!Number.isFinite(value)) return 0;
  const unit = (m[2] ?? "b").toLowerCase() || "b";
  const factor = SIZE_UNITS[unit] ?? 1;
  return Math.round(value * factor);
}

/** Split a docker "X / Y" usage field into its two byte values. */
function parseUsagePair(s: unknown): [number, number] {
  const parts = String(s ?? "").split("/");
  return [parseDockerSize(parts[0] ?? ""), parseDockerSize(parts[1] ?? "")];
}

/**
 * Parse `docker stats --no-stream --format '{{json .}}'` (one JSON object per
 * line) into structured stats, **sorted by memory used descending** (the
 * operator's first question is "what's eating RAM"). Malformed lines are skipped.
 */
export function parseDockerStats(output: string): DockerStat[] {
  const out: DockerStat[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const [memUsedBytes, memLimitBytes] = parseUsagePair(row.MemUsage);
    out.push({
      name: str(row.Name),
      cpuPct: parsePercent(row.CPUPerc),
      memUsedBytes,
      memLimitBytes,
      memPct: parsePercent(row.MemPerc),
      netIO: str(row.NetIO),
      blockIO: str(row.BlockIO),
    });
  }
  out.sort((a, b) => b.memUsedBytes - a.memUsedBytes);
  return out;
}

// ---------------------------------------------------------------------------
// compose_discover — read-only compose project map (ADR-016 §3)
// ---------------------------------------------------------------------------

export interface ComposeService {
  name: string;
  image: string;
  ports: string;
}

export interface ComposeProject {
  project: string;
  /** com.docker.compose.project.config_files label, when present. */
  configFile?: string;
  services: ComposeService[];
}

/** Parse the comma-joined `k=v` `docker ps` Labels field into a map. */
export function parseDockerLabels(labels: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of labels.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    if (k) out[k] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Build the compose-project map from `docker ps --format '{{json .}}'` output
 * (reuses `buildDockerPsCommand`). Groups running containers by their
 * `com.docker.compose.project` label; the service name/image/ports come from the
 * row + `com.docker.compose.service` label. **Honest limit (ADR-016 §3): only
 * RUNNING containers carry labels** — a fully-`down` project is invisible here.
 * Projects + services are sorted for a stable result; services dedupe by name.
 */
export function parseComposeProjects(output: string): ComposeProject[] {
  const byProject = new Map<string, { configFile?: string; services: Map<string, ComposeService> }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const labels = parseDockerLabels(typeof row.Labels === "string" ? row.Labels : "");
    const project = labels["com.docker.compose.project"];
    if (!project) continue;
    let entry = byProject.get(project);
    if (!entry) {
      entry = { services: new Map() };
      byProject.set(project, entry);
    }
    const configFile = labels["com.docker.compose.project.config_files"];
    if (configFile && !entry.configFile) entry.configFile = configFile;
    const serviceName = labels["com.docker.compose.service"] || str(row.Names);
    if (!entry.services.has(serviceName)) {
      entry.services.set(serviceName, {
        name: serviceName,
        image: str(row.Image),
        ports: str(row.Ports),
      });
    }
  }
  return [...byProject.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, e]) => ({
      project,
      ...(e.configFile ? { configFile: e.configFile } : {}),
      services: [...e.services.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
