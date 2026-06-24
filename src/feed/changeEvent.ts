/**
 * ADR-022 §2 — the change-event projection (pure).
 *
 * The semantic-history feed's PUSH half streams one record per change to the
 * external rust file-system indexer as `{ uri, content, mime, meta }` — the
 * indexer's streamed-ingestion contract. This module realizes that shape from an
 * `AuditRecord` (+ its diff). It is the ONLY part of the push feed that lands now:
 * the actual fire-and-forget HTTP emitter is **deferred / external-blocked** — it
 * cannot be integration-tested until the indexer's ingestion tool exists, and the
 * ADR itself defers it. When that socket lands it MUST call
 * `feedGuard.assertFeedTarget` (loopback-only) before opening a connection, and it
 * feeds each record through `buildChangeEvent` here.
 *
 * Redaction boundary (ADR-022 §3 + ADR-019 "best-effort, not a security control"):
 * the diff handed in is the RAW diff-on-write output (the audit.db projector redacts
 * separately), so `buildChangeEvent` redacts it HERE — a change-event must never
 * leave this server unredacted. `cmd` is already redacted at record-build time
 * (`buildAuditRecord`), so it is used as-is.
 */
import type { AuditRecord } from "../audit/record.js";
import { redactString } from "../guardrails/redaction.js";

export interface ChangeEventMeta {
  /** The tool that caused the change (e.g. write_file, pct_write_file). */
  tool: string;
  /** Discriminator so the indexer never confuses a pushed change-event with a pulled mirror file. */
  source: "homelab-change";
  /** ISO timestamp of the audit record. */
  ts: string;
  vmid?: number;
  container?: string;
  path?: string;
  /** ADR-009 content-leaf hash before the change (the pivot back to audit.db). */
  pre_hash?: string;
  /** ADR-009 content-leaf hash after the change. */
  post_hash?: string;
}

export interface ChangeEvent {
  /** Synthetic, addressable, re-pushable URI: change://<vmid|host>/<path>@<ts>. */
  uri: string;
  /** Redacted diff (write-family) or redacted cmd (exec-family) — the text to embed. */
  content: string;
  mime: string;
  meta: ChangeEventMeta;
}

/**
 * Project an audit record + its (raw) diff into the indexer's change-event shape.
 * Returns `null` when there is nothing to embed — a read/list record with neither a
 * diff nor a cmd contributes no change-event. The diff is redacted here; the cmd is
 * already redacted by `buildAuditRecord`.
 */
export function buildChangeEvent(
  record: AuditRecord,
  diff: string | null | undefined
): ChangeEvent | null {
  const content = diff && diff.length > 0 ? redactString(diff).value : record.cmd ?? "";
  if (content === "") return null;

  // Namespace by guest (host writes have no vmid). The path component is escaped so
  // a path with spaces/odd chars still yields a parseable URI; it is addressable, not
  // canonical (the meta carries the verbatim path/hashes for the join back to audit.db).
  const ns = record.vmid !== undefined ? String(record.vmid) : "host";
  const pathPart = record.path ?? record.hashScope ?? "_";
  const uri = `change://${ns}/${encodeURIComponent(pathPart)}@${record.ts}`;

  return {
    uri,
    content,
    mime: "text/plain",
    meta: {
      tool: record.tool,
      source: "homelab-change",
      ts: record.ts,
      ...(record.vmid !== undefined && { vmid: record.vmid }),
      ...(record.container !== undefined && { container: record.container }),
      ...(record.path !== undefined && { path: record.path }),
      ...(record.beforeHash !== undefined && { pre_hash: record.beforeHash }),
      ...(record.afterHash !== undefined && { post_hash: record.afterHash }),
    },
  };
}
