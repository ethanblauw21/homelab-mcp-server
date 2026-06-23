import { describe, it, expect } from "vitest";
import { buildGrepCommand, parseGrepContext } from "./searchFileRegex.js";

describe("buildGrepCommand", () => {
  it("builds a -C balloon with overflow detection (-m maxMatches+1)", () => {
    expect(buildGrepCommand("/etc/ssh/sshd_config", "PermitRoot", 2, 20)).toBe(
      "grep -a -n -E -C 2 -m 21 -e 'PermitRoot' -- '/etc/ssh/sshd_config'"
    );
  });

  it("escapes single quotes in the pattern and path (no shell breakout)", () => {
    const c = buildGrepCommand("/etc/x'; reboot", "a'b", 1, 5);
    // Both the pattern and the path carry a single quote; each is neutralized via
    // the '\'' idiom, so neither can close its quoting and inject a command.
    expect(c).toContain(`'\\''`);
    expect(c.endsWith("'")).toBe(true);
    expect(c).toContain("-C 1");
    expect(c).toContain("-m 6");
  });
});

describe("parseGrepContext", () => {
  it("reconstructs before/after for a single isolated match", () => {
    const out = ["8-listen 80", "9-server {", "10:    root /var/www;", "11-}", "12-# end"].join("\n");
    const r = parseGrepContext(out, 2, 20);
    expect(r.truncated).toBe(false);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toEqual({
      lineNo: 10,
      matchLine: "    root /var/www;",
      before: ["listen 80", "server {"],
      after: ["}", "# end"],
    });
  });

  it("handles two matches in one merged group via the line-number index", () => {
    // grep merges overlapping contexts: no `--`, both `:` lines in one block.
    const out = ["4-a", "5:match one", "6-b", "7:match two", "8-c"].join("\n");
    const r = parseGrepContext(out, 1, 20);
    expect(r.matches.map((m) => m.lineNo)).toEqual([5, 7]);
    expect(r.matches[0]).toEqual({ lineNo: 5, matchLine: "match one", before: ["a"], after: ["b"] });
    expect(r.matches[1]).toEqual({ lineNo: 7, matchLine: "match two", before: ["b"], after: ["c"] });
  });

  it("splits non-adjacent groups separated by --", () => {
    const out = ["2-x", "3:hit", "4-y", "--", "20-p", "21:hit2", "22-q"].join("\n");
    const r = parseGrepContext(out, 1, 20);
    expect(r.matches.map((m) => m.lineNo)).toEqual([3, 21]);
    expect(r.matches[1].before).toEqual(["p"]);
    expect(r.matches[1].after).toEqual(["q"]);
  });

  it("flags truncation and drops the overflow match when more than maxMatches", () => {
    const out = ["1:a", "2:b", "3:c"].join("\n");
    const r = parseGrepContext(out, 0, 2);
    expect(r.truncated).toBe(true);
    expect(r.matches.map((m) => m.lineNo)).toEqual([1, 2]);
  });

  it("preserves leading dashes/colons in matched text", () => {
    const out = ["5:--flag=value", "6-127.0.0.1:8080"].join("\n");
    const r = parseGrepContext(out, 1, 20);
    expect(r.matches[0].matchLine).toBe("--flag=value");
    expect(r.matches[0].after).toEqual(["127.0.0.1:8080"]);
  });

  it("returns no matches for empty output", () => {
    expect(parseGrepContext("", 2, 20)).toEqual({ matches: [], truncated: false });
  });

  it("omits missing neighbors at the start of file (no negative line numbers)", () => {
    const out = ["1:first line", "2-second"].join("\n");
    const r = parseGrepContext(out, 2, 20);
    expect(r.matches[0].before).toEqual([]);
    expect(r.matches[0].after).toEqual(["second"]);
  });
});
