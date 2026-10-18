/**
 * Pure core of the ADR-025 container update workflow — `docker_restart`,
 * `image_updates`, `compose_update`. Command builders, output parsers, and the
 * decision functions (update classification, version extraction, Diun parsing,
 * tag ranking, Watchtower ownership, netns dependents, health evaluation). No I/O:
 * the handlers (`dockerRestart.ts`, `imageUpdates.ts`, `composeUpdate.ts`) wrap
 * every inner command with `buildPctExecCommand` and feed the output back here.
 *
 * Every caller-supplied string that reaches a shell is either charset-validated
 * (container/service/project names, image refs) or single-quoted.
 */
import { shSingleQuote } from "../ssh/command.js";
import { parseEnvFileLabel, parsePortMap, type DockerPortMap } from "./dockerHelpers.js";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** Field separator for the batched `--format` templates (a tab; values never contain one). */
const SEP = "\t";

/** Docker's `--format` prints `<no value>` for a missing map key on some versions — fold to "". */
function clean(v: string | undefined): string {
  const s = (v ?? "").trim();
  return s === "<no value>" ? "" : s;
}

// ---------------------------------------------------------------------------
// Image references
// ---------------------------------------------------------------------------

/**
 * Image-ref charset gate before interpolation: registry host[:port], path
 * components, optional `:tag`, optional `@sha256:…`. Deliberately narrower than
 * the full reference grammar — anything else is refused, never quoted-and-hoped.
 */
const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;

export function assertImageRef(ref: string): void {
  if (!IMAGE_REF_RE.test(ref) || ref.length > 512) {
    throw new Error(`Invalid image reference: ${JSON.stringify(ref)}.`);
  }
}

export interface ParsedImageRef {
  /** Fully-qualified repository: `docker.io/library/nginx`, `lscr.io/linuxserver/sonarr`. */
  name: string;
  /** Repository exactly as written, without tag/digest (`nginx`, `lscr.io/linuxserver/sonarr`). */
  repo: string;
  tag?: string;
  digest?: string;
}

/**
 * Parse + normalize a Docker image reference. The default registry is `docker.io`
 * and single-segment Docker Hub names live under `library/` — Diun stores names
 * fully qualified (ADR-025 §0), so lookups go through `name`.
 */
export function parseImageRef(ref: string): ParsedImageRef {
  let rest = ref.trim();
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  const repo = rest;
  const parts = repo.split("/");
  const first = parts[0] ?? "";
  const hasRegistry = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  let name: string;
  if (hasRegistry) {
    name = repo;
  } else if (parts.length === 1) {
    name = `docker.io/library/${repo}`;
  } else {
    name = `docker.io/${repo}`;
  }
  if (name.startsWith("index.docker.io/")) name = "docker.io/" + name.slice("index.docker.io/".length);
  return { name: name.toLowerCase(), repo, ...(tag !== undefined && { tag }), ...(digest !== undefined && { digest }) };
}

/** Same as `parseImageRef(ref).name` — the key Diun and RepoDigests are joined on. */
export function normalizeImageName(ref: string): string {
  return parseImageRef(ref).name;
}

/** A ref that names a content digest (`repo@sha256:…`) — nothing to pull/update. */
export function isDigestPinned(ref: string): boolean {
  return parseImageRef(ref).digest !== undefined;
}

/** The local RepoDigests entry for `ref`'s repository, as a bare `sha256:` digest. */
export function localDigestFor(ref: string, repoDigests: string[]): string | null {
  const want = normalizeImageName(ref);
  for (const rd of repoDigests) {
    const p = parseImageRef(rd);
    if (p.name === want && p.digest && DIGEST_RE.test(p.digest)) return p.digest;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version labels
// ---------------------------------------------------------------------------

/**
 * The human version an image declares: `org.opencontainers.image.version`, else the
 * linuxserver `build_version` label's `version:- X` segment, else null. Never
 * inferred from the tag (a tag like `latest` says nothing).
 */
export function extractImageVersion(ociVersion: string | undefined, buildVersion: string | undefined): string | null {
  const oci = clean(ociVersion);
  if (oci) return oci;
  const m = clean(buildVersion).match(/version:-\s*(\S+)/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Container identity batch (image_updates / compose_update)
// ---------------------------------------------------------------------------

export interface ContainerIdentity {
  name: string;
  id: string;
  /** Configured ref (`.Config.Image`). */
  ref: string;
  /** Resolved local image id (`.Image`). */
  imageId: string;
  state: string;
  composeProject: string;
  composeService: string;
  composeConfigFiles: string;
  /** `com.centurylinklabs.watchtower.enable` label value ("" when absent). */
  watchtowerLabel: string;
  /** `diun.enable` label value ("" when absent). */
  diunLabel: string;
  /** `diun.watch_repo` label value ("" when absent). */
  diunWatchRepoLabel: string;
  networkMode: string;
  /** `com.docker.compose.project.environment_file` label ("" when absent): the --env-file paths. */
  composeEnvFiles: string;
  /** Published port bindings (`.NetworkSettings.Ports`); empty for a container in another's netns. */
  publishedPorts: DockerPortMap[];
}

const IDENTITY_FORMAT = [
  "{{.Name}}",
  "{{.Id}}",
  "{{.Config.Image}}",
  "{{.Image}}",
  "{{.State.Status}}",
  '{{index .Config.Labels "com.docker.compose.project"}}',
  '{{index .Config.Labels "com.docker.compose.service"}}',
  '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
  '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}',
  '{{index .Config.Labels "diun.enable"}}',
  '{{index .Config.Labels "diun.watch_repo"}}',
  "{{.HostConfig.NetworkMode}}",
  '{{index .Config.Labels "com.docker.compose.project.environment_file"}}',
  "{{json .NetworkSettings.Ports}}",
].join(SEP);

/** One identity row per running container (`all` includes stopped ones). */
export function buildContainerIdentityCommand(all = false): string {
  return `docker ps -q --no-trunc${all ? " -a" : ""} | xargs -r docker inspect --format ${shSingleQuote(IDENTITY_FORMAT)}`;
}

/** Identity rows for specific containers (names are charset-validated by the caller). */
export function buildContainerIdentityForCommand(names: string[]): string {
  return `docker inspect --format ${shSingleQuote(IDENTITY_FORMAT)} ${names.map(shSingleQuote).join(" ")}`;
}

export function parseContainerIdentities(output: string): ContainerIdentity[] {
  const out: ContainerIdentity[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 12) continue;
    out.push({
      name: clean(f[0]).replace(/^\//, ""),
      id: clean(f[1]),
      ref: clean(f[2]),
      imageId: clean(f[3]),
      state: clean(f[4]),
      composeProject: clean(f[5]),
      composeService: clean(f[6]),
      composeConfigFiles: clean(f[7]),
      watchtowerLabel: clean(f[8]),
      diunLabel: clean(f[9]),
      diunWatchRepoLabel: clean(f[10]),
      networkMode: clean(f[11]),
      composeEnvFiles: clean(f[12]),
      publishedPorts: parsePortsJson(f[13]),
    });
  }
  return out;
}

function parsePortsJson(v: string | undefined): DockerPortMap[] {
  const s = clean(v);
  if (!s || s === "null") return [];
  try {
    return parsePortMap(JSON.parse(s));
  } catch {
    return [];
  }
}

export interface LocalImageInfo {
  id: string;
  repoDigests: string[];
  version: string | null;
}

/**
 * Labels are read from `{{json .Config}}` and picked apart here, never with
 * `{{index .Config.Labels …}}` in the template: an image built with no labels has no
 * `Labels` key at all, and the CLI's raw-map template fallback then fails the WHOLE
 * batched inspect ("map has no entry for key Labels") — `{{with .Config.Labels}}`
 * does not help, the field lookup itself is what errors (verified on a containerd
 * image store). `json` of a missing/nil Config prints `null`.
 */
const IMAGE_FORMAT = ["{{.Id}}", "{{json .RepoDigests}}", "{{json .Config}}"].join(SEP);

/** RepoDigests + version labels for the given image ids (the ADR-016 §1 second round trip, batched). */
export function buildImageInfoCommand(imageIds: string[]): string {
  const ids = imageIds.filter((i) => DIGEST_RE.test(i));
  if (ids.length === 0) return "true";
  return `docker image inspect --format ${shSingleQuote(IMAGE_FORMAT)} ${ids.join(" ")}`;
}

/** String labels from a `{{json .Config}}` field; anything absent/malformed ⇒ `{}`. */
function labelsFromConfigJson(field: string | undefined): Record<string, string> {
  try {
    const cfg: unknown = JSON.parse(clean(field) || "null");
    const labels = cfg && typeof cfg === "object" ? (cfg as { Labels?: unknown }).Labels : undefined;
    if (!labels || typeof labels !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function parseImageInfo(output: string): Map<string, LocalImageInfo> {
  const out = new Map<string, LocalImageInfo>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split(SEP);
    const id = clean(f[0]);
    if (!id) continue;
    let repoDigests: string[] = [];
    try {
      const parsed = JSON.parse(clean(f[1]) || "[]");
      if (Array.isArray(parsed)) repoDigests = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      repoDigests = [];
    }
    const labels = labelsFromConfigJson(f[2]);
    out.set(id, {
      id,
      repoDigests,
      version: extractImageVersion(labels["org.opencontainers.image.version"], labels["build_version"]),
    });
  }
  return out;
}

/**
 * Pick env values by NAME from a container (`docker inspect` `.Config.Env` + `.Args`).
 * Only the named keys are ever returned — this reads Watchtower/Diun schedule
 * settings without lifting the rest of the env (which may hold secrets).
 */
export function buildEnvArgsCommand(container: string): string {
  return `docker inspect --format ${shSingleQuote("{{json .Config.Env}}" + SEP + "{{json .Args}}")} ${shSingleQuote(container)}`;
}

export function pickEnv(output: string, keys: readonly string[]): { env: Record<string, string>; args: string[] } {
  const [envJson, argsJson] = output.trim().split(SEP);
  const env: Record<string, string> = {};
  let args: string[] = [];
  try {
    const list = JSON.parse(envJson ?? "[]");
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry !== "string") continue;
        const eq = entry.indexOf("=");
        const k = eq === -1 ? entry : entry.slice(0, eq);
        if (keys.includes(k)) env[k] = eq === -1 ? "" : entry.slice(eq + 1);
      }
    }
  } catch {
    /* unreadable env ⇒ nothing picked */
  }
  try {
    const a = JSON.parse(argsJson ?? "[]");
    if (Array.isArray(a)) args = a.filter((x): x is string => typeof x === "string");
  } catch {
    args = [];
  }
  return { env, args };
}

// ---------------------------------------------------------------------------
// Watchtower ownership
// ---------------------------------------------------------------------------

export interface WatchtowerInfo {
  container: string;
  schedule: string | null;
  labelEnable: boolean;
  cleanup: boolean;
}

export const WATCHTOWER_ENV_KEYS = [
  "WATCHTOWER_LABEL_ENABLE",
  "WATCHTOWER_CLEANUP",
  "WATCHTOWER_SCHEDULE",
  "WATCHTOWER_POLL_INTERVAL",
] as const;

const WATCHTOWER_REPOS = new Set([
  "docker.io/containrrr/watchtower",
  "docker.io/nickfedor/watchtower",
  "docker.io/beatkind/watchtower",
  "ghcr.io/containrrr/watchtower",
  "ghcr.io/nicholas-fedor/watchtower",
]);

export function isWatchtowerImage(ref: string): boolean {
  return WATCHTOWER_REPOS.has(normalizeImageName(ref));
}

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? "").trim());

export function parseWatchtowerConfig(container: string, env: Record<string, string>, args: string[]): WatchtowerInfo {
  const argVal = (flag: string): string | undefined => {
    const i = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
    if (i === -1) return undefined;
    const a = args[i] ?? "";
    return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
  };
  const schedule = env.WATCHTOWER_SCHEDULE ?? argVal("--schedule") ?? null;
  const poll = env.WATCHTOWER_POLL_INTERVAL ?? argVal("--interval");
  return {
    container,
    schedule: schedule ?? (poll ? `every ${poll}s` : null),
    labelEnable: truthy(env.WATCHTOWER_LABEL_ENABLE) || args.includes("--label-enable"),
    cleanup: truthy(env.WATCHTOWER_CLEANUP) || args.includes("--cleanup"),
  };
}

/**
 * Would a running Watchtower update this container? With `LABEL_ENABLE` only
 * containers labelled `com.centurylinklabs.watchtower.enable=true`; without it,
 * everything not labelled `false`. (Watchtower scopes / positional name lists are
 * not modelled — an honest over-approximation in the safe direction.)
 */
export function watchtowerManages(wt: WatchtowerInfo | null, c: ContainerIdentity): boolean {
  if (!wt) return false;
  if (c.name === wt.container) return false;
  const label = c.watchtowerLabel.toLowerCase();
  return wt.labelEnable ? label === "true" : label !== "false";
}

// ---------------------------------------------------------------------------
// Registry check (buildx imagetools)
// ---------------------------------------------------------------------------

export interface RemoteDigestResult {
  ref: string;
  digest: string | null;
  error?: string;
}

/**
 * One loop in the LXC resolving each ref's remote index digest via
 * `docker buildx imagetools inspect --format '{{.Manifest.Digest}}'` (inherits the
 * daemon's registry credentials). Per-ref isolation: a failure prints its error on
 * its own row and the loop continues. Refs are charset-validated by the caller.
 */
export function buildRemoteDigestCommand(refs: string[]): string {
  if (refs.length === 0) return "true";
  const list = refs.map(shSingleQuote).join(" ");
  return (
    `for r in ${list}; do ` +
    `out=$(docker buildx imagetools inspect "$r" --format '{{.Manifest.Digest}}' 2>&1); rc=$?; ` +
    `printf '%s\\t%s\\t%s\\n' "$r" "$rc" "$(printf '%s' "$out" | tr '\\n\\t' '  ' | cut -c1-300)"; ` +
    `done`
  );
}

export function parseRemoteDigests(output: string): Map<string, RemoteDigestResult> {
  const out = new Map<string, RemoteDigestResult>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [ref = "", rc = "", rest = ""] = line.split(SEP);
    const text = rest.trim();
    if (rc === "0" && DIGEST_RE.test(text)) {
      out.set(ref, { ref, digest: text });
    } else {
      out.set(ref, { ref, digest: null, error: text || `exit ${rc}` });
    }
  }
  return out;
}

export type UpdateStatus = "up-to-date" | "update-available" | "pinned" | "unknown";

/**
 * The update verdict for one container. Compares INDEX digests (what RepoDigests
 * records on pull and what imagetools/Diun report) — never per-platform digests,
 * which would report a false update on every multi-arch image.
 */
export function classifyImageUpdate(input: {
  ref: string;
  localDigest: string | null;
  remote: RemoteDigestResult | undefined;
}): { status: UpdateStatus; reason?: string } {
  if (isDigestPinned(input.ref)) return { status: "pinned", reason: "ref is digest-pinned; change it by editing the compose file" };
  if (DIGEST_RE.test(input.ref)) return { status: "unknown", reason: "container was created from a bare image id (no ref to check)" };
  if (!input.localDigest) return { status: "unknown", reason: "local-image (no registry digest; built or loaded locally)" };
  if (!input.remote) return { status: "unknown", reason: "registry not checked" };
  if (!input.remote.digest) return { status: "unknown", reason: `registry check failed: ${input.remote.error ?? "no digest"}` };
  return input.remote.digest === input.localDigest ? { status: "up-to-date" } : { status: "update-available" };
}

// ---------------------------------------------------------------------------
// Diun (v4.33.0 fixture-pinned; ADR-025 §0)
// ---------------------------------------------------------------------------

export interface DiunManifest {
  tag: string;
  digest: string;
  created: string;
  version: string | null;
}

export interface DiunImage {
  name: string;
  manifestsCount: number;
  latest: DiunManifest | null;
}

export class DiunParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DiunParseError";
  }
}

function toManifest(raw: unknown): DiunManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.tag !== "string" || typeof m.digest !== "string") return null;
  const labels = (m.labels && typeof m.labels === "object" ? m.labels : {}) as Record<string, unknown>;
  const lab = (k: string): string | undefined => (typeof labels[k] === "string" ? (labels[k] as string) : undefined);
  return {
    tag: m.tag,
    digest: m.digest,
    created: typeof m.created === "string" ? m.created : "",
    version: extractImageVersion(lab("org.opencontainers.image.version"), lab("build_version")),
  };
}

/** Find the first JSON object in mixed output (Diun may log lines before it). */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new DiunParseError("no JSON object in output");
  try {
    return JSON.parse(text.slice(start));
  } catch (err) {
    throw new DiunParseError(`invalid JSON: ${(err as Error).message}`);
  }
}

/** `diun image list --raw` → `{images:[{name, manifestsCount:"<n>", latest:{…}}]}`. */
export function parseDiunImageList(output: string): DiunImage[] {
  const doc = firstJsonObject(output) as Record<string, unknown>;
  if (doc && (doc as { level?: unknown }).level === "fatal") {
    throw new DiunParseError(`diun error: ${String((doc as { error?: unknown }).error ?? "fatal")}`);
  }
  if (!doc || !Array.isArray(doc.images)) throw new DiunParseError("missing `images` array");
  return doc.images.map((raw) => {
    const im = (raw ?? {}) as Record<string, unknown>;
    const count = typeof im.manifestsCount === "number" ? im.manifestsCount : parseInt(String(im.manifestsCount ?? ""), 10);
    if (typeof im.name !== "string" || !Number.isFinite(count)) {
      throw new DiunParseError("image entry without name / numeric manifestsCount");
    }
    return { name: im.name.toLowerCase(), manifestsCount: count, latest: toManifest(im.latest) };
  });
}

/**
 * `diun image inspect --image <name> --raw` → `{image:{name, manifests:[…]}}`. A
 * name Diun does not track prints a `{"level":"fatal",…"not found in database"}`
 * log line (independent of exit code) → `null`.
 */
export function parseDiunImageInspect(output: string): DiunManifest[] | null {
  const doc = firstJsonObject(output) as Record<string, unknown>;
  if (doc && doc.level === "fatal") {
    if (/not found/i.test(String(doc.error ?? ""))) return null;
    throw new DiunParseError(`diun error: ${String(doc.error ?? "fatal")}`);
  }
  const image = doc?.image as Record<string, unknown> | undefined;
  if (!image || !Array.isArray(image.manifests)) throw new DiunParseError("missing `image.manifests` array");
  return image.manifests.map(toManifest).filter((m): m is DiunManifest => m !== null);
}

const DIUN_REPOS = new Set(["docker.io/crazymax/diun", "ghcr.io/crazy-max/diun"]);

export function isDiunImage(ref: string): boolean {
  return DIUN_REPOS.has(normalizeImageName(ref));
}

/** Diun CLI calls run inside the Diun container (talks to its local gRPC API). */
export function buildDiunListCommand(diunContainer: string): string {
  const c = shSingleQuote(diunContainer);
  return `docker exec ${c} diun --version; echo '@@DIUN@@'; docker exec ${c} diun image list --raw`;
}

export function splitDiunListOutput(output: string): { version: string | null; body: string } {
  const i = output.indexOf("@@DIUN@@");
  if (i === -1) return { version: null, body: output };
  const v = output.slice(0, i).trim().split("\n")[0]?.trim() ?? "";
  return { version: v || null, body: output.slice(i + "@@DIUN@@".length) };
}

/** Batched inspects for repos where Diun tracks more than one tag; names are Diun's own. */
export function buildDiunInspectCommand(diunContainer: string, names: string[]): string {
  const c = shSingleQuote(diunContainer);
  return names
    .map((n) => `echo ${shSingleQuote("@@IMG@@" + n)}; docker exec ${c} diun image inspect --image ${shSingleQuote(n)} --raw 2>&1`)
    .join("; ");
}

export function splitDiunInspectOutput(output: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = output.split("@@IMG@@");
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const name = (nl === -1 ? part : part.slice(0, nl)).trim();
    out.set(name, nl === -1 ? "" : part.slice(nl + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tag candidates (choosing a version)
// ---------------------------------------------------------------------------

export interface TagCandidate {
  tag: string;
  digest: string;
  created: string;
  version: string | null;
  /** True when this tag's digest is the one the container runs. */
  current: boolean;
}

const VERSION_TAG_RE = /^(v?)(\d+(?:\.\d+)*)(.*)$/;

function versionParts(tag: string): { v: string; nums: number[]; suffix: string } | null {
  const m = tag.match(VERSION_TAG_RE);
  if (!m) return null;
  return { v: m[1] ?? "", nums: (m[2] ?? "").split(".").map((n) => parseInt(n, 10)), suffix: m[3] ?? "" };
}

function compareNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Rank the tags Diun has seen for a repo, for version choice. A version-shaped
 * running tag (`1.2.3`, `v11`, `4.0.20-ls327`) keeps version-shaped tags with the
 * same `v` prefix; a moving tag (`latest`, `stable`, `master-omnibus`) also gets
 * the version-shaped tags — those are what you would pin to. Ordered newest
 * version first (numeric components, then created time), capped at `max`; the
 * tag(s) whose digest equals the running digest are marked `current`.
 */
export function rankCandidateTags(
  currentTag: string | undefined,
  runningDigest: string | null,
  manifests: DiunManifest[],
  max: number
): TagCandidate[] {
  const cur = currentTag ? versionParts(currentTag) : null;
  const versioned = manifests.filter((m) => {
    const p = versionParts(m.tag);
    if (!p) return false;
    return cur ? p.v === cur.v : true;
  });
  versioned.sort((a, b) => {
    const d = compareNums(versionParts(b.tag)!.nums, versionParts(a.tag)!.nums);
    return d !== 0 ? d : b.created.localeCompare(a.created);
  });
  const seen = new Set<string>();
  const out: TagCandidate[] = [];
  for (const m of versioned) {
    if (seen.has(m.tag)) continue;
    seen.add(m.tag);
    out.push({ ...m, current: runningDigest !== null && m.digest === runningDigest });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// docker_restart — netns dependents
// ---------------------------------------------------------------------------

/**
 * Running containers whose network namespace IS the target's (`NetworkMode`
 * `container:<id|name>` — compose's `service:<x>` resolves to `container:<id>` at
 * create time). Restarting the provider tears that namespace down under them.
 */
export function findNetnsDependents(target: ContainerIdentity, all: ContainerIdentity[]): ContainerIdentity[] {
  return all.filter((c) => {
    if (c.id === target.id) return false;
    const m = c.networkMode.match(/^container:(.+)$/);
    if (!m) return false;
    const ref = (m[1] ?? "").trim();
    return ref === target.name || ref === target.id || (ref.length >= 12 && target.id.startsWith(ref));
  });
}

export function buildDockerRestartCommand(containers: string[], timeoutSec?: number): string {
  const t = timeoutSec !== undefined ? ` -t ${Math.max(0, Math.floor(timeoutSec))}` : "";
  return `docker restart${t} ${containers.map(shSingleQuote).join(" ")}`;
}

// ---------------------------------------------------------------------------
// compose_update — invocation, hold tag, health
// ---------------------------------------------------------------------------

/** Compose project names: lowercase alnum, `_`, `-`, starting alnum (compose's own rule). */
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Compose service names (and tag-safe): alnum start, then alnum `_` `.` `-`. */
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function assertComposeProject(p: string): void {
  if (!PROJECT_RE.test(p)) throw new Error(`Invalid compose project name: ${JSON.stringify(p)}.`);
}

export function assertComposeService(s: string): void {
  if (!SERVICE_RE.test(s) || s.length > 100) throw new Error(`Invalid compose service name: ${JSON.stringify(s)}.`);
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/**
 * `cd <dir> && docker compose -p <project> -f <file> <args>`. Explicit `-p` (don't
 * derive the project from the directory name) and running from the file's
 * directory (so its sibling `.env` loads) match how Portainer deploys a stack.
 */
/**
 * `docker compose` for one project. `envFiles` are the project's recorded
 * `--env-file` paths (ADR-027 — from the environment_file label); compose reads
 * them on the node, the server only passes the paths. `--env-file` is a global
 * flag, so it precedes the subcommand.
 */
export function buildComposeCommand(composePath: string, project: string, args: string, envFiles: string[] = []): string {
  const env = envFiles.map((f) => ` --env-file ${shSingleQuote(f)}`).join("");
  return `cd ${shSingleQuote(posixDirname(composePath))} && docker compose -p ${project} -f ${shSingleQuote(composePath)}${env} ${args}`;
}

/** The env files a running service container was started with (ADR-027). */
export function envFilesFor(c: Pick<ContainerIdentity, "composeEnvFiles">): { files: string[]; rejected: string[] } {
  return parseEnvFileLabel(c.composeEnvFiles);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WILDCARD_IPS = new Set(["", "0.0.0.0", "::"]);

/**
 * ADR-027 — would a probe URL curled from inside the LXC reach one of the
 * container's published bindings? Returns a human warning when it clearly would
 * not, or null when it would or when it cannot be judged (a hostname, or a
 * container that shares another container's network namespace, whose bindings
 * live on that provider). Ops finding 2026-10-17: searxng was published on
 * 10.0.0.52:8888 only and the probe targeted 127.0.0.1:8888.
 */
export function probeBindingWarning(
  url: string,
  container: Pick<ContainerIdentity, "name" | "networkMode" | "publishedPorts">
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (/^(container|service):/.test(container.networkMode) || container.networkMode === "host") return null;
  const host = u.hostname.toLowerCase();
  const isIp = /^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[");
  if (!isIp && host !== "localhost") return null;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const onPort = container.publishedPorts.filter((p) => p.hostPort === port);
  const all = container.publishedPorts.map((p) => `${p.hostIp || "0.0.0.0"}:${p.hostPort}`);
  const listing = all.length > 0 ? `published bindings: ${[...new Set(all)].join(", ")}` : "it publishes no ports";
  if (onPort.length === 0) {
    return `probe ${u.host} does not match any port ${container.name} publishes (${listing}); the probe may be wrong.`;
  }
  const reachable = onPort.some(
    (p) =>
      WILDCARD_IPS.has(p.hostIp) ||
      p.hostIp.toLowerCase() === host ||
      (LOOPBACK_HOSTS.has(host) && LOOPBACK_HOSTS.has(p.hostIp))
  );
  if (reachable) return null;
  return (
    `probe targets ${u.host}, but ${container.name} publishes port ${port} only on ` +
    `${onPort.map((p) => p.hostIp).join(", ")} (${listing}); the probe may be wrong.`
  );
}

/** The server-owned rollback hold tag (`mcp-` ownership convention): one per service. */
export function holdTagFor(ref: string, service: string): string {
  return `${parseImageRef(ref).repo}:mcp-hold-${service}`;
}

/** True when `composeConfigFiles` (comma-separated label) names `composePath`. */
export function configFilesInclude(composeConfigFiles: string, composePath: string): boolean {
  return composeConfigFiles
    .split(",")
    .map((s) => s.trim())
    .includes(composePath);
}

export interface HealthSample {
  /** ms since the gate started. */
  t: number;
  status: string;
  /** "healthy" | "unhealthy" | "starting" | "none" (no HEALTHCHECK). */
  health: string;
  restartCount: number;
  restarting: boolean;
}

export const HEALTH_FORMAT = [
  "{{.State.Status}}",
  "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
  "{{.RestartCount}}",
  "{{.State.Restarting}}",
  "{{.Image}}",
].join(SEP);

export function buildHealthSampleCommand(container: string): string {
  return `docker inspect --format ${shSingleQuote(HEALTH_FORMAT)} ${shSingleQuote(container)}`;
}

export function parseHealthSample(output: string, t: number): (HealthSample & { imageId: string }) | null {
  const f = output.trim().split(SEP);
  if (f.length < 5) return null;
  return {
    t,
    status: clean(f[0]),
    health: clean(f[1]) || "none",
    restartCount: parseInt(clean(f[2]), 10) || 0,
    restarting: clean(f[3]) === "true",
    imageId: clean(f[4]),
  };
}

export type HealthVerdict = { state: "pass" | "fail" | "pending"; mode: "healthcheck" | "stability"; detail: string };

/**
 * Pure health gate over the samples so far (ADR-025 §3 step 5), so timing logic is
 * tested without sleeping. With a HEALTHCHECK: healthy ⇒ pass, unhealthy ⇒ fail.
 * Without: running, not restarting, and RestartCount unchanged for `stableMs`. Any
 * exited/dead sample or a RestartCount increase ⇒ fail. The caller turns a
 * still-pending verdict at the deadline into a fail.
 */
export function evaluateHealthPoll(samples: HealthSample[], stableMs: number): HealthVerdict {
  const last = samples[samples.length - 1];
  if (!last) return { state: "pending", mode: "stability", detail: "no samples yet" };
  const mode = samples.some((s) => s.health !== "none") ? "healthcheck" : "stability";
  const base = samples[0]!.restartCount;
  if (samples.some((s) => s.status === "exited" || s.status === "dead")) {
    return { state: "fail", mode, detail: `container ${last.status === "running" ? "exited during the window" : last.status}` };
  }
  if (last.restartCount > base) {
    return { state: "fail", mode, detail: `restart count rose ${base} → ${last.restartCount} (crash loop)` };
  }
  if (mode === "healthcheck") {
    if (last.health === "healthy") return { state: "pass", mode, detail: "HEALTHCHECK reports healthy" };
    if (last.health === "unhealthy") return { state: "fail", mode, detail: "HEALTHCHECK reports unhealthy" };
    return { state: "pending", mode, detail: `HEALTHCHECK ${last.health}` };
  }
  // Stability: the longest trailing run of running && !restarting samples.
  let since: number | null = null;
  for (const s of samples) {
    if (s.status === "running" && !s.restarting) since ??= s.t;
    else since = null;
  }
  if (since !== null && last.t - since >= stableMs) {
    return { state: "pass", mode, detail: `running and stable for ${Math.round((last.t - since) / 1000)}s` };
  }
  return { state: "pending", mode, detail: `${last.status}${last.restarting ? " (restarting)" : ""}` };
}
