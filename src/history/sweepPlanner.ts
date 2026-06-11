/**
 * Pure sweep planner for `config_sweep` (ADR-006 §3) — the file-level counterpart
 * of the census drift diff. Split into two phases so each is independently
 * unit-testable and neither touches I/O:
 *
 *   Phase 1  classifyEnumeration  — given the remote file list (path + size),
 *            split into {candidates, excluded, skippedOversize}. Excludes and the
 *            per-file size cap are applied HERE, before anything is hashed.
 *
 *   Phase 2  diffAgainstMirror    — given candidate hashes (remote) vs. the
 *            mirror's recorded hashes, split into {toFetch, unchanged, toDelete}.
 *            Deletions are mirror paths absent from the full remote enumeration.
 *
 * Hash-compare-before-fetch is the whole point: a sweep fetches only changed/new
 * files, so subsequent sweeps are cheap regardless of watched-set size.
 */

export interface EnumeratedFile {
  /** Absolute path inside the guest/host. */
  path: string;
  sizeBytes: number;
}

export interface ClassifyResult {
  /** Paths to hash + potentially fetch (passed exclude + size filters). */
  candidates: string[];
  /** Paths dropped by an exclude pattern. */
  excluded: string[];
  /** Paths skipped for exceeding the per-file size cap (noted, not dropped). */
  skippedOversize: Array<{ path: string; sizeBytes: number }>;
}

/**
 * Translate a restricted glob to an anchored RegExp.
 *  - `**` matches any characters including `/` (zero or more path segments)
 *  - `*`  matches any characters except `/`
 *  - `?`  matches a single character except `/`
 * Everything else is matched literally. Patterns are full-path anchored.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

export function classifyEnumeration(opts: {
  enumerated: EnumeratedFile[];
  excludePatterns: string[];
  sizeCapBytes: number;
}): ClassifyResult {
  const { enumerated, excludePatterns, sizeCapBytes } = opts;
  const candidates: string[] = [];
  const excluded: string[] = [];
  const skippedOversize: Array<{ path: string; sizeBytes: number }> = [];

  for (const f of enumerated) {
    if (matchesAnyGlob(f.path, excludePatterns)) {
      excluded.push(f.path);
      continue;
    }
    if (f.sizeBytes > sizeCapBytes) {
      skippedOversize.push({ path: f.path, sizeBytes: f.sizeBytes });
      continue;
    }
    candidates.push(f.path);
  }

  return { candidates, excluded, skippedOversize };
}

export interface DiffResult {
  /** Changed-or-new candidate paths to pull into the mirror. */
  toFetch: string[];
  /** Candidate paths whose remote hash equals the mirror's — left untouched. */
  unchanged: string[];
  /** Mirror paths no longer present remotely — removed from the mirror. */
  toDelete: string[];
}

export function diffAgainstMirror(opts: {
  /** Candidate paths from phase 1 (already exclude/size filtered). */
  candidates: string[];
  /** Remote content hash per candidate path. */
  remoteHashes: Map<string, string>;
  /** Mirror's recorded content hash per path (absent ⇒ new file). */
  mirrorHashes: Map<string, string>;
  /** Every path the mirror currently holds for this target. */
  mirrorPaths: string[];
  /** Every path present in the FULL remote enumeration (incl. oversize/excluded). */
  allRemotePaths: string[];
}): DiffResult {
  const { candidates, remoteHashes, mirrorHashes, mirrorPaths, allRemotePaths } = opts;
  const toFetch: string[] = [];
  const unchanged: string[] = [];

  for (const p of candidates) {
    const remote = remoteHashes.get(p);
    if (remote === undefined) continue; // hash missing (stat/hash failed) — skip
    const mirror = mirrorHashes.get(p);
    if (mirror === remote) unchanged.push(p);
    else toFetch.push(p);
  }

  const remoteSet = new Set(allRemotePaths);
  const toDelete = mirrorPaths.filter((p) => !remoteSet.has(p));

  return { toFetch, unchanged, toDelete };
}

export interface EnumLine {
  sizeBytes: number;
  path: string;
}

/**
 * Parse `find <paths> -type f -printf '%s\t%p\n'` output into enumerated files.
 * Tab-separated so paths with spaces survive; malformed lines are skipped.
 */
export function parseFindEnumeration(output: string): EnumLine[] {
  const out: EnumLine[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sizeStr = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const size = parseInt(sizeStr, 10);
    if (!Number.isFinite(size) || path === "") continue;
    out.push({ sizeBytes: size, path });
  }
  return out;
}

/**
 * Parse `sha256sum -- <paths>` output: each line is `<64 hex>␠␠<path>` where the
 * path may contain spaces (verbatim after the two-space separator).
 */
export function parseSha256Sum(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^([0-9a-f]{64})\s\s?(.+)$/i);
    if (!m) continue;
    map.set(m[2] as string, (m[1] as string).toLowerCase());
  }
  return map;
}
