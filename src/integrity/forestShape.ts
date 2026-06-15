/**
 * Pure forest-shape helpers (ADR-009 §1, §4) — the structural glue between a flat
 * node enumeration and the foldable tree the rest of the system consumes. Two jobs,
 * both pure:
 *
 *  - `synthesizeEntries` maps a source's real node paths into namespaced forest
 *    paths (`/etc/ssh` under prefix `host` → `host/etc/ssh`) and fills in every
 *    ancestor directory between a watched path and its prefix root, so
 *    `assembleSubtree` always receives a connected tree.
 *  - `foldForestRoots` builds the layer ABOVE the subtree roots: the intermediate
 *    group dirs (`pct` over `pct/101`, `pct/102`, …) and the synthetic super-root
 *    (`""`), folding them from the already-hashed subtree roots. This is what makes
 *    "one root hash over the whole lab" real.
 *
 * The host/container watched sets never overlap (§1) — `assertNonOverlap` enforces
 * the config invariant that the host watcher does not point at container-backing
 * storage, so the same bytes are never hashed twice via two transports.
 */
import { foldNode, emptyDirHash, type ChildRef } from "./folding.js";
import type { StoredNode } from "./nodeStore.js";
import { parentForestPath, leafName, SUPER_ROOT, type RawEntry } from "./tree.js";

export interface EnumeratedEntry {
  /** Node-absolute path, e.g. "/etc/ssh/sshd_config". */
  nodePath: string;
  kind: "file" | "dir";
  /** mtime in whole seconds, or null when unknown. */
  mtime: number | null;
  state: "present" | "unreadable";
}

/** Map a node path into the forest namespace: prefix="host", "/etc" → "host/etc". */
export function toForestPath(prefix: string, nodePath: string): string {
  // nodePath carries a leading "/", so concatenation yields the "/" separator.
  return nodePath === "/" ? prefix : prefix + nodePath;
}

/** Inverse of toForestPath, for sensitive-path matching: "host/etc/pve" → "/etc/pve". */
export function toNodePath(prefix: string, forestPath: string): string {
  if (forestPath === prefix) return "/";
  return forestPath.slice(prefix.length); // keeps the leading "/"
}

/**
 * Map a source's enumeration to RawEntries under `prefix`, synthesizing the prefix
 * root and every missing ancestor directory (as `present` dirs) so the subtree is
 * fully connected for folding.
 */
export function synthesizeEntries(prefix: string, enumerated: EnumeratedEntry[]): RawEntry[] {
  const byPath = new Map<string, RawEntry>();
  // The prefix root always exists as a present directory.
  byPath.set(prefix, { path: prefix, kind: "dir", mtime: null, state: "present" });

  for (const e of enumerated) {
    const fp = toForestPath(prefix, e.nodePath);
    byPath.set(fp, { path: fp, kind: e.kind, mtime: e.mtime, state: e.state });
    // Walk ancestors up to (and including) prefix, filling any gap as a present dir.
    let p = parentForestPath(fp);
    while (p && p.length >= prefix.length && !byPath.has(p)) {
      byPath.set(p, { path: p, kind: "dir", mtime: null, state: "present" });
      if (p === prefix) break;
      p = parentForestPath(p);
    }
  }
  return [...byPath.values()];
}

/**
 * Given every subtree node (each subtree root's parentPath points at its group),
 * synthesize and fold the intermediate group dirs + the super-root, returning ONLY
 * the newly-created ancestor nodes (caller concatenates with the subtree nodes).
 * Bottom-up by descending path length — a parent path is always a strict prefix of
 * its children, hence strictly shorter, so length order is topological.
 */
export function foldForestRoots(subtreeNodes: StoredNode[]): StoredNode[] {
  const hashOf = new Map<string, Buffer>();
  for (const n of subtreeNodes) hashOf.set(n.path, Buffer.from(n.hash, "hex"));

  // Every distinct ancestor path not already materialized as a node.
  const present = new Set(subtreeNodes.map((n) => n.path));
  const ancestors = new Set<string>();
  for (const n of subtreeNodes) {
    let p = n.parentPath;
    while (p !== null && !present.has(p) && !ancestors.has(p)) {
      ancestors.add(p);
      if (p === SUPER_ROOT) break;
      p = parentForestPath(p);
    }
  }

  const ordered = [...ancestors].sort((a, b) => b.length - a.length); // children before parents
  const childrenOf = (parent: string): ChildRef[] => {
    const refs: ChildRef[] = [];
    for (const n of subtreeNodes) if (n.parentPath === parent) refs.push({ name: leafName(n.path), hash: hashOf.get(n.path)! });
    for (const p of ancestors) if (p !== parent && parentForestPath(p) === parent) refs.push({ name: leafName(p), hash: hashOf.get(p)! });
    return refs;
  };

  const out: StoredNode[] = [];
  for (const path of ordered) {
    const kids = childrenOf(path);
    const hash = kids.length === 0 ? emptyDirHash() : foldNode(kids);
    hashOf.set(path, hash);
    out.push({
      path,
      hash: hash.toString("hex"),
      state: kids.length === 0 ? "empty-dir" : "present",
      mtime: null,
      parentPath: path === SUPER_ROOT ? null : parentForestPath(path),
      childNames: kids.map((k) => k.name).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))),
    });
  }
  return out;
}

/**
 * Non-overlap invariant (§1): throw if any host watch path is at/under a known
 * container-backing storage path. Asserted at forest-config load.
 */
export function assertNonOverlap(hostWatchPaths: string[], containerBackingPaths: string[]): void {
  for (const w of hostWatchPaths) {
    for (const b of containerBackingPaths) {
      const base = b.replace(/\/+$/, "");
      if (w === base || w.startsWith(base + "/")) {
        throw new Error(
          `integrity: host watch path "${w}" overlaps container-backing storage "${b}" — ` +
            `the same bytes would be hashed twice (raw vs pct view). Remove it from hostWatchPaths.`
        );
      }
    }
  }
}
