import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { redactRecord } from "../guardrails/redaction.js";
import { buildPctExecCommand, parsePctList } from "./pctHelpers.js";
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
} from "./censusParsers.js";
import { ALL_SECTIONS } from "./censusTypes.js";
import type {
  CensusSnapshot,
  CensusSections,
  CensusError,
  CensusSection,
  GuestEntry,
  ServiceEntry,
  NodeSection,
} from "./censusTypes.js";
import { CensusStore } from "./censusStore.js";
import { diffSnapshots } from "./censusDrift.js";

export const DescribeHomelabInputSchema = z.object({
  sections: z
    .array(z.enum(["node", "storage", "network", "containers", "vms", "services", "tailscale"]))
    .optional()
    .describe("Sections to include; defaults to all"),
  depth: z
    .enum(["summary", "full"])
    .default("summary")
    .describe("summary (default): identity + status; full: includes redacted per-guest config"),
  saveSnapshot: z.boolean().default(true).describe("Persist the snapshot locally (default true)"),
  compareToPrevious: z
    .boolean()
    .default(false)
    .describe("Include a drift diff vs the latest stored snapshot"),
});

export type DescribeHomelabInput = z.infer<typeof DescribeHomelabInputSchema>;

/** Thrown internally when the global census time budget is exhausted. */
class BudgetExceeded extends Error {}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function describeHomelabHandler(
  input: DescribeHomelabInput,
  transport: SshTransport,
  store: CensusStore,
  cfg: Config,
  now: () => number = Date.now
): Promise<CensusSnapshot> {
  const requested = new Set<CensusSection>(input.sections ?? ALL_SECTIONS);
  const depth = input.depth;
  const extraKeys = cfg.census.redactionExtraKeys;
  const deadline = now() + cfg.census.budgetMs;

  const sections: CensusSections = {};
  const errors: CensusError[] = [];
  let redactions = 0;
  let budgetHit = false;

  // A probe that enforces the global budget and the per-probe timeout, and
  // treats a non-zero exit as a probe failure.
  async function probe(cmd: string): Promise<string> {
    if (now() > deadline) {
      throw new BudgetExceeded(`census time budget (${cfg.census.budgetMs}ms) exceeded`);
    }
    const r = await transport.exec(cmd, cfg.census.probeTimeoutMs);
    if (r.exitCode !== 0) {
      throw new Error(`exit ${r.exitCode}: ${r.stderr.trim() || "(no stderr)"}`);
    }
    return r.stdout;
  }

  // Soft probe: tolerate non-zero exit / absence (e.g. zfs, tailscale, docker)
  // but still let a budget exhaustion propagate.
  async function probeSoft(cmd: string): Promise<string | null> {
    try {
      return await probe(cmd);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      return null;
    }
  }

  // Run one probe, recording a section-level error (and falling back) on
  // failure; budget exhaustion propagates to stop the whole census.
  async function tryProbe<T>(
    section: CensusSection,
    probeName: string,
    fallback: T,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      errors.push({ section, probe: probeName, error: errMsg(e) });
      return fallback;
    }
  }

  // Container rows are needed by both `containers` and `services`; fetch once.
  let pctRows: ReturnType<typeof parsePctList> | null = null;
  async function getPctRows(): Promise<ReturnType<typeof parsePctList>> {
    if (pctRows === null) pctRows = parsePctList(await probe("pct list"));
    return pctRows;
  }

  try {
    if (requested.has("node")) {
      const node: NodeSection = {
        version: await tryProbe("node", "pveversion", "", async () =>
          parsePveVersion(await probe("pveversion"))
        ),
        uptime: await tryProbe("node", "uptime -p", "", async () =>
          (await probe("uptime -p")).trim()
        ),
        cpu: await tryProbe("node", "nproc", 0, async () =>
          parseInt((await probe("nproc")).trim(), 10) || 0
        ),
        memBytes: 0,
        memUsedBytes: 0,
        load: await tryProbe("node", "loadavg", [], async () =>
          parseLoadAvg(await probe("cat /proc/loadavg"))
        ),
      };
      const mem = await tryProbe("node", "free -b", { totalBytes: 0, usedBytes: 0 }, async () =>
        parseFreeBytes(await probe("free -b"))
      );
      node.memBytes = mem.totalBytes;
      node.memUsedBytes = mem.usedBytes;
      const zpool = await probeSoft("zpool status -x");
      if (zpool !== null) node.zpool = parseZpoolStatusX(zpool);
      sections.node = node;
    }

    if (requested.has("storage")) {
      sections.storage = await tryProbe("storage", "pvesm status", [], async () =>
        parsePvesmStatus(await probe("pvesm status"))
      );
    }

    if (requested.has("network")) {
      const ifaces = await tryProbe("network", "ip -br addr", [], async () =>
        parseIpBrief(await probe("ip -br addr"))
      );
      const bridges = await tryProbe("network", "/etc/network/interfaces", [], async () =>
        parseInterfacesBridges(await probe("cat /etc/network/interfaces"))
      );
      sections.network = { ifaces, bridges };
    }

    if (requested.has("containers")) {
      const rows = await tryProbe("containers", "pct list", [], async () => getPctRows());
      const entries: GuestEntry[] = [];
      for (const r of rows) {
        const entry: GuestEntry = { vmid: r.vmid, name: r.name, status: r.status, lock: r.lock };
        if (depth === "full") {
          const cfgText = await tryProbe(
            "containers",
            `pct config ${r.vmid}`,
            null as string | null,
            async () => probe(`pct config ${r.vmid}`)
          );
          if (cfgText !== null) {
            const red = redactRecord(parseGuestConfig(cfgText), extraKeys);
            entry.config = red.value;
            redactions += red.redactedCount;
          }
        }
        entries.push(entry);
      }
      sections.containers = entries;
    }

    if (requested.has("vms")) {
      const rows = await tryProbe("vms", "qm list", [], async () =>
        parseQmList(await probe("qm list"))
      );
      const entries: GuestEntry[] = [];
      for (const r of rows) {
        const entry: GuestEntry = { vmid: r.vmid, name: r.name, status: r.status };
        if (depth === "full") {
          const cfgText = await tryProbe(
            "vms",
            `qm config ${r.vmid}`,
            null as string | null,
            async () => probe(`qm config ${r.vmid}`)
          );
          if (cfgText !== null) {
            const red = redactRecord(parseGuestConfig(cfgText), extraKeys);
            entry.config = red.value;
            redactions += red.redactedCount;
          }
        }
        entries.push(entry);
      }
      sections.vms = entries;
    }

    if (requested.has("services")) {
      const rows = await tryProbe("services", "pct list", [], async () => getPctRows());
      const running = rows.filter((r) => r.status === "running");
      const svc: ServiceEntry[] = [];
      for (const r of running) {
        const failedOut = await probeSoft(
          buildPctExecCommand(r.vmid, "systemctl list-units --failed --no-legend --plain")
        );
        const dockerOut = await probeSoft(
          buildPctExecCommand(
            r.vmid,
            'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
          )
        );
        svc.push({
          vmid: r.vmid,
          failedUnits: failedOut ? parseFailedUnits(failedOut) : [],
          docker: dockerOut ? parseDockerPs(dockerOut) : [],
        });
      }
      sections.services = svc;
    }

    if (requested.has("tailscale")) {
      const ts = await probeSoft("tailscale status --json");
      sections.tailscale = ts ? parseTailscaleStatus(ts) : null;
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      budgetHit = true;
      errors.push({ section: "node", probe: "(budget)", error: errMsg(e) });
    } else {
      throw e;
    }
  }

  // Load the previous snapshot BEFORE saving the new one, so drift compares
  // against history rather than the run we are about to write.
  const prev = input.compareToPrevious ? store.loadLatest() : null;

  const snapshot: CensusSnapshot = {
    ts: new Date(now()).toISOString(),
    host: cfg.ssh.host,
    depth,
    sections,
    errors,
    redactions,
  };

  if (prev) {
    snapshot.drift = diffSnapshots(prev, snapshot, {
      storageDriftPercent: cfg.census.storageDriftPercent,
    });
  }

  if (input.saveSnapshot && !budgetHit) {
    snapshot.snapshotPath = store.save(snapshot);
  }

  return snapshot;
}
