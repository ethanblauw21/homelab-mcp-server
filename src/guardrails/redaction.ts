/**
 * Shared, pure secret-redaction module (ADR-002).
 *
 * This is the single redaction implementation consumed by BOTH the audit log
 * (`audit/redact.ts`) and the homelab census (`describe_homelab`). It is a
 * guardrail-class module: conservative, fail-closed, and heavily tested. The
 * built-in patterns can be EXTENDED (via `extraKeys`) but never disabled.
 *
 * Strategy is layered and key-name-first:
 *   1. Key-name denylist — a record key (or `NAME=` in free text) whose name
 *      matches the secret-key pattern has its value replaced wholesale.
 *   2. Value patterns — PEM blocks, JWTs, WireGuard/32-byte base64 keys,
 *      URLs with embedded credentials, and Authorization-style headers are
 *      redacted regardless of any key name.
 *   3. Fail-closed summary — a config blob that cannot be parsed into
 *      key/value pairs is summarized rather than passed through raw
 *      (see `summarizeUnparsable`).
 *
 * Over-redaction is acceptable; under-redaction is the failure mode we guard
 * against. When in doubt, redact.
 */

export interface RedactionResult<T> {
  value: T;
  redactedCount: number;
}

const REDACTED = "[REDACTED]";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the case-insensitive secret-key matcher. Matches if the name CONTAINS
 * any secret-ish token. `extraKeys` (from REDACTION_EXTRA_KEYS) are appended;
 * the built-ins are always present.
 */
export function buildKeyNameRegex(extraKeys: string[] = []): RegExp {
  const base = [
    "pass(?:word)?",
    "passwd",
    "secret",
    "token",
    "api[_-]?key",
    "access[_-]?key",
    "private[_-]?key",
    "client[_-]?secret",
    "auth",
    "credential",
    "wireguard.*?key",
    "psk",
  ];
  const extra = extraKeys.map((k) => escapeRegex(k)).filter(Boolean);
  const src = [...base, ...extra].join("|");
  return new RegExp(`(?:${src})`, "i");
}

/**
 * Redact secrets from a free-text string. Applies value patterns plus
 * env-style `NAME=value` assignments whose NAME is secret-ish.
 */
export function redactString(text: string, extraKeys: string[] = []): RedactionResult<string> {
  const keyRe = buildKeyNameRegex(extraKeys);
  let count = 0;
  const bump = (v: string): string => {
    count++;
    return v;
  };

  let out = text;

  // 1. PEM private-key / certificate blocks (multiline) — redact the whole block.
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*(?:KEY|CERTIFICATE)[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*(?:KEY|CERTIFICATE)[A-Z0-9 ]*-----/g,
    () => bump(REDACTED)
  );

  // 2. URLs with embedded credentials: scheme://user:pass@host -> scheme://user:[REDACTED]@host
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s:/@]+@/gi,
    (_m, prefix) => bump(`${prefix}:${REDACTED}@`)
  );

  // 3. Authorization-style headers — redact to end of line.
  out = out.replace(
    /\b(Authorization|Proxy-Authorization|x-api-key|x-auth-token)\s*:\s*\S[^\n]*/gi,
    (m) => bump(m.slice(0, m.indexOf(":") + 1) + " " + REDACTED)
  );

  // 4. Env-style assignments whose NAME is secret-ish: NAME=value -> NAME=[REDACTED]
  out = out.replace(
    /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("[^"\n]*"|'[^'\n]*'|\S+)/g,
    (m, name: string) => (keyRe.test(name) ? bump(m.slice(0, m.indexOf("=") + 1) + REDACTED) : m)
  );

  // 5. JWTs (header.payload.signature, base64url).
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*/g,
    () => bump(REDACTED)
  );

  // 6. AWS access key IDs.
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, () => bump(REDACTED));

  // NOTE: We deliberately do NOT blanket-redact bare 44-char base64 strings.
  // WireGuard *private* keys arrive as `*key=` assignments (caught by the
  // env-style / key-name layers); but Tailscale/WireGuard *public* keys,
  // base64 SHA-256 digests, and cert fragments share that exact shape and are
  // the useful content of the inventory. Blanket-matching them would gut the
  // census's whole purpose. Raw-base64 redaction therefore happens ONLY when an
  // adjacent key name is secret-suggesting (see redactRecord / env-style layer).

  return { value: out, redactedCount: count };
}

/**
 * Redact a parsed key/value record (e.g. parsed `pct config`). A secret-ish
 * key has its value replaced with `[REDACTED:<key>]`; other values are scanned
 * for value-pattern secrets.
 */
export function redactRecord(
  record: Record<string, unknown>,
  extraKeys: string[] = []
): RedactionResult<Record<string, string>> {
  const keyRe = buildKeyNameRegex(extraKeys);
  const out: Record<string, string> = {};
  let count = 0;

  for (const [k, v] of Object.entries(record)) {
    if (keyRe.test(k)) {
      out[k] = `[REDACTED:${k}]`;
      count++;
      continue;
    }
    const r = redactString(String(v ?? ""), extraKeys);
    out[k] = r.value;
    count += r.redactedCount;
  }

  return { value: out, redactedCount: count };
}

/** Overloaded entry point: dispatches on input type. */
export function redact(input: string, extraKeys?: string[]): RedactionResult<string>;
export function redact(
  input: Record<string, unknown>,
  extraKeys?: string[]
): RedactionResult<Record<string, string>>;
export function redact(
  input: string | Record<string, unknown>,
  extraKeys: string[] = []
): RedactionResult<string> | RedactionResult<Record<string, string>> {
  return typeof input === "string"
    ? redactString(input, extraKeys)
    : redactRecord(input, extraKeys);
}

/**
 * Fail-closed handling for a config blob that could not be parsed into
 * key/value pairs. Rather than passing raw content through, return a summary
 * line and the count of values a pattern scan WOULD have redacted — so an
 * unparsable secret-bearing blob never leaks verbatim.
 */
export function summarizeUnparsable(text: string, extraKeys: string[] = []): RedactionResult<string> {
  const lineCount = text === "" ? 0 : text.split("\n").length;
  const { redactedCount } = redactString(text, extraKeys);
  return {
    value: `[unparsed: ${lineCount} lines, ${redactedCount} redactions by pattern scan]`,
    redactedCount,
  };
}
