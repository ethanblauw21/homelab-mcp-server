import { describe, it, expect } from "vitest";
import { detectLargeFileWrite, detectHeavyCommand } from "./largeChange.js";

const THRESHOLD = 1024 * 1024; // 1 MB

describe("detectLargeFileWrite", () => {
  it("flags new file creation regardless of size", () => {
    const result = detectLargeFileWrite(0, true, THRESHOLD);
    expect(result.isLarge).toBe(true);
    expect(result.reason).toMatch(/new file/i);
  });

  it("flags writes above the threshold", () => {
    expect(detectLargeFileWrite(THRESHOLD + 1, false, THRESHOLD).isLarge).toBe(true);
  });

  it("does not flag writes exactly at the threshold", () => {
    expect(detectLargeFileWrite(THRESHOLD, false, THRESHOLD).isLarge).toBe(false);
  });

  it("does not flag small writes to existing files", () => {
    expect(detectLargeFileWrite(100, false, THRESHOLD).isLarge).toBe(false);
  });

  it("includes byte count info in reason", () => {
    const result = detectLargeFileWrite(THRESHOLD + 100, false, THRESHOLD);
    expect(result.reason).toContain(String(THRESHOLD + 100));
  });
});

describe("detectHeavyCommand", () => {
  it("flags tar commands", () => {
    expect(detectHeavyCommand("tar -czf backup.tar.gz /var").isHeavy).toBe(true);
  });

  it("flags rsync", () => {
    expect(detectHeavyCommand("rsync -av /source /dest").isHeavy).toBe(true);
  });

  it("flags find /", () => {
    expect(detectHeavyCommand("find / -name '*.conf'").isHeavy).toBe(true);
  });

  it("flags wget", () => {
    expect(detectHeavyCommand("wget https://example.com/large.iso").isHeavy).toBe(true);
  });

  it("flags curl", () => {
    expect(detectHeavyCommand("curl -O https://example.com/file.tar.gz").isHeavy).toBe(true);
  });

  it("flags scp", () => {
    expect(detectHeavyCommand("scp root@host:/etc/config /tmp/").isHeavy).toBe(true);
  });

  it("flags fsck", () => {
    expect(detectHeavyCommand("fsck /dev/sda1").isHeavy).toBe(true);
  });

  it("flags dump", () => {
    expect(detectHeavyCommand("dump -0u -f /dev/st0 /home").isHeavy).toBe(true);
  });

  it("flags restore", () => {
    expect(detectHeavyCommand("restore -rf /dev/st0").isHeavy).toBe(true);
  });

  it("includes pattern info in reason", () => {
    const result = detectHeavyCommand("tar -czf backup.tar.gz /var");
    expect(result.isHeavy).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("does not flag ls", () => {
    expect(detectHeavyCommand("ls -la /etc").isHeavy).toBe(false);
  });

  it("does not flag cat", () => {
    expect(detectHeavyCommand("cat /etc/hosts").isHeavy).toBe(false);
  });

  it("does not flag systemctl", () => {
    expect(detectHeavyCommand("systemctl restart nginx").isHeavy).toBe(false);
  });

  // --- Mutation-hardening (kills survivors the broad tests miss) ---

  it("flags a bare `tar` command even with no `.tar` substring in the args", () => {
    // Guards `\btar\s+` against the `\btar\S+` mutant: an input like
    // "tar -czf backup.tar.gz" hides a second "tar" inside "tar.gz", so the
    // \S+ mutant still matches there. This input has NO such substring, so only
    // the real `\s+` (space after the command) can match.
    expect(detectHeavyCommand("tar -czf /var/spool").isHeavy).toBe(true);
  });

  it("requires an argument after `find /` (the trailing `\\s` is normalized, not trimmed away)", () => {
    // `\bfind\s+\/\s/` only fires when something follows the root slash. With the
    // real `.trim()` in normalization, "find / " collapses to "find /" (no trailing
    // whitespace) and is NOT heavy. The trim-removal mutant leaves the trailing
    // space, which the pattern would match — so this asserting-false test kills it.
    expect(detectHeavyCommand("find / ").isHeavy).toBe(false);
    // And the canonical args-present form stays heavy.
    expect(detectHeavyCommand("find / -name x").isHeavy).toBe(true);
  });
});
