import type {
  CensusSnapshot,
  DriftReport,
  GuestDrift,
  StorageDrift,
  NetworkDrift,
  GuestEntry,
} from "./censusTypes.js";
import type { StorageInfo, NetworkIface } from "./censusParsers.js";

/**
 * Pure drift diff between two census snapshots (ADR-002). Cosmetic noise
 * (uptime, load, memory, timestamps) is excluded by design — only structural
 * changes (guests added/removed/status-changed, storage activity/usage beyond
 * a threshold, network interfaces) are reported.
 */

function diffGuests(prev: GuestEntry[] = [], next: GuestEntry[] = []): GuestDrift {
  const prevById = new Map(prev.map((g) => [g.vmid, g]));
  const nextById = new Map(next.map((g) => [g.vmid, g]));

  const added = next.filter((g) => !prevById.has(g.vmid)).map((g) => g.vmid);
  const removed = prev.filter((g) => !nextById.has(g.vmid)).map((g) => g.vmid);
  const changed: GuestDrift["changed"] = [];
  for (const g of next) {
    const p = prevById.get(g.vmid);
    if (p && p.status !== g.status) {
      changed.push({ vmid: g.vmid, from: p.status, to: g.status });
    }
  }
  return { added, removed, changed };
}

function diffStorage(
  prev: StorageInfo[] = [],
  next: StorageInfo[] = [],
  driftPercent: number
): StorageDrift {
  const prevByName = new Map(prev.map((s) => [s.name, s]));
  const nextByName = new Map(next.map((s) => [s.name, s]));

  const added = next.filter((s) => !prevByName.has(s.name)).map((s) => s.name);
  const removed = prev.filter((s) => !nextByName.has(s.name)).map((s) => s.name);
  const changed: StorageDrift["changed"] = [];

  for (const s of next) {
    const p = prevByName.get(s.name);
    if (!p) continue;
    if (p.active !== s.active) {
      changed.push({ name: s.name, reason: `active ${p.active} -> ${s.active}` });
      continue;
    }
    if (s.totalBytes > 0) {
      const deltaPct = (Math.abs(s.usedBytes - p.usedBytes) / s.totalBytes) * 100;
      if (deltaPct >= driftPercent) {
        changed.push({
          name: s.name,
          reason: `usage ${deltaPct.toFixed(1)}% change (>= ${driftPercent}%)`,
        });
      }
    }
  }
  return { added, removed, changed };
}

function diffNetwork(prev: NetworkIface[] = [], next: NetworkIface[] = []): NetworkDrift {
  const prevByIface = new Map(prev.map((n) => [n.iface, n]));
  const nextByIface = new Map(next.map((n) => [n.iface, n]));

  const added = next.filter((n) => !prevByIface.has(n.iface)).map((n) => n.iface);
  const removed = prev.filter((n) => !nextByIface.has(n.iface)).map((n) => n.iface);
  const changed: NetworkDrift["changed"] = [];

  for (const n of next) {
    const p = prevByIface.get(n.iface);
    if (!p) continue;
    if (p.state !== n.state) {
      changed.push({ iface: n.iface, reason: `state ${p.state} -> ${n.state}` });
    } else if (p.addrs.join(",") !== n.addrs.join(",")) {
      changed.push({ iface: n.iface, reason: "addresses changed" });
    }
  }
  return { added, removed, changed };
}

export function diffSnapshots(
  prev: CensusSnapshot,
  next: CensusSnapshot,
  opts: { storageDriftPercent: number }
): DriftReport {
  const report: DriftReport = {
    containers: diffGuests(prev.sections.containers, next.sections.containers),
    vms: diffGuests(prev.sections.vms, next.sections.vms),
    storage: diffStorage(prev.sections.storage, next.sections.storage, opts.storageDriftPercent),
    network: diffNetwork(prev.sections.network?.ifaces, next.sections.network?.ifaces),
    comparedTo: prev.ts,
  };

  const prevPeers = prev.sections.tailscale?.peerCount;
  const nextPeers = next.sections.tailscale?.peerCount;
  if (
    prevPeers !== undefined &&
    nextPeers !== undefined &&
    prevPeers !== nextPeers
  ) {
    report.tailscale = { from: prevPeers, to: nextPeers };
  }

  return report;
}
