import { describe, it, expect } from "vitest";
import {
  shSingleQuote,
  buildTimeoutWrapper,
  timeoutMsToSecs,
  TIMEOUT_EXIT_CODE,
} from "./command.js";

describe("shSingleQuote", () => {
  it("wraps a simple string in single quotes", () => {
    expect(shSingleQuote("echo hi")).toBe("'echo hi'");
  });

  it("escapes embedded single quotes via the '\\'' idiom", () => {
    expect(shSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(shSingleQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("leaves double quotes and other metacharacters untouched (single-quote context)", () => {
    expect(shSingleQuote('echo "x" ; rm $y')).toBe("'echo \"x\" ; rm $y'");
  });
});

describe("buildTimeoutWrapper", () => {
  it("defaults to bash with a 5s kill-after grace", () => {
    expect(buildTimeoutWrapper("echo hi", 30)).toBe(
      "timeout --signal=TERM --kill-after=5 30 bash -c 'echo hi'"
    );
  });

  it("honors the sh shell override for minimal guests", () => {
    expect(buildTimeoutWrapper("echo hi", 10, { shell: "sh" })).toBe(
      "timeout --signal=TERM --kill-after=5 10 sh -c 'echo hi'"
    );
  });

  it("honors a custom kill-after grace", () => {
    expect(buildTimeoutWrapper("echo hi", 10, { killAfterSecs: 2 })).toBe(
      "timeout --signal=TERM --kill-after=2 10 bash -c 'echo hi'"
    );
  });

  it("escapes single quotes in the wrapped command", () => {
    expect(buildTimeoutWrapper("echo 'hi'", 5)).toBe(
      "timeout --signal=TERM --kill-after=5 5 bash -c 'echo '\\''hi'\\'''"
    );
  });
});

describe("timeoutMsToSecs", () => {
  it("rounds up to whole seconds", () => {
    expect(timeoutMsToSecs(1500)).toBe(2);
    expect(timeoutMsToSecs(30_000)).toBe(30);
  });

  it("never returns less than 1", () => {
    expect(timeoutMsToSecs(0)).toBe(1);
    expect(timeoutMsToSecs(10)).toBe(1);
  });
});

describe("TIMEOUT_EXIT_CODE", () => {
  it("is the coreutils timeout expiry status", () => {
    expect(TIMEOUT_EXIT_CODE).toBe(124);
  });
});
