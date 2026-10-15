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
        // ADR-020 §2 — host-side probes need no credentials, so they floor at observe.
        "tcp_ping",
        "http_probe",
      ].sort()
    );
  });

  it("operate adds exactly the API-native lifecycle tools, nothing else", () => {
    const added = toolsForTier("operate").filter((t) => !toolsForTier("observe").includes(t));
    expect(added.sort()).toEqual(["guest_restart", "guest_start", "guest_stop"].sort());
  });

  it("companion adds in-guest tools + the SSH-routed snapshot set but NOT host exec/file tools", () => {
    const companion = toolsForTier("companion");
    expect(companion).toContain("pct_exec");
    expect(companion).toContain("qm_exec");
    expect(companion).toContain("config_sweep");
    expect(companion).toContain("snapshot_create");
    expect(companion).toContain("snapshot_list");
    // ADR-012 — compose_preflight reaches inside an LXC (pct exec/pull), so it
    // floors at companion alongside compose_redeploy and the docker family; an
    // observe token cannot exec in a container.
    expect(companion).toContain("compose_preflight");
    // ADR-017 §4 — describe_guest is exec-bound (config/docker/units), companion floor.
    expect(companion).toContain("describe_guest");
    expect(toolsForTier("observe")).not.toContain("describe_guest");
    // ADR-016 — Docker introspection trio rides the companion `pct exec docker …` boundary.
    expect(companion).toContain("docker_inspect");
    expect(companion).toContain("docker_stats");
    expect(companion).toContain("compose_discover");
    expect(toolsForTier("observe")).not.toContain("docker_inspect");
    expect(toolsForTier("operate")).not.toContain("compose_preflight");
    expect(toolsForTier("observe")).not.toContain("compose_preflight");
    // ADR-020 §1/§3 — systemd front door + regex read floor at companion (an LXC
    // target via pct exec); a host target additionally requires root at runtime.
    expect(companion).toContain("service_status");
    expect(companion).toContain("service_logs");
    expect(companion).toContain("service_restart");
    expect(companion).toContain("search_file_regex");
    // ADR-011 — guest edit tools share their write surface's companion floor.
    expect(companion).toContain("pct_edit_file");
    expect(companion).toContain("qm_edit_file");
    expect(companion).toContain("docker_edit_file");
    expect(companion).not.toContain("execute");
    expect(companion).not.toContain("write_file");
    expect(companion).not.toContain("edit_file");
    expect(companion).not.toContain("read_file");
    expect(companion).not.toContain("list_directory");
  });

  it("root adds exactly the host-level tools (incl. ADR-011 edit_file)", () => {
    const added = toolsForTier("root").filter((t) => !toolsForTier("companion").includes(t));
    expect(added.sort()).toEqual(
      ["edit_file", "execute", "list_directory", "read_file", "write_file"].sort()
    );
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

// ADR-024 — startup tool allowlist: an intersection inside the tier, fail-closed.
import { isToolRegistered, registeredTools, checkToolAllowlist, nearestNames } from "./registry.js";

describe("tool allowlist (ADR-024)", () => {
  it("unset allowlist registers exactly the tier set (byte-for-byte today's behaviour)", () => {
    for (const tier of ["observe", "operate", "companion", "root"] as Tier[]) {
      expect(registeredTools(tier)).toEqual(toolsForTier(tier));
    }
  });

  it("is an intersection: it can shrink the set but never add a tool above the tier", () => {
    const list = ["docker_ps", "query_audit", "execute"]; // execute is root-only
    expect(registeredTools("companion", list)).toEqual(["docker_ps", "query_audit"]);
    expect(isToolRegistered("execute", "companion", list)).toBe(false);
    expect(isToolRegistered("execute", "root", list)).toBe(true);
    expect(isToolRegistered("pct_exec", "companion", list)).toBe(false);
  });

  it("every registered tool under any allowlist is a subset of the tier set", () => {
    const list = Object.keys(TOOL_MIN_TIER).filter((_, i) => i % 3 === 0);
    for (const tier of ["observe", "operate", "companion", "root"] as Tier[]) {
      const reg = registeredTools(tier, list);
      for (const t of reg) expect(toolsForTier(tier)).toContain(t);
      for (const t of reg) expect(list).toContain(t);
    }
  });

  it("unset passes the startup check", () => {
    expect(checkToolAllowlist(undefined, "observe")).toEqual({ aboveTier: [] });
  });

  it("an empty list is a startup error, never 'zero tools'", () => {
    expect(() => checkToolAllowlist([], "companion")).toThrow(/empty/);
  });

  it("an unknown name is a startup error with a nearest-name hint", () => {
    expect(() => checkToolAllowlist(["docker_pss", "query_audit"], "companion")).toThrow(
      /unknown tool\(s\): docker_pss \(did you mean docker_ps/
    );
  });

  it("known tools above the tier are reported for a warning, not an error", () => {
    expect(checkToolAllowlist(["docker_ps", "execute", "pct_exec"], "operate").aboveTier).toEqual([
      "docker_ps",
      "execute",
      "pct_exec",
    ]);
    expect(checkToolAllowlist(["docker_ps", "execute"], "companion").aboveTier).toEqual(["execute"]);
  });

  it("nearestNames returns close matches only", () => {
    expect(nearestNames("health_chek", Object.keys(TOOL_MIN_TIER))).toContain("health_check");
    expect(nearestNames("zzzzzzzzzzzz", Object.keys(TOOL_MIN_TIER))).toEqual([]);
  });
});
