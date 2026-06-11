/**
 * Command guardrail (ADR-004 §5): segment-anchored, two-tier.
 *
 *  - DENY (unconditional): destructive-by-nature patterns. No flag bypasses.
 *  - CONFIRM (deliberate-action gate): availability-class commands, matched
 *    ONLY in command position. Refused unless the caller passes confirm:true.
 *
 * Honest limit (restated from ADR-001): this is a tripwire against catastrophic
 * and availability-affecting commands, not a sandbox. Root can still do unbounded
 * damage with commands that match nothing — e.g. `bash -c "reboot"` hides the
 * command in an argument and is NOT caught (A4.2 known limit).
 */

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Quote-aware split into command segments (A4.2). Separators recognised:
 *   ; && || | & newline  and command-substitution introducers $( and backtick.
 * Separators inside single or double quotes do NOT split. Chosen fidelity: a
 * lexical scan, not a full shell parser — nested/escaped exotica may under-split,
 * which is acceptable for a tripwire (it errs toward inspecting more text).
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  const push = () => {
    segments.push(cur);
    cur = "";
  };
  while (i < command.length) {
    const c = command[i]!;
    const c2 = command.slice(i, i + 2);
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (c2 === "$(") {
      push();
      i += 2;
      continue;
    }
    if (c2 === "&&" || c2 === "||") {
      push();
      i += 2;
      continue;
    }
    if (c === "`" || c === ")" || c === ";" || c === "|" || c === "&" || c === "\n") {
      push();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** The command-position token of a segment, basename-stripped (so /sbin/reboot → reboot). */
function commandToken(segment: string): string {
  const first = normalize(segment).split(" ")[0] ?? "";
  return first.split("/").pop() ?? first;
}

// ADR-007 §4 — the Protected Set. Destructive operations against /etc/pve
// (pmxcfs: node identity + cluster config) and cluster membership are DENY at
// EVERY tier including root, with NO confirm bypass. Recovering a node's identity
// is always a human-at-the-console action. Honest limit: like the rest of the
// denylist this is a tripwire over shell commands — it does NOT cover the SFTP
// write_file path (which is root-tier and path-validated separately). Read access
// to /etc/pve (cat/grep) is deliberately NOT blocked.
const PROTECTED_PATTERNS: RegExp[] = [
  /\b(rm|rmdir|shred|unlink)\b[^\n]*\/etc\/pve(\/|\b)/, // delete under /etc/pve
  /\bmv\b[^\n]*\/etc\/pve(\/|\b)/, // move into/out of /etc/pve
  /\btruncate\b[^\n]*\/etc\/pve(\/|\b)/,
  />\s*\/etc\/pve\//, // redirect/truncate into /etc/pve
  /\bpvecm\s+(add|addnode|delnode|qdevice)\b/, // cluster membership mutation
];

// DENY patterns are matched against the *normalized full command* — these are
// destructive-by-nature and we want to catch them wherever they appear.
const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(\*|\s|$)/, // rm -rf / or rm -rf /*
  /\bmkfs\b/,
  /\bdd\s+if=\/dev\/(zero|random|urandom)/,
  /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme\d)/,
  />\s*\/dev\/(sd[a-z]|nvme\d)/, // redirect into a block device
  /:\(\)\s*\{.*\|.*&.*\}/, // fork bomb
  /\bchmod\s+-r\s+777\s+\//, // normalize() lowercases -R → -r
];

// CONFIRM commands match only in COMMAND POSITION (segment's leading token).
const CONFIRM_SIMPLE = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const SYSTEMCTL_CONFIRM = new Set(["reboot", "poweroff", "halt"]);

export type CommandTier = "allow" | "deny" | "confirm";

export interface CommandVerdict {
  tier: CommandTier;
  reason?: string;
}

/** True if a segment's command position is an availability-class (CONFIRM) command. */
function segmentNeedsConfirm(segment: string): boolean {
  const norm = normalize(segment);
  const tokens = norm.split(" ");
  const cmd = commandToken(segment);
  if (CONFIRM_SIMPLE.has(cmd)) return true;
  if (cmd === "init" && (tokens[1] === "0" || tokens[1] === "6")) return true;
  if (cmd === "systemctl") {
    // first non-flag argument after `systemctl`
    const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (sub && SYSTEMCTL_CONFIRM.has(sub)) return true;
  }
  return false;
}

/**
 * Evaluate a command against the two-tier guardrail.
 * Configured `extraDenylist` entries use segment-PREFIX matching (a segment must
 * start with the normalized entry). An entry prefixed `confirm:` is CONFIRM-tier;
 * otherwise DENY.
 */
export function checkCommand(command: string, extraDenylist: string[] = []): CommandVerdict {
  const normalizedFull = normalize(command);
  const segments = splitSegments(command);

  // 0. Protected set (ADR-007 §4) — DENY at every tier, no confirm bypass. Checked
  // first so its reason text is the one surfaced for /etc/pve + cluster ops.
  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(normalizedFull)) {
      return {
        tier: "deny",
        reason:
          `protected set (ADR-007 §4): /etc/pve and cluster membership are off-limits ` +
          `at every tier including root (matched ${pattern})`,
      };
    }
  }

  // 1. Built-in DENY (unconditional) — wins over everything.
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(normalizedFull)) {
      return { tier: "deny", reason: `matches built-in dangerous pattern: ${pattern}` };
    }
  }

  // 2. Configured denylist entries (segment-prefix; default DENY, confirm: → CONFIRM).
  const normalizedSegments = segments.map(normalize);
  let configConfirm: string | null = null;
  for (const raw of extraDenylist) {
    const isConfirm = raw.toLowerCase().startsWith("confirm:");
    const entry = normalize(isConfirm ? raw.slice("confirm:".length) : raw);
    if (!entry) continue;
    const matched = normalizedSegments.some((seg) => seg === entry || seg.startsWith(entry + " "));
    if (matched) {
      if (isConfirm) {
        configConfirm = raw.slice("confirm:".length).trim();
      } else {
        return { tier: "deny", reason: `matches configured denylist entry: ${entry}` };
      }
    }
  }

  // 3. Built-in CONFIRM (command-position only).
  for (const seg of segments) {
    if (segmentNeedsConfirm(seg)) {
      return {
        tier: "confirm",
        reason: `availability-class command "${commandToken(seg)}" requires confirm:true`,
      };
    }
  }

  if (configConfirm !== null) {
    return {
      tier: "confirm",
      reason: `configured confirm-tier command "${configConfirm}" requires confirm:true`,
    };
  }

  return { tier: "allow" };
}
