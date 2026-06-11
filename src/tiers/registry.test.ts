import { describe, it, expect } from "vitest";
import {
  tierRank,
  tierAtLeast,
  isToolEnabled,
  toolsForTier,
  targetMinTier,
  assertTargetTier,
  TOOL_MIN_TIER,
  type Tier,
} from "./registry.js";

describe("tier ordering", () => {
  it("ranks tiers as a strict superset chain", () => {
    expect(tierRank("observe")).toBeLessThan(tierRank("operate"));
    expect(tierRank("operate")).toBeLessThan(tierRank("companion"));
    expect(tierRank("companion")).toBeLessThan(tierRank("root"));
  });

  it("tierAtLeast is inclusive and respects the ordering", () => {
    expect(tierAtLeast("companion", "observe")).toBe(true);
    expect(tierAtLeast("observe", "observe")).toBe(true);
    expect(tierAtLeast("observe", "companion")).toBe(false);
    expect(tierAtLeast("root", "companion")).toBe(true);
  });
});

describe("tool → tier registration", () => {
  // Per-tier registration snapshots (ADR-007 testing addition, "critical"):
  // exactly the mapped tools, nothing above.
  it("observe registers only the read-only set", () => {
    expect(toolsForTier("observe")).toEqual(
      [
        "describe_homelab",
        "health_check",
        "list_backups",
        "pct_list",
        "qm_agent_ping",
        "qm_list",
        "query_audit",
        "snapshot_list",
      ].sort()
    );
  });

  it("operate adds lifecycle + snapshot mutation, nothing else", () => {
    const added = toolsForTier("operate").filter((t) => !toolsForTier("observe").includes(t));
    expect(added.sort()).toEqual(
      [
        "guest_restart",
        "guest_start",
        "guest_stop",
        "snapshot_create",
        "snapshot_delete",
        "snapshot_rollback",
      ].sort()
    );
  });

  it("companion adds in-guest tools but NOT host exec/file tools", () => {
    const companion = toolsForTier("companion");
    expect(companion).toContain("pct_exec");
    expect(companion).toContain("qm_exec");
    expect(companion).toContain("config_sweep");
    expect(companion).not.toContain("execute");
    expect(companion).not.toContain("write_file");
    expect(companion).not.toContain("read_file");
    expect(companion).not.toContain("list_directory");
  });

  it("root adds exactly the four host-level tools", () => {
    const added = toolsForTier("root").filter((t) => !toolsForTier("companion").includes(t));
    expect(added.sort()).toEqual(["execute", "list_directory", "read_file", "write_file"]);
  });

  it("each tier is a strict superset of the one below", () => {
    const tiers: Tier[] = ["observe", "operate", "companion", "root"];
    for (let i = 1; i < tiers.length; i++) {
      const lower = toolsForTier(tiers[i - 1]!);
      const higher = toolsForTier(tiers[i]!);
      for (const t of lower) expect(higher).toContain(t);
    }
  });

  it("an unknown tool is never enabled", () => {
    expect(isToolEnabled("definitely_not_a_tool", "root")).toBe(false);
  });

  it("every mapped tool resolves to a known tier", () => {
    for (const [tool, tier] of Object.entries(TOOL_MIN_TIER)) {
      expect(isToolEnabled(tool, tier)).toBe(true);
    }
  });
});

describe("target-kind tier rule (diff_config / revert_file)", () => {
  it("a host target is root-grade; a guest target is companion-grade", () => {
    expect(targetMinTier("host")).toBe("root");
    expect(targetMinTier("pct")).toBe("companion");
    expect(targetMinTier("qm")).toBe("companion");
  });

  it("assertTargetTier allows a guest target at companion", () => {
    expect(() => assertTargetTier("revert_file", "pct", "companion")).not.toThrow();
  });

  it("assertTargetTier refuses a host target below root with a structured error", () => {
    expect(() => assertTargetTier("diff_config", "host", "companion")).toThrowError(
      /host target requires the 'root' tier/
    );
  });

  it("assertTargetTier allows a host target at root", () => {
    expect(() => assertTargetTier("revert_file", "host", "root")).not.toThrow();
  });
});
