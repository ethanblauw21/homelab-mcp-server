import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  computeFingerprint,
  normalizeFingerprint,
  decideHostKey,
  KnownHostsStore,
} from "./hostKey.js";

describe("computeFingerprint", () => {
  it("produces a stable SHA256:base64 fingerprint without padding", () => {
    const fp = computeFingerprint(Buffer.from("some-host-key-bytes"));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith("=")).toBe(false);
    // deterministic
    expect(computeFingerprint(Buffer.from("some-host-key-bytes"))).toBe(fp);
  });
});

describe("normalizeFingerprint", () => {
  it("passes through a canonical SHA256 token", () => {
    expect(normalizeFingerprint("SHA256:abcDEF123")).toBe("SHA256:abcDEF123");
  });
  it("extracts from a full ssh-keygen -lf line", () => {
    expect(normalizeFingerprint("256 SHA256:abcDEF123 root@pve (ED25519)")).toBe("SHA256:abcDEF123");
  });
  it("prefixes a bare base64 digest and strips padding", () => {
    expect(normalizeFingerprint("abcDEF123==")).toBe("SHA256:abcDEF123");
  });
});

describe("decideHostKey", () => {
  const presented = "SHA256:PRESENTED";
  const hostPort = "10.0.0.10:22";

  it("accepts a matching pin", () => {
    const d = decideHostKey({ presented, pinned: "SHA256:PRESENTED", hostPort });
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.persist).toBeUndefined();
  });

  it("accepts a matching pin given in ssh-keygen line form", () => {
    const d = decideHostKey({ presented, pinned: "256 SHA256:PRESENTED root@pve (ED25519)", hostPort });
    expect(d.accept).toBe(true);
  });

  it("rejects a pin mismatch (fail closed) and names both fingerprints", () => {
    const d = decideHostKey({ presented, pinned: "SHA256:OTHER", hostPort });
    expect(d.accept).toBe(false);
    if (!d.accept) {
      expect(d.reason).toContain("SHA256:OTHER");
      expect(d.reason).toContain("SHA256:PRESENTED");
      expect(d.reason).toContain("refused");
    }
  });

  it("pin takes priority over a stored TOFU entry", () => {
    const d = decideHostKey({ presented, pinned: "SHA256:OTHER", stored: "SHA256:PRESENTED", hostPort });
    expect(d.accept).toBe(false); // pin wins, and it mismatches
  });

  it("accepts a matching stored TOFU fingerprint", () => {
    const d = decideHostKey({ presented, stored: "SHA256:PRESENTED", hostPort });
    expect(d.accept).toBe(true);
    if (d.accept) expect(d.persist).toBeUndefined();
  });

  it("rejects a stored TOFU mismatch (fail closed)", () => {
    const d = decideHostKey({ presented, stored: "SHA256:WAS_TRUSTED", hostPort });
    expect(d.accept).toBe(false);
    if (!d.accept) expect(d.reason).toContain("TOFU");
  });

  it("trusts on first use (no pin, no stored) and asks to persist", () => {
    const d = decideHostKey({ presented, hostPort });
    expect(d.accept).toBe(true);
    if (d.accept) {
      expect(d.persist).toEqual({ hostPort, fingerprint: presented });
      expect(d.reason).toContain("first use");
    }
  });
});

describe("KnownHostsStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "knownhosts-"));
    file = path.join(dir, "known_hosts.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns undefined for an unknown host and round-trips a set value", () => {
    const store = new KnownHostsStore(file);
    expect(store.get("10.0.0.10:22")).toBeUndefined();
    store.set("10.0.0.10:22", "SHA256:ABC");
    expect(new KnownHostsStore(file).get("10.0.0.10:22")).toBe("SHA256:ABC");
  });

  it("preserves other entries when adding one", () => {
    const store = new KnownHostsStore(file);
    store.set("a:22", "SHA256:A");
    store.set("b:22", "SHA256:B");
    expect(store.get("a:22")).toBe("SHA256:A");
    expect(store.get("b:22")).toBe("SHA256:B");
  });

  it("no-ops safely when no path is configured", () => {
    const store = new KnownHostsStore(undefined);
    expect(store.get("a:22")).toBeUndefined();
    expect(() => store.set("a:22", "SHA256:A")).not.toThrow();
  });
});
