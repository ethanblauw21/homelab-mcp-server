import { describe, it, expect } from "vitest";
import {
  sha256Fingerprint,
  normalizeFingerprint,
  decidePin,
  type PinLabels,
} from "./pinnedTrust.js";

const LABELS: PinLabels = { pin: "the configured pin", tofu: "the TOFU store" };

describe("sha256Fingerprint", () => {
  it("produces SHA256:<base64-no-padding>", () => {
    const fp = sha256Fingerprint(Buffer.from("hello"));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith("=")).toBe(false);
  });

  it("is deterministic and content-sensitive", () => {
    expect(sha256Fingerprint(Buffer.from("a"))).toBe(sha256Fingerprint(Buffer.from("a")));
    expect(sha256Fingerprint(Buffer.from("a"))).not.toBe(sha256Fingerprint(Buffer.from("b")));
  });
});

describe("normalizeFingerprint", () => {
  it("accepts a bare base64 digest", () => {
    expect(normalizeFingerprint("abcDEF123")).toBe("SHA256:abcDEF123");
  });
  it("extracts from a SHA256: token and strips padding", () => {
    expect(normalizeFingerprint("SHA256:abcDEF12==")).toBe("SHA256:abcDEF12");
  });
  it("extracts from a full ssh-keygen -lf line", () => {
    expect(normalizeFingerprint("256 SHA256:abcDEF12 root@host (ED25519)")).toBe(
      "SHA256:abcDEF12"
    );
  });
});

describe("decidePin", () => {
  it("accepts a matching pin", () => {
    const d = decidePin({ presented: "SHA256:AAA", pinned: "SHA256:AAA", key: "h:22", labels: LABELS });
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.persist).toBeUndefined();
  });

  it("refuses a pin mismatch fail-closed (no persist)", () => {
    const d = decidePin({ presented: "SHA256:BBB", pinned: "SHA256:AAA", key: "h:22", labels: LABELS });
    expect(d.accept).toBe(false);
    expect(d.reason).toContain("MISMATCH");
    expect(d.reason).toContain("refused");
    expect(d.reason).toContain("the configured pin");
    expect(d.reason).toContain("SHA256:AAA");
    expect(d.reason).toContain("SHA256:BBB");
  });

  it("normalizes the configured pin before comparing", () => {
    const d = decidePin({
      presented: "SHA256:AAA",
      pinned: "256 SHA256:AAA root@host (RSA)",
      key: "h:22",
      labels: LABELS,
    });
    expect(d.accept).toBe(true);
  });

  it("accepts a matching TOFU record when no pin is set", () => {
    const d = decidePin({ presented: "SHA256:AAA", stored: "SHA256:AAA", key: "h:22", labels: LABELS });
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.persist).toBeUndefined();
  });

  it("refuses a TOFU mismatch with the TOFU label", () => {
    const d = decidePin({ presented: "SHA256:BBB", stored: "SHA256:AAA", key: "h:22", labels: LABELS });
    expect(d.accept).toBe(false);
    expect(d.reason).toContain("the TOFU store");
  });

  it("pins on first use and asks to persist when neither pin nor store exists", () => {
    const d = decidePin({ presented: "SHA256:AAA", key: "h:22", labels: LABELS });
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.persist).toEqual({ key: "h:22", fingerprint: "SHA256:AAA" });
  });

  it("prefers the pin over a stored TOFU value", () => {
    const d = decidePin({
      presented: "SHA256:AAA",
      pinned: "SHA256:AAA",
      stored: "SHA256:ZZZ",
      key: "h:22",
      labels: LABELS,
    });
    expect(d.accept).toBe(true);
  });
});
