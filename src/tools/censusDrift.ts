import type {
  CensusSnapshot,
  DriftReport,
  GuestDrift,
  StorageDrift,
  NetworkDrift,
  GuestEntry,
  CensusSection,
} from "./censusTypes.js";
import { VOLATILE_FIELDS, observed } from "./censusTypes.js";
import type { StorageInfo, NetworkIface } from "./censusParsers.js";

/**
 * Pure drift diff between two census snapshots (ADR-002). Cosmetic noise
 * (uptime, load, memory, timestamps) is excluded by design — only structural
 * changes (guests added/removed/status-changed, storage activity/usage beyond
 * a threshold, network interfaces) are reported.
 *
 * R3: the whole `node` section is excluded from drift precisely because every
 * field on it is annotated volatile (see VOLATILE_FIELDS, consulted here so the
 * ignore-list lives in exactly one place).
 */

// Touch the single volatility annotation so node drift is suppressed by the
// same source of truth a future renderer would read, not an ad-hoc list here.
const NODE_IS_ALL_VOLATILE = VOLATILE_FIELDS.node.length > 0;

/**
 * R5: when the newer snapshot truncated a section, we cannot tell "removed"
 * from "didn't fit", so removals for that section are suppressed. A `_response`
 * truncation only drops per-guest *configs* (items remain), so it does not
 * suppress.
 */
function sectionTruncated(snap: CensusSnapshot, section: CensusSection): boolean {
  return !!snap.truncations?.some((t) => t.section === section);
}

function diffGuests(
  prev: GuestEntry[] = [],
  next: GuestEntry[] = [],
  suppressRemoved = false
): GuestDrift {
  const prevById = new Map(prev.map((g) => [g.vmid, g]));
  const nextById = new Map(next.map((g) => [g.vmid, g]));

  const added = next.filter((g) => !prevById.has(g.vmid)).map((g) => g.vmid);
  const removed = suppressRemoved
    ? []
    : prev.filter((g) => !nextById.has(g.vmid)).map((g) => g.vmid);
  const changed: GuestDrift["changed"] = [];
  for (const g of next) {
    const p = prevById.get(g.vmid);
    if (!p) continue;
    if (p.status !== g.status) {
      changed.push({ vmid: g.vmid, from: p.status, to: g.status });
    }
    // ADR-008 §5 — a snapshot-capability transition is real drift. Only compared
    // when both snapshots observed the field (full depth); a snapshot that didn't
    // collect config leaves it undefined and is treated as not-observed, never a
    // change (mirrors the unavailableAtTier suppression rule).
    if (p.snapshotCapable !== undefined && g.snapshotCapable !== undefined) {
      const pc = capabilityLabel(p.snapshotCapable);
      const gc = capabilityLabel(g.snapshotCapable);
      if (pc !== gc) {
        changed.push({ vmid: g.vmid, from: pc, to: gc, field: "snapshotCapable" });
      }
    }
  }
  return { added, removed, changed };
}

/** Stable label for a snapshot-capability value, e.g. `capable` / `incapable (device passthrough)`. */
function capabilityLabel(c: { capable: boolean; reason?: string }): string {
  return c.capable ? "capable" : `incapable${c.reason ? ` (${c.reason})` : ""}`;
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

/** Empty sub-diffs, used for the degraded (schema-mismatch) report. */
function emptyDrift(comparedTo: string): DriftReport {
  return {
    containers: { added: [], removed: [], changed: [] },
    vms: { added: [], removed: [], changed: [] },
    storage: { added: [], removed: [], changed: [] },
    network: { added: [], removed: [], changed: [] },
    comparedTo,
  };
}

export function diffSnapshots(
  prev: CensusSnapshot,
  next: CensusSnapshot,
  opts: { storageDriftPercent: number }
): DriftReport {
  // R3 — refuse-or-degrade across schema versions rather than diff garbage.
  if (prev.schemaVersion !== next.schemaVersion) {
    return { ...emptyDrift(prev.ts), schemaMismatch: true };
  }

  void NODE_IS_ALL_VOLATILE; // node section intentionally excluded from drift

  // ADR-007 §6 — collapse any Unavailable marker on the newer snapshot to
  // undefined; a not-observed section drives an empty (suppressed) sub-diff.
  const observedNext = {
    network: observed(next.sections.network),
    tailscale: observed(next.sections.tailscale),
  };

  const report: DriftReport = {
    containers: diffGuests(
      prev.sections.containers,
      next.sections.containers,
      sectionTruncated(next, "containers")
    ),
    vms: diffGuests(prev.sections.vms, next.sections.vms, sectionTruncated(next, "vms")),
    storage: diffStorage(prev.sections.storage, next.sections.storage, opts.storageDriftPercent),
    // ADR-007 §6 — when the NEWER snapshot did not observe a section (an
    // Unavailable marker at a lower tier), suppress its drift entirely: a section
    // we did not look at can report neither additions, removals, nor changes.
    network: observedNext.network
      ? diffNetwork(observed(prev.sections.network)?.ifaces, observedNext.network.ifaces)
      : { added: [], removed: [], changed: [] },
    comparedTo: prev.ts,
  };

  const prevPeers = observed(prev.sections.tailscale)?.peerCount;
  const nextPeers = observedNext.tailscale?.peerCount;
  if (
    prevPeers !== undefined &&
    nextPeers !== undefined &&
    prevPeers !== nextPeers
  ) {
    report.tailscale = { from: prevPeers, to: nextPeers };
  }

  return report;
}
