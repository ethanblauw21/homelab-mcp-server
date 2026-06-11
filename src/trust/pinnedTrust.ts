import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Shared pinned-trust core (ADR-007 §3, Action Item 1). Originally the SSH
 * host-key verifier (ADR-004 §1); generalized here so the API TLS cert pin reuses
 * the SAME fail-closed decision logic — one module, two consumers (SSH host key,
 * API TLS cert). The pure decision is unit-tested; the JSON store is a thin I/O
 * wrapper.
 *
 * Trust anchor priority, identical for both channels:
 *   1. An explicit pin (recommended; captured at setup) — fail-closed on mismatch.
 *   2. A trust-on-first-use (TOFU) store: first connection records the
 *      fingerprint (with a loud warning); every later connection must match.
 * A mismatch FAILS CLOSED — the connection is refused and no re-pin happens
 * automatically.
 */

/** OpenSSH-style SHA-256 fingerprint of raw bytes: "SHA256:<base64-no-padding>". */
export function sha256Fingerprint(data: Buffer): string {
  const digest = crypto.createHash("sha256").update(data).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/**
 * Normalize a user-supplied fingerprint to canonical "SHA256:<base64>" form.
 * Accepts the bare base64 digest, the "SHA256:..." token, or a full
 * `ssh-keygen -lf` line ("256 SHA256:... comment (ED25519)").
 */
export function normalizeFingerprint(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/SHA256:([A-Za-z0-9+/]+=*)/i);
  if (m) return `SHA256:${m[1]!.replace(/=+$/, "")}`;
  return `SHA256:${trimmed.replace(/=+$/, "")}`;
}

export type PinDecision =
  | { accept: true; reason: string; persist?: { key: string; fingerprint: string } }
  | { accept: false; reason: string };

/** Source labels for the mismatch message, per channel. */
export interface PinLabels {
  pin: string;
  tofu: string;
}

function mismatch(sourceLabel: string, expected: string, presented: string): string {
  return (
    `key MISMATCH against ${sourceLabel}.\n` +
    `  expected:  ${expected}\n` +
    `  presented: ${presented}\n` +
    `Connection refused (fail-closed). If the key genuinely changed, verify the ` +
    `new key out of band, then update the pin or remove the stale entry from the ` +
    `trust store and reconnect.`
  );
}

/**
 * Pure pin decision, channel-agnostic. `presented` is the canonical fingerprint
 * offered by the server; `pinned` is the configured pin (any accepted format);
 * `stored` is the TOFU-recorded fingerprint for this `key`, if any.
 */
export function decidePin(args: {
  presented: string;
  pinned?: string;
  stored?: string;
  key: string;
  labels: PinLabels;
}): PinDecision {
  const { presented, pinned, stored, key, labels } = args;

  if (pinned && pinned.trim() !== "") {
    const want = normalizeFingerprint(pinned);
    return presented === want
      ? { accept: true, reason: "matches pinned fingerprint" }
      : { accept: false, reason: mismatch(labels.pin, want, presented) };
  }

  if (stored && stored.trim() !== "") {
    return presented === stored
      ? { accept: true, reason: "matches trust-on-first-use fingerprint" }
      : { accept: false, reason: mismatch(labels.tofu, stored, presented) };
  }

  // No pin, no prior record: trust on first use, record it, warn loudly.
  return {
    accept: true,
    reason: "pinned on first use (TOFU) — verify out of band",
    persist: { key, fingerprint: presented },
  };
}

/** Thin JSON-file store mapping an arbitrary key (host:port / api-host) -> fingerprint. */
export class PinStore {
  constructor(private readonly filePath?: string) {}

  get(key: string): string | undefined {
    if (!this.filePath) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, string>;
      return data[key];
    } catch {
      return undefined;
    }
  }

  set(key: string, fingerprint: string): void {
    if (!this.filePath) return;
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, string>;
    } catch {
      /* new or unreadable -> start fresh */
    }
    data[key] = fingerprint;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
