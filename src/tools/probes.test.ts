import { describe, it, expect } from "vitest";
import {
  validateProbeHost,
  parseProbeUrl,
  resolveTimeoutMs,
  buildCurlProbeCommand,
  parseCurlProbeOutput,
  evaluateHttpOk,
} from "./probes.js";
import type { Config } from "../config.js";

const cfg = {
  tools: { probeDefaultTimeoutMs: 5000, probeMaxTimeoutMs: 30000 },
} as unknown as Config;

describe("validateProbeHost", () => {
  it("accepts hostnames, IPv4, and bracketed IPv6", () => {
    expect(validateProbeHost("proxlab")).toBe(true);
    expect(validateProbeHost("10.0.0.10")).toBe(true);
    expect(validateProbeHost("svc.lan")).toBe(true);
    expect(validateProbeHost("[::1]")).toBe(true);
  });

  it("rejects spaces and shell metacharacters", () => {
    expect(validateProbeHost("a b")).toBe(false);
    expect(validateProbeHost("host;reboot")).toBe(false);
    expect(validateProbeHost("$(id)")).toBe(false);
    expect(validateProbeHost("")).toBe(false);
  });
});

describe("parseProbeUrl", () => {
  it("accepts http and https", () => {
    expect(parseProbeUrl("http://x/y")).toEqual({ ok: true });
    expect(parseProbeUrl("https://x:8443/health")).toEqual({ ok: true });
  });

  it("rejects non-http(s) and malformed URLs", () => {
    expect(parseProbeUrl("ftp://x").ok).toBe(false);
    expect(parseProbeUrl("file:///etc/passwd").ok).toBe(false);
    expect(parseProbeUrl("not a url").ok).toBe(false);
  });
});

describe("resolveTimeoutMs", () => {
  it("defaults when omitted and clamps to the cap", () => {
    expect(resolveTimeoutMs(undefined, cfg)).toBe(5000);
    expect(resolveTimeoutMs(1000, cfg)).toBe(1000);
    expect(resolveTimeoutMs(999999, cfg)).toBe(30000);
    expect(resolveTimeoutMs(0, cfg)).toBe(1);
  });
});

describe("buildCurlProbeCommand", () => {
  it("builds an insecure, body-discarding curl with a single-quoted URL", () => {
    const c = buildCurlProbeCommand("http://10.0.0.5:8080/", 5);
    expect(c).toContain("curl -k -s -S -o /dev/null");
    expect(c).toContain("--max-time 5");
    expect(c).toContain("'http://10.0.0.5:8080/'");
    expect(c).toContain("%{http_code} %{size_download} %{time_total}");
  });

  it("escapes a URL single quote so it cannot break out of the quoting", () => {
    const c = buildCurlProbeCommand("http://x/'; reboot", 5);
    // shSingleQuote neutralizes the embedded quote via the '\'' idiom; the whole
    // URL stays one single-quoted token (ends with the closing quote).
    expect(c).toContain(`'\\''`);
    expect(c.endsWith("'")).toBe(true);
  });
});

describe("parseCurlProbeOutput", () => {
  it("parses status, bytes, and seconds→ms", () => {
    expect(parseCurlProbeOutput("200 1234 0.045")).toEqual({
      status: 200,
      bodyBytes: 1234,
      latencyMs: 45,
    });
  });

  it("degrades a connection-failure (all zeros) cleanly", () => {
    expect(parseCurlProbeOutput("000 0 0.000")).toEqual({
      status: 0,
      bodyBytes: 0,
      latencyMs: 0,
    });
  });

  it("tolerates garbage", () => {
    expect(parseCurlProbeOutput("")).toEqual({ status: 0, bodyBytes: 0, latencyMs: 0 });
  });
});

describe("evaluateHttpOk", () => {
  it("treats 2xx/3xx as ok without an expectation", () => {
    expect(evaluateHttpOk(200)).toBe(true);
    expect(evaluateHttpOk(301)).toBe(true);
    expect(evaluateHttpOk(404)).toBe(false);
    expect(evaluateHttpOk(500)).toBe(false);
  });

  it("becomes an exact assertion with expectStatus", () => {
    expect(evaluateHttpOk(204, 204)).toBe(true);
    expect(evaluateHttpOk(200, 204)).toBe(false);
    expect(evaluateHttpOk(404, 404)).toBe(true);
  });
});
