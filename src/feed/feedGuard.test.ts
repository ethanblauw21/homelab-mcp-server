import { describe, it, expect } from "vitest";
import { checkFeedTarget, assertFeedTarget } from "./feedGuard.js";

describe("checkFeedTarget (ADR-022 §3 loopback tripwire)", () => {
  it("accepts loopback hosts over http/https", () => {
    for (const ep of [
      "http://127.0.0.1:9000/ingest",
      "https://localhost:443/feed",
      "http://[::1]:8080/",
      "http://127.5.5.5/x",
    ]) {
      expect(checkFeedTarget(ep).ok).toBe(true);
    }
  });

  it("refuses a non-loopback host", () => {
    const r = checkFeedTarget("http://10.0.0.10:9000/ingest");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-loopback/);
  });

  it("refuses a non-http(s) scheme", () => {
    expect(checkFeedTarget("ftp://127.0.0.1/x").ok).toBe(false);
    expect(checkFeedTarget("file:///etc/passwd").ok).toBe(false);
  });

  it("refuses an unparseable URL", () => {
    expect(checkFeedTarget("not a url").ok).toBe(false);
    expect(checkFeedTarget("").ok).toBe(false);
  });

  it("assertFeedTarget throws on a bad target and is silent on a good one", () => {
    expect(() => assertFeedTarget("http://example.com/")).toThrow(/non-loopback/);
    expect(() => assertFeedTarget("http://127.0.0.1:9000/")).not.toThrow();
  });
});
