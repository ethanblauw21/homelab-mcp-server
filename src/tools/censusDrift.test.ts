import { describe, it, expect } from "vitest";
import { diffSnapshots } from "./censusDrift.js";
import type { CensusSnapshot } from "./censusTypes.js";

function snap(partial: Partial<CensusSnapshot["sections"]>, ts = "2026-06-01T00:00:00.000Z"): CensusSnapshot {
  return {
    schemaVersion: 1,
    ts,
    host: "pve",
    depth: "summary",
    sections: partial,
    errors: [],
    redactions: 0,
  };
}

describe("diffSnapshots", () => {
  it("detects added, removed, and status-changed containers", () => {
    const prev = snap({
      containers: [
        { vmid: 101, name: "gluetun", status: "running" },
        { vmid: 102, name: "old", status: "running" },
      ],
    });
    const next = snap(
      {
        containers: [
          { vmid: 101, name: "gluetun", status: "stopped" },
          { vmid: 103, name: "new", status: "running" },
        ],
      },
      "2026-06-02T00:00:00.000Z"
    );
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.containers.added).toEqual([103]);
    expect(d.containers.removed).toEqual([102]);
    expect(d.containers.changed).toEqual([{ vmid: 101, from: "running", to: "stopped" }]);
    expect(d.comparedTo).toBe("2026-06-01T00:00:00.000Z");
  });

  it("flags storage usage change beyond the threshold but ignores small drift", () => {
    const prev = snap({
      storage: [
        { name: "local", type: "dir", active: true, totalBytes: 1000, usedBytes: 100, availBytes: 900 },
        { name: "lvm", type: "lvmthin", active: true, totalBytes: 1000, usedBytes: 100, availBytes: 900 },
      ],
    });
    const next = snap({
      storage: [
        // +30% of total -> flagged
        { name: "local", type: "dir", active: true, totalBytes: 1000, usedBytes: 400, availBytes: 600 },
        // +5% of total -> ignored
        { name: "lvm", type: "lvmthin", active: true, totalBytes: 1000, usedBytes: 150, availBytes: 850 },
      ],
    });
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.storage.changed.map((c) => c.name)).toEqual(["local"]);
  });

  it("flags storage active-state flips", () => {
    const prev = snap({
      storage: [{ name: "backup", type: "dir", active: true, totalBytes: 0, usedBytes: 0, availBytes: 0 }],
    });
    const next = snap({
      storage: [{ name: "backup", type: "dir", active: false, totalBytes: 0, usedBytes: 0, availBytes: 0 }],
    });
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.storage.changed[0]).toMatchObject({ name: "backup" });
  });

  it("detects network interface state changes", () => {
    const prev = snap({ network: { ifaces: [{ iface: "vmbr0", state: "UP", addrs: ["10.0.0.10/24"] }], bridges: [] } });
    const next = snap({ network: { ifaces: [{ iface: "vmbr0", state: "DOWN", addrs: ["10.0.0.10/24"] }], bridges: [] } });
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.network.changed[0]).toMatchObject({ iface: "vmbr0" });
  });

  it("reports tailscale peer-count change", () => {
    const prev = snap({ tailscale: { self: "pve", peerCount: 10 } });
    const next = snap({ tailscale: { self: "pve", peerCount: 12 } });
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.tailscale).toEqual({ from: 10, to: 12 });
  });

  it("ignores cosmetic node fields (no drift surface for uptime/load)", () => {
    const prev = snap({ node: { version: "8.1.4", uptime: "up 1 day", cpu: 8, memBytes: 1, memUsedBytes: 1, load: [0.1, 0.1, 0.1] } });
    const next = snap({ node: { version: "8.1.4", uptime: "up 2 days", cpu: 8, memBytes: 1, memUsedBytes: 2, load: [9, 9, 9] } });
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.containers.added).toEqual([]);
    expect(d.storage.changed).toEqual([]);
    expect(d).not.toHaveProperty("node");
  });

  it("degrades to a schemaMismatch report when schema versions differ (R3)", () => {
    const prev = snap({ containers: [{ vmid: 101, name: "a", status: "running" }] });
    const next = snap({ containers: [{ vmid: 102, name: "b", status: "running" }] }, "2026-06-02T00:00:00.000Z");
    next.schemaVersion = 999;
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.schemaMismatch).toBe(true);
    expect(d.containers).toEqual({ added: [], removed: [], changed: [] });
    expect(d.comparedTo).toBe("2026-06-01T00:00:00.000Z");
  });

  it("suppresses 'removed' for a section the newer snapshot truncated (R5)", () => {
    const prev = snap({
      containers: [
        { vmid: 101, name: "a", status: "running" },
        { vmid: 102, name: "b", status: "running" },
      ],
    });
    const next = snap({ containers: [{ vmid: 101, name: "a", status: "running" }] }, "2026-06-02T00:00:00.000Z");
    next.truncations = [{ section: "containers", reason: "capped", omitted: 1 }];
    const d = diffSnapshots(prev, next, { storageDriftPercent: 10 });
    expect(d.containers.removed).toEqual([]); // 102 not reported removed — it may have been truncated
  });
});
