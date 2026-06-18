import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { BackupStore, BackupTarget, BackupVersionInfo } from "../backup/store.js";
import type { Config } from "../config.js";
import { sha256 } from "../audit/record.js";
import { computeUnifiedDiff } from "../util/diff.js";
import { assertContainerRunning, pullContainerFile } from "./pctFiles.js";
import { resolveDockerContainer, readDockerFile } from "./dockerFiles.js";

export const DiffConfigInputSchema = z
  .object({
    backupPath: z
      .string()
      .min(1)
      .optional()
      .describe("Local path to a specific backup blob/.meta. If omitted, the latest backup for `path` is used."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Target file path. Required when `backupPath` is omitted; resolves the latest backup for this file."),
    vmid: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Container VMID when the target is an LXC file (used only with `path`)."),
  })
  .describe("Preview the diff between a backup and the file's current content. Read-only, not audited.");

export type DiffConfigInput = z.infer<typeof DiffConfigInputSchema>;

export interface DiffConfigResult {
  target: BackupTarget;
  backupPath: string;
  timestamp: string;
  kind: string;
  revertible: boolean;
  /** Present only when the backup is revertible (metadata-only backups carry no content). */
  diff?: string;
  diffTruncated?: boolean;
  addedLines?: number;
  removedLines?: number;
  currentSha256?: string;
  backupSha256?: string;
  note?: string;
}

/** path.resolve-style comparison without importing path: normalize separators + case-fold drive. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * `diff_config` — the revert-preview leg of the triad (ADR-005 §Part 2):
 * dryRun (before a write) → **diff_config (before a revert)** → query_audit
 * (after the fact). Reconstructs a backup's content and diffs it against the
 * file as it stands now, so an operator sees exactly what reverting would change.
 *
 * Read-only and NOT audited: it performs no write and leaves no trail (the revert
 * it precedes is what gets audited). Metadata-only backups carry no content and
 * return a structured `revertible: false` response rather than a diff.
 */
export async function diffConfigHandler(
  input: DiffConfigInput,
  transport: SshTransport,
  backupStore: BackupStore,
  cfg: Config
): Promise<DiffConfigResult> {
  if (input.backupPath === undefined && input.path === undefined) {
    throw new Error("Provide either `backupPath` or `path`.");
  }

  // Resolve the target descriptor: from the backup meta when a blob is named,
  // otherwise from the supplied path/vmid.
  let target: BackupTarget;
  if (input.backupPath !== undefined) {
    try {
      target = backupStore.readBackupTarget(input.backupPath);
    } catch {
      // Legacy/bare blob without meta: fall back to host using the supplied path.
      if (input.path === undefined) {
        throw new Error("Backup metadata not found and no `path` supplied; cannot resolve the target.");
      }
      target = input.vmid !== undefined
        ? { kind: "pct", vmid: input.vmid, remotePath: input.path }
        : { kind: "host", remotePath: input.path };
    }
  } else {
    target =
      input.vmid !== undefined
        ? { kind: "pct", vmid: input.vmid, remotePath: input.path! }
        : { kind: "host", remotePath: input.path! };
  }

  // Read the current content of the live file FIRST so the diff reflects "what a
  // revert would change right now" AND so revertibility is computed against the
  // real live hash (#20). A missing file is treated as empty content.
  let currentContent: Buffer | undefined;
  const timeoutMs = cfg.ssh.commandTimeoutMs;
  if (target.kind === "pct") {
    if (target.vmid === undefined) {
      throw new Error("Container backup is missing its vmid; cannot read current content.");
    }
    await assertContainerRunning(transport, target.vmid, timeoutMs);
    const { content } = await pullContainerFile(
      transport,
      target.vmid,
      target.remotePath,
      cfg.container.nodeTempDir,
      timeoutMs
    );
    if (content) currentContent = content;
  } else if (target.kind === "docker") {
    if (target.vmid === undefined || !target.container) {
      throw new Error("Docker backup is missing its vmid/container; cannot read current content.");
    }
    await assertContainerRunning(transport, target.vmid, timeoutMs);
    const inspect = await resolveDockerContainer(transport, target.vmid, target.container, timeoutMs);
    const { content } = await readDockerFile(
      transport,
      target.vmid,
      target.container,
      target.remotePath,
      inspect,
      cfg.container.nodeTempDir,
      timeoutMs
    );
    if (content) currentContent = content;
  } else {
    try {
      currentContent = await transport.readFile(target.remotePath);
    } catch {
      /* file may not exist — treat as empty */
    }
  }
  const currentHash = currentContent ? sha256(currentContent) : sha256(Buffer.alloc(0));

  // Choose the backup version: the named one, or the newest for the target.
  // Listing with the live hash makes each version's `revertible` honest (#20).
  const versions = backupStore.listBackupsForPath(target, currentHash);
  let chosen: BackupVersionInfo | undefined;
  if (input.backupPath !== undefined) {
    chosen = versions.find((v) => samePath(v.backupPath, input.backupPath!));
    if (chosen === undefined) {
      // Not in the listing (e.g. legacy path); synthesize from the path itself.
      const isMeta = input.backupPath.endsWith(".meta");
      chosen = {
        backupPath: input.backupPath,
        timestamp: input.backupPath.replace(/^.*[\\/]/, "").replace(/\.(gz|meta)$/, ""),
        kind: isMeta ? "metadata-only" : "unknown",
        sizeBytes: 0,
        revertible: !isMeta,
      };
    }
  } else {
    if (versions.length === 0) {
      throw new Error(`No backups found for ${target.remotePath}.`);
    }
    // Prefer the newest revertible version; fall back to newest (so the operator
    // still sees the stale/metadata reason rather than an opaque failure).
    chosen = versions.find((v) => v.revertible) ?? versions[0];
  }

  const base = {
    target,
    backupPath: chosen.backupPath,
    timestamp: chosen.timestamp,
    kind: chosen.kind,
  };

  if (!chosen.revertible) {
    // #20 — distinguish a stale delta base (out-of-band edit) from a genuinely
    // contentless metadata-only backup. The former is the bug this fix targets:
    // return a clear structured reason instead of throwing the raw delta error.
    if (chosen.revertibleReason === "stale-base") {
      return {
        ...base,
        revertible: false,
        currentSha256: currentHash,
        backupSha256: chosen.baseHash,
        note:
          `This delta backup is anchored to a base the live file no longer matches ` +
          `(base ${(chosen.baseHash ?? "").slice(0, 8)}…, current ${currentHash.slice(0, 8)}…) — ` +
          `the file was edited out-of-band since the backup was written, so it cannot be applied. ` +
          `Revert a more recent (self-contained) backup, or restore manually.`,
      };
    }
    return {
      ...base,
      revertible: false,
      note: "Backup is metadata-only (large/binary write) — no content stored, so no diff and no revert.",
    };
  }

  const backupContent = await backupStore.restore(chosen.backupPath, currentContent);
  if (backupContent === null) {
    // Defensive: listing said revertible but restore returned null.
    return {
      ...base,
      revertible: false,
      note: "Backup could not be reconstructed (no stored content).",
    };
  }

  const currentText = (currentContent ?? Buffer.alloc(0)).toString("utf8");
  const backupText = backupContent.toString("utf8");

  // Diff direction: current → backup, i.e. exactly what reverting would apply.
  const d = computeUnifiedDiff(currentText, backupText, cfg.tools.dryRunDiffMaxLines);

  return {
    ...base,
    revertible: true,
    diff: d.diff,
    diffTruncated: d.truncated,
    addedLines: d.addedLines,
    removedLines: d.removedLines,
    currentSha256: currentContent ? sha256(currentContent) : sha256(Buffer.alloc(0)),
    backupSha256: sha256(backupContent),
  };
}
