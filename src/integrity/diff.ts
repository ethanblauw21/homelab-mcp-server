/**
 * Pure tree diff (ADR-009 §5) — walk two folded trees (baseline vs working) from a
 * root and report drift. The whole point of the Merkle structure: **where two
 * subtrees share a hash, prune** — an unchanged `/etc/ssh` is one hash comparison,
 * not a thousand stat calls. Only the path-to-a-real-change is ever descended.
 *
 * The differ is transport-agnostic: it reads through a `TreeView` (a `get(path)` +
 * `children(parent)` pair), so it runs identically over a `NodeStore` partition or a
 * plain `StoredNode[]` (tests). Smart escalation (§1, §3) is the companion planner:
 * an L1 (mtime) diff yields the touched file set; only those paths get their L2/L3
 * content recomputed — L1 is the cheap tripwire that gates the expensive read.
 */
import type { StoredNode, NodeStore, TreeKind, Level } from "./nodeStore.js";
import type { NodeState } from "./folding.js";

export type DriftKind = "added" | "removed" | "changed" | "state-changed";

export interface DriftEntry {
  path: string;
  kind: DriftKind;
  baselineHash?: string;
  workingHash?: string;
  baselineState?: NodeState;
  workingState?: NodeState;
}

export interface TreeView {
  get(path: string): StoredNode | undefined;
  children(parentPath: string): StoredNode[];
}

/** A `TreeView` over a flat `StoredNode[]` (tests, in-memory forests). */
export function viewOf(nodes: StoredNode[]): TreeView {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const byParent = new Map<string, StoredNode[]>();
  for (const n of nodes) {
    if (n.parentPath === null) continue;
    const arr = byParent.get(n.parentPath) ?? [];
    arr.push(n);
    byParent.set(n.parentPath, arr);
  }
  return {
    get: (p) => byPath.get(p),
    children: (p) => (byParent.get(p) ?? []).slice().sort(byPathCmp),
  };
}

/** A `TreeView` bound to one (tree, level) partition of a `NodeStore`. */
export function storeView(store: NodeStore, tree: TreeKind, level: Level): TreeView {
  return {
    get: (p) => store.get(tree, level, p),
    children: (p) => store.getChildren(tree, level, p),
  };
}

/**
 * Diff `working` against `baseline` from `rootPath` down. Equal subtree hashes are
 * pruned (not descended). Returns drift newest-discovered-first is not guaranteed;
 * callers that want order should sort by `path`.
 */
export function treeDiff(baseline: TreeView, working: TreeView, rootPath: string): DriftEntry[] {
  const out: DriftEntry[] = [];
  walk(baseline, working, rootPath, out);
  return out;
}

function walk(baseline: TreeView, working: TreeView, path: string, out: DriftEntry[]): void {
  const b = baseline.get(path);
  const w = working.get(path);

  if (b && !w) {
    out.push({ path, kind: "removed", baselineHash: b.hash, baselineState: b.state });
    return;
  }
  if (!b && w) {
    out.push({ path, kind: "added", workingHash: w.hash, workingState: w.state });
    return;
  }
  if (!b || !w) return; // neither exists — nothing to report.

  if (b.hash === w.hash) return; // ★ short-circuit: identical subtree, prune.

  const bothLeaves = b.childNames === null && w.childNames === null;
  if (bothLeaves) {
    out.push({
      path,
      kind: b.state !== w.state ? "state-changed" : "changed",
      baselineHash: b.hash,
      workingHash: w.hash,
      baselineState: b.state,
      workingState: w.state,
    });
    return;
  }

  // A node that flipped kind (file⇄dir) or changed state at a dir — record, then
  // still descend the directory side so the concrete leaf drift is reported too.
  if (b.state !== w.state) {
    out.push({
      path,
      kind: "state-changed",
      baselineHash: b.hash,
      workingHash: w.hash,
      baselineState: b.state,
      workingState: w.state,
    });
  }

  const names = new Set<string>();
  for (const c of baseline.children(path)) names.add(lastSeg(c.path));
  for (const c of working.children(path)) names.add(lastSeg(c.path));
  for (const name of [...names].sort(byNameCmp)) {
    walk(baseline, working, joinPath(path, name), out);
  }
}

/**
 * Smart-escalation planner (§3): given an L1 (mtime) diff, return the set of file
 * paths whose content must be re-hashed at L2/L3. Only `added`/`changed`/`state-changed`
 * leaves count — a `removed` path has nothing left to read. Directory drift is ignored
 * here (its touched files surface as their own leaf entries).
 */
export function escalationTargets(l1Diff: DriftEntry[]): string[] {
  const targets = new Set<string>();
  for (const d of l1Diff) {
    if (d.kind === "removed") continue;
    targets.add(d.path);
  }
  return [...targets].sort();
}

function lastSeg(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}
function byPathCmp(a: StoredNode, b: StoredNode): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function byNameCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
