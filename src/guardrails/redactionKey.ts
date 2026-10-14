/**
 * ADR-026 — the per-install redaction fingerprint key (thin I/O shell). 32 random
 * bytes, created once beside the audit log (mode 0600) and fed to
 * `setRedactionFingerprintKey`, so a marker's `fp=` is an HMAC no other install can
 * reproduce. Fail-soft: an unreadable/unwritable key only drops the `fp=` field.
 */
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export function loadOrCreateRedactionKey(keyPath: string): Buffer | null {
  try {
    if (existsSync(keyPath)) {
      const hex = readFileSync(keyPath, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
      process.stderr.write(`[redaction] ${keyPath} is malformed; markers will carry no fp=.\n`);
      return null;
    }
    mkdirSync(path.dirname(keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    return key;
  } catch (err) {
    process.stderr.write(`[redaction] fingerprint key unavailable (${(err as Error).message}); markers will carry no fp=.\n`);
    return null;
  }
}
