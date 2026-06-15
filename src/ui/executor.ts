import type { Config } from "../config.js";
import type { AuditLog } from "../audit/log.js";
import type { SshTransport } from "../ssh/transport.js";
import type { ConfigHistory } from "../history/configHistory.js";
import type { IntegrityEngine } from "../integrity/integrityEngine.js";
import { type Tier } from "../tiers/registry.js";
import { humanToolsForTier } from "./humanTools.js";
import {
  ComputeTreeInputSchema,
  computeTreeHandler,
  VerifyIntegrityInputSchema,
  verifyIntegrityHandler,
  AcceptTruthInputSchema,
  acceptTruthHandler,
  type DriftSnapshotSink,
} from "../tools/integrity.js";
import { ConfigSweepInputSchema, configSweepHandler } from "../tools/configSweep.js";

/**
 * ADR-010 §2 — the EXECUTOR half: a minimal local component that runs the bounded
 * §5 human-tool set when the user clicks a live action. The reframe (§1) is
 * enforced HERE by REGISTRATION-FILTERING, not a runtime refusal:
 *
 *   - In strict renderer-only mode (the default, `enableActions: false`) the
 *     runner map is left EMPTY — no tool is wired, the executor holds no node
 *     credentials, `run()` always refuses. This IS the original ADR-001 property
 *     in its empty-set form.
 *   - When actions are enabled, ONLY `humanToolsForTier(tier)` are wired. An
 *     agent-principal tool (`execute`, `write_file`, `qm_exec`, guest lifecycle, …)
 *     is never in the map, so `run("execute", …)` fails the same way an absent
 *     tier fails: the tool simply does not exist in this process.
 *
 * Each runner delegates to the exact same handler the MCP path uses, so a button
 * press writes the identical audit record (accept_truth/compute_tree/config_sweep
 * audit inside their handlers; verify_integrity is read-only and unaudited on both
 * paths — parity preserved).
 */
export interface ExecutorDeps {
  tier: Tier;
  enableActions: boolean;
  config: Config;
  // The action-only deps are optional: in strict renderer-only mode `server.ts`
  // deliberately constructs NONE of them (no SSH transport, no native SQLite store,
  // no engine — zero node credentials). They are required iff `enableActions`, which
  // the constructor asserts before wiring any runner.
  audit?: AuditLog;
  engine?: IntegrityEngine;
  transport?: SshTransport;
  configHistory?: ConfigHistory;
  // Persist verify reports run via the UI too, so the cached drift panel refreshes.
  driftSink?: DriftSnapshotSink | null;
}

type Runner = (input: unknown) => Promise<unknown>;

export class UiExecutor {
  private readonly runners = new Map<string, Runner>();

  constructor(private readonly deps: ExecutorDeps) {
    // Strict renderer-only: wire NOTHING. The executor is inert by construction.
    if (!deps.enableActions) return;

    // Actions on ⇒ the node-touching deps MUST be present. Fail loud at startup
    // rather than NPE on the first button press.
    const { engine, audit, transport, configHistory } = deps;
    if (!engine || !audit || !transport || !configHistory) {
      throw new Error(
        "UiExecutor: enableActions is true but engine/audit/transport/configHistory were not provided."
      );
    }

    for (const tool of humanToolsForTier(deps.tier)) {
      switch (tool) {
        case "verify_integrity":
          this.runners.set(tool, (i) =>
            verifyIntegrityHandler(VerifyIntegrityInputSchema.parse(i), engine, deps.config, deps.driftSink ?? null)
          );
          break;
        case "compute_tree":
          this.runners.set(tool, (i) =>
            computeTreeHandler(ComputeTreeInputSchema.parse(i), engine, audit, deps.config)
          );
          break;
        case "accept_truth":
          this.runners.set(tool, (i) =>
            acceptTruthHandler(AcceptTruthInputSchema.parse(i), engine, deps.config)
          );
          break;
        case "config_sweep":
          // Only when the git mirror actually initialized (parity with index.ts,
          // which registers config_sweep solely when the subsystem is enabled).
          if (configHistory.enabled) {
            this.runners.set(tool, (i) =>
              configSweepHandler(
                ConfigSweepInputSchema.parse(i),
                transport,
                configHistory,
                audit,
                deps.config
              )
            );
          }
          break;
      }
    }
  }

  get actionsEnabled(): boolean {
    return this.deps.enableActions;
  }

  /** The exact tools this executor will run (sorted, for the UI + snapshot tests). */
  availableTools(): string[] {
    return [...this.runners.keys()].sort();
  }

  /**
   * Run a human-principal tool. Refuses in strict mode, and refuses any tool not
   * in the wired set — which is every agent-principal tool, by construction.
   */
  async run(tool: string, input: unknown): Promise<unknown> {
    if (!this.deps.enableActions) {
      throw new Error(
        "UI is in strict renderer-only mode (ADR-010 action item 7); live actions are disabled. " +
          "Set UI_ENABLE_ACTIONS=true and restart the UI to enable the bounded executor."
      );
    }
    const runner = this.runners.get(tool);
    if (!runner) {
      throw new Error(
        `'${tool}' is not a standing human-principal tool (ADR-010 §1/§5). ` +
          "Agent-principal tools (execute, *_write_file, *_exec, guest lifecycle, snapshot rollback) " +
          "are reachable only through an MCP client session."
      );
    }
    return runner(input);
  }
}
