export interface LargeChangeResult {
  isLarge: boolean;
  reason?: string;
}

/**
 * Result of heavy-command detection (ADR-008 §4). Deliberately a distinct type
 * from LargeChangeResult: a heavy command (curl/wget/tar/rsync/…) is an *audit
 * annotation only* — it is never a "large change" and never gates. Conflating the
 * two (the drift §4 removes) polluted the `largeOnly` audit filter.
 */
export interface HeavyCommandResult {
  isHeavy: boolean;
  reason?: string;
}

const HEAVY_COMMAND_PATTERNS: RegExp[] = [
  /\bfind\s+\/\s/,
  /\btar\s+/,
  /\brsync\b/,
  /\bscp\b/,
  /\bwget\b/,
  /\bcurl\b/,
  /\bdump\b/,
  /\brestore\b/,
  /\bfsck\b/,
];

export function detectLargeFileWrite(
  newBytes: number,
  isNewFile: boolean,
  thresholdBytes: number
): LargeChangeResult {
  if (isNewFile) {
    return { isLarge: true, reason: "new file creation" };
  }
  if (newBytes > thresholdBytes) {
    return {
      isLarge: true,
      reason: `file size ${newBytes} bytes exceeds threshold ${thresholdBytes} bytes`,
    };
  }
  return { isLarge: false };
}

export function detectHeavyCommand(command: string): HeavyCommandResult {
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const pattern of HEAVY_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) {
      return { isHeavy: true, reason: `command matches heavy pattern: ${pattern}` };
    }
  }
  return { isHeavy: false };
}
