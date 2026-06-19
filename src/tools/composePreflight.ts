/**
 * `compose_preflight` (ADR-012) — the pure, I/O-free analyzer at the heart of the
 * tool. It statically predicts the two deploy-time hazards of the shared-netns
 * "one tailscale container, every service behind it" topology *before* a deploy
 * ever produces an opaque HTTP 500:
 *
 *   1. Port collisions inside a shared network namespace (two services in the same
 *      netns claiming the same internal port — the loser silently fails to bind).
 *   2. Netns-provider recreate deadlock (touching the provider's definition forces
 *      a recreate that wedges while dependents are still attached).
 *
 * Per the house invariant (pure core, thin I/O shell — like `denylist.ts`,
 * `healthEvaluators.ts`, `sweepPlanner.ts`) **everything here is a pure function**:
 * the handler (`composePreflightHandler`) does the SSH/`pct pull`/probe I/O and
 * hands plain structured data to `analyzeCompose`. There is no audit record and no
 * backup — this tool only ever reads and reasons.
 */
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface ComposeService {
  name: string;
  image?: string;
  /** Raw `network_mode` value, e.g. "service:tailscale" or "container:abc". */
  networkMode?: string;
  /** Published-port specs as written (`"8080:80"`, `"80"`, long-form folded to a string). */
  ports: string[];
  /** `expose:` entries (container-internal ports). */
  expose: string[];
  /** Environment as a flat key→value map (array and map forms both folded here). */
  environment: Record<string, string>;
  /** Every other top-level key of the service, for change detection (§3.2). */
  rawKeys: string[];
}

export interface ComposeModel {
  services: ComposeService[];
}

/** A single port a service is judged to claim, with provenance for severity. */
export interface PortClaim {
  service: string;
  port: number;
  source: "ports" | "expose" | "env-hint";
  raw: string;
}

/** A netns group: the provider (if it is a service in this compose) + its members. */
export interface NetnsGroup {
  /** Netns owner — the service name everyone in the group shares, or an external ref. */
  key: string;
  /** The provider service, when it is defined in this compose (null ⇒ external `container:<id>`). */
  provider: string | null;
  /** All service names sharing this netns (the provider included when present). */
  members: string[];
  /** Dependents = members that attach via `network_mode: service:/container:<key>`. */
  dependents: string[];
  /** True when the netns owner is an external container, not a service in this file. */
  external: boolean;
}

export interface Hazard {
  kind: "port-collision" | "dependent-publishes" | "netns-recreate" | "port-bound-elsewhere";
  severity: "error" | "warn" | "info";
  services: string[];
  port?: number;
  detail: string;
  recommendation: string;
}

export interface BoundPort {
  port: number;
  /** Best-effort identity of who holds it (container/process name), when known. */
  holder?: string;
}

export interface PreflightReport {
  ok: boolean;
  stack: {
    provider: string | null;
    services: string[];
    netnsGroups: Array<{ key: string; provider: string | null; members: string[]; external: boolean }>;
  };
  hazards: Hazard[];
  boundPortsChecked: boolean;
}

/**
 * Well-known env vars that conventionally carry the internal listening port. A
 * best-effort, lower-confidence signal (§3.1) — an env-hint collision is a `warn`,
 * never the hard `error` a real `ports:`/`expose:` duplicate earns. This table is
 * an explicitly-maintained surface (new images, new conventions).
 */
export const PORT_ENV_HINTS: readonly string[] = [
  "PORT",
  "WEBUI_PORT",
  "WEB_PORT",
  "UI_PORT",
  "HTTP_PORT",
  "HTTPS_PORT",
  "SERVER_PORT",
  "LISTEN_PORT",
  "HTTP_PROXY_PORT",
  "HTTPS_PROXY_PORT",
];

// ---------------------------------------------------------------------------
// parseCompose — the thin, fail-soft YAML → model wrapper
// ---------------------------------------------------------------------------

export class ComposeParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComposeParseError";
  }
}

/**
 * Parse compose YAML into a typed `ComposeModel`. A malformed file is a clean,
 * structured `ComposeParseError` (never a thrown stack trace from the YAML lib) —
 * the analyzer must see a typed model, never raw YAML.
 */
export function parseCompose(text: string): ComposeModel {
  let doc: unknown;
  try {
    // `merge: true` resolves YAML `<<` merge keys (anchors + overrides) the way a
    // compose file expects — without it `<<` is read as a literal key and the
    // merged fields silently vanish (a confidently-wrong parse, worse than none).
    doc = parseYaml(text, { merge: true });
  } catch (err) {
    throw new ComposeParseError(`could not parse compose YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined || typeof doc !== "object") {
    throw new ComposeParseError("compose file is empty or not a mapping");
  }
  const servicesRaw = (doc as Record<string, unknown>).services;
  if (servicesRaw === undefined || servicesRaw === null) {
    // A compose file with no services is valid YAML but useless to preflight.
    return { services: [] };
  }
  if (typeof servicesRaw !== "object" || Array.isArray(servicesRaw)) {
    throw new ComposeParseError("`services` must be a mapping of service name → definition");
  }
  const services: ComposeService[] = [];
  for (const [name, defRaw] of Object.entries(servicesRaw as Record<string, unknown>)) {
    const def = (defRaw && typeof defRaw === "object" ? defRaw : {}) as Record<string, unknown>;
    services.push({
      name,
      image: typeof def.image === "string" ? def.image : undefined,
      networkMode: typeof def.network_mode === "string" ? def.network_mode : undefined,
      ports: normalizePorts(def.ports),
      expose: normalizeExpose(def.expose),
      environment: normalizeEnvironment(def.environment),
      rawKeys: Object.keys(def),
    });
  }
  return { services };
}

/** Fold both `ports:` forms (short string, long-form mapping) to canonical strings. */
function normalizePorts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") out.push(entry);
    else if (typeof entry === "number") out.push(String(entry));
    else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      // Long syntax: { target, published, protocol }
      const target = e.target !== undefined ? String(e.target) : "";
      const published = e.published !== undefined ? String(e.published) : "";
      const proto = typeof e.protocol === "string" ? `/${e.protocol}` : "";
      if (published && target) out.push(`${published}:${target}${proto}`);
      else if (target) out.push(`${target}${proto}`);
    }
  }
  return out;
}

function normalizeExpose(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => typeof e === "string" || typeof e === "number").map((e) => String(e));
}

/** `environment:` is either a `["K=V"]` array or a `{K: V}` map — fold to a map. */
function normalizeEnvironment(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq === -1) out[entry] = "";
      else out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === null || v === undefined ? "" : String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Port extraction
// ---------------------------------------------------------------------------

/**
 * The container/internal-side port of a `ports:` spec — the port that actually
 * listens inside the (shared) netns. `8080:80` → 80, `127.0.0.1:8080:80/tcp` → 80,
 * `80` → 80, `80/tcp` → 80. Returns null for an unparseable spec or a port range.
 */
export function containerPortOf(spec: string): number | null {
  const noProto = spec.split("/")[0] ?? "";
  const parts = noProto.split(":");
  const target = parts[parts.length - 1] ?? "";
  if (target.includes("-")) return null; // ranges out of scope (v1)
  const n = parseInt(target, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 && String(n) === target.trim() ? n : null;
}

function portFromScalar(raw: string): number | null {
  const noProto = raw.split("/")[0]?.trim() ?? "";
  if (noProto.includes("-")) return null;
  const n = parseInt(noProto, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 && String(n) === noProto ? n : null;
}

/** Gather every port a service is judged to claim, tagged with provenance. */
export function extractPortClaims(svc: ComposeService): PortClaim[] {
  const out: PortClaim[] = [];
  for (const p of svc.ports) {
    const port = containerPortOf(p);
    if (port !== null) out.push({ service: svc.name, port, source: "ports", raw: p });
  }
  for (const e of svc.expose) {
    const port = portFromScalar(e);
    if (port !== null) out.push({ service: svc.name, port, source: "expose", raw: e });
  }
  for (const hint of PORT_ENV_HINTS) {
    const v = svc.environment[hint];
    if (v === undefined) continue;
    const port = portFromScalar(v);
    if (port !== null) out.push({ service: svc.name, port, source: "env-hint", raw: `${hint}=${v}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// groupByNetns
// ---------------------------------------------------------------------------

/** Parse `network_mode: service:<x>` / `container:<x>` → the owner name, else null. */
export function netnsOwner(networkMode: string | undefined): string | null {
  if (!networkMode) return null;
  const m = networkMode.match(/^(?:service|container):(.+)$/);
  return m ? (m[1] ?? "").trim() || null : null;
}

/**
 * Build netns groups. A service that attaches via `network_mode: service:/container:<p>`
 * joins provider `<p>`'s group; a service with no shared `network_mode` is its own
 * (single-member) group and cannot collide with anything (its own netns). Returns
 * one group per distinct netns key, deterministic (insertion order of services).
 */
export function groupByNetns(model: ComposeModel): NetnsGroup[] {
  const names = new Set(model.services.map((s) => s.name));
  const byKey = new Map<string, NetnsGroup>();
  const ensure = (key: string): NetnsGroup => {
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        provider: names.has(key) ? key : null,
        members: [],
        dependents: [],
        external: !names.has(key),
      };
      byKey.set(key, g);
    }
    return g;
  };
  for (const svc of model.services) {
    const owner = netnsOwner(svc.networkMode);
    const key = owner ?? svc.name; // own netns when no shared network_mode
    const g = ensure(key);
    if (!g.members.includes(svc.name)) g.members.push(svc.name);
    if (owner !== null) g.dependents.push(svc.name);
  }
  // The provider's own group membership: if a provider service exists but never
  // declared its own group (it had its own network_mode pointing elsewhere — rare),
  // it is still recorded via ensure above. Ensure provider is listed as a member.
  for (const g of byKey.values()) {
    if (g.provider && !g.members.includes(g.provider) && names.has(g.provider)) {
      g.members.unshift(g.provider);
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Check 3.1 — port collisions across a shared netns (+ dependent-publishes)
// ---------------------------------------------------------------------------

export function detectPortCollisions(
  groups: NetnsGroup[],
  claims: PortClaim[],
  model: ComposeModel
): Hazard[] {
  const hazards: Hazard[] = [];
  const claimsByService = new Map<string, PortClaim[]>();
  for (const c of claims) {
    const list = claimsByService.get(c.service) ?? [];
    list.push(c);
    claimsByService.set(c.service, list);
  }

  // 3.1a — a dependent that publishes its own ports: is itself an error. Only the
  // netns owner may publish; a dependent's `ports:` is silently ignored by Docker.
  const svcByName = new Map(model.services.map((s) => [s.name, s]));
  for (const g of groups) {
    for (const dep of g.dependents) {
      const svc = svcByName.get(dep);
      if (svc && svc.ports.length > 0) {
        hazards.push({
          kind: "dependent-publishes",
          severity: "error",
          services: [dep],
          detail:
            `${dep} declares ports: but attaches to ${g.key}'s network namespace ` +
            `(network_mode). Published ports must live on the netns owner (${g.key}); ` +
            `Docker ignores a dependent's ports:.`,
          recommendation: `Move ${dep}'s published ports onto the ${g.key} service definition.`,
        });
      }
    }
  }

  // 3.1b — within each shared group (>1 member), flag any internal port claimed by
  // two distinct services. Severity follows the lowest-confidence source involved.
  for (const g of groups) {
    if (g.members.length < 2) continue; // single-member netns: no shared collision
    const byPort = new Map<number, PortClaim[]>();
    for (const member of g.members) {
      for (const c of claimsByService.get(member) ?? []) {
        const list = byPort.get(c.port) ?? [];
        list.push(c);
        byPort.set(c.port, list);
      }
    }
    for (const [port, list] of byPort) {
      const services = [...new Set(list.map((c) => c.service))];
      if (services.length < 2) continue; // same service twice ≠ collision
      const anyEnvHint = list.some((c) => c.source === "env-hint");
      const severity: Hazard["severity"] = anyEnvHint ? "warn" : "error";
      hazards.push({
        kind: "port-collision",
        severity,
        services,
        port,
        detail:
          `internal port ${port} is claimed by ${services.join(" and ")} inside ${g.key}'s shared ` +
          `network namespace (${list.map((c) => `${c.service}:${c.source}`).join(", ")}).` +
          (anyEnvHint ? " (one or more claims derive from an env hint — lower confidence.)" : ""),
        recommendation: `Assign a distinct internal port to one of: ${services.join(", ")}.`,
      });
    }
  }
  return hazards;
}

// ---------------------------------------------------------------------------
// Check 3.2 — netns-provider recreate deadlock
// ---------------------------------------------------------------------------

/** Provider services that have ≥1 dependent (the recreate-deadlock candidates). */
function providersWithDependents(groups: NetnsGroup[]): NetnsGroup[] {
  return groups.filter((g) => g.provider !== null && g.dependents.length > 0);
}

/** Has the provider's definition changed between prev and next? (ports/image/any field) */
function providerChanged(prev: ComposeService, next: ComposeService): boolean {
  if (prev.image !== next.image) return true;
  if (prev.networkMode !== next.networkMode) return true;
  if (prev.ports.join(",") !== next.ports.join(",")) return true;
  if (prev.expose.join(",") !== next.expose.join(",")) return true;
  if (JSON.stringify(prev.environment) !== JSON.stringify(next.environment)) return true;
  // Any structural key added/removed counts as a recreate-forcing change.
  if (prev.rawKeys.slice().sort().join(",") !== next.rawKeys.slice().sort().join(",")) return true;
  return false;
}

export function detectNetnsRecreate(next: ComposeModel, prev?: ComposeModel): Hazard[] {
  const groups = groupByNetns(next);
  const candidates = providersWithDependents(groups);
  const hazards: Hazard[] = [];
  const prevByName = prev ? new Map(prev.services.map((s) => [s.name, s])) : undefined;
  const nextByName = new Map(next.services.map((s) => [s.name, s]));

  for (const g of candidates) {
    const provider = g.provider!;
    if (prevByName) {
      const before = prevByName.get(provider);
      const after = nextByName.get(provider);
      // A provider newly introduced, removed, or with a changed definition forces a recreate.
      const changed = !before || !after || providerChanged(before, after);
      if (changed) {
        hazards.push({
          kind: "netns-recreate",
          severity: "error",
          services: [provider, ...g.dependents],
          detail:
            `the netns provider ${provider} changed; recreating it will wedge while its ${g.dependents.length} ` +
            `dependent(s) (${g.dependents.join(", ")}) are attached — an in-place \`up -d\` deadlocks (HTTP 500).`,
          recommendation:
            `Do a full \`down\` then \`up\` (or stop the dependents first): \`compose_redeploy\` (up -d) alone will not suffice.`,
        });
      }
    } else {
      // Degraded mode (§3.2): no prev to diff against — emit a conservative reminder.
      hazards.push({
        kind: "netns-recreate",
        severity: "info",
        services: [provider, ...g.dependents],
        detail:
          `${provider} is a netns provider with ${g.dependents.length} dependent(s) ` +
          `(${g.dependents.join(", ")}). Any change to ${provider}'s definition forces a recreate that wedges ` +
          `while dependents are attached. (No previous version supplied, so this is a reminder, not a detected change.)`,
        recommendation: `If this deploy edits ${provider}, do a full \`down\`/\`up\` rather than an in-place \`up -d\`.`,
      });
    }
  }
  return hazards;
}

// ---------------------------------------------------------------------------
// Check 3.3 — live bound-port cross-check
// ---------------------------------------------------------------------------

export function crossCheckBoundPorts(
  claims: PortClaim[],
  bound: BoundPort[],
  ownNames: string[]
): Hazard[] {
  const own = new Set(ownNames);
  const boundByPort = new Map<number, BoundPort>();
  for (const b of bound) if (!boundByPort.has(b.port)) boundByPort.set(b.port, b);

  const hazards: Hazard[] = [];
  const seen = new Set<number>();
  for (const c of claims) {
    const b = boundByPort.get(c.port);
    if (!b) continue;
    if (seen.has(c.port)) continue;
    // Bound by one of our own stack's services ⇒ that's expected (it's us), ignore.
    if (b.holder && own.has(b.holder)) continue;
    seen.add(c.port);
    // A *known* foreign holder is a hard error. An *unknown* holder is only a warn:
    // without identity we cannot rule out that the binding is our own already-running
    // instance of this very service (the TOCTOU/identity honesty of §3.3, §7).
    const severity: Hazard["severity"] = b.holder ? "error" : "warn";
    hazards.push({
      kind: "port-bound-elsewhere",
      severity,
      services: [c.service],
      port: c.port,
      detail:
        `${c.service} wants internal port ${c.port}, but it is already bound in the guest` +
        (b.holder ? ` by ${b.holder}` : " (holder unknown — possibly your own running instance)") +
        ` — the deploy may fail to bind (the 500 you'd otherwise debug by hand).`,
      recommendation: `Pick a free internal port for ${c.service} (current binding holder: ${b.holder ?? "unknown"}).`,
    });
  }
  return hazards;
}

// ---------------------------------------------------------------------------
// ss -tlnp parsing (pure) — the higher-fidelity bound-port probe parser
// ---------------------------------------------------------------------------

/**
 * Parse `ss -tlnp` (or `ss -tln`) listener rows into bound ports with a best-effort
 * holder name pulled from the `users:(("name",...))` tail. Lines without that tail
 * (no `-p`, or no permission) yield a port with no holder. The local-address column
 * is `ADDR:PORT`; we take the port after the last colon. Header/blank rows skipped.
 */
export function parseSsListeners(output: string): BoundPort[] {
  const out: BoundPort[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^State\b/i.test(trimmed) || /^Netid\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    // Local address column: index varies (Netid present or not). Find the token that
    // looks like ADDR:PORT and is followed by a peer addr — take the 4th-from-end-ish.
    // ss -tln columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port [Process]
    let localCol: string | undefined;
    for (let i = 0; i < cols.length; i++) {
      const tok = cols[i] ?? "";
      if (/:\d+$/.test(tok) || /:\*$/.test(tok)) {
        localCol = tok;
        break;
      }
    }
    if (!localCol) {
      // Fall back to a fixed position when the heuristic misses.
      localCol = cols.length >= 4 ? cols[3] : undefined;
    }
    if (!localCol) continue;
    const colon = localCol.lastIndexOf(":");
    if (colon === -1) continue;
    const port = parseInt(localCol.slice(colon + 1), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const holderMatch = trimmed.match(/users:\(\("([^"]+)"/);
    const holder = holderMatch ? holderMatch[1] : undefined;
    const key = `${port}:${holder ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(holder ? { port, holder } : { port });
  }
  return out;
}

// ---------------------------------------------------------------------------
// analyzeCompose — the orchestrating pure fn
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  prev?: ComposeModel;
  bound?: BoundPort[];
  /** When false, the bound-port cross-check is skipped and reported as not-checked. */
  boundPortsChecked?: boolean;
}

export function analyzeCompose(next: ComposeModel, opts: AnalyzeOptions = {}): PreflightReport {
  const groups = groupByNetns(next);
  const claims = next.services.flatMap(extractPortClaims);

  const hazards: Hazard[] = [
    ...detectPortCollisions(groups, claims, next),
    ...detectNetnsRecreate(next, opts.prev),
  ];

  const boundPortsChecked = Boolean(opts.boundPortsChecked && opts.bound);
  if (boundPortsChecked) {
    hazards.push(...crossCheckBoundPorts(claims, opts.bound!, next.services.map((s) => s.name)));
  }

  // The dominant provider: the netns owner with the most dependents (the tailscale
  // role in this topology). null when no service is anyone's netns provider.
  const providerGroups = providersWithDependents(groups).sort(
    (a, b) => b.dependents.length - a.dependents.length
  );
  const provider = providerGroups[0]?.provider ?? null;

  return {
    ok: !hazards.some((h) => h.severity === "error"),
    stack: {
      provider,
      services: next.services.map((s) => s.name),
      netnsGroups: groups.map((g) => ({
        key: g.key,
        provider: g.provider,
        members: g.members,
        external: g.external,
      })),
    },
    hazards,
    boundPortsChecked,
  };
}

// ---------------------------------------------------------------------------
// /proc/net/tcp parsing (pure) — the bound-port probe's parser
// ---------------------------------------------------------------------------

/**
 * Parse the listening ports out of `/proc/net/tcp` + `/proc/net/tcp6`. Each data
 * row's 2nd column is `LOCALADDR:PORT` in hex; state `0A` is LISTEN. Returns the
 * set of listening local ports. Tolerant of headers/blank/short lines.
 */
export function parseProcNetTcpPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1] ?? "";
    const state = cols[3] ?? "";
    if (state.toUpperCase() !== "0A") continue; // LISTEN only
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    const hexPort = local.slice(colon + 1);
    const port = parseInt(hexPort, 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
