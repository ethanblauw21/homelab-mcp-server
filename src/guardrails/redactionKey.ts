/**
 * ADR-026 — the per-install redaction fingerprint key (thin I/O shell). 32 random
 * bytes, created once beside the audit log (mode 0600) and fed to
 * `setRedactionFingerprintKey`, so a marker's `fp=` is an HMAC no other install can
 * reproduce. Fail-soft: an unreadable/unwritable key only drops the `fp=` field.
 *
 * ADR-027 — an EXISTING key is tightened to 0600 on load (POSIX only; Windows has
 * no mode bits). A key copied between machines or created under another umask
 * could otherwise stay group/world-readable.
 */
import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";

/** Tighten a key file to 0600 if group/other bits are set. Returns true when it changed. */
export function enforceKeyFileMode(keyPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  const mode = statSync(keyPath).mode & 0o777;
  if ((mode & 0o077) === 0) return false;
  chmodSync(keyPath, 0o600);
  process.stderr.write(`[redaction] ${keyPath} was mode ${mode.toString(8)}; tightened to 600.\n`);
  return true;
}

export function loadOrCreateRedactionKey(keyPath: string): Buffer | null {
  try {
    if (existsSync(keyPath)) {
      try {
        enforceKeyFileMode(keyPath);
      } catch (err) {
        process.stderr.write(`[redaction] could not check/tighten ${keyPath} mode (${(err as Error).message}).\n`);
      }
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
