/**
 * Pure tree assembly (ADR-009 §1, §3) — fold a flat list of enumerated entries into
 * the `StoredNode[]` for one forest subtree, at one level. No I/O: the caller
 * (`forest.ts`) gathers entries + content hashes over a transport and hands them in.
 *
 * Forest paths are namespaced (`host/etc/…`, `pct/101/etc/…`) so the host and
 * container subtrees can never collide; the synthetic super-root (path `""`) folds
 * the roots together (done in `forest.ts`). Membership differs per level:
 *   - L1 / L3 — every enumerated file.
 *   - L2 — only files the config predicate accepts, plus the ancestor dirs that
 *           transitively contain one (dirs with no config descendant are pruned).
 */
import {
  foldLeaf,
  foldNode,
  emptyDirHash,
  unreadableHash,
  mtimePayload,
  hashHex,
  type ChildRef,
  type NodeState,
} from "./folding.js";
import type { Level, StoredNode } from "./nodeStore.js";

/** The super-root's path: the empty string, parent of every forest root. */
export const SUPER_ROOT = "";

export interface RawEntry {
  /** Namespaced forest path, e.g. "host/etc/ssh/sshd_config". */
  path: string;
  kind: "file" | "dir";
  /** mtime in whole seconds, or null when unknown (e.g. unreadable). */
  mtime: number | null;
  /** `present` | `empty-dir` | `unreadable`. (`unavailable` is a forest-level state.) */
  state: NodeState;
}

export interface AssembleInput {
  level: Level;
  /** The subtree root forest path (e.g. "host" or "pct/101"). Always included. */
  rootPath: string;
  /** Every entry at/under `rootPath`, including `rootPath` itself (a dir). */
  entries: RawEntry[];
  /** Hex content hash for a file path (L2/L3 only); undefined ⇒ unreadable content. */
  contentHash: (path: string) => string | undefined;
  /** L2 membership predicate over a file's forest path. */
  isConfigFile: (path: string) => boolean;
}

/** Parent forest path of a namespaced path: "host/etc/ssh" → "host/etc"; "host" → SUPER_ROOT. */
export function parentForestPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? SUPER_ROOT : path.slice(0, i);
}

/** Last path segment (the raw name folded into the parent): "host/etc/ssh" → "ssh". */
export function leafName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Fold one subtree into stored nodes. Returns every included node (root + descendants)
 * with hash/state/parent/childNames populated, ready for `NodeStore.replaceSubtree`.
 */
export function assembleSubtree(input: AssembleInput): StoredNode[] {
  const { level, rootPath, entries, contentHash, isConfigFile } = input;
  const byPath = new Map<string, RawEntry>();
  for (const e of entries) byPath.set(e.path, e);

  // L2 membership: a file is included iff config; a dir iff it has an included descendant.
  const included = new Set<string>();
  if (level === "l2") {
    for (const e of entries) {
      if (e.kind === "file" && isConfigFile(e.path)) {
        // include the file and every ancestor up to (and including) rootPath.
        let p: string = e.path;
        while (p && p.length >= rootPath.length && !included.has(p)) {
          included.add(p);
          if (p === rootPath) break;
          p = parentForestPath(p);
        }
      }
    }
    included.add(rootPath); // the subtree root is always present even if config-empty.
  } else {
    for (const e of entries) included.add(e.path);
  }

  // Order by descending depth so a directory is folded after its children.
  const ordered = [...included].sort((a, b) => depth(b) - depth(a));
  const hashOf = new Map<string, Buffer>();
  const out: StoredNode[] = [];

  for (const path of ordered) {
    const e = byPath.get(path);
    if (!e) continue;
    let hash: Buffer;
    let childNames: string[] | null = null;

    if (e.state === "unreadable") {
      hash = unreadableHash();
      if (e.kind === "dir") childNames = [];
    } else if (e.kind === "file") {
      const payload = level === "l1" ? mtimePayload(e.mtime ?? 0) : contentBuffer(contentHash(path));
      // A file whose content could not be read (L2/L3) is unreadable, not silently empty.
      hash = payload === UNREADABLE ? unreadableHash() : foldLeaf(payload);
    } else {
      // directory: fold its included children (already hashed, deeper in `ordered`).
      const kids: ChildRef[] = [];
      for (const child of entries) {
        if (child.path === path) continue;
        if (parentForestPath(child.path) === path && included.has(child.path)) {
          const ch = hashOf.get(child.path);
          if (ch) kids.push({ name: leafName(child.path), hash: ch });
        }
      }
      childNames = kids.map((k) => k.name).sort(compareBytes);
      hash = kids.length === 0 ? emptyDirHash() : foldNode(kids);
    }

    hashOf.set(path, hash);
    const state: NodeState = e.kind === "dir" && e.state === "present" && childNames!.length === 0 ? "empty-dir" : e.state;
    out.push({
      path,
      hash: hashHex(hash),
      state,
      mtime: e.mtime,
      // parentForestPath("host") = "" (super-root); parentForestPath("pct/101") =
      // "pct" (an intermediate group dir synthesized by the forest layer).
      parentPath: parentForestPath(path),
      childNames,
    });
  }
  return out;
}

// Sentinel distinguishing "content unavailable" from a real empty buffer.
const UNREADABLE = Symbol("unreadable") as unknown as Buffer;
function contentBuffer(hex: string | undefined): Buffer {
  if (hex === undefined) return UNREADABLE;
  return Buffer.from(hex, "utf8"); // leaf_payload = the content hash bytes (§1)
}

function depth(path: string): number {
  let d = 0;
  for (const c of path) if (c === "/") d++;
  return d;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
