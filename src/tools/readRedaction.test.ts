import { describe, it, expect } from "vitest";
import { applyReadRedaction } from "./readRedaction.js";

describe("applyReadRedaction (ADR-019)", () => {
  const secretConfig = [
    "[General]",
    "WebUI\\Password_PBKDF2=@ByteArray(deadbeefhash)",
    "DB_PASSWORD=supersecret",
    "TZ=America/New_York",
  ].join("\n");

  it("flag absent ⇒ verbatim, NO extra fields (default-invariance)", () => {
    const r = applyReadRedaction(secretConfig, "utf8", undefined);
    expect(r.content).toBe(secretConfig);
    expect(r).not.toHaveProperty("redacted");
    expect(r).not.toHaveProperty("redactionCount");
  });

  it("flag false ⇒ verbatim, NO extra fields", () => {
    const r = applyReadRedaction(secretConfig, "utf8", false);
    expect(r.content).toBe(secretConfig);
    expect(r.redacted).toBeUndefined();
    expect(r.redactionCount).toBeUndefined();
  });

  it("redact:true + utf8 ⇒ masks secret values, keeps structure, reports count", () => {
    const r = applyReadRedaction(secretConfig, "utf8", true);
    expect(r.redacted).toBe(true);
    expect(r.redactionCount).toBeGreaterThan(0);
    // The secret-bearing keys are masked...
    expect(r.content).toContain("[REDACTED]");
    expect(r.content).not.toContain("supersecret");
    expect(r.content).not.toContain("deadbeefhash");
    // ...but the non-secret structure survives (structure-over-secrets is the point).
    expect(r.content).toContain("TZ=America/New_York");
    expect(r.content).toContain("[General]");
  });

  it("redact:true but base64 ⇒ no-op, says so (redacted:false), no count", () => {
    const blob = Buffer.from(secretConfig, "utf8").toString("base64");
    const r = applyReadRedaction(blob, "base64", true);
    expect(r.content).toBe(blob); // byte-for-byte the blob — never mangled
    expect(r.redacted).toBe(false);
    expect(r.redactionCount).toBeUndefined();
  });

  it("redact:true + utf8 with nothing to redact ⇒ redacted:true, count 0", () => {
    const clean = "key=value\nfoo=bar\n";
    const r = applyReadRedaction(clean, "utf8", true);
    expect(r.redacted).toBe(true);
    expect(r.redactionCount).toBe(0);
    expect(r.content).toBe(clean);
  });

  it("threads extraKeys through to the matcher", () => {
    const text = "CUSTOMFIELD=hunter2";
    const without = applyReadRedaction(text, "utf8", true);
    expect(without.redactionCount).toBe(0);
    const withKey = applyReadRedaction(text, "utf8", true, ["CUSTOMFIELD"]);
    expect(withKey.redactionCount).toBe(1);
    expect(withKey.content).not.toContain("hunter2");
  });
});
