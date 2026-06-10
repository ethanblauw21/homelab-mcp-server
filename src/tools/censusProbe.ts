/**
 * R1 — probes as data, run through one chokepoint (ADR-002 refinement).
 *
 * Every census probe is a declarative `ProbeSpec` row routed through a single
 * generic runner; every probe result passes through one `expectSuccess` helper
 * instead of inline `exitCode === 0` checks. When ADR-004's `ExecResult`
 * migration lands (`exitCode: number | null`, `timedOut: boolean`), only
 * `expectSuccess` changes — not fifteen call sites.
 */
import type { ExecResult, SshTransport } from "../ssh/transport.js";
import type { CensusError, CensusSection } from "./censusTypes.js";

/** Thrown when the global census time budget is exhausted; stops the whole run. */
export class BudgetExceeded extends Error {}

/**
 * The single success/failure decision for every probe. Returns stdout on
 * success; throws a descriptive error on a non-zero exit. This is the seam for
 * ADR-004 — `timedOut` and a null exit code get interpreted here and nowhere
 * else.
 */
export function expectSuccess(result: ExecResult): string {
  if (result.exitCode !== 0) {
    throw new Error(`exit ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`);
  }
  return result.stdout;
}

/** A declarative probe row. Adding a probe = adding one of these + a parser. */
export interface ProbeSpec<T> {
  section: CensusSection;
  /** Stable label used in error records (matches the underlying command). */
  key: string;
  command: string;
  parser: (stdout: string) => T;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs probe commands under one wall-clock budget and one per-probe timeout,
 * funnelling every exec through `expectSuccess`. Holds no section logic — it is
 * the transport-facing half of the census handler.
 */
export class ProbeRunner {
  private readonly deadline: number;

  constructor(
    private readonly transport: SshTransport,
    private readonly timeoutMs: number,
    private readonly budgetMs: number,
    private readonly now: () => number = Date.now
  ) {
    this.deadline = now() + budgetMs;
  }

  private checkBudget(): void {
    if (this.now() > this.deadline) {
      throw new BudgetExceeded(`census time budget (${this.budgetMs}ms) exceeded`);
    }
  }

  /** Exec + budget + timeout + success check. Throws on non-zero exit or budget. */
  async hard(command: string): Promise<string> {
    this.checkBudget();
    return expectSuccess(await this.transport.exec(command, this.timeoutMs));
  }

  /**
   * Tolerant variant: a non-zero exit / absence yields `null` (e.g. zfs,
   * tailscale, docker that may not be installed). Budget exhaustion still
   * propagates so it can stop the census.
   */
  async soft(command: string): Promise<string | null> {
    try {
      return await this.hard(command);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      return null;
    }
  }
}

/**
 * Run one declarative probe row. On failure records a section-scoped error and
 * returns `fallback`; budget exhaustion propagates to abort the whole census.
 * This is the single generic runner R1 calls for: a new section field is "a new
 * row plus a parser" handed to this function.
 */
export async function runProbe<T>(
  runner: ProbeRunner,
  spec: ProbeSpec<T>,
  fallback: T,
  errors: CensusError[]
): Promise<T> {
  try {
    return spec.parser(await runner.hard(spec.command));
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    errors.push({ section: spec.section, probe: spec.key, error: errMsg(e) });
    return fallback;
  }
}
