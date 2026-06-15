import { describe, it, expect } from "vitest";
import {
  HUMAN_TOOLS,
  HUMAN_TOOL_JUSTIFICATION,
  EXCLUDED_AGENT_TOOLS,
  isHumanTool,
  humanToolsForTier,
} from "./humanTools.js";
import { TOOL_MIN_TIER } from "../tiers/registry.js";

/**
 * ADR-010 §5 — the safety-critical registry. These tests are the executable
 * specification of "the standing UI may run ONLY this tiny human-principal set."
 * A regression that adds an agent-principal actuator must turn one of these RED.
 */
describe("HUMAN_TOOLS registry (ADR-010 §5)", () => {
  it("is exactly the four read-mostly human-principal tools — no more", () => {
    // Pinned literally: growing this set is an ADR-level decision, so the test must
    // be edited deliberately alongside the doc, never drift silently.
    expect([...HUMAN_TOOLS].sort()).toEqual(
      ["accept_truth", "compute_tree", "config_sweep", "verify_integrity"].sort()
    );
  });

  it("never intersects the explicitly-excluded agent-principal tools", () => {
    const human = new Set<string>(HUMAN_TOOLS);
    for (const agent of EXCLUDED_AGENT_TOOLS) {
      expect(human.has(agent)).toBe(false);
    }
  });

  it("excludes every open-ended actuator: exec, write, guest lifecycle, snapshot rollback", () => {
    // Spot-check the categories §1 forbids from the standing surface.
    for (const forbidden of [
      "execute",
      "pct_exec",
      "qm_exec",
      "docker_exec",
      "write_file",
      "pct_write_file",
      "qm_write_file",
      "docker_write_file",
      "guest_start",
      "guest_stop",
      "guest_restart",
      "guest_backup_restore",
      "compose_redeploy",
      "snapshot_rollback",
    ]) {
      expect(isHumanTool(forbidden)).toBe(false);
    }
  });

  it("holds guest_* OUT of v1 (promotion is an ADR decision, not config)", () => {
    expect(isHumanTool("guest_start")).toBe(false);
    expect(isHumanTool("guest_stop")).toBe(false);
    expect(isHumanTool("guest_restart")).toBe(false);
  });

  it("carries a recorded justification for every human tool", () => {
    for (const t of HUMAN_TOOLS) {
      expect(HUMAN_TOOL_JUSTIFICATION[t]).toBeTruthy();
      expect(HUMAN_TOOL_JUSTIFICATION[t].length).toBeGreaterThan(10);
    }
  });

  it("every human tool is a real registered tool with a known min-tier", () => {
    for (const t of HUMAN_TOOLS) {
      expect(TOOL_MIN_TIER[t]).toBeDefined();
    }
  });
});

describe("humanToolsForTier — obeys the ADR-007 tier floor", () => {
  it("exposes the full set at companion and root (all four are companion-tier)", () => {
    expect(humanToolsForTier("companion").sort()).toEqual([...HUMAN_TOOLS].sort());
    expect(humanToolsForTier("root").sort()).toEqual([...HUMAN_TOOLS].sort());
  });

  it("exposes an EMPTY set below companion (observe/operate executor is inert)", () => {
    // The §2 promise: an observe/operate install's executor has no companion-tier
    // actions, so it is renderer-only in practice.
    expect(humanToolsForTier("observe")).toEqual([]);
    expect(humanToolsForTier("operate")).toEqual([]);
  });
});
