import { describe, it, expect, vi } from "vitest";
import { UiExecutor, type ExecutorDeps } from "./executor.js";
import type { Config } from "../config.js";
import type { Tier } from "../tiers/registry.js";

/**
 * ADR-010 §2 — the executor is the enforcement point for the §1 reframe. These tests
 * assert: strict mode wires nothing, action mode wires EXACTLY the tier's human set,
 * agent tools are unreachable by construction, and the tier floor is honored.
 */

const CONFIG = {
  integrity: { level: "l2" },
  ssh: { host: "node.lan" },
} as unknown as Config;

// A minimal engine/audit/history; the wiring tests never actually RUN a handler that
// reaches these (we assert availability + refusal, not handler internals).
function fakeDeps(overrides: Partial<ExecutorDeps>): ExecutorDeps {
  return {
    tier: "companion",
    enableActions: true,
    config: CONFIG,
    audit: { append: vi.fn() } as never,
    engine: {} as never,
    transport: {} as never,
    configHistory: { enabled: true } as never,
    ...overrides,
  };
}

describe("UiExecutor — strict renderer-only mode (default)", () => {
  it("wires NO tools and refuses every run() when actions are disabled", async () => {
    const ex = new UiExecutor({ tier: "companion", enableActions: false, config: CONFIG });
    expect(ex.actionsEnabled).toBe(false);
    expect(ex.availableTools()).toEqual([]);
    await expect(ex.run("verify_integrity", {})).rejects.toThrow(/strict renderer-only/i);
    await expect(ex.run("accept_truth", {})).rejects.toThrow(/strict renderer-only/i);
  });

  it("needs no node-touching deps in strict mode (renderer-only is credential-free)", () => {
    // Construct with ONLY tier/enableActions/config — the omitted engine/transport/
    // audit/configHistory must not be dereferenced.
    expect(() => new UiExecutor({ tier: "companion", enableActions: false, config: CONFIG })).not.toThrow();
  });
});

describe("UiExecutor — action mode wiring", () => {
  it("wires EXACTLY the companion human-tool set", () => {
    const ex = new UiExecutor(fakeDeps({ tier: "companion" }));
    expect(ex.availableTools()).toEqual(["accept_truth", "compute_tree", "config_sweep", "verify_integrity"]);
  });

  it("omits config_sweep when the git mirror never initialized", () => {
    const ex = new UiExecutor(fakeDeps({ tier: "companion", configHistory: { enabled: false } as never }));
    expect(ex.availableTools()).toEqual(["accept_truth", "compute_tree", "verify_integrity"]);
  });

  it("refuses any agent-principal tool — it is not in the wired map", async () => {
    const ex = new UiExecutor(fakeDeps({ tier: "companion" }));
    for (const agent of ["execute", "write_file", "qm_exec", "guest_stop", "snapshot_rollback"]) {
      await expect(ex.run(agent, {})).rejects.toThrow(/not a standing human-principal tool/i);
    }
  });

  it("throws at construction if actions are enabled but deps are missing", () => {
    expect(
      () =>
        new UiExecutor({
          tier: "companion",
          enableActions: true,
          config: CONFIG,
          // engine/transport/audit/configHistory deliberately omitted
        })
    ).toThrow(/were not provided/i);
  });
});

describe("UiExecutor — tier floor (ADR-007)", () => {
  it.each(["observe", "operate"] as Tier[])("exposes an empty action set at %s tier", (tier) => {
    const ex = new UiExecutor(fakeDeps({ tier }));
    expect(ex.availableTools()).toEqual([]);
  });
});

describe("UiExecutor — handler delegation (audit parity)", () => {
  it("calls the real verify handler with the drift sink so a button refreshes the cache", async () => {
    const save = vi.fn();
    const engine = {
      verify: vi.fn().mockResolvedValue({ level: "l2", drift: [], baselineSeeded: false }),
    } as never;
    const ex = new UiExecutor(fakeDeps({ tier: "companion", engine, driftSink: { save } }));
    const out = await ex.run("verify_integrity", { level: "l2" });
    expect(out).toMatchObject({ level: "l2" });
    expect(save).toHaveBeenCalledOnce();
  });
});
