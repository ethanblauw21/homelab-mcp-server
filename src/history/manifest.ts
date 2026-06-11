import { shQuote } from "../tools/pctFiles.js";

/**
 * Permission/metadata manifests for the config-history repo (ADR-006 §1, the
 * "etckeeper trick"). Git stores content + the execute bit only, so each target
 * keeps a manifest (`manifests/<target-key>.json`) mapping absolute path →
 * `{ mode, uid, gid }`, captured via a batched `stat -c '%a %u %g %n'` and
 * committed alongside content — keeping history restore-faithful.
 *
 * Pure builders + parser here; the I/O (running the stat, reading/writing the
 * JSON file) lives in the orchestrator. The parser is the load-bearing piece:
 * `%n` is the LAST field and a path may contain spaces, so the first three
 * whitespace-separated tokens are the numeric mode/uid/gid and the remainder
 * (verbatim, spaces preserved) is the path.
 */

export interface FileMeta {
  /** Octal mode string from `stat %a`, e.g. "644". */
  mode: string;
  uid: number;
  gid: number;
}

/** A manifest: absolute path → metadata, plus paths skipped (e.g. oversize). */
export interface Manifest {
  files: Record<string, FileMeta>;
  /** Paths intentionally not mirrored (oversize/excluded), with a reason. */
  skipped?: Record<string, string>;
}

export function emptyManifest(): Manifest {
  return { files: {} };
}

/**
 * Build a batched `stat` over many paths. Host form runs directly; container
 * form wraps it in `pct exec <vmid> -- sh -c '...'`. The `--` guards paths that
 * begin with a dash. Returns null for an empty path list (nothing to stat).
 */
export function buildStatBatchCommand(paths: string[], vmid?: number): string | null {
  if (paths.length === 0) return null;
  const quoted = paths.map(shQuote).join(" ");
  const inner = `stat -c '%a %u %g %n' -- ${quoted}`;
  if (vmid === undefined) return inner;
  // pct exec needs the whole stat invocation as one shell string in the guest.
  return `pct exec ${vmid} -- sh -c ${shQuote(inner)}`;
}

/**
 * Parse `stat -c '%a %u %g %n'` batch output. Each line is
 * `<mode> <uid> <gid> <path...>` where the path may contain spaces. Lines that
 * stat emitted to stderr (missing files) never reach here; unrecognized lines
 * are skipped rather than guessed at.
 */
export function parseStatBatch(output: string): Record<string, FileMeta> {
  const result: Record<string, FileMeta> = {};
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    // Three leading numeric tokens, then the path (greedy, spaces preserved).
    const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const [, mode, uid, gid, path] = m;
    result[path as string] = {
      mode: mode as string,
      uid: parseInt(uid as string, 10),
      gid: parseInt(gid as string, 10),
    };
  }
  return result;
}

/** Round-trip serialize a manifest (stable key order for clean git diffs). */
export function serializeManifest(manifest: Manifest): string {
  const files: Record<string, FileMeta> = {};
  for (const key of Object.keys(manifest.files).sort()) {
    files[key] = manifest.files[key] as FileMeta;
  }
  const out: Manifest = { files };
  if (manifest.skipped && Object.keys(manifest.skipped).length > 0) {
    const skipped: Record<string, string> = {};
    for (const key of Object.keys(manifest.skipped).sort()) {
      skipped[key] = manifest.skipped[key] as string;
    }
    out.skipped = skipped;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

export function parseManifest(text: string): Manifest {
  try {
    const parsed = JSON.parse(text) as Partial<Manifest>;
    return {
      files: parsed.files ?? {},
      ...(parsed.skipped ? { skipped: parsed.skipped } : {}),
    };
  } catch {
    return emptyManifest();
  }
}
