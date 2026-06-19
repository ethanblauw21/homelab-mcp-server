import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { buildPctExecCommand, parsePctList, type PctContainer } from "./pctHelpers.js";
import { buildQmAgentPingCommand } from "./qmHelpers.js";
import { buildDockerExecCommand } from "./dockerHelpers.js";
import {
  parsePveVersion,
  parseFreeBytes,
  parseLoadAvg,
  parseGuestConfig,
  parseQmList,
  parsePvesmStatus,
  parseIpBrief,
  parseInterfacesBridges,
  parseTailscaleStatus,
  parseZpoolStatusX,
  parseFailedUnits,
  parseDockerPs,
  findTailscaleContainer,
  evaluateSnapshotCapable,
  type DockerContainer,
  type TailscaleSummary,
  type TailscaleAbsent,
} from "./censusParsers.js";
import { ALL_SECTIONS, CENSUS_SCHEMA_VERSION } from "./censusTypes.js";
import type {
  CensusSections,
  CensusError,
  CensusSection,
  GuestEntry,
  ServiceEntry,
  NodeSection,
  Unavailable,
} from "./censusTypes.js";
import { CensusStore } from "./censusStore.js";
import { diffSnapshots } from "./censusDrift.js";
import { ProbeRunner, runProbe, BudgetExceeded } from "./censusProbe.js";
import {
  finalizeInventory,
  type RawCensusSnapshot,
  type RedactedCensusSnapshot,
} from "./censusInventory.js";
import type { NodeOps } from "../node/nodeOps.js";
import { tierAtLeast, type Tier } from "../tiers/registry.js";

export const DescribeHomelabInputSchema = z.object({
  sections: z
    .array(z.enum(["node", "storage", "network", "containers", "vms", "services", "tailscale"]))
    .optional()
    .describe("Sections to include; defaults to all"),
  depth: z
    .enum(["summary", "status", "full"])
    .default("summary")
    .describe(
      "summary (default): identity + status; status: + snapshotCapable, no config/docker roster; " +
        "full: includes redacted per-guest config + service docker roster"
    ),
  saveSnapshot: z.boolean().default(true).describe("Persist the snapshot locally (default true)"),
  compareToPrevious: z
    .boolean()
    .default(false)
    .describe("Include a drift diff vs the latest stored snapshot"),
});

export type DescribeHomelabInput = z.infer<typeof DescribeHomelabInputSchema>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * #12 — the snapshot `host` field. `cfg.ssh.host` is the source when SSH is
 * configured (companion+), but at observe/operate the census rides the API and
 * `SSH_HOST` is typically unset (empty). Fall back to the API base URL's
 * hostname so the snapshot is never anonymously blank. Malformed/absent URL ⇒
 * "" (honest, never a thrown census).
 */
function censusHost(cfg: Config): string {
  if (cfg.ssh.host) return cfg.ssh.host;
  const base = cfg.api?.baseUrl;
  if (!base) return "";
  try {
    return new URL(base).hostname;
  } catch {
    return "";
  }
}

/**
 * Interpret a `qm config` `agent:` value as enabled/disabled. Proxmox accepts
 * `agent: 1`, `agent: 0`, or `agent: enabled=1,fstrim_cloned_disks=1`. Absence ⇒
 * undefined (unknown); a present non-"0"/non-"enabled=0" value ⇒ enabled.
 */
function parseAgentEnabled(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  const m = s.match(/enabled=([01])/);
  if (m) return m[1] === "1";
  if (s === "0") return false;
  return true;
}

/** Human uptime string from seconds (ADR-007 §6 API census path). */
function formatUptime(secs?: number): string {
  if (!secs || secs <= 0) return "";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return "up " + parts.join(" ");
}

/**
 * ADR-013 (#22) — host-first, then container-fallback Tailscale probe. Tailscale
 * is commonly run as a Docker container inside an LXC guest (the netns provider
 * for a VPN-routed stack), not on the PVE host, so a host-only probe reports a
 * misleading `null`. Resolution order, first hit wins:
 *   1. host  `tailscale status --json` (short-circuits when present)
 *   2. each running guest's Docker containers → first one that looks like
 *      Tailscale → `pct exec <vmid> -- docker exec <name> tailscale status --json`
 *   3. a structured `{ scope: "none", reason }` — never a bare null, so the
 *      operator can tell "not present" from "down".
 */
async function probeTailscale(
  runner: ProbeRunner,
  getPctRows: (section: CensusSection) => Promise<PctContainer[]>,
  getContainerDocker: (vmid: number) => Promise<DockerContainer[]>
): Promise<TailscaleSummary | TailscaleAbsent> {
  // 1. Host scope.
  const hostOut = await runner.soft("tailscale status --json");
  if (hostOut) {
    const host = parseTailscaleStatus(hostOut);
    if (host) return { ...host, scope: "host" };
  }

  // 2. Container scope — scan running guests, first Tailscale container wins.
  const running = (await getPctRows("tailscale")).filter((r) => r.status === "running");
  let foundButUnreadable: string | null = null;
  for (const r of running) {
    const tsContainer = findTailscaleContainer(await getContainerDocker(r.vmid));
    if (!tsContainer) continue;
    const inner = await runner.soft(
      buildPctExecCommand(r.vmid, buildDockerExecCommand(tsContainer.name, "tailscale status --json"))
    );
    const parsed = inner ? parseTailscaleStatus(inner) : null;
    if (parsed) {
      return { ...parsed, scope: "container", vmid: r.vmid, container: tsContainer.name };
    }
    foundButUnreadable =
      `found a Tailscale container '${tsContainer.name}' in guest ${r.vmid}, but ` +
      `'tailscale status' returned no parseable output`;
  }

  // 3. None found.
  return {
    scope: "none",
    reason:
      foundButUnreadable ??
      "no host-level Tailscale; no Tailscale container found in running guests",
  };
}

export async function describeHomelabHandler(
  input: DescribeHomelabInput,
  transport: SshTransport,
  store: CensusStore,
  cfg: Config,
  now: () => number = Date.now,
  // ADR-007 §6 — below companion the census has no SSH; metadata sections
  // (node/storage/containers/vms) are served through the API backend and the
  // exec-bound sections (network/services/tailscale) report `unavailableAtTier`.
  // Defaults preserve the pre-tier (companion+) SSH path for existing callers.
  nodeOps: NodeOps | null = null,
  tier: Tier = "companion"
): Promise<RedactedCensusSnapshot> {
  const requested = new Set<CensusSection>(input.sections ?? ALL_SECTIONS);
  const depth = input.depth;
  const runner = new ProbeRunner(transport, cfg.census.probeTimeoutMs, cfg.census.budgetMs, now);

  const sections: CensusSections = {};
  const errors: CensusError[] = [];
  let budgetHit = false;

  // ADR-007 §6 — API census path (below companion: no SSH key on the wire).
  const apiOnly = !tierAtLeast(tier, "companion");

  // Container rows feed both `containers` and `services`; fetch+cache once.
  let pctRows: PctContainer[] | null = null;
  async function getPctRows(section: CensusSection): Promise<PctContainer[]> {
    if (pctRows === null) {
      pctRows = await runProbe(
        runner,
        { section, key: "pct list", command: "pct list", parser: parsePctList },
        [],
        errors
      );
    }
    return pctRows;
  }

  // #22 — a guest's `docker ps` feeds BOTH `services` and the tailscale
  // container-fallback probe; memoize per vmid so both sections share one call.
  const dockerPsCache = new Map<number, DockerContainer[]>();
  async function getContainerDocker(vmid: number): Promise<DockerContainer[]> {
    const cached = dockerPsCache.get(vmid);
    if (cached) return cached;
    const out = await runner.soft(
      buildPctExecCommand(
        vmid,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      )
    );
    const rows = out ? parseDockerPs(out) : [];
    dockerPsCache.set(vmid, rows);
    return rows;
  }

  if (apiOnly) {
    await buildApiCensus(input, nodeOps, requested, sections, errors);
  } else
  try {
    if (requested.has("node")) {
      const node: NodeSection = {
        version: await runProbe(
          runner,
          { section: "node", key: "pveversion", command: "pveversion", parser: parsePveVersion },
          "",
          errors
        ),
        uptime: await runProbe(
          runner,
          { section: "node", key: "uptime -p", command: "uptime -p", parser: (s) => s.trim() },
          "",
          errors
        ),
        cpu: await runProbe(
          runner,
          { section: "node", key: "nproc", command: "nproc", parser: (s) => parseInt(s.trim(), 10) || 0 },
          0,
          errors
        ),
        memBytes: 0,
        memUsedBytes: 0,
        load: await runProbe(
          runner,
          { section: "node", key: "loadavg", command: "cat /proc/loadavg", parser: parseLoadAvg },
          [],
          errors
        ),
      };
      const mem = await runProbe(
        runner,
        { section: "node", key: "free -b", command: "free -b", parser: parseFreeBytes },
        { totalBytes: 0, usedBytes: 0 },
        errors
      );
      node.memBytes = mem.totalBytes;
      node.memUsedBytes = mem.usedBytes;
      const zpool = await runner.soft("zpool status -x");
      if (zpool !== null) node.zpool = parseZpoolStatusX(zpool);
      sections.node = node;
    }

    if (requested.has("storage")) {
      sections.storage = await runProbe(
        runner,
        { section: "storage", key: "pvesm status", command: "pvesm status", parser: parsePvesmStatus },
        [],
        errors
      );
    }

    if (requested.has("network")) {
      const ifaces = await runProbe(
        runner,
        { section: "network", key: "ip -br addr", command: "ip -br addr", parser: parseIpBrief },
        [],
        errors
      );
      const bridges = await runProbe(
        runner,
        {
          section: "network",
          key: "/etc/network/interfaces",
          command: "cat /etc/network/interfaces",
          parser: parseInterfacesBridges,
        },
        [],
        errors
      );
      sections.network = { ifaces, bridges };
    }

    // ADR-008 §5 — storage-type lookup for the snapshotCapable heuristic, built
    // from the storage section when it was collected (it runs before containers/
    // vms). Absent ⇒ heuristic falls back to passthrough-only (best-effort).
    const storageTypeByName = Array.isArray(sections.storage)
      ? new Map(sections.storage.map((s) => [s.name, s.type]))
      : undefined;

    if (requested.has("containers")) {
      const rows = await getPctRows("containers");
      const entries: GuestEntry[] = [];
      for (const r of rows) {
        const entry: GuestEntry = { vmid: r.vmid, name: r.name, status: r.status, lock: r.lock };
        // ADR-017 §3 — both `status` and `full` need the config probe (it feeds
        // snapshotCapable); only `full` attaches the bulky redacted config blob.
        if (depth === "full" || depth === "status") {
          const cfgText = await runProbe(
            runner,
            {
              section: "containers",
              key: `pct config ${r.vmid}`,
              command: `pct config ${r.vmid}`,
              parser: (s) => s,
            },
            null as string | null,
            errors
          );
          // Raw (unredacted) here; redaction happens once in finalizeInventory.
          if (cfgText !== null) {
            const parsed = parseGuestConfig(cfgText);
            entry.snapshotCapable = evaluateSnapshotCapable(parsed, storageTypeByName);
            if (depth === "full") entry.config = parsed;
          }
        }
        entries.push(entry);
      }
      sections.containers = entries;
    }

    if (requested.has("vms")) {
      const rows = await runProbe(
        runner,
        { section: "vms", key: "qm list", command: "qm list", parser: parseQmList },
        [],
        errors
      );
      const entries: GuestEntry[] = [];
      for (const r of rows) {
        const entry: GuestEntry = { vmid: r.vmid, name: r.name, status: r.status };
        let agentEnabled: boolean | undefined;
        // ADR-017 §3 — `status` and `full` both probe config (for snapshotCapable +
        // agent-enabled); only `full` attaches the redacted config blob.
        if (depth === "full" || depth === "status") {
          const cfgText = await runProbe(
            runner,
            {
              section: "vms",
              key: `qm config ${r.vmid}`,
              command: `qm config ${r.vmid}`,
              parser: (s) => s,
            },
            null as string | null,
            errors
          );
          if (cfgText !== null) {
            const parsed = parseGuestConfig(cfgText);
            entry.snapshotCapable = evaluateSnapshotCapable(parsed, storageTypeByName);
            agentEnabled = parseAgentEnabled(parsed["agent"]);
            if (depth === "full") entry.config = parsed;
          }
        }
        // ADR-005 §Part 1: surface qemu-guest-agent coverage on the map (R6 slot).
        // `running` (responsiveness) comes from a soft ping; `enabled` from the VM
        // config when available, else inferred from the ping. Only running VMs are
        // pinged (a stopped VM's agent is trivially unresponsive).
        if (r.status === "running") {
          const ping = await runner.soft(buildQmAgentPingCommand(r.vmid));
          const running = ping !== null;
          entry.agent = { enabled: agentEnabled ?? running, running };
        } else if (agentEnabled !== undefined) {
          entry.agent = { enabled: agentEnabled };
        }
        entries.push(entry);
      }
      sections.vms = entries;
    }

    if (requested.has("services")) {
      const rows = await getPctRows("services");
      const running = rows.filter((r) => r.status === "running");
      const svc: ServiceEntry[] = [];
      for (const r of running) {
        const failedOut = await runner.soft(
          buildPctExecCommand(r.vmid, "systemctl list-units --failed --no-legend --plain")
        );
        svc.push({
          vmid: r.vmid,
          failedUnits: failedOut ? parseFailedUnits(failedOut) : [],
          // ADR-017 §3 — the docker image roster is the heavy part of a service
          // entry; `status` depth drops it. `summary`/`full` keep today's behaviour.
          docker: depth === "status" ? [] : await getContainerDocker(r.vmid),
        });
      }
      sections.services = svc;
    }

    if (requested.has("tailscale")) {
      // ADR-013 (#22): probe Tailscale host-first, then fall back to execing into
      // a guest's tailscale container for real identity (supersedes #27's
      // detect-only stopgap, which reported a container's mere presence with empty
      // identity and a flat null when absent).
      sections.tailscale = await probeTailscale(runner, getPctRows, getContainerDocker);
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      budgetHit = true;
      errors.push({ section: "node", probe: "(budget)", error: errMsg(e) });
    } else {
      throw e;
    }
  }

  // Assemble the RAW snapshot (per-guest configs still unredacted). Load the
  // previous snapshot BEFORE finalize so drift compares against history; drift
  // never reads configs, so running it on raw is safe.
  const raw: RawCensusSnapshot = {
    schemaVersion: CENSUS_SCHEMA_VERSION,
    ts: new Date(now()).toISOString(),
    host: censusHost(cfg),
    depth,
    sections,
    errors,
    redactions: 0,
  };

  const prev = input.compareToPrevious ? store.loadLatest() : null;
  if (prev) {
    raw.drift = diffSnapshots(prev, raw, { storageDriftPercent: cfg.census.storageDriftPercent });
  }

  // THE redaction chokepoint (R2): the only path from raw → branded redacted.
  const snapshot = finalizeInventory(raw, {
    extraKeys: cfg.census.redactionExtraKeys,
    maxItemsPerSection: cfg.census.maxItemsPerSection,
    maxResponseBytes: cfg.census.maxResponseBytes,
  });

  if (input.saveSnapshot && !budgetHit) {
    snapshot.snapshotPath = store.save(snapshot);
  }

  return snapshot;
}

/**
 * ADR-007 §6 — build the census from the API backend (observe/operate tiers).
 *
 * `node`, `storage`, `containers`, `vms` are **API-complete** — one structured
 * call each through NodeOps, no exec. The exec-bound sections (`network`,
 * `services`, `tailscale`) cannot be served by an API token (they parse
 * in-guest/host command output), so they report `{ unavailableAtTier: "companion" }`
 * — a structured status the differ treats as "not observed", never "removed".
 *
 * Per-section try/catch isolation mirrors the SSH path: a failed section becomes
 * a recorded `CensusError`, never an abort (a 403 here is Proxmox RBAC, surfaced
 * verbatim by `mapApiError`).
 */
async function buildApiCensus(
  input: DescribeHomelabInput,
  nodeOps: NodeOps | null,
  requested: Set<CensusSection>,
  sections: CensusSections,
  errors: CensusError[]
): Promise<void> {
  if (!nodeOps) {
    throw new Error(
      "describe_homelab below companion requires the API backend, but none is configured " +
        "(set PVE_API_BASE_URL / PVE_API_TOKEN_ID / PVE_API_TOKEN_SECRET / PVE_API_NODE)."
    );
  }
  const unavailable: Unavailable = { unavailableAtTier: "companion" };

  // Guests feed both `containers` and `vms`; fetch once.
  let guests: Awaited<ReturnType<NodeOps["listGuests"]>> | null = null;
  async function getGuests(section: CensusSection): Promise<typeof guests> {
    if (guests === null) {
      try {
        guests = await nodeOps!.listGuests();
      } catch (e) {
        errors.push({ section, probe: "listGuests", error: errMsg(e) });
        guests = [];
      }
    }
    return guests;
  }

  if (requested.has("node")) {
    try {
      const s = await nodeOps.nodeStatus();
      const node: NodeSection = {
        // #12 — normalize to the bare manager version (e.g. "8.1.4") so the API
        // path matches the SSH path (which parses `pveversion`). The API
        // nodeStatus returns the raw "pve-manager/8.1.4" form.
        version: s.version ? parsePveVersion(s.version) : "",
        uptime: formatUptime(s.uptimeSecs),
        cpu: s.cpuCount ?? 0,
        memBytes: s.memoryTotal ?? 0,
        memUsedBytes: s.memoryUsed ?? 0,
        load: s.loadavg ?? [],
      };
      sections.node = node;
    } catch (e) {
      errors.push({ section: "node", probe: "nodeStatus", error: errMsg(e) });
    }
  }

  if (requested.has("storage")) {
    try {
      const st = await nodeOps.storageStatus();
      sections.storage = st.map((s) => ({
        name: s.storage,
        type: s.type,
        active: s.active,
        totalBytes: s.totalBytes,
        usedBytes: s.usedBytes,
        availBytes: s.availBytes,
      }));
    } catch (e) {
      errors.push({ section: "storage", probe: "storageStatus", error: errMsg(e) });
    }
  }

  if (requested.has("containers")) {
    const rows = (await getGuests("containers")) ?? [];
    sections.containers = rows
      .filter((g) => g.type === "lxc")
      .map<GuestEntry>((g) => ({ vmid: g.vmid, name: g.name, status: g.status }));
  }

  if (requested.has("vms")) {
    const rows = (await getGuests("vms")) ?? [];
    sections.vms = rows
      .filter((g) => g.type === "qemu")
      .map<GuestEntry>((g) => ({ vmid: g.vmid, name: g.name, status: g.status }));
  }

  // Exec-bound sections: not observable through the API token.
  if (requested.has("network")) sections.network = unavailable;
  if (requested.has("services")) sections.services = unavailable;
  if (requested.has("tailscale")) sections.tailscale = unavailable;

  // `depth: "full"` per-guest configs are an SSH/agent capability (companion+);
  // the API census is summary-grade by construction.
  void input;
}
