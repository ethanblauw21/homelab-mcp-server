/**
 * SQLite node store (ADR-009 §2) — the client-side persistence for the Merkle
 * forest. Keyed by `(tree, level, path)` so:
 *   - incremental update is surgical (one leaf + its path-to-root, not a blob rewrite);
 *   - `tree_diff` and "nodes under this subtree" are indexed queries, not walks;
 *   - writes are atomic (better-sqlite3 transactions + WAL) — a crash mid-update
 *     cannot corrupt the baseline.
 *
 * Two `tree` partitions: `baseline` (the accepted truth, three levels) and `working`
 * (freshly-computed trees during a verify, before accept-truth folds them in). The
 * store is deliberately dumb — row CRUD + atomic batches; the folding, diffing, and
 * accept-policy logic live in pure modules above it. A Map-backed `MemoryNodeStore`
 * mirrors the same contract so the forest/diff layers test without native SQLite.
 */
import type Database from "better-sqlite3";
import type { NodeState } from "./folding.js";

export type Level = "l1" | "l2" | "l3";
export type TreeKind = "baseline" | "working";

export const LEVELS: readonly Level[] = ["l1", "l2", "l3"];

export interface StoredNode {
  path: string;
  /** Hex hash (the folded node/leaf hash, or a frozen hash for `unavailable`). */
  hash: string;
  state: NodeState;
  /** mtime in whole seconds, or null for non-file nodes / when unknown. */
  mtime: number | null;
  /** Parent path, or null for a forest root / the synthetic super-root. */
  parentPath: string | null;
  /** Child segment names for a directory node; null for a file leaf. */
  childNames: string[] | null;
}

export interface NodeStore {
  get(tree: TreeKind, level: Level, path: string): StoredNode | undefined;
  getChildren(tree: TreeKind, level: Level, parentPath: string): StoredNode[];
  /** All nodes at/under `scopePath` (inclusive) for (tree, level). */
  allUnder(tree: TreeKind, level: Level, scopePath: string): StoredNode[];
  /** Nodes whose hash equals `hash` (for diagnostics; audit join lives elsewhere). */
  findByHash(tree: TreeKind, level: Level, hash: string): StoredNode[];

  /** Atomically replace every node at/under `scopePath` for (tree, level) with `nodes`. */
  replaceSubtree(tree: TreeKind, level: Level, scopePath: string, nodes: StoredNode[]): void;
  /** Atomically upsert a leaf and its path-to-root ancestors into (tree, level). */
  surgicalUpdate(tree: TreeKind, level: Level, nodes: StoredNode[]): void;
  /** Atomically copy `working`→`baseline` for (level) at/under `scopePath`. */
  promote(level: Level, scopePath: string): void;
  /** Drop the working partition (one level, or all). */
  clearWorking(level?: Level): void;

  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  tree         TEXT NOT NULL,
  level        TEXT NOT NULL,
  path         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  state        TEXT NOT NULL,
  mtime        INTEGER,
  parent_path  TEXT,
  child_names  TEXT,
  PRIMARY KEY (tree, level, path)
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(tree, level, parent_path);
CREATE INDEX IF NOT EXISTS idx_nodes_hash   ON nodes(tree, level, hash);
`;

interface Row {
  path: string;
  hash: string;
  state: string;
  mtime: number | null;
  parent_path: string | null;
  child_names: string | null;
}

function rowToNode(r: Row): StoredNode {
  return {
    path: r.path,
    hash: r.hash,
    state: r.state as NodeState,
    mtime: r.mtime,
    parentPath: r.parent_path,
    childNames: r.child_names ? (JSON.parse(r.child_names) as string[]) : null,
  };
}

/** Match a scope: the node itself or anything strictly beneath it (path-prefix on a `/` boundary). */
function underClause(col: string): string {
  // `path = @scope OR path LIKE @scope || '/%'` — but treat "/" as matching all.
  return `(@scope = '/' OR ${col} = @scope OR ${col} LIKE @scopePrefix)`;
}

export class SqliteNodeStore implements NodeStore {
  constructor(private readonly db: Database.Database) {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  get(tree: TreeKind, level: Level, path: string): StoredNode | undefined {
    const r = this.db
      .prepare("SELECT path, hash, state, mtime, parent_path, child_names FROM nodes WHERE tree=? AND level=? AND path=?")
      .get(tree, level, path) as Row | undefined;
    return r ? rowToNode(r) : undefined;
  }

  getChildren(tree: TreeKind, level: Level, parentPath: string): StoredNode[] {
    const rows = this.db
      .prepare(
        "SELECT path, hash, state, mtime, parent_path, child_names FROM nodes WHERE tree=? AND level=? AND parent_path=? ORDER BY path"
      )
      .all(tree, level, parentPath) as Row[];
    return rows.map(rowToNode);
  }

  allUnder(tree: TreeKind, level: Level, scopePath: string): StoredNode[] {
    const rows = this.db
      .prepare(
        `SELECT path, hash, state, mtime, parent_path, child_names FROM nodes
         WHERE tree=@tree AND level=@level AND ${underClause("path")} ORDER BY path`
      )
      .all({ tree, level, scope: scopePath, scopePrefix: scopePath + "/%" }) as Row[];
    return rows.map(rowToNode);
  }

  findByHash(tree: TreeKind, level: Level, hash: string): StoredNode[] {
    const rows = this.db
      .prepare("SELECT path, hash, state, mtime, parent_path, child_names FROM nodes WHERE tree=? AND level=? AND hash=?")
      .all(tree, level, hash) as Row[];
    return rows.map(rowToNode);
  }

  private upsertStmt() {
    return this.db.prepare(
      `INSERT INTO nodes (tree, level, path, hash, state, mtime, parent_path, child_names)
       VALUES (@tree, @level, @path, @hash, @state, @mtime, @parent_path, @child_names)
       ON CONFLICT(tree, level, path) DO UPDATE SET
         hash=excluded.hash, state=excluded.state, mtime=excluded.mtime,
         parent_path=excluded.parent_path, child_names=excluded.child_names`
    );
  }

  private bind(tree: TreeKind, level: Level, n: StoredNode) {
    return {
      tree,
      level,
      path: n.path,
      hash: n.hash,
      state: n.state,
      mtime: n.mtime,
      parent_path: n.parentPath,
      child_names: n.childNames ? JSON.stringify(n.childNames) : null,
    };
  }

  replaceSubtree(tree: TreeKind, level: Level, scopePath: string, nodes: StoredNode[]): void {
    const del = this.db.prepare(
      `DELETE FROM nodes WHERE tree=@tree AND level=@level AND ${underClause("path")}`
    );
    const ins = this.upsertStmt();
    const tx = this.db.transaction(() => {
      del.run({ tree, level, scope: scopePath, scopePrefix: scopePath + "/%" });
      for (const n of nodes) ins.run(this.bind(tree, level, n));
    });
    tx();
  }

  surgicalUpdate(tree: TreeKind, level: Level, nodes: StoredNode[]): void {
    const ins = this.upsertStmt();
    const tx = this.db.transaction(() => {
      for (const n of nodes) ins.run(this.bind(tree, level, n));
    });
    tx();
  }

  promote(level: Level, scopePath: string): void {
    const del = this.db.prepare(
      `DELETE FROM nodes WHERE tree='baseline' AND level=@level AND ${underClause("path")}`
    );
    const copy = this.db.prepare(
      `INSERT INTO nodes (tree, level, path, hash, state, mtime, parent_path, child_names)
       SELECT 'baseline', level, path, hash, state, mtime, parent_path, child_names FROM nodes
       WHERE tree='working' AND level=@level AND ${underClause("path")}`
    );
    const tx = this.db.transaction(() => {
      const args = { level, scope: scopePath, scopePrefix: scopePath + "/%" };
      del.run(args);
      copy.run(args);
    });
    tx();
  }

  clearWorking(level?: Level): void {
    if (level) this.db.prepare("DELETE FROM nodes WHERE tree='working' AND level=?").run(level);
    else this.db.prepare("DELETE FROM nodes WHERE tree='working'").run();
  }

  close(): void {
    this.db.close();
  }
}

/**
 * In-memory `NodeStore` for fast higher-layer tests (forest assembly, diff, policy)
 * without the native SQLite dependency. Same contract; not WAL/crash-atomic — its
 * mutations are synchronous and all-or-nothing in JS, which is sufficient for unit
 * logic. The real atomicity guarantees are tested against `SqliteNodeStore`.
 */
export class MemoryNodeStore implements NodeStore {
  private m = new Map<string, StoredNode>();
  private key(tree: TreeKind, level: Level, path: string): string {
    return `${tree} ${level} ${path}`;
  }
  private under(path: string, scope: string): boolean {
    return scope === "/" || path === scope || path.startsWith(scope + "/");
  }

  get(tree: TreeKind, level: Level, path: string): StoredNode | undefined {
    return this.m.get(this.key(tree, level, path));
  }
  getChildren(tree: TreeKind, level: Level, parentPath: string): StoredNode[] {
    const out: StoredNode[] = [];
    for (const [k, v] of this.m) {
      const [t, l] = k.split(" ");
      if (t === tree && l === level && v.parentPath === parentPath) out.push(v);
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  allUnder(tree: TreeKind, level: Level, scopePath: string): StoredNode[] {
    const out: StoredNode[] = [];
    for (const [k, v] of this.m) {
      const [t, l] = k.split(" ");
      if (t === tree && l === level && this.under(v.path, scopePath)) out.push(v);
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  findByHash(tree: TreeKind, level: Level, hash: string): StoredNode[] {
    const out: StoredNode[] = [];
    for (const [k, v] of this.m) {
      const [t, l] = k.split(" ");
      if (t === tree && l === level && v.hash === hash) out.push(v);
    }
    return out;
  }
  replaceSubtree(tree: TreeKind, level: Level, scopePath: string, nodes: StoredNode[]): void {
    for (const [k, v] of [...this.m]) {
      const [t, l] = k.split(" ");
      if (t === tree && l === level && this.under(v.path, scopePath)) this.m.delete(k);
    }
    for (const n of nodes) this.m.set(this.key(tree, level, n.path), { ...n });
  }
  surgicalUpdate(tree: TreeKind, level: Level, nodes: StoredNode[]): void {
    for (const n of nodes) this.m.set(this.key(tree, level, n.path), { ...n });
  }
  promote(level: Level, scopePath: string): void {
    for (const [k, v] of [...this.m]) {
      const [t, l] = k.split(" ");
      if (t === "baseline" && l === level && this.under(v.path, scopePath)) this.m.delete(k);
    }
    for (const [k, v] of [...this.m]) {
      const [t, l] = k.split(" ");
      if (t === "working" && l === level && this.under(v.path, scopePath)) {
        this.m.set(this.key("baseline", level, v.path), { ...v });
      }
    }
  }
  clearWorking(level?: Level): void {
    for (const [k] of [...this.m]) {
      const [t, l] = k.split(" ");
      if (t === "working" && (!level || l === level)) this.m.delete(k);
    }
  }
  close(): void {
    this.m.clear();
  }
}
