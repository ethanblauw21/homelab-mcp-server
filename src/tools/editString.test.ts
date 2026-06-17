import { describe, it, expect } from "vitest";
import {
  applyStringEdit,
  countOccurrences,
  editFailureMessage,
  type EditResult,
} from "./editString.js";

const ok = (r: EditResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
};
const fail = (r: EditResult) => {
  if (r.ok) throw new Error("expected failure, got ok");
  return r;
};

describe("countOccurrences", () => {
  it("counts non-overlapping literal occurrences", () => {
    expect(countOccurrences("a.b.c.d", ".")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2); // non-overlapping
    expect(countOccurrences("hello", "x")).toBe(0);
  });

  it("returns 0 for an empty needle (undefined count)", () => {
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("applyStringEdit — happy paths", () => {
  it("replaces a unique occurrence", () => {
    const r = ok(applyStringEdit({ prev: "port = 8080\n", oldString: "8080", newString: "9090" }));
    expect(r.next).toBe("port = 9090\n");
    expect(r.replacements).toBe(1);
  });

  it("replaces all occurrences when replaceAll is set", () => {
    const r = ok(
      applyStringEdit({ prev: "x=1; x=1; x=1", oldString: "x=1", newString: "x=2", replaceAll: true })
    );
    expect(r.next).toBe("x=2; x=2; x=2");
    expect(r.replacements).toBe(3);
  });

  it("treats an empty newString as a deletion", () => {
    const r = ok(applyStringEdit({ prev: "keep DROP keep", oldString: " DROP", newString: "" }));
    expect(r.next).toBe("keep keep");
    expect(r.replacements).toBe(1);
  });

  it("handles multi-line oldString verbatim (whitespace-sensitive)", () => {
    const prev = "a\n  indented\nb\n";
    const r = ok(applyStringEdit({ prev, oldString: "  indented\n", newString: "  changed\n" }));
    expect(r.next).toBe("a\n  changed\nb\n");
  });
});

describe("applyStringEdit — literal, never regex/$-pattern", () => {
  it("matches regex-special characters literally", () => {
    const r = ok(
      applyStringEdit({ prev: "value = a.*b (x)", oldString: "a.*b (x)", newString: "ok" })
    );
    expect(r.next).toBe("value = ok");
  });

  it("does NOT interpret $-patterns in newString (the String.replace footgun)", () => {
    // $&, $1, $$ must land verbatim, not be substituted.
    const r = ok(applyStringEdit({ prev: "TOKEN", oldString: "TOKEN", newString: "$& $1 $$" }));
    expect(r.next).toBe("$& $1 $$");
  });

  it("does not interpret $-patterns under replaceAll either", () => {
    const r = ok(
      applyStringEdit({ prev: "A A", oldString: "A", newString: "$&", replaceAll: true })
    );
    expect(r.next).toBe("$& $&");
  });

  it("handles multi-byte UTF-8 literally", () => {
    const r = ok(applyStringEdit({ prev: "café ☕ end", oldString: "café ☕", newString: "tea" }));
    expect(r.next).toBe("tea end");
  });
});

describe("applyStringEdit — refusals", () => {
  it("refuses when oldString is not found", () => {
    const r = fail(applyStringEdit({ prev: "abc", oldString: "xyz", newString: "q" }));
    expect(r.reason).toBe("not_found");
    expect(r.count).toBe(0);
  });

  it("refuses an ambiguous match without replaceAll, reporting the count", () => {
    const r = fail(applyStringEdit({ prev: "a a a", oldString: "a", newString: "b" }));
    expect(r.reason).toBe("not_unique");
    expect(r.count).toBe(3);
  });

  it("refuses a no-op edit (oldString === newString)", () => {
    const r = fail(applyStringEdit({ prev: "same", oldString: "same", newString: "same" }));
    expect(r.reason).toBe("no_change");
  });

  it("refuses an empty oldString as not_found", () => {
    const r = fail(applyStringEdit({ prev: "abc", oldString: "", newString: "x" }));
    expect(r.reason).toBe("not_found");
  });

  it("not_found takes precedence and never throws on a missing match", () => {
    const r = fail(applyStringEdit({ prev: "", oldString: "anything", newString: "q" }));
    expect(r.reason).toBe("not_found");
  });
});

describe("editFailureMessage", () => {
  it("renders a distinct, actionable message per reason", () => {
    expect(editFailureMessage({ ok: false, reason: "not_found" })).toMatch(/not found/i);
    expect(editFailureMessage({ ok: false, reason: "not_unique", count: 4 })).toMatch(/4 times/);
    expect(editFailureMessage({ ok: false, reason: "no_change" })).toMatch(/not change/i);
  });
});
