/**
 * ADR-022 §3 — the content-feed trust tripwire (pure).
 *
 * The semantic-history feed ships audit diffs to the rust indexer. Those diffs
 * are best-effort redacted (ADR-019: "not a security control"), and FTS makes a
 * redaction miss *searchable* — a strictly larger exposure than the JSONL. So the
 * feed inherits the ADR-006 "private, no-cloud / same-trust-zone" constraint: the
 * indexer endpoint MUST be loopback. This guard is the fail-closed precondition
 * the push emitter (deferred — gated on the indexer's streamed-ingestion tool)
 * calls before it ever opens a socket. Pure + unit-tested so the rule cannot
 * silently rot when the emitter lands.
 *
 * Reuses `isLoopbackAddress` (the same loopback decision ADR-010's UI bind uses)
 * over the URL's hostname — one definition of "loopback," two consumers.
 */
import { isLoopbackAddress } from "../ui/router.js";

export interface FeedTargetCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a content-feed endpoint URL. Returns `{ok}` rather than throwing so a
 * caller can decide between fail-closed (refuse to start the feed) and log-and-skip.
 * Refuses: an unparseable URL, a non-http(s) scheme, or a non-loopback host.
 */
export function checkFeedTarget(endpoint: string): FeedTargetCheck {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: `not a valid URL: ${endpoint}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme '${url.protocol}' (http/https only)` };
  }
  // URL wraps IPv6 hosts in brackets; strip them before the loopback test.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackAddress(host)) {
    return {
      ok: false,
      reason: `non-loopback feed target '${host}' refused — the content feed carries best-effort-redacted diffs and must stay on-host (ADR-022 §3)`,
    };
  }
  return { ok: true };
}

/** Fail-closed variant: throws when the endpoint is not an acceptable loopback target. */
export function assertFeedTarget(endpoint: string): void {
  const r = checkFeedTarget(endpoint);
  if (!r.ok) throw new Error(r.reason);
}
