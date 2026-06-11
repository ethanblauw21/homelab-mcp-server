import type { BackupTarget } from "../backup/store.js";

/**
 * Mirror-path mapping for the ADR-006 config-history repo.
 *
 * The repo layout mirrors ADR-003 target descriptors:
 *   - `host/<absolute-path>`        — node files
 *   - `pct/<vmid>/<absolute-path>`  — container files
 *
 * VM (`qm`) targets have NO mirror layout — the guest-agent file model exposes
 * no perms and the ADR scopes the history layer to host + pct. `qm` targets are
 * rejected here so the caller skips history rather than inventing a layout.
 *
 * Everything in this module is pure (no I/O) and re-validates paths even though
 * the descriptor was already validated upstream: a mirror path is re-checked for
 * `..` so a traversal can never escape the repo root, even post-descriptor
 * (ADR-006 Testing: "mirror paths re-validated; `..` rejected even post-descriptor").
 */

export interface MirrorMapping {
  /** Repo-relative POSIX path for the file content, e.g. `host/etc/hosts`. */
  repoRelPath: string;
  /** Filesystem-safe manifest key, e.g. `host` or `pct-104`. */
  manifestKey: string;
  /** Manifest-internal key for this file: the absolute guest/host path. */
  fileKey: string;
}

/** Targets this ADR mirrors. `qm` is deliberately excluded. */
export type HistoryTargetKind = "host" | "pct";

function assertSafeAbsolute(p: string): void {
  if (!p.startsWith("/")) {
    throw new Error(`history mirror path must be absolute: ${JSON.stringify(p)}`);
  }
  if (p.includes("\0")) {
    throw new Error("history mirror path contains a null byte");
  }
  // Reject `..` as a path SEGMENT (a filename merely containing ".." is fine).
  const segments = p.split("/");
  if (segments.includes("..")) {
    throw new Error(`history mirror path traversal rejected (..): ${JSON.stringify(p)}`);
  }
}

/** Strip the leading slash and collapse no segments — content goes under a prefix dir. */
function stripLeadingSlash(absPath: string): string {
  return absPath.replace(/^\/+/, "");
}

/**
 * Map a backup target descriptor to its mirror location. Throws for `qm` (no
 * mirror layout) and for any path that fails the post-descriptor traversal guard.
 */
export function mirrorMappingForTarget(target: BackupTarget): MirrorMapping {
  if (target.kind === "qm") {
    throw new Error("VM (qm) targets are not mirrored by the config-history layer");
  }
  assertSafeAbsolute(target.remotePath);
  const rel = stripLeadingSlash(target.remotePath);

  if (target.kind === "pct") {
    if (target.vmid === undefined) {
      throw new Error("container target is missing its vmid; cannot map a mirror path");
    }
    return {
      repoRelPath: `pct/${target.vmid}/${rel}`,
      manifestKey: `pct-${target.vmid}`,
      fileKey: target.remotePath,
    };
  }

  return {
    repoRelPath: `host/${rel}`,
    manifestKey: "host",
    fileKey: target.remotePath,
  };
}

/** True when a target kind participates in the history layer (host/pct only). */
export function isHistoryTarget(target: BackupTarget): boolean {
  return target.kind === "host" || target.kind === "pct";
}

/** Manifest key for a sweep target descriptor (`host` or `pct-<vmid>`). */
export function manifestKeyForSweepTarget(target: "host" | { vmid: number }): string {
  return target === "host" ? "host" : `pct-${target.vmid}`;
}

/** Repo-relative prefix under which a sweep target's files live. */
export function repoPrefixForSweepTarget(target: "host" | { vmid: number }): string {
  return target === "host" ? "host" : `pct/${target.vmid}`;
}

/**
 * Map an absolute guest/host path under a sweep target to its repo-relative
 * mirror path, re-validating traversal. Shared by the sweep fetch/delete logic.
 */
export function mirrorRelPathForSweepFile(
  target: "host" | { vmid: number },
  absPath: string
): string {
  assertSafeAbsolute(absPath);
  return `${repoPrefixForSweepTarget(target)}/${stripLeadingSlash(absPath)}`;
}
