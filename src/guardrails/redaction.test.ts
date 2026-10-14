import { describe, it, expect, afterEach } from "vitest";
import {
  redact,
  redactString,
  redactRecord,
  redactDeep,
  redactToolText,
  redactToolResult,
  redactionMarker,
  setRedactionFingerprintKey,
  containsRedactionMarker,
  introducesRedactionMarker,
  summarizeUnparsable,
  buildKeyNameRegex,
} from "./redaction.js";
import { REDACT_FIXTURES, DIUN_ENV, FAKE_WEBHOOK_TOKEN, FAKE_WEBHOOK_ID, FAKE_DISCORD_WEBHOOK } from "./redactionFixtures.js";

afterEach(() => setRedactionFingerprintKey(null));

describe("fixtures — every rule, both directions", () => {
  for (const f of REDACT_FIXTURES) {
    it(f.name, () => {
      const out = redactString(f.input).value;
      for (const s of f.secrets) expect(out, `leaked ${JSON.stringify(s)}\n${out}`).not.toContain(s);
      for (const k of f.keep) expect(out, `lost ${JSON.stringify(k)}\n${out}`).toContain(k);
      if (f.secrets.length === 0) expect(out).toBe(f.input);
      else expect(out).toMatch(/<redacted len=\d+>/);
    });
  }
});

describe("marker + fingerprint", () => {
  it("replaces only the value and records its length", () => {
    expect(redactString("Password=abc").value).toBe("Password=<redacted len=3>");
    expect(redactString('API_TOKEN="fake two"').value).toBe('API_TOKEN="<redacted len=8>"');
  });

  it("adds a stable HMAC fingerprint once a per-install key is set — never a plain hash", () => {
    setRedactionFingerprintKey(Buffer.from("fake-install-key-0000000000000000"));
    const a = redactionMarker("hunter2");
    expect(a).toMatch(/^<redacted len=7 fp=[0-9a-f]{8}>$/);
    expect(redactionMarker("hunter2")).toBe(a); // stable → a rotation shows as a changed fp
    expect(redactionMarker("hunter3")).not.toBe(a);
    // sha256("hunter2") starts f52fbd32 — the fp must not be the unkeyed digest.
    expect(a).not.toContain("f52fbd32");
    setRedactionFingerprintKey(Buffer.from("another-install-key-000000000000"));
    expect(redactionMarker("hunter2")).not.toBe(a);
  });

  it("is idempotent — a second pass changes nothing", () => {
    for (const f of REDACT_FIXTURES) {
      const once = redactString(f.input).value;
      expect(redactString(once).value).toBe(once);
      expect(redactString(once).redactedCount).toBe(0);
    }
  });

  it("counts distinct secrets", () => {
    const r = redactString("run TOKEN=t1 PASSWORD=p2 ok");
    expect(r.redactedCount).toBe(2);
    expect(r.value).toBe("run TOKEN=<redacted len=2> PASSWORD=<redacted len=2> ok");
  });

  it("a line-leading KEY=value runs to end of line (env_file semantics: no half-leak)", () => {
    expect(redactString("TOKEN=t1 t2 t3").value).toBe("TOKEN=<redacted len=8>");
  });

  it("leaves non-secret assignments alone", () => {
    const s = "VERSION=1.2.3 TIMESTAMP=2024-01-01 cores=2 monkey=1 keyboard=us";
    expect(redactString(s)).toEqual({ value: s, redactedCount: 0 });
  });
});

describe("Diun regression — docker inspect Env", () => {
  it("free-text docker inspect JSON never shows the webhook token or id", () => {
    const raw = JSON.stringify([{ Config: { Env: DIUN_ENV } }], null, 2);
    const out = redactString(raw).value;
    expect(out).not.toContain(FAKE_WEBHOOK_TOKEN);
    expect(out).not.toContain(FAKE_WEBHOOK_ID);
    expect(out).toContain('"DIUN_NOTIF_DISCORD_WEBHOOKURL=');
    expect(() => JSON.parse(out)).not.toThrow(); // structure preserved
  });

  it("a parsed env map (docker_inspect's projection) keeps the name, masks the value", () => {
    const env = Object.fromEntries(DIUN_ENV.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    const r = redactRecord(env);
    expect(r.value.DIUN_NOTIF_DISCORD_WEBHOOKURL).toBe(`<redacted len=${FAKE_DISCORD_WEBHOOK.length}>`);
    expect(r.value.TZ).toBe("America/Chicago");
    expect(r.redactedCount).toBe(1);
  });
});

describe("redactRecord / redactDeep", () => {
  it("masks secret-named keys and shape-scans the rest", () => {
    const r = redactRecord({ cores: "2", net0: "name=eth0,bridge=vmbr0", password: "hunter2", description: "see ghp_FAKEfake0123456789FAKEfake0123456789" });
    expect(r.value).toMatchObject({ cores: "2", net0: "name=eth0,bridge=vmbr0", password: "<redacted len=7>" });
    expect(r.value.description).toBe("see ghp_<redacted len=36>");
    expect(r.redactedCount).toBe(2);
  });

  it("deep-walks tool results: keyed scalars, nested strings; structural `key` and booleans kept", () => {
    const r = redactDeep({
      key: "pct config 101",
      passed: true,
      env: { WEBHOOK_URL: "https://x.test/a", DB_PASSWORD: "fake-pw" },
      lines: ["ok", "Authorization: Bearer fakeBearerToken0001"],
      pin_secret: 1234,
    });
    expect(r.value).toEqual({
      key: "pct config 101",
      passed: true,
      env: { WEBHOOK_URL: "<redacted len=16>", DB_PASSWORD: "<redacted len=7>" },
      lines: ["ok", "Authorization: Bearer <redacted len=19>"],
      pin_secret: "<redacted len=4>",
    });
  });

  it("dispatches on type", () => {
    expect(redact("PASSWORD=x").value).toBe("PASSWORD=<redacted len=1>");
    expect((redact({ token: "abc" }).value as Record<string, string>).token).toBe("<redacted len=3>");
  });
});

describe("redactToolText / redactToolResult (the MCP boundary)", () => {
  it("compact JSON is deep-redacted and stays valid JSON", () => {
    const text = JSON.stringify({ env: Object.fromEntries([["DIUN_NOTIF_DISCORD_WEBHOOKURL", FAKE_DISCORD_WEBHOOK]]) });
    const out = redactToolText(text);
    expect(out).not.toContain(FAKE_WEBHOOK_TOKEN);
    expect(JSON.parse(out).env.DIUN_NOTIF_DISCORD_WEBHOOKURL).toMatch(/^<redacted len=\d+>$/);
  });

  it("raw text (file content) keeps its layout", () => {
    const file = '{\n  "password": "fake-pw",\n  "port": 8080\n}\n';
    expect(redactToolText(file)).toBe('{\n  "password": "<redacted len=7>",\n  "port": 8080\n}\n');
  });

  it("redacts every text block, error results included", () => {
    const res = redactToolResult({ isError: true, content: [{ type: "text", text: `failed: ${FAKE_DISCORD_WEBHOOK}` }] });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).not.toContain(FAKE_WEBHOOK_TOKEN);
  });
});

describe("write guard", () => {
  it("refuses content that adds markers; allows reverts / edits that do not", () => {
    expect(introducesRedactionMarker("TOKEN=real", "TOKEN=<redacted len=4>")).toBe(true);
    expect(introducesRedactionMarker(null, "x <redacted len=4 fp=0123abcd>")).toBe(true);
    expect(introducesRedactionMarker("a <redacted len=4> b", "a <redacted len=4> c")).toBe(false);
    expect(introducesRedactionMarker("TOKEN=real", "TOKEN=real\nPORT=1")).toBe(false);
    expect(containsRedactionMarker("[REDACTED]")).toBe(true);
  });
});

describe("summarizeUnparsable — fail closed", () => {
  it("summarizes instead of passing raw content through", () => {
    const r = summarizeUnparsable("garbage line\nOPENVPN_PASSWORD=leak\nAPI_TOKEN=abc123");
    expect(r.value).toBe("[unparsed: 3 lines, 2 redactions by pattern scan]");
    expect(r.redactedCount).toBe(2);
  });
  it("handles empty input", () => {
    expect(summarizeUnparsable("").value).toBe("[unparsed: 0 lines, 0 redactions by pattern scan]");
  });
});

describe("buildKeyNameRegex", () => {
  it("matches the ADR-026 key list", () => {
    const re = buildKeyNameRegex();
    for (const k of [
      "DIUN_NOTIF_DISCORD_WEBHOOKURL", "token", "SECRET", "pass", "password", "passwd", "API_KEY", "apikey",
      "ENCRYPTION_KEY", "KEY", "app.key", "auth", "cookie", "credential", "private", "session", "signature",
      "salt", "dsn", "connection_string", "CONNSTRING", "psk", "wireguard_private_key",
    ]) expect(re.test(k), k).toBe(true);
  });
  it("does not match ordinary keys", () => {
    const re = buildKeyNameRegex();
    for (const k of ["cores", "memory", "ostype", "bridge", "hostname", "monkey", "keyboard", "TZ", "PUID"]) {
      expect(re.test(k), k).toBe(false);
    }
  });
  it("extra keys extend, never disable", () => {
    const re = buildKeyNameRegex(["vpn_user"]);
    expect(re.test("VPN_USER")).toBe(true);
    expect(re.test("password")).toBe(true);
  });
});
