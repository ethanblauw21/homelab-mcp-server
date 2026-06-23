import { describe, it, expect } from "vitest";
import {
  projectDiff,
  recordToColumns,
  buildFtsMatch,
  type DiffProjectionOpts,
} from "./auditProjection.js";
import type { AuditRecord } from "./record.js";

const OPTS: DiffProjectionOpts = { storeDiffs: true, redactDiffs: true, diffMaxBytes: 64 * 1024 };

function rec(p: Partial<AuditRecord>): AuditRecord {
  return {
    id: p.id ?? "id-1",
    ts: p.ts ?? "2026-06-10T00:00:00.000Z",
    tool: p.tool ?? "write_file",
    ...p,
  } as AuditRecord;
}

describe("projectDiff", () => {
  it("returns an empty projection for null/undefined/empty diff", () => {
    for (const d of [null, undefined, ""]) {
      expect(projectDiff(d, OPTS)).toEqual({
        text: null,
        redacted: false,
        redactionCount: 0,
        truncated: false,
      });
    }
  });

  it("returns null text when storeDiffs is disabled, even with a real diff", () => {
    const out = projectDiff("+ hello\n- world", { ...OPTS, storeDiffs: false });
    expect(out.text).toBeNull();
  });

  it("redacts secrets in the diff and counts them when redactDiffs is on", () => {
    const out = projectDiff("+password=supersecret123\n+keep=this", OPTS);
    expect(out.redacted).toBe(true);
    expect(out.redactionCount).toBeGreaterThan(0);
    expect(out.text).not.toContain("supersecret123");
    expect(out.text).toContain("keep=this");
  });

  it("leaves the diff verbatim when redactDiffs is off", () => {
    const diff = "+password=supersecret123";
    const out = projectDiff(diff, { ...OPTS, redactDiffs: false });
    expect(out.text).toBe(diff);
    expect(out.redacted).toBe(false);
    expect(out.redactionCount).toBe(0);
  });

  it("reports redacted:false when redaction runs but changes nothing", () => {
    const out = projectDiff("+ just plain text, nothing secret", OPTS);
    expect(out.redacted).toBe(false);
    expect(out.redactionCount).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it("truncates an over-cap diff to a marker and stays within the byte budget", () => {
    const big = "x".repeat(5000);
    const out = projectDiff(big, { ...OPTS, diffMaxBytes: 1000 });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("truncated by audit.db cap");
    expect(Buffer.byteLength(out.text as string, "utf8")).toBeLessThanOrEqual(1000);
  });

  it("keeps a diff at/under the cap untruncated", () => {
    const out = projectDiff("short diff", { ...OPTS, diffMaxBytes: 1000 });
    expect(out.truncated).toBe(false);
    expect(out.text).toBe("short diff");
  });

  it("truncates multi-byte content without exceeding the byte cap", () => {
    const out = projectDiff("€".repeat(2000), { ...OPTS, diffMaxBytes: 300 });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text as string, "utf8")).toBeLessThanOrEqual(300);
  });
});

describe("recordToColumns", () => {
  const NO_DIFF = { text: null, redacted: false, redactionCount: 0, truncated: false };

  it("maps fields to snake_case columns and serializes raw verbatim", () => {
    const r = rec({
      tool: "write_file",
      vmid: 101,
      path: "/etc/app.conf",
      hashScope: "/etc/app.conf",
      beforeHash: "cafe",
      afterHash: "beef",
    });
    const c = recordToColumns(r, NO_DIFF);
    expect(c.tool).toBe("write_file");
    expect(c.vmid).toBe(101);
    expect(c.hash_scope).toBe("/etc/app.conf");
    expect(c.before_hash).toBe("cafe");
    expect(c.after_hash).toBe("beef");
    expect(JSON.parse(c.raw)).toEqual(r);
  });

  it("preserves a null exitCode (never coerced) and maps undefined to null", () => {
    expect(recordToColumns(rec({ tool: "execute", exitCode: null }), NO_DIFF).exit_code).toBeNull();
    expect(recordToColumns(rec({ tool: "execute", exitCode: 0 }), NO_DIFF).exit_code).toBe(0);
    expect(recordToColumns(rec({ tool: "execute" }), NO_DIFF).exit_code).toBeNull();
  });

  it("maps booleans to 0/1 and absent optional fields to 0", () => {
    const set = recordToColumns(
      rec({ isLargeChange: true, isHeavy: true, confirmGated: true, rootTier: true }),
      NO_DIFF
    );
    expect([set.is_large, set.is_heavy, set.confirm_gated, set.root_tier]).toEqual([1, 1, 1, 1]);
    const unset = recordToColumns(rec({}), NO_DIFF);
    expect([unset.is_large, unset.is_heavy, unset.confirm_gated, unset.root_tier]).toEqual([0, 0, 0, 0]);
  });

  it("treats historyCommitted as tri-state: null when absent, 0/1 otherwise", () => {
    expect(recordToColumns(rec({}), NO_DIFF).history_committed).toBeNull();
    expect(recordToColumns(rec({ historyCommitted: false }), NO_DIFF).history_committed).toBe(0);
    expect(recordToColumns(rec({ historyCommitted: true }), NO_DIFF).history_committed).toBe(1);
  });

  it("nulls every diff column when there is no stored diff", () => {
    const c = recordToColumns(rec({}), NO_DIFF);
    expect([c.diff, c.diff_redacted, c.diff_redaction_count, c.diff_truncated]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("populates the diff columns when a diff is present", () => {
    const c = recordToColumns(rec({}), {
      text: "+ a",
      redacted: true,
      redactionCount: 2,
      truncated: true,
    });
    expect(c.diff).toBe("+ a");
    expect(c.diff_redacted).toBe(1);
    expect(c.diff_redaction_count).toBe(2);
    expect(c.diff_truncated).toBe(1);
  });
});

describe("buildFtsMatch", () => {
  it("returns null for undefined, empty, or token-free input", () => {
    expect(buildFtsMatch(undefined)).toBeNull();
    expect(buildFtsMatch("")).toBeNull();
    expect(buildFtsMatch("   !!!  ---  ")).toBeNull();
  });

  it("quotes each token as a literal phrase and AND-joins them", () => {
    expect(buildFtsMatch("docker security")).toBe('"docker" "security"');
  });

  it("neutralizes FTS5 operators by quoting them as literals", () => {
    // OR / NEAR / * would change query meaning or throw if passed raw.
    expect(buildFtsMatch("foo OR bar")).toBe('"foo" "OR" "bar"');
    expect(buildFtsMatch("drop* NEAR")).toBe('"drop" "NEAR"');
  });

  it("keeps unicode word characters", () => {
    expect(buildFtsMatch("café naïve")).toBe('"café" "naïve"');
  });
});
