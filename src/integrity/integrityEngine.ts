/**
 * Integrity engine (ADR-009 §5–§6) — the orchestration layer tying the node store,
 * the forest sources, the pure diff/classify/policy cores, and the audit log into
 * the three tool verbs. Kept off the handlers so it can be tested whole against a
 * `MemoryNodeStore` + `FakeTransport`.
 *
 *  - `computeTree`  — assemble a fresh forest at one level into a tree partition.
 *  - `verify`       — read-only drift report: diff working vs baseline, classify each
 *                     leaf explained/unexplained (audit afterHash join), and preview
 *                     what the auto-accept policy WOULD do. Never mutates the baseline.
 *  - `acceptTruth`  — the explicit human override: fold current state (scope, or whole
 *                     forest) into all three baselines at once, audited.
 *  - `autoAccept`   — the audited automatic policy: fold exactly the leaves the policy
 *                     permits (explained always; unexplained per level/threshold;
 *                     sensitive never), one audit record per fold.
 *
 * Smart escalation (§3): `verify("smart")` computes L1, and descends into L2/L3 ONLY
 * when L1 flags a touch — a clean L1 reads zero file content.
 */
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import type { AuditLog } from "../audit/log.js";
import { buildAuditRecord } from "../audit/record.js";
import { parsePctList } from "../tools/pctHelpers.js";
import { foldNode, type ChildRef } from "./folding.js";
import {
  LEVELS,
  type Level,
  type TreeKind,
  type NodeStore,
  type StoredNode,
} from "./nodeStore.js";
import { SUPER_ROOT, leafName } from "./tree.js";
import {
  assembleForest,
  hostSubtreeSource,
  containerSubtreeSource,
  type SubtreeSource,
} from "./forest.js";
import { treeDiff, storeView, type DriftEntry } from "./diff.js";
import { buildExplainIndex, classifyHash, type Explainer } from "./classify.js";
import {
  applyAcceptPolicy,
  type AcceptPolicyConfig,
  type LeafDrift,
  type PolicyOutcome,
} from "./acceptPolicy.js";

export interface VerifyDriftLeaf {
  path: string;
  nodePath: string;
  oldHash?: string;
  newHash?: string;
  status: "explained" | "unexplained";
  explainedBy?: Explainer;
  l1: boolean;
  l2: boolean;
  l3: boolean;
}

/** ADR-018 §1: did this run actually compare, or did it just establish truth? */
export type VerifyMode = "seeded" | "compared";

/**
 * ADR-018 §1: WHY a run seeded rather than compared.
 *  - `no-baseline`   — first run ever for these levels; nothing existed to diff against.
 *  - `level-changed` — a baseline existed for some levels but not the one(s) being verified
 *                      (e.g. `INTEGRITY_LEVEL` changed, adding a new level tree). The
 *                      dangerous, silent re-seed: detection was NOT running for that level.
 *  - `scope-new`     — reserved for per-scope seeding. The current whole-tree seed trigger
 *                      (`baselineEmpty` over `/`) never emits this; it is part of the
 *                      documented contract for when scoped seeding lands.
 */
export type SeededReason = "no-baseline" | "level-changed" | "scope-new";

export interface VerifyReport {
  level: Level | "smart";
  scope: string;
  rootHash: string | null;
  drift: VerifyDriftLeaf[];
  policy: PolicyOutcome[];
  /** Back-compat flag (ADR-009). `mode === "seeded"` is the field new consumers read. */
  baselineSeeded: boolean;
  /** ADR-018 §1: `"seeded"` (this run established truth — NO detection occurred) vs `"compared"`. */
  mode: VerifyMode;
  /** ADR-018 §1: present only when `mode === "seeded"` — why the run seeded. */
  seededReason?: SeededReason;
  /** ADR-018 §1: human-readable explanation, present only when `mode === "seeded"`. */
  note?: string;
}

/** Pretty scope for operator-facing notes: the super-root renders as "whole forest". */
function scopeLabel(scope: string): string {
  return scope === SUPER_ROOT ? "whole forest" : scope;
}

/**
 * ADR-018 §1 (pure): classify why a verify run seeded. `emptyCount` of `totalCount`
 * seed levels had an empty baseline. All empty ⇒ first-run-ever (`no-baseline`); a
 * partial subset empty ⇒ a level/config change re-seeded (`level-changed`, the silent
 * case worth calling out). `scope-new` is reserved (see `SeededReason`).
 */
export function seededReasonFor(emptyCount: number, totalCount: number): SeededReason {
  return emptyCount >= totalCount ? "no-baseline" : "level-changed";
}

/** ADR-018 §1 (pure): the operator-facing `note` for a seeded run. */
export function seededNote(reason: SeededReason, scope: string): string {
  const where = scopeLabel(scope);
  if (reason === "level-changed") {
    return `Baseline re-seeded for ${where} (tracking level/config changed); drift detection did NOT run for the new level and begins on the next run.`;
  }
  if (reason === "scope-new") {
    return `Baseline established for new scope ${where}; drift detection begins on the next run.`;
  }
  return `Baseline established for ${where}; drift detection begins on the next run.`;
}

/** Map a forest path back to its node-absolute path (for sensitive matching). */
export function forestToNodePath(forestPath: string): string {
  if (forestPath === "host" || forestPath.startsWith("host/")) {
    const rest = forestPath.slice("host".length);
    return rest === "" ? "/" : rest;
  }
  const m = /^pct\/\d+(.*)$/.exec(forestPath);
  if (m) return m[1] === "" ? "/" : m[1];
  return "/" + forestPath; // super-root / group dirs — never sensitive leaves.
}

export class IntegrityEngine {
  constructor(
    private readonly store: NodeStore,
    private readonly transport: SshTransport,
    private readonly cfg: Config,
    private readonly audit: AuditLog
  ) {}

  private policyConfig(): AcceptPolicyConfig {
    return {
      maxUnexplainedL3: this.cfg.integrity.maxUnexplainedL3,
      allowL2AutoAccept: this.cfg.integrity.allowL2AutoAccept,
      sensitiveGlobs: this.cfg.integrity.sensitiveGlobs,
    };
  }

  /** Host + every container (stopped ones freeze via their own `available()`). */
  private async buildSources(): Promise<SubtreeSource[]> {
    const sources: SubtreeSource[] = [hostSubtreeSource(this.transport, this.cfg)];
    const res = await this.transport.exec("pct list", this.cfg.ssh.commandTimeoutMs);
    if (res.exitCode === 0) {
      for (const c of parsePctList(res.stdout)) {
        sources.push(containerSubtreeSource(this.transport, this.cfg, c.vmid));
      }
    }
    return sources;
  }

  private async computeForestNodes(level: Level): Promise<StoredNode[]> {
    const sources = await this.buildSources();
    return assembleForest({
      level,
      sources,
      configFileGlobs: this.cfg.integrity.configFileGlobs,
      frozenBaseline: (prefix) => this.store.allUnder("baseline", level, prefix),
    });
  }

  /** Assemble a fresh forest at `level` into `tree` (whole forest; scope filters reporting). */
  async computeTree(level: Level, tree: TreeKind = "baseline"): Promise<{ rootHash: string | null; nodeCount: number }> {
    const nodes = await this.computeForestNodes(level);
    this.store.replaceSubtree(tree, level, "/", nodes);
    const root = nodes.find((n) => n.path === SUPER_ROOT);
    return { rootHash: root ? root.hash : null, nodeCount: nodes.length };
  }

  private baselineEmpty(level: Level): boolean {
    return this.store.allUnder("baseline", level, "/").length === 0;
  }

  /**
   * Read-only drift report. `level` "smart" runs L1-gated escalation; a single level
   * reports only that level's drift. Never mutates the baseline.
   */
  async verify(level: Level | "smart", scope = SUPER_ROOT): Promise<VerifyReport> {
    // First-run seeding: with no baseline there is nothing to diff against. Seed the
    // baseline(s) and report no drift (everything is, by definition, the truth now).
    const seedLevels: Level[] = level === "smart" ? [...LEVELS] : [level];
    const emptyLevels = seedLevels.filter((l) => this.baselineEmpty(l));
    if (emptyLevels.length > 0) {
      for (const l of seedLevels) await this.computeTree(l, "baseline");
      const rootHash = this.store.get("baseline", seedLevels[seedLevels.length - 1], SUPER_ROOT)?.hash ?? null;
      const seededReason = seededReasonFor(emptyLevels.length, seedLevels.length);
      return {
        level,
        scope,
        rootHash,
        drift: [],
        policy: [],
        baselineSeeded: true,
        mode: "seeded",
        seededReason,
        note: seededNote(seededReason, scope),
      };
    }

    const perLevel = new Map<Level, Map<string, DriftEntry>>();
    const computeAndDiff = async (l: Level): Promise<void> => {
      const nodes = await this.computeForestNodes(l);
      this.store.replaceSubtree("working", l, "/", nodes);
      const entries = new Map<string, DriftEntry>();
      for (const d of treeDiff(storeView(this.store, "baseline", l), storeView(this.store, "working", l), scope)) {
        // Only file-leaf drift drives the policy; structural dir add/remove is captured
        // by its leaf entries. A leaf is a node with childNames === null in working.
        const w = this.store.get("working", l, d.path);
        const b = this.store.get("baseline", l, d.path);
        const isLeaf = (w && w.childNames === null) || (b && b.childNames === null) || d.kind === "added" || d.kind === "removed";
        if (isLeaf) entries.set(d.path, d);
      }
      perLevel.set(l, entries);
    };

    await computeAndDiff("l1");
    const l1Dirty = (perLevel.get("l1")?.size ?? 0) > 0;
    if (level === "smart") {
      if (l1Dirty) {
        await computeAndDiff("l2");
        await computeAndDiff("l3");
      }
    } else if (level !== "l1") {
      perLevel.delete("l1");
      await computeAndDiff(level);
    } else {
      // level === "l1": keep only the L1 diff.
    }

    const report = this.assembleReport(level, scope, perLevel);
    this.store.clearWorking();
    return report;
  }

  private assembleReport(
    level: Level | "smart",
    scope: string,
    perLevel: Map<Level, Map<string, DriftEntry>>
  ): VerifyReport {
    const index = buildExplainIndex(this.audit.readAll());
    const paths = new Set<string>();
    for (const m of perLevel.values()) for (const p of m.keys()) paths.add(p);

    const drift: VerifyDriftLeaf[] = [];
    for (const path of [...paths].sort()) {
      const l1 = perLevel.get("l1")?.get(path);
      const l2 = perLevel.get("l2")?.get(path);
      const l3 = perLevel.get("l3")?.get(path);
      const best = l3 ?? l2 ?? l1!; // richest level present drives old/new hash + classify.
      const cls = classifyHash(best.workingHash, index);
      drift.push({
        path,
        nodePath: forestToNodePath(path),
        oldHash: best.baselineHash,
        newHash: best.workingHash,
        status: cls.status,
        explainedBy: cls.explainedBy,
        l1: !!l1,
        l2: !!l2,
        l3: !!l3,
      });
    }

    const leafDrifts: LeafDrift[] = drift.map((d) => ({
      path: d.path,
      nodePath: d.nodePath,
      explained: d.status === "explained",
      explainedBy: d.explainedBy?.auditId,
      l1: d.l1,
      l2: d.l2,
      l3: d.l3,
    }));
    const policy = applyAcceptPolicy(leafDrifts, this.policyConfig());
    const rootHash = this.store.get("working", "l3", SUPER_ROOT)?.hash ?? null;
    return { level, scope, rootHash, drift, policy, baselineSeeded: false, mode: "compared" };
  }

  /**
   * Explicit accept-truth: fold current state (scope, or whole forest) into all three
   * baselines at once — they describe one moment. Audited with before/after super-root
   * hashes.
   */
  async acceptTruth(scope = SUPER_ROOT): Promise<{ auditId: string; rootHash: string | null; levels: Level[] }> {
    const beforeHash = this.store.get("baseline", "l3", SUPER_ROOT)?.hash;
    // The store's whole-tree sentinel is "/"; the forest super-root path is "".
    const storeScope = scope === SUPER_ROOT ? "/" : scope;
    for (const l of LEVELS) {
      const nodes = await this.computeForestNodes(l);
      this.store.replaceSubtree("working", l, "/", nodes);
      this.store.promote(l, storeScope);
    }
    this.store.clearWorking();
    const rootHash = this.store.get("baseline", "l3", SUPER_ROOT)?.hash ?? null;
    const record = buildAuditRecord({
      tool: "accept_truth",
      host: this.cfg.ssh.host,
      hashScope: scope === SUPER_ROOT ? "/" : scope,
      beforeHash,
      afterHash: rootHash ?? undefined,
      note: `accept_truth folded ${scope === SUPER_ROOT ? "whole forest" : scope} into all baselines`,
    });
    await this.audit.append(record);
    return { auditId: record.id, rootHash, levels: [...LEVELS] };
  }

  /**
   * Apply the auto-accept policy to a verify report: fold exactly the permitted leaves
   * into the baseline(s) and audit each fold. Requires a fresh working tree, so it
   * recomputes the same levels the report covered. Returns the folded outcomes.
   */
  async autoAccept(level: Level | "smart", scope = SUPER_ROOT): Promise<{ folded: PolicyOutcome[]; flagged: PolicyOutcome[] }> {
    const report = await this.verify(level, scope);
    if (report.baselineSeeded || report.policy.length === 0) return { folded: [], flagged: [] };

    // Recompute working so the accepted leaves' fresh nodes are available to fold.
    const levels: Level[] = level === "smart" ? [...LEVELS] : [level];
    for (const l of levels) {
      const nodes = await this.computeForestNodes(l);
      this.store.replaceSubtree("working", l, "/", nodes);
    }

    const folded: PolicyOutcome[] = [];
    const flagged: PolicyOutcome[] = [];
    for (const outcome of report.policy) {
      if (outcome.decision !== "fold") {
        flagged.push(outcome);
        continue;
      }
      this.foldLeafIntoBaseline(outcome.path, levels);
      folded.push(outcome);
      const record = buildAuditRecord({
        tool: "accept_truth",
        host: this.cfg.ssh.host,
        path: forestToNodePath(outcome.path),
        hashScope: forestToNodePath(outcome.path),
        afterHash: this.store.get("baseline", "l3", outcome.path)?.hash,
        note: `auto-accept (${outcome.reason}) folded ${outcome.path}` +
          (outcome.explainedBy ? ` [explained by ${outcome.explainedBy}]` : ""),
      });
      await this.audit.append(record);
    }
    this.store.clearWorking();
    return { folded, flagged };
  }

  /** Surgically fold one working leaf into the baseline at each level it exists, refolding ancestors. */
  private foldLeafIntoBaseline(path: string, levels: Level[]): void {
    for (const l of levels) {
      const w = this.store.get("working", l, path);
      if (!w) continue;
      this.store.surgicalUpdate("baseline", l, [w]);
      this.refoldPathToRoot(l, path);
    }
  }

  /** Recompute every ancestor hash from its children after a leaf changed, up to the super-root. */
  private refoldPathToRoot(level: Level, leafPath: string): void {
    let path = this.store.get("baseline", level, leafPath)?.parentPath ?? null;
    while (path !== null) {
      const node = this.store.get("baseline", level, path);
      if (!node) break;
      const children = this.store.getChildren("baseline", level, path);
      const refs: ChildRef[] = children.map((c) => ({ name: leafName(c.path), hash: Buffer.from(c.hash, "hex") }));
      const hash = refs.length === 0 ? node.hash : foldNode(refs).toString("hex");
      this.store.surgicalUpdate("baseline", level, [
        { ...node, hash, childNames: children.map((c) => leafName(c.path)).sort(byteCmp) },
      ]);
      path = node.parentPath;
    }
  }
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
