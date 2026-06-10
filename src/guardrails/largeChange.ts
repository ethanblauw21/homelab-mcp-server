export interface LargeChangeResult {
  isLarge: boolean;
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

export function detectHeavyCommand(command: string): LargeChangeResult {
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const pattern of HEAVY_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) {
      return { isLarge: true, reason: `command matches heavy pattern: ${pattern}` };
    }
  }
  return { isLarge: false };
}
