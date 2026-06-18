/**
 * Forest assembly orchestrator (ADR-009 §4) — the thin I/O shell over the pure
 * shape/fold cores. It walks a set of `SubtreeSource`s (host over SSH/SFTP, each
 * container over `pct pull`), turns each into a folded subtree at the requested
 * level, and folds the intermediate group dirs + super-root on top. The whole
 * orchestrator depends only on the `SubtreeSource` interface, so it tests against a
 * fake; the concrete SSH/pct sources live at the bottom of this file.
 *
 * Stopped guests (§4): a source that reports `available() === false` is **frozen**,
 * not enumerated — its subtree is reused from the last baseline and its root marked
 * `unavailable`, so a power-off never reads as "every file in the container deleted."
 * Drift that happened while it was off surfaces on its next available compute.
 */
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { unreadableHash } from "./folding.js";
import type { Level, StoredNode } from "./nodeStore.js";
import { assembleSubtree, parentForestPath } from "./tree.js";
import {
  synthesizeEntries,
  foldForestRoots,
  toNodePath,
  type EnumeratedEntry,
} from "./forestShape.js";
import { matchesAnyGlob } from "../history/sweepPlanner.js";
import { shQuote, parsePctStatus, buildPctStatusCommand } from "../tools/pctFiles.js";
import { buildSha256Command } from "../tools/configSweep.js";
import { parseSha256Sum } from "../history/sweepPlanner.js";

/**
 * A source of one forest subtree. `prefix` is the namespace (`host`, `pct/101`);
 * `hashFiles` returns hex content hashes keyed by node-absolute path (only for the
 * paths it could read — an omitted path folds as `unreadable` content).
 */
export interface SubtreeSource {
  prefix: string;
  available(): Promise<boolean>;
  enumerate(): Promise<EnumeratedEntry[]>;
  hashFiles(nodePaths: string[]): Promise<Map<string, string>>;
}

export interface AssembleForestInput {
  level: Level;
  sources: SubtreeSource[];
  /** L2 membership globs (node-path form, e.g. star-star slash *.conf). */
  configFileGlobs: string[];
  /** Returns the last-known baseline subtree nodes under `prefix` (for freezing). */
  frozenBaseline?: (prefix: string) => StoredNode[];
}

/** Assemble the whole forest into a flat `StoredNode[]` (super-root + every subtree). */
export async function assembleForest(input: AssembleForestInput): Promise<StoredNode[]> {
  const { level, sources, configFileGlobs, frozenBaseline } = input;
  const all: StoredNode[] = [];

  for (const src of sources) {
    if (!(await src.available())) {
      all.push(...freezeSubtree(src.prefix, frozenBaseline?.(src.prefix) ?? []));
      continue;
    }

    const enumerated = await src.enumerate();
    const entries = synthesizeEntries(src.prefix, enumerated);
    const isConfigFile = (forestPath: string) =>
      matchesAnyGlob(toNodePath(src.prefix, forestPath), configFileGlobs);

    let contentHash: (p: string) => string | undefined = () => undefined;
    if (level !== "l1") {
      const wantFiles = entries
        .filter((e) => e.kind === "file" && e.state === "present")
        .filter((e) => level === "l3" || isConfigFile(e.path))
        .map((e) => toNodePath(src.prefix, e.path));
      const hashes = await src.hashFiles(wantFiles);
      contentHash = (forestPath) => hashes.get(toNodePath(src.prefix, forestPath));
    }

    all.push(...assembleSubtree({ level, rootPath: src.prefix, entries, contentHash, isConfigFile }));
  }

  all.push(...foldForestRoots(all));
  return all;
}

/**
 * Freeze a stopped guest's subtree: reuse its last baseline nodes verbatim (so its
 * hashes do not change ⇒ no false drift), but flip the prefix root to `unavailable`
 * so the diff layer excludes it. With no baseline yet (first run while down), emit a
 * single `unavailable` placeholder rather than an empty (= mass-deletion) subtree.
 */
function freezeSubtree(prefix: string, baseline: StoredNode[]): StoredNode[] {
  if (baseline.length === 0) {
    return [
      {
        path: prefix,
        hash: unreadableHash().toString("hex"),
        state: "unavailable",
        mtime: null,
        parentPath: parentForestPath(prefix),
        childNames: [],
      },
    ];
  }
  return baseline.map((n) => (n.path === prefix ? { ...n, state: "unavailable" } : { ...n }));
}

// ---------------------------------------------------------------------------
// Pure enumeration command builder + parser (host or pct).
// ---------------------------------------------------------------------------

/** `find <paths> -printf '%y\t%T@\t%p\n'` — type letter, mtime epoch, path; dirs included. */
export function buildForestEnumCommand(watchPaths: string[], vmid?: number): string {
  const paths = watchPaths.map(shQuote).join(" ");
  const inner = `find ${paths} -printf '%y\\t%T@\\t%p\\n' 2>/dev/null`;
  return vmid === undefined ? inner : `pct exec ${vmid} -- sh -c ${shQuote(inner)}`;
}

/** Parse the enum output into entries. `f`→file, `d`→dir, `l`(symlink)→file leaf; others skipped. */
export function parseForestEnumeration(stdout: string): EnumeratedEntry[] {
  const out: EnumeratedEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const y = line.slice(0, tab1);
    const mtimeRaw = line.slice(tab1 + 1, tab2);
    const nodePath = line.slice(tab2 + 1);
    if (!nodePath.startsWith("/")) continue;
    const kind: "file" | "dir" = y === "d" ? "dir" : y === "f" || y === "l" ? "file" : (undefined as never);
    if (kind === undefined) continue;
    const mtime = mtimeRaw ? Math.trunc(Number(mtimeRaw)) : null;
    out.push({ nodePath, kind, mtime: Number.isFinite(mtime as number) ? (mtime as number) : null, state: "present" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Concrete SSH / pct subtree sources.
// ---------------------------------------------------------------------------

/** The Proxmox host subtree, read over SSH/SFTP. Always available. */
export function hostSubtreeSource(transport: SshTransport, cfg: Config): SubtreeSource {
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  return {
    prefix: "host",
    available: async () => true,
    enumerate: async () => {
      const res = await transport.exec(buildForestEnumCommand(cfg.history.hostWatchPaths), timeoutMs);
      if (res.exitCode !== 0 && res.stdout.trim() === "") {
        throw new Error(`host enumerate failed: ${res.stderr.trim() || "exit " + res.exitCode}`);
      }
      return applyExcludes(parseForestEnumeration(res.stdout), cfg.history.excludePatterns);
    },
    hashFiles: (nodePaths) => hashViaSha256(transport, nodePaths, undefined, timeoutMs),
  };
}

/** A container subtree, read via `pct pull` / `pct exec`. Unavailable when stopped. */
export function containerSubtreeSource(transport: SshTransport, cfg: Config, vmid: number): SubtreeSource {
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  return {
    prefix: `pct/${vmid}`,
    available: async () => {
      const st = await transport.exec(buildPctStatusCommand(vmid), timeoutMs);
      return st.exitCode === 0 && parsePctStatus(st.stdout) === "running";
    },
    enumerate: async () => {
      const res = await transport.exec(buildForestEnumCommand(cfg.history.containerWatchPaths, vmid), timeoutMs);
      if (res.exitCode !== 0 && res.stdout.trim() === "") {
        throw new Error(`pct/${vmid} enumerate failed: ${res.stderr.trim() || "exit " + res.exitCode}`);
      }
      return applyExcludes(parseForestEnumeration(res.stdout), cfg.history.excludePatterns);
    },
    hashFiles: (nodePaths) => hashViaSha256(transport, nodePaths, vmid, timeoutMs),
  };
}

async function hashViaSha256(
  transport: SshTransport,
  nodePaths: string[],
  vmid: number | undefined,
  timeoutMs: number
): Promise<Map<string, string>> {
  const cmd = buildSha256Command(nodePaths, vmid);
  if (!cmd) return new Map();
  const res = await transport.exec(cmd, timeoutMs);
  // sha256sum may exit non-zero if a file vanished mid-walk; keep what it produced.
  return parseSha256Sum(res.stdout);
}

function applyExcludes(entries: EnumeratedEntry[], excludePatterns: string[]): EnumeratedEntry[] {
  if (excludePatterns.length === 0) return entries;
  return entries.filter((e) => e.kind === "dir" || !matchesAnyGlob(e.nodePath, excludePatterns));
}
