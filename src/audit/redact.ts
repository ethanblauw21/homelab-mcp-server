const REDACTED = "[REDACTED]";

/**
 * Patterns are matched against raw text (cmd / note fields).
 * Each replacer preserves the key/header name and replaces only the value.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; replace: (m: string) => string }> = [
  // env-var assignments with secret-sounding names: SECRET=value, TOKEN=value, etc.
  {
    re: /\b(password|passwd|secret(?:[_-]?key)?|token|api[_-]?(?:key|secret)|access[_-]?key|auth(?:[_-]?token)?|private[_-]?key|client[_-]?secret|aws[_-]?secret(?:[_-]?access[_-]?key)?|db[_-]?pass(?:word)?|database[_-]?pass(?:word)?)\s*=\s*\S+/gi,
    replace: (m) => m.slice(0, m.indexOf("=") + 1) + REDACTED,
  },
  // HTTP/curl Authorization header and common secret headers
  {
    re: /\b(Authorization|x-api-key|x-auth-token)\s*:\s*\S+/gi,
    replace: (m) => {
      const idx = m.indexOf(":");
      return m.slice(0, idx + 1) + " " + REDACTED;
    },
  },
  // AWS IAM access key IDs
  {
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  // PEM private key / certificate blocks
  {
    re: /-----BEGIN [A-Z0-9 ]*(?:KEY|CERTIFICATE)[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*(?:KEY|CERTIFICATE)[A-Z0-9 ]*-----/g,
    replace: () => REDACTED,
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
