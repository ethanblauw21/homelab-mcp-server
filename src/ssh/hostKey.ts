import {
  sha256Fingerprint,
  normalizeFingerprint,
  decidePin,
  PinStore,
} from "../trust/pinnedTrust.js";

/**
 * SSH host-key verification (ADR-004 §1) — now a thin SSH-specific adapter over
 * the shared pinnedTrust module (ADR-007 Action Item 1). The generic pin/TOFU
 * decision lives in trust/pinnedTrust.ts and is shared with the API TLS cert pin;
 * this file only fixes the SSH labels and the host:port key shape.
 */

const SSH_LABELS = {
  pin: "the configured pin",
  tofu: "the known_hosts (TOFU) store",
};

/** OpenSSH-style SHA-256 fingerprint of a raw host public key: "SHA256:<base64>". */
export function computeFingerprint(key: Buffer): string {
  return sha256Fingerprint(key);
}

export { normalizeFingerprint };

export type HostKeyDecision =
  | { accept: true; reason: string; persist?: { hostPort: string; fingerprint: string } }
  | { accept: false; reason: string };

/**
 * Pure host-key decision. Delegates to the shared `decidePin` and maps the
 * generic `persist.key` back to `persist.hostPort` for the SSH consumer.
 */
export function decideHostKey(args: {
  presented: string;
  pinned?: string;
  stored?: string;
  hostPort: string;
}): HostKeyDecision {
  const d = decidePin({
    presented: args.presented,
    pinned: args.pinned,
    stored: args.stored,
    key: args.hostPort,
    labels: SSH_LABELS,
  });
  if (!d.accept) return { accept: false, reason: d.reason };
  return d.persist
    ? {
        accept: true,
        reason: d.reason,
        persist: { hostPort: d.persist.key, fingerprint: d.persist.fingerprint },
      }
    : { accept: true, reason: d.reason };
}

/** JSON-file store mapping "host:port" -> canonical fingerprint (same shape as before). */
export class KnownHostsStore extends PinStore {}
