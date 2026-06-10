import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Host-key verification (ADR-004 §1, pulled forward per amendment A4.3 so the
 * census's first real runs do not happen over an unverified connection).
 *
 * Trust anchor priority:
 *   1. An explicit pin (SSH_HOST_KEY_FINGERPRINT) — recommended.
 *   2. A trust-on-first-use (TOFU) store: first connection records the
 *      fingerprint (with a loud warning); every later connection must match.
 * A mismatch FAILS CLOSED — the connection is refused and no re-pin happens
 * automatically. The pure decision logic here is unit-tested; the I/O store is
 * a thin wrapper.
 */

/** OpenSSH-style SHA-256 fingerprint of a raw host public key: "SHA256:<base64>". */
export function computeFingerprint(key: Buffer): string {
  const digest = crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
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

export type HostKeyDecision =
  | { accept: true; reason: string; persist?: { hostPort: string; fingerprint: string } }
  | { accept: false; reason: string };

function mismatch(sourceLabel: string, expected: string, presented: string): string {
  return (
    `host key MISMATCH against ${sourceLabel}.\n` +
    `  expected:  ${expected}\n` +
    `  presented: ${presented}\n` +
    `Connection refused (fail-closed). If the node's key genuinely changed, ` +
    `verify the new key out of band, then update the pin (SSH_HOST_KEY_FINGERPRINT) ` +
    `or remove the stale entry from the known_hosts store and reconnect.`
  );
}

/**
 * Pure host-key decision. `presented` is the canonical fingerprint of the key
 * offered by the server; `pinned` is the configured pin (any accepted format);
 * `stored` is the TOFU-recorded fingerprint for this host:port, if any.
 */
export function decideHostKey(args: {
  presented: string;
  pinned?: string;
  stored?: string;
  hostPort: string;
}): HostKeyDecision {
  const { presented, pinned, stored, hostPort } = args;

  if (pinned && pinned.trim() !== "") {
    const want = normalizeFingerprint(pinned);
    return presented === want
      ? { accept: true, reason: "matches pinned fingerprint" }
      : { accept: false, reason: mismatch("the configured pin", want, presented) };
  }

  if (stored && stored.trim() !== "") {
    return presented === stored
      ? { accept: true, reason: "matches trust-on-first-use fingerprint" }
      : { accept: false, reason: mismatch("the known_hosts (TOFU) store", stored, presented) };
  }

  // No pin, no prior record: trust on first use, record it, warn loudly.
  return {
    accept: true,
    reason: "pinned on first use (TOFU) — verify out of band",
    persist: { hostPort, fingerprint: presented },
  };
}

/** Thin JSON-file store mapping "host:port" -> canonical fingerprint. */
export class KnownHostsStore {
  constructor(private readonly filePath?: string) {}

  get(hostPort: string): string | undefined {
    if (!this.filePath) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, string>;
      return data[hostPort];
    } catch {
      return undefined;
    }
  }

  set(hostPort: string, fingerprint: string): void {
    if (!this.filePath) return;
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, string>;
    } catch {
      /* new or unreadable -> start fresh */
    }
    data[hostPort] = fingerprint;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
