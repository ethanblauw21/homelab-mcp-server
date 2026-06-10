import { describe, it, expect } from "vitest";
import {
  redact,
  redactString,
  redactRecord,
  summarizeUnparsable,
  buildKeyNameRegex,
} from "./redaction.js";

// A WireGuard-shaped key: 43 base64 chars + '=' (32 bytes).
const WG_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq=";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redactString — value patterns", () => {
  it("redacts a PEM private-key block to a single token", () => {
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkBASE64\n-----END OPENSSH PRIVATE KEY-----";
    const r = redactString(key);
    expect(r.value).toBe("[REDACTED]");
    expect(r.redactedCount).toBe(1);
  });

  it("redacts a JWT", () => {
    const r = redactString(`token is ${JWT} ok`);
    expect(r.value).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(r.value).toContain("[REDACTED]");
    expect(r.redactedCount).toBe(1);
  });

  it("does NOT redact a bare 44-char base64 key with no secret key-name", () => {
    // Tailscale/WireGuard public keys, base64 SHA-256 digests, and cert
    // fragments share this shape and are useful census content. Only the
    // key-name / env-style layers redact base64 — never a blanket value scan.
    const r = redactString(`peer pubkey ${WG_KEY} active`);
    expect(r.value).toContain(WG_KEY);
    expect(r.redactedCount).toBe(0);
  });

  it("redacts credentials embedded in a URL but keeps scheme/user/host", () => {
    const r = redactString("postgres://admin:s3cr3tpw@db.local:5432/app");
    expect(r.value).not.toContain("s3cr3tpw");
    expect(r.value).toContain("postgres://admin:[REDACTED]@db.local");
    expect(r.redactedCount).toBe(1);
  });

  it("redacts an Authorization header value", () => {
    const r = redactString("Authorization: Bearer abc.def.ghi");
    expect(r.value).toBe("Authorization: [REDACTED]");
    expect(r.redactedCount).toBe(1);
  });
});

describe("redactString — env-style assignments", () => {
  it("redacts a Gluetun-style env block (password + wireguard key only)", () => {
    const env = [
      "OPENVPN_USER=myuser",
      "OPENVPN_PASSWORD=supersecretvpn",
      `WIREGUARD_PRIVATE_KEY=${WG_KEY}`,
      "SERVER_COUNTRIES=Switzerland",
      "TZ=America/Chicago",
    ].join("\n");
    const r = redactString(env);

    expect(r.value).not.toContain("supersecretvpn");
    expect(r.value).not.toContain(WG_KEY);
    // Non-secret values are preserved.
    expect(r.value).toContain("OPENVPN_USER=myuser");
    expect(r.value).toContain("SERVER_COUNTRIES=Switzerland");
    expect(r.value).toContain("TZ=America/Chicago");
    expect(r.redactedCount).toBe(2);
  });

  it("is case-insensitive on the key name", () => {
    expect(redactString("Password=abc").value).toBe("Password=[REDACTED]");
    expect(redactString("APITOKEN=abc").value).toContain("[REDACTED]");
  });

  it("does not redact non-secret assignments", () => {
    const s = "VERSION=1.2.3 TIMESTAMP=2024-01-01 cores=2";
    expect(redactString(s).value).toBe(s);
    expect(redactString(s).redactedCount).toBe(0);
  });

  it("counts multiple distinct secrets accurately", () => {
    const r = redactString("TOKEN=t1 PASSWORD=p2 ok");
    expect(r.redactedCount).toBe(2);
    expect(r.value).not.toContain("t1");
    expect(r.value).not.toContain("p2");
  });
});

describe("redactRecord — parsed config maps", () => {
  it("redacts secret-named keys with a labeled token and scans the rest", () => {
    const r = redactRecord({
      cores: "2",
      memory: "1024",
      net0: "name=eth0,bridge=vmbr0",
      WIREGUARD_PRIVATE_KEY: WG_KEY,
      password: "hunter2",
    });

    expect(r.value.cores).toBe("2");
    expect(r.value.memory).toBe("1024");
    expect(r.value.net0).toBe("name=eth0,bridge=vmbr0");
    expect(r.value.WIREGUARD_PRIVATE_KEY).toBe("[REDACTED:WIREGUARD_PRIVATE_KEY]");
    expect(r.value.password).toBe("[REDACTED:password]");
    expect(r.redactedCount).toBe(2);
  });

  it("redacts value-pattern secrets even under a non-secret key", () => {
    const r = redactRecord({ description: `deploy with ${JWT}` });
    expect(r.value.description).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(r.redactedCount).toBe(1);
  });

  it("returns zero redactions for an all-clean record", () => {
    const r = redactRecord({ cores: "4", ostype: "debian", arch: "amd64" });
    expect(r.redactedCount).toBe(0);
  });
});

describe("redact — dispatch", () => {
  it("dispatches string input to redactString", () => {
    expect(redact("PASSWORD=x").value).toBe("PASSWORD=[REDACTED]");
  });
  it("dispatches record input to redactRecord", () => {
    const v = redact({ token: "abc" }).value as Record<string, string>;
    expect(v.token).toBe("[REDACTED:token]");
  });
});

describe("summarizeUnparsable — fail closed", () => {
  it("returns a summary instead of raw content and counts pattern hits", () => {
    const blob = "garbage line\nOPENVPN_PASSWORD=leak\nAPI_TOKEN=abc123";
    const r = summarizeUnparsable(blob);
    expect(r.value).toBe("[unparsed: 3 lines, 2 redactions by pattern scan]");
    expect(r.value).not.toContain("leak");
    expect(r.value).not.toContain("abc123");
    expect(r.redactedCount).toBe(2);
  });

  it("handles empty input", () => {
    expect(summarizeUnparsable("").value).toBe("[unparsed: 0 lines, 0 redactions by pattern scan]");
  });
});

describe("buildKeyNameRegex — extensibility", () => {
  it("matches built-in secret tokens", () => {
    const re = buildKeyNameRegex();
    for (const k of ["password", "API_KEY", "wireguard_private_key", "psk", "auth"]) {
      expect(re.test(k)).toBe(true);
    }
  });

  it("does not match ordinary config keys", () => {
    const re = buildKeyNameRegex();
    for (const k of ["cores", "memory", "ostype", "bridge", "hostname"]) {
      expect(re.test(k)).toBe(false);
    }
  });

  it("honors extra keys (REDACTION_EXTRA_KEYS) but cannot disable built-ins", () => {
    const re = buildKeyNameRegex(["vpn_user"]);
    expect(re.test("VPN_USER")).toBe(true);
    expect(re.test("password")).toBe(true); // built-in still on
  });
});
