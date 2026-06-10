function normalize(cmd: string): string {
  return cmd
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// All patterns are matched against the *normalized* (lowercased, whitespace-collapsed) command.
const BUILT_IN_PATTERNS: RegExp[] = [
  // rm -rf / or rm -rf /* — path must be exactly "/" optionally followed by "*"
  /\brm\s+-rf\s+\/(\*|\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+if=\/dev\/(zero|random|urandom)/,
  />\s*\/dev\/(sd[a-z]|nvme\d)/,
  /:\(\)\s*\{.*\|.*&.*\}/,       // fork bomb
  // normalize() lowercases, so -R becomes -r
  /\bchmod\s+-r\s+777\s+\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\binit\s+[06]\b/,
  /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme\d)/,
];

export interface DenylistResult {
  denied: boolean;
  reason?: string;
}

export function checkDenylist(
  command: string,
  extraDenylist: string[] = []
): DenylistResult {
  const normalized = normalize(command);

  for (const pattern of BUILT_IN_PATTERNS) {
    if (pattern.test(normalized)) {
      return { denied: true, reason: `matches built-in dangerous pattern: ${pattern}` };
    }
  }

  for (const entry of extraDenylist) {
    if (normalized.includes(normalize(entry))) {
      return { denied: true, reason: `matches configured denylist entry: ${entry}` };
    }
  }

  return { denied: false };
}
