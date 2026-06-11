import { describe, it, expect } from "vitest";
import { parseRootFlag, resolveTier, rootBanner, ROOT_ACK_STRING } from "./rootFlag.js";

describe("parseRootFlag — exact acknowledgment string only", () => {
  it("enables on the exact string", () => {
    expect(parseRootFlag(ROOT_ACK_STRING)).toBe(true);
  });

  it("rejects true, casing variants, whitespace, and empties", () => {
    expect(parseRootFlag("true")).toBe(false);
    expect(parseRootFlag("1")).toBe(false);
    expect(parseRootFlag(ROOT_ACK_STRING.toLowerCase())).toBe(false);
    expect(parseRootFlag(ROOT_ACK_STRING.toUpperCase())).toBe(false);
    expect(parseRootFlag(` ${ROOT_ACK_STRING}`)).toBe(false);
    expect(parseRootFlag(`${ROOT_ACK_STRING} `)).toBe(false);
    expect(parseRootFlag("")).toBe(false);
    expect(parseRootFlag(undefined)).toBe(false);
    expect(parseRootFlag(null)).toBe(false);
  });
});

describe("resolveTier", () => {
  it("returns the configured level when the flag is off", () => {
    expect(resolveTier("observe", false)).toBe("observe");
    expect(resolveTier("operate", false)).toBe("operate");
    expect(resolveTier("companion", false)).toBe("companion");
  });

  it("elevates to root when the flag is on", () => {
    expect(resolveTier("companion", true)).toBe("root");
  });
});

describe("rootBanner", () => {
  it("warns about root capability and the no-runtime-de-escalation rule", () => {
    const b = rootBanner();
    expect(b).toMatch(/ROOT TIER ENABLED/);
    expect(b).toMatch(/rootTier/);
    expect(b).toMatch(/protected set/i);
  });
});
