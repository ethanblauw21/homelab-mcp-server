import { describe, it, expect } from "vitest";
import { finalizeInventory } from "./censusInventory.js";
import type { RawCensusSnapshot } from "./censusInventory.js";
import { CENSUS_SCHEMA_VERSION } from "./censusTypes.js";
import type { GuestEntry } from "./censusTypes.js";

function rawSnap(overrides: Partial<RawCensusSnapshot> = {}): RawCensusSnapshot {
  return {
    schemaVersion: CENSUS_SCHEMA_VERSION,
    ts: "2026-06-09T00:00:00.000Z",
    host: "pve",
    depth: "full",
    sections: {},
    errors: [],
    redactions: 0,
    ...overrides,
  };
}

const opts = { extraKeys: [], maxItemsPerSection: 200, maxResponseBytes: 512 * 1024 };

describe("finalizeInventory — redaction (R2)", () => {
  it("redacts guest configs and counts redactions", () => {
    const containers: GuestEntry[] = [
      { vmid: 101, name: "c", status: "running", config: { password: "hunter2", cores: "2" } },
    ];
    const out = finalizeInventory(rawSnap({ sections: { containers } }), opts);
    expect(out.sections.containers?.[0]?.config?.password).toBe("[REDACTED:password]");
    expect(out.sections.containers?.[0]?.config?.cores).toBe("2");
    expect(out.redactions).toBe(1);
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
});

describe("finalizeInventory — deterministic ordering (R3)", () => {
  it("sorts guests by vmid and config keys lexically", () => {
    const containers: GuestEntry[] = [
      { vmid: 103, name: "c3", status: "running", config: { zeta: "1", alpha: "2" } },
      { vmid: 101, name: "c1", status: "running" },
    ];
    const out = finalizeInventory(rawSnap({ sections: { containers } }), opts);
    expect(out.sections.containers?.map((c) => c.vmid)).toEqual([101, 103]);
    expect(Object.keys(out.sections.containers![1]!.config!)).toEqual(["alpha", "zeta"]);
  });

  it("sorts storage by name", () => {
    const storage = [
      { name: "zfs", type: "zfspool", active: true, totalBytes: 0, usedBytes: 0, availBytes: 0 },
      { name: "local", type: "dir", active: true, totalBytes: 0, usedBytes: 0, availBytes: 0 },
    ];
    const out = finalizeInventory(rawSnap({ sections: { storage } }), opts);
    expect(out.sections.storage?.map((s) => s.name)).toEqual(["local", "zfs"]);
  });
});

describe("finalizeInventory — truncation contract (R5)", () => {
  it("caps a section at maxItemsPerSection and records an explicit truncation", () => {
    const containers: GuestEntry[] = Array.from({ length: 5 }, (_, i) => ({
      vmid: 100 + i,
      name: `c${i}`,
      status: "running",
    }));
    const out = finalizeInventory(rawSnap({ sections: { containers } }), { ...opts, maxItemsPerSection: 3 });
    expect(out.sections.containers).toHaveLength(3);
    expect(out.truncated).toBe(true);
    expect(out.truncations).toContainEqual({
      section: "containers",
      reason: "more than 3 items; kept first 3",
      omitted: 2,
    });
  });

  it("drops guest configs and records a _response truncation when over the byte budget", () => {
    const containers: GuestEntry[] = [
      { vmid: 101, name: "c", status: "running", config: { blob: "x".repeat(5000) } },
    ];
    const out = finalizeInventory(rawSnap({ sections: { containers } }), { ...opts, maxResponseBytes: 200 });
    expect(out.sections.containers?.[0]?.config).toBeUndefined();
    expect(out.truncated).toBe(true);
    expect(out.truncations?.some((t) => t.section === "_response")).toBe(true);
  });

  it("does not flag truncation when within limits", () => {
    const out = finalizeInventory(rawSnap({ sections: { containers: [] } }), opts);
    expect(out.truncated).toBeUndefined();
    expect(out.truncations).toBeUndefined();
  });
});
