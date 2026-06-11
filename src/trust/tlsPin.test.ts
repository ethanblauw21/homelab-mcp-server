import { describe, it, expect } from "vitest";
import { certFingerprint, decideTlsPin, apiTrustKey } from "./tlsPin.js";

describe("certFingerprint", () => {
  it("produces a SHA256: fingerprint over the DER bytes", () => {
    const fp = certFingerprint(Buffer.from("der-bytes"));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });
  it("changes when the cert bytes change", () => {
    expect(certFingerprint(Buffer.from("certA"))).not.toBe(certFingerprint(Buffer.from("certB")));
  });
});

describe("decideTlsPin", () => {
  it("accepts a matching pin", () => {
    const d = decideTlsPin({ presented: "SHA256:AAA", pinned: "SHA256:AAA", key: "pve:8006" });
    expect(d.accept).toBe(true);
  });
  it("refuses a mismatch with the API TLS label, fail-closed", () => {
    const d = decideTlsPin({ presented: "SHA256:BBB", pinned: "SHA256:AAA", key: "pve:8006" });
    expect(d.accept).toBe(false);
    expect(d.reason).toContain("the configured API TLS pin");
    expect(d.reason).toContain("refused");
  });
  it("trusts on first use and asks to persist when unpinned/unstored", () => {
    const d = decideTlsPin({ presented: "SHA256:AAA", key: "pve:8006" });
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.persist).toEqual({ key: "pve:8006", fingerprint: "SHA256:AAA" });
  });
});

describe("apiTrustKey", () => {
  it("derives host:port from a base URL", () => {
    expect(apiTrustKey("https://pve.lan:8006/api2/json")).toBe("pve.lan:8006");
  });
  it("falls back to a stable label when the URL is absent", () => {
    expect(apiTrustKey(undefined)).toBe("pve-api");
  });
  it("returns the raw string when it is not a parseable URL", () => {
    expect(apiTrustKey("not a url")).toBe("not a url");
  });
});
