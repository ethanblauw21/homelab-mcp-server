/**
 * Shared, pure secret-redaction module (ADR-002, hardened by ADR-026).
 *
 * The ONE redaction implementation. Consumers: the audit log (`audit/redact.ts`),
 * the audit.db diff projection, the census / describe_guest / docker_inspect
 * parsers, the log tools, and — since ADR-026 — the MCP registration boundary in
 * `index.ts`, which runs every tool result and error message through
 * `redactToolResult` (so a tool that forgets to redact is still covered). There
 * is no bypass flag. The built-in patterns can be EXTENDED (`extraKeys`) but never
 * disabled.
 *
 * Two layers, both best-effort:
 *   1. KEY NAME — a value whose key/name matches the secret-key pattern is
 *      replaced, the key kept: env `NAME=value`, `key: value` / `key = value`
 *      lines (YAML/INI/.env), JSON `"key": value`, XML `<Key>value</Key>`,
 *      CLI `--password value`, URL query params, parsed records/objects.
 *   2. SHAPE — wherever it appears: webhook URLs, URL userinfo, auth headers,
 *      PVE API tokens, JWTs, PEM private keys, known token prefixes, and a
 *      high-entropy hex/base64 fallback that allow-lists digests, container ids,
 *      git SHAs, SSH public keys and `SHA256:` fingerprints.
 *
 * Marker: `<redacted len=N>` — or `<redacted len=N fp=xxxxxxxx>` once a per-install
 * key is set (`setRedactionFingerprintKey`): an HMAC-SHA256 prefix, so a rotation
 * can be confirmed without the value (never a plain hash — short passwords would
 * brute-force). Redaction is idempotent: a value already holding a marker is left.
 *
 * Over-redaction is acceptable; under-redaction is the failure mode we guard
 * against. When in doubt, redact.
 */
import { createHmac } from "crypto";

export interface RedactionResult<T> {
  value: T;
  redactedCount: number;
}

// ---------------------------------------------------------------------------
// Marker + fingerprint
// ---------------------------------------------------------------------------

let fingerprintKey: Buffer | null = null;

/** Install the per-install HMAC key (null disables the `fp=` field). */
export function setRedactionFingerprintKey(key: Buffer | null): void {
  fingerprintKey = key && key.length > 0 ? Buffer.from(key) : null;
}

/** The marker that replaces a secret value. */
export function redactionMarker(secret: string): string {
  if (!fingerprintKey) return `<redacted len=${secret.length}>`;
  const fp = createHmac("sha256", fingerprintKey).update(secret, "utf8").digest("hex").slice(0, 8);
  return `<redacted len=${secret.length} fp=${fp}>`;
}

const MARKER_RE = /<redacted len=\d+(?: fp=[0-9a-f]{8})?>/g;

/** True when `text` holds a redaction marker (current or the legacy `[REDACTED…]`). */
export function containsRedactionMarker(text: string): boolean {
  return text.includes("<redacted") || text.includes("[REDACTED");
}

function countMarkers(text: string): number {
  return (text.match(MARKER_RE) ?? []).length;
}

/**
 * Write guard: does `next` carry MORE redaction markers than `prev`? A write built
 * from redacted read output would replace real secrets with markers; refuse it.
 * Comparing counts (not presence) lets a revert or an unrelated edit of a file that
 * already contains marker-like text through.
 */
export function introducesRedactionMarker(prev: string | null, next: string): boolean {
  return countMarkers(next) > countMarkers(prev ?? "");
}

export const REDACTION_MARKER_WRITE_REFUSAL =
  "Refusing to write: the new content contains `<redacted len=…>` markers that the current file does not. " +
  "Tool output is secret-redacted, so writing it back would replace real secrets with markers. " +
  "Use the matching *_edit_file tool to change only the lines you need (untouched secrets are preserved), " +
  "or supply the real value yourself.";

// ---------------------------------------------------------------------------
// Key-name layer
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const KEY_PATTERNS = [
  "webhook",
  "token",
  "secret",
  "pass(?:word|wd)?",
  "api[_-]?key",
  "(?:^|[._-])key$",
  "^key$",
  "auth",
  "cookie",
  "credential",
  "private",
  "session",
  "signature",
  "salt",
  "dsn",
  "conn(?:ection)?[_-]?string",
  "access[_-]?key",
  "psk",
  "wireguard.*?key",
];

/**
 * Case-insensitive secret-key matcher (the name CONTAINS a secret-ish token, with
 * `KEY` anchored so `monkey`/`keyboard` stay readable). `extraKeys`
 * (REDACTION_EXTRA_KEYS) are appended; the built-ins are always present.
 */
export function buildKeyNameRegex(extraKeys: string[] = []): RegExp {
  const extra = extraKeys.map((k) => escapeRegex(k)).filter(Boolean);
  return new RegExp(`(?:${[...KEY_PATTERNS, ...extra].join("|")})`, "i");
}

/** Values that are never secrets, even under a secret-ish key. */
function isExemptValue(raw: string): boolean {
  const v = raw.trim().replace(/^(["'])(.*)\1$/s, "$2").trim();
  if (v === "") return true;
  if (containsRedactionMarker(v)) return true;
  if (/^(?:true|false|yes|no|on|off|null|none|nil|undefined)$/i.test(v)) return true;
  // Compose/shell interpolation references are pointers, not secrets. `${VAR:-default}`
  // is NOT exempt — the default can be the secret.
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?\?[^}]*)?\}$/.test(v)) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true;
  return false;
}

/** Replace a value, keeping surrounding quotes. */
function maskValue(raw: string): string {
  const q = raw.match(/^(\\?["'])(.*)(\1)$/s);
  if (q) return `${q[1]}${redactionMarker(q[2]!)}${q[3]}`;
  return redactionMarker(raw);
}

// ---------------------------------------------------------------------------
// Shape layer
// ---------------------------------------------------------------------------

/** Notification URL schemes (shoutrrr / Apprise) whose authority IS the credential. */
const NOTIFY_SCHEMES =
  "discord|slack|teams|telegram|tgram|pushover|pover|pushbullet|pbul|gotify|matrix|mattermost|rocketchat|rocket|zulip|ifttt|join|opsgenie|ntfy|bark|googlechat|pagerduty|signal";

const QUERY_SECRET_NAMES = /^(?:token|key|apikey|api_key|api-key|access_token|secret|sig|signature|password|passwd|pwd|auth|code|client_secret)$/i;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Contexts whose long hex/base64 is identity, not secret (checked on the text just before the run). */
const ALLOWED_RUN_CONTEXT =
  /(?:sha(?:1|224|256|384|512)[:-]|md5[:-]|(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) |(?:node|disco|machine|m)key:|public[ _-]?key["']?\s*[:=]\s*["']?|fingerprint["']?\s*[:=]\s*["']?)$/i;

function isAllowedHexRun(run: string, before: string): boolean {
  if (ALLOWED_RUN_CONTEXT.test(before)) return true;
  // Git SHAs (40), container/image ids + sha256 sums (64), sha512 sums (128): lowercase identity hashes.
  return /^[0-9a-f]+$/.test(run) && (run.length === 40 || run.length === 64 || run.length === 128);
}

function isHighEntropyBase64(run: string): boolean {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) return false;
  return shannonBitsPerChar(run.replace(/=+$/, "")) >= 4.2;
}

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------

/**
 * Redact secrets from free text. Shape rules run first (they keep the useful
 * prefix — scheme, host, token id), then key-name rules, then the entropy fallback;
 * a value already holding a marker is never re-redacted.
 */
export function redactString(text: string, extraKeys: string[] = []): RedactionResult<string> {
  const keyRe = buildKeyNameRegex(extraKeys);
  let count = 0;
  const mark = (secret: string): string => {
    count++;
    return redactionMarker(secret);
  };
  const markValue = (raw: string): string => {
    count++;
    return maskValue(raw);
  };

  let out = text;

  // 1. PEM private-key blocks — keep the BEGIN/END lines, redact the body.
  out = out.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----)/g,
    (m, begin: string, body: string, end: string) =>
      containsRedactionMarker(body) ? m : `${begin}\n${mark(body.trim())}\n${end}`
  );

  // 2. Webhook URLs — keep scheme, host and path prefix; redact everything after.
  out = out.replace(
    /(https?:\/\/(?:[a-z0-9-]+\.)*(?:discord(?:app)?\.com\/api\/webhooks\/|hooks\.slack\.com\/(?:services|workflows|triggers)\/|[a-z0-9-]*\.?webhook\.office\.com\/webhookb2\/))([^\s"'<>`]+)/gi,
    (_m, prefix: string, rest: string) => prefix + mark(rest)
  );
  out = out.replace(
    /(https?:\/\/[^\s/"'<>`]+(?:\/[^\s/"'<>`?#]+)*?\/(?:webhooks?|hooks)\/)([^\s"'<>`]+)/gi,
    (m, prefix: string, rest: string) => (containsRedactionMarker(rest) ? m : prefix + mark(rest))
  );
  // Notification URLs (shoutrrr/Apprise: discord://token@id, slack://a/b/c, …).
  out = out.replace(
    new RegExp(`\\b((?:${NOTIFY_SCHEMES})s?:\\/\\/)([^\\s"'<>\`]+)`, "gi"),
    (m, prefix: string, rest: string) => (containsRedactionMarker(rest) ? m : prefix + mark(rest))
  );

  // 3. URL userinfo: scheme://user:pass@host -> scheme://user:<redacted>@host
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>`]*):([^\s/@"'<>`]+)@/gi,
    (m, prefix: string, pass: string) => (containsRedactionMarker(pass) ? m : `${prefix}:${mark(pass)}@`)
  );

  // 4. URL query params named like secrets (?token=…&sig=…).
  out = out.replace(
    /([?&;])([A-Za-z0-9_.-]+)=([^&#\s"'<>`]+)/g,
    (m, sep: string, name: string, value: string) =>
      (QUERY_SECRET_NAMES.test(name) || keyRe.test(name)) && !isExemptValue(value) ? `${sep}${name}=${mark(value)}` : m
  );

  // 5. PVE API tokens and `!tokenname=<uuid>` secrets — keep the token id.
  out = out.replace(
    new RegExp(`(![A-Za-z0-9._-]+=)(${UUID})`, "g"),
    (_m, id: string, secret: string) => id + mark(secret)
  );

  // 6. Authorization headers — keep the scheme word.
  out = out.replace(
    /\b((?:Proxy-)?Authorization\s*[:=]\s*)(?:(Bearer|Basic|Token|Digest|Negotiate|Bot)\s+)?([^\s"'`,;]+)/gi,
    (m, head: string, scheme: string | undefined, cred: string) =>
      containsRedactionMarker(cred) ? m : `${head}${scheme ? scheme + " " : ""}${mark(cred)}`
  );
  out = out.replace(
    /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
    (m, head: string, cred: string) => (containsRedactionMarker(cred) ? m : head + mark(cred))
  );
  out = out.replace(
    /\b((?:x-api-key|x-auth-token|x-access-token|api-key|x-gitlab-token|private-token|cookie|set-cookie)\s*:\s*)([^\r\n"'`]+)/gi,
    (m, head: string, value: string) => (containsRedactionMarker(value) ? m : head + mark(value.trim()))
  );

  // 7. Known token prefixes — keep the prefix (it names the issuer).
  const prefixed: RegExp[] = [
    /\b(gh[pousr]_)([A-Za-z0-9]{20,})/g,
    /\b(github_pat_)([A-Za-z0-9_]{20,})/g,
    /\b(glpat-)([A-Za-z0-9_-]{20,})/g,
    /\b(xox[abposr]-)([A-Za-z0-9-]{10,})/g,
    /\b(sk-(?:ant-|proj-)?)([A-Za-z0-9_-]{20,})/g,
    /\b([rs]k_(?:live|test)_)([A-Za-z0-9]{16,})/g,
    /\b(tskey-(?:auth-|client-|api-|webhook-)?)([A-Za-z0-9-]{10,})/g,
    /\b(AKIA|ASIA)([0-9A-Z]{16})\b/g,
  ];
  for (const re of prefixed) {
    out = out.replace(re, (_m, prefix: string, secret: string) => prefix + mark(secret));
  }

  // 8. JWTs (header.payload.signature, base64url).
  out = out.replace(/\beyJ[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*/g, (m) => mark(m));

  // 9. JSON `"secretKey": value`.
  out = out.replace(
    /"([^"\\\n]{1,128})"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?)/g,
    (m, key: string, sep: string, value: string) =>
      keyRe.test(key) && !isExemptValue(value)
        ? `"${key}"${sep}${value.startsWith('"') ? markValue(value) : `"${mark(value)}"`}`
        : m
  );

  // 10. XML `<ApiKey>value</ApiKey>` (the *arr config.xml shape).
  out = out.replace(
    /<([A-Za-z_][\w.-]*)>([^<\n]*)<\/\1>/g,
    (m, tag: string, value: string) => (keyRe.test(tag) && !isExemptValue(value) ? `<${tag}>${mark(value)}</${tag}>` : m)
  );

  // 11. Line-anchored `key: value` / `key = value` (YAML, INI, .env, `export K=v`):
  //     the value runs to end of line; YAML block scalars (`key: |`) redact the
  //     more-indented lines that follow.
  out = redactLines(out, keyRe, () => count++);

  // 12. Inline `NAME=value` (env, labels, CLI `--token=x`, k=v logs). An unquoted
  //     value runs to whitespace — commas included, so a secret with a comma is
  //     not half-leaked; for a NON-secret name the text after its first comma is
  //     re-scanned, so `a=1,webhook=x` (docker ps Labels) still catches `webhook`.
  const inline =
    /(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(<redacted[^>]*>|"[^"\n]*"|'[^'\n]*'|\\"(?:[^"\\\n]|\\[^"])*\\"|[^\s"'`]+)/g;
  const assign = (src: string): string =>
    src.replace(inline, (m, name: string, sep: string, value: string) => {
      if (keyRe.test(name) && !isExemptValue(value)) return `${name}${sep}${markValue(value)}`;
      const comma = value.indexOf(",");
      if (comma === -1 || /^["'\\<]/.test(value)) return m;
      return `${name}${sep}${value.slice(0, comma + 1)}${assign(value.slice(comma + 1))}`;
    });
  out = assign(out);

  // 13. CLI `--password value` (space-separated long flag).
  out = out.replace(
    /(?<![A-Za-z0-9_-])(--[A-Za-z][A-Za-z0-9_-]*)([ \t]+)(?!-)("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/g,
    (m, flag: string, sep: string, value: string) =>
      keyRe.test(flag.slice(2)) && !isExemptValue(value) ? `${flag}${sep}${markValue(value)}` : m
  );

  // 14. Entropy fallback — long hex, then long base64/base64url, outside allow-listed contexts.
  out = out.replace(/(?<![A-Za-z0-9_])[0-9a-fA-F]{32,}(?![A-Za-z0-9_])/g, (run: string, offset: number, whole: string) =>
    isAllowedHexRun(run, whole.slice(Math.max(0, offset - 48), offset)) ? run : mark(run)
  );
  out = out.replace(
    /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/g,
    (run: string, offset: number, whole: string) => {
      if (/^[0-9a-fA-F]+$/.test(run)) return run; // the hex rule's call
      if (run.startsWith("/") || run.includes("//")) return run; // a path or URL, not a token
      if (ALLOWED_RUN_CONTEXT.test(whole.slice(Math.max(0, offset - 48), offset))) return run;
      return isHighEntropyBase64(run) ? mark(run) : run;
    }
  );

  return { value: out, redactedCount: count };
}

const LINE_KV = /^(\s*(?:-\s+)?(?:export\s+)?(["']?))([A-Za-z0-9_.-]+)((?:\2)?\s*[:=][ \t]*)(.*)$/;

function redactLines(text: string, keyRe: RegExp, bump: () => void): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(LINE_KV);
    if (!m) continue;
    const [, lead, quote, key, sep, rawValue] = m as unknown as [string, string, string, string, string, string];
    if (!keyRe.test(key)) continue;
    const value = rawValue.replace(/\s+$/, "");
    // YAML block scalar: redact every following line indented deeper than the key.
    if (/^[|>][-+0-9]*$/.test(value)) {
      const indent = line.length - line.trimStart().length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") continue;
        if (next.length - next.trimStart().length <= indent) break;
        const pad = next.slice(0, next.length - next.trimStart().length);
        if (!containsRedactionMarker(next)) {
          lines[j] = pad + redactionMarker(next.trim());
          bump();
        }
        i = j;
      }
      continue;
    }
    if (value === "" || value.startsWith("{") || value.startsWith("[") || isExemptValue(value)) continue;
    // `"KEY=value",` (a JSON-array line) keeps its closing quote + comma; a
    // `key: value,` keeps the trailing comma.
    let body = value;
    let tail = "";
    const keyClosed = quote !== "" && sep.startsWith(quote);
    const t = quote && !keyClosed ? value.match(/^(.*?)(["'],?)$/) : value.match(/^(.*?)(,)$/);
    if (t) {
      body = t[1]!;
      tail = t[2]!;
    }
    if (isExemptValue(body)) continue;
    lines[i] = `${lead}${key}${sep}${maskValue(body)}${tail}`;
    bump();
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Records, objects, tool results
// ---------------------------------------------------------------------------

/**
 * Redact a parsed key/value record (e.g. parsed `pct config`, a container's env
 * map or labels). A secret-ish key has its value replaced (key kept); every other
 * value is shape-scanned.
 */
export function redactRecord(
  record: Record<string, unknown>,
  extraKeys: string[] = []
): RedactionResult<Record<string, string>> {
  const keyRe = buildKeyNameRegex(extraKeys);
  const out: Record<string, string> = {};
  let count = 0;

  for (const [k, v] of Object.entries(record)) {
    const s = String(v ?? "");
    if (keyRe.test(k) && !isExemptValue(s)) {
      out[k] = redactionMarker(s);
      count++;
      continue;
    }
    const r = redactString(s, extraKeys);
    out[k] = r.value;
    count += r.redactedCount;
  }

  return { value: out, redactedCount: count };
}

/**
 * Structural field names in this server's OWN result objects that match the key
 * pattern but hold no secret (census/preflight/snapshot `key` descriptors). Their
 * values are still shape-scanned.
 */
const STRUCTURAL_KEYS = new Set(["key"]);

/** Deep-redact any JSON-shaped value: secret-keyed scalars are masked, every string is shape-scanned. */
export function redactDeep<T>(input: T, extraKeys: string[] = []): RedactionResult<T> {
  const keyRe = buildKeyNameRegex(extraKeys);
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactString(v, extraKeys);
      count += r.redactedCount;
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (
          (typeof val === "string" || typeof val === "number") &&
          keyRe.test(k) &&
          !STRUCTURAL_KEYS.has(k) &&
          !isExemptValue(String(val))
        ) {
          out[k] = redactionMarker(String(val));
          count++;
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  };
  return { value: walk(input) as T, redactedCount: count };
}

/**
 * Redact one tool-output text. Compact JSON this server produced (`JSON.stringify`)
 * is parsed and deep-redacted so key context survives; anything else (file
 * content, raw stdout, error text) is redacted as text, byte layout preserved.
 */
export function redactToolText(text: string): string {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (JSON.stringify(parsed) === text) return JSON.stringify(redactDeep(parsed).value);
    } catch {
      /* not JSON — fall through to text */
    }
  }
  return redactString(text).value;
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: unknown } & Record<string, unknown>>;
  structuredContent?: unknown;
}

/**
 * The MCP-boundary redactor (ADR-026): every text block and any structured content
 * of a tool result. Wired into `register` in `index.ts`, so EVERY registered tool
 * passes through it — success and error results alike.
 */
export function redactToolResult<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const r = result as T & ToolResultLike;
  const content = Array.isArray(r.content)
    ? r.content.map((c) => (c && c.type === "text" && typeof c.text === "string" ? { ...c, text: redactToolText(c.text) } : c))
    : r.content;
  return {
    ...r,
    ...(content !== undefined && { content }),
    ...(r.structuredContent !== undefined && { structuredContent: redactDeep(r.structuredContent).value }),
  };
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
  return typeof input === "string" ? redactString(input, extraKeys) : redactRecord(input, extraKeys);
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
