import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import {
  parseLoadAvg,
  parseFreeBytes,
  parseDf,
  parsePvesmStatus,
  parseZpoolStatusX,
  parseFailedUnits,
  parseQmList,
} from "./censusParsers.js";
import { parsePctList } from "./pctHelpers.js";
import type { NodeOps } from "../node/nodeOps.js";
import { tierAtLeast, type Tier } from "../tiers/registry.js";
import {
  evaluateLoad,
  evaluateMemory,
  evaluateUsage,
  evaluateZpool,
  evaluateFailedUnits,
  evaluateOnbootStopped,
  evaluatePendingUpdates,
  rollupStatus,
  parseOnbootConfig,
  parseAptUpgradeCount,
  type CheckResult,
  type HealthStatus,
  type OnbootGuest,
} from "./healthEvaluators.js";

export const HEALTH_SECTIONS = ["node", "storage", "guests", "units", "updates"] as const;
export type HealthSection = (typeof HEALTH_SECTIONS)[number];

export const HealthCheckInputSchema = z.object({
  sections: z
    .array(z.enum(HEALTH_SECTIONS))
    .optional()
    .describe("Sections to probe; defaults to all (node, storage, guests, units, updates)"),
});

export type HealthCheckInput = z.infer<typeof HealthCheckInputSchema>;

export interface HealthFinding extends CheckResult {
  section: HealthSection;
}

export interface HealthCheckResult {
  status: HealthStatus;
  findings: HealthFinding[];
  errors: Array<{ section: HealthSection; error: string }>;
  /**
   * ADR-007 §6 — sections that need exec (host/in-guest config) the API token
   * cannot run, reported below companion as a structured status (not an error).
   */
  unavailable?: Array<{ section: HealthSection; unavailableAtTier: Tier }>;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `health_check` — fixed read-only probes feeding pure evaluators (ADR-005 §Part
 * 2). Each section is isolated: a probe failure records a section error and never
 * aborts the others (census pattern). No mutation, no audit record.
 *
 * A5.1: the updates section SIMULATES (`apt-get -s`) and NEVER runs `apt update`.
 */
export async function healthCheckHandler(
  input: HealthCheckInput,
  transport: SshTransport,
  cfg: Config,
  // ADR-007 §6 — below companion (no SSH) probes route through the API backend;
  // exec-bound sections (units, onboot guests) report `unavailableAtTier`.
  // Defaults preserve the pre-tier SSH path for existing callers.
  nodeOps: NodeOps | null = null,
  tier: Tier = "companion"
): Promise<HealthCheckResult> {
  const requested = new Set<HealthSection>(input.sections ?? HEALTH_SECTIONS);

  if (!tierAtLeast(tier, "companion")) {
    return apiHealthCheck(requested, nodeOps, cfg);
  }

  const findings: HealthFinding[] = [];
  const errors: Array<{ section: HealthSection; error: string }> = [];
  const timeout = cfg.health.probeTimeoutMs;

  const add = (section: HealthSection, ...checks: CheckResult[]): void => {
    for (const c of checks) findings.push({ section, ...c });
  };

  // Exec + non-zero-exit guard. Throws so the section's catch records the error.
  const probe = async (command: string): Promise<string> => {
    const r = await transport.exec(command, timeout);
    if (r.exitCode !== 0) {
      throw new Error(`\`${command}\` exit ${r.exitCode}: ${r.stderr.trim() || "(no stderr)"}`);
    }
    return r.stdout;
  };
  // Tolerant variant for optional probes (e.g. ZFS absent).
  const probeSoft = async (command: string): Promise<string | null> => {
    try {
      return await probe(command);
    } catch {
      return null;
    }
  };

  if (requested.has("node")) {
    try {
      const cores = parseInt((await probe("nproc")).trim(), 10) || 0;
      const load = parseLoadAvg(await probe("cat /proc/loadavg"));
      const mem = parseFreeBytes(await probe("free -b"));
      add(
        "node",
        evaluateLoad(load[0] ?? 0, cores, {
          warnRatio: cfg.health.loadWarnRatio,
          critRatio: cfg.health.loadCritRatio,
        }),
        evaluateMemory(mem.usedBytes, mem.totalBytes, {
          warnPercent: cfg.health.memWarnPercent,
          critPercent: cfg.health.memCritPercent,
        })
      );
      const zpool = await probeSoft("zpool status -x");
      if (zpool !== null) add("node", evaluateZpool(parseZpoolStatusX(zpool)));
    } catch (e) {
      errors.push({ section: "node", error: errMsg(e) });
    }
  }

  if (requested.has("storage")) {
    try {
      const fsThresholds = { warnPercent: cfg.health.fsWarnPercent, critPercent: cfg.health.fsCritPercent };
      const df = parseDf(await probe("df -B1 --output=target,size,used,avail"));
      for (const fs of df) add("storage", evaluateUsage(`fs:${fs.target}`, fs.usedBytes, fs.sizeBytes, fsThresholds));
      const stores = parsePvesmStatus(await probe("pvesm status"));
      for (const s of stores) {
        if (!s.active) {
          add("storage", { check: `store:${s.name}`, status: "warn", finding: `store ${s.name} is not active` });
          continue;
        }
        add("storage", evaluateUsage(`store:${s.name}`, s.usedBytes, s.totalBytes, fsThresholds));
      }
    } catch (e) {
      errors.push({ section: "storage", error: errMsg(e) });
    }
  }

  if (requested.has("guests")) {
    try {
      const cts = parsePctList(await probe("pct list"));
      const vms = parseQmList(await probe("qm list"));
      const onboot = parseOnbootConfig(
        (await probeSoft(
          "grep -H '^onboot:' /etc/pve/lxc/*.conf /etc/pve/qemu-server/*.conf 2>/dev/null || true"
        )) ?? ""
      );
      const guests: OnbootGuest[] = [
        ...cts.map((c) => ({ vmid: c.vmid, name: c.name, status: c.status, onboot: onboot.get(c.vmid) ?? false })),
        ...vms.map((v) => ({ vmid: v.vmid, name: v.name, status: v.status, onboot: onboot.get(v.vmid) ?? false })),
      ];
      add("guests", evaluateOnbootStopped(guests));
    } catch (e) {
      errors.push({ section: "guests", error: errMsg(e) });
    }
  }

  if (requested.has("units")) {
    try {
      const units = parseFailedUnits(await probe("systemctl --failed --no-legend --plain"));
      add("units", evaluateFailedUnits(units, cfg.health.failedUnitsCritList));
    } catch (e) {
      errors.push({ section: "units", error: errMsg(e) });
    }
  }

  if (requested.has("updates")) {
    try {
      // A5.1: simulate only; never `apt update`.
      const count = parseAptUpgradeCount(
        await probe("apt-get -s -o Debug::NoLocking=true upgrade")
      );
      add("updates", evaluatePendingUpdates(count, cfg.health.pendingUpdatesWarnCount));
    } catch (e) {
      errors.push({ section: "updates", error: errMsg(e) });
    }
  }

  return { status: rollupStatus(findings), findings, errors };
}

/**
 * ADR-007 §6 — API-backed health check (observe/operate tiers).
 *
 * `node` (load/memory), `storage` (PVE stores), and `updates` (apt simulate) are
 * served through NodeOps. The exec-bound sections — `units` (host `systemctl
 * --failed`) and `guests` onboot-stopped detection (needs `/etc/pve/*.conf`) —
 * report `{ unavailableAtTier: "companion" }`. ZFS and per-filesystem `df` usage
 * have no token-grade API and are simply omitted (not errors).
 */
async function apiHealthCheck(
  requested: Set<HealthSection>,
  nodeOps: NodeOps | null,
  cfg: Config
): Promise<HealthCheckResult> {
  const findings: HealthFinding[] = [];
  const errors: Array<{ section: HealthSection; error: string }> = [];
  const unavailable: Array<{ section: HealthSection; unavailableAtTier: Tier }> = [];
  const add = (section: HealthSection, ...checks: CheckResult[]): void => {
    for (const c of checks) findings.push({ section, ...c });
  };

  if (!nodeOps) {
    throw new Error(
      "health_check below companion requires the API backend, but none is configured " +
        "(set PVE_API_BASE_URL / PVE_API_TOKEN_ID / PVE_API_TOKEN_SECRET / PVE_API_NODE)."
    );
  }

  if (requested.has("node")) {
    try {
      const s = await nodeOps.nodeStatus();
      add(
        "node",
        evaluateLoad(s.loadavg?.[0] ?? 0, s.cpuCount ?? 0, {
          warnRatio: cfg.health.loadWarnRatio,
          critRatio: cfg.health.loadCritRatio,
        }),
        evaluateMemory(s.memoryUsed ?? 0, s.memoryTotal ?? 0, {
          warnPercent: cfg.health.memWarnPercent,
          critPercent: cfg.health.memCritPercent,
        })
      );
    } catch (e) {
      errors.push({ section: "node", error: errMsg(e) });
    }
  }

  if (requested.has("storage")) {
    try {
      const fsThresholds = { warnPercent: cfg.health.fsWarnPercent, critPercent: cfg.health.fsCritPercent };
      for (const s of await nodeOps.storageStatus()) {
        if (!s.active) {
          add("storage", { check: `store:${s.storage}`, status: "warn", finding: `store ${s.storage} is not active` });
          continue;
        }
        add("storage", evaluateUsage(`store:${s.storage}`, s.usedBytes, s.totalBytes, fsThresholds));
      }
    } catch (e) {
      errors.push({ section: "storage", error: errMsg(e) });
    }
  }

  if (requested.has("updates")) {
    try {
      // A5.1: aptUpdates simulates (`apt-get -s`); never `apt update`.
      const count = (await nodeOps.aptUpdates()).length;
      add("updates", evaluatePendingUpdates(count, cfg.health.pendingUpdatesWarnCount));
    } catch (e) {
      errors.push({ section: "updates", error: errMsg(e) });
    }
  }

  // Exec-bound: onboot config (/etc/pve/*.conf) and host failed units.
  if (requested.has("guests")) unavailable.push({ section: "guests", unavailableAtTier: "companion" });
  if (requested.has("units")) unavailable.push({ section: "units", unavailableAtTier: "companion" });

  return {
    status: rollupStatus(findings),
    findings,
    errors,
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
}
