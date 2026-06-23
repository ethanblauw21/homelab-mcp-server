/**
 * Reachability probes (ADR-020 §2) — `tcp_ping` / `http_probe`. The structured
 * *outcome* check that pairs with every lifecycle/deploy verb: after a
 * `compose_redeploy`/`guest_restart`, "did it come back?" today means hand-writing
 * `curl -sS -o /dev/null -w '%{http_code}'` or `nc -z` through `*_exec`. These
 * give a parse-free `{reachable}` / `{status, ok}` instead.
 *
 * **Tier.** Both default to a **host-side** probe (Node `net`/`http`, zero
 * credentials, no node round-trip) ⇒ observe floor. `http_probe`'s `fromVmid`
 * runs the probe *inside* an LXC via `pct exec` so it can reach container-network
 * services — that needs the companion-tier SSH plumbing and is asserted at runtime.
 *
 * **Honest limits.** (1) A host-side probe and an in-guest probe see different
 * network namespaces — the result's `from` says which ran. (2) The HTTP probe is a
 * reachability/status check, **not a TLS-trust check**: it does not verify the
 * server certificate (homelab services routinely use self-signed certs), so `ok`
 * means "answered as expected," never "trusted." Read-only, not audited.
 */
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import type { SshTransport } from "../ssh/transport.js";
import type { Config } from "../config.js";
import { shSingleQuote } from "../ssh/command.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { tierAtLeast, type Tier } from "../tiers/registry.js";

// ---------------------------------------------------------------------------
// Pure helpers (no I/O) — validation, command building, output shaping.
// ---------------------------------------------------------------------------

/** Hostname / IPv4 / IPv6 charset. No spaces, no shell metacharacters. */
const HOST_RE = /^[A-Za-z0-9._:\-[\]]{1,255}$/;

export function validateProbeHost(host: string): boolean {
  return HOST_RE.test(host);
}

export interface ParsedProbeUrl {
  ok: boolean;
  error?: string;
}

/** A probe URL must be a well-formed http(s) URL — nothing else reaches curl. */
export function parseProbeUrl(url: string): ParsedProbeUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `not a valid URL: ${JSON.stringify(url)}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `unsupported protocol ${u.protocol} (http/https only)` };
  }
  return { ok: true };
}

/** Clamp a requested timeout into [1, max] ms, falling back to the default. */
export function resolveTimeoutMs(requested: number | undefined, cfg: Config): number {
  const def = cfg.tools.probeDefaultTimeoutMs;
  const max = cfg.tools.probeMaxTimeoutMs;
  if (requested === undefined) return def;
  return Math.max(1, Math.min(requested, max));
}

/**
 * `curl` invocation for the in-guest HTTP probe. `-k` (insecure) mirrors the
 * host-side `rejectUnauthorized:false` — this is a reachability check, not a TLS
 * trust check. `-w` emits a single parse-friendly line; the URL is single-quoted.
 */
export function buildCurlProbeCommand(url: string, timeoutSecs: number): string {
  return (
    `curl -k -s -S -o /dev/null ` +
    `-w '%{http_code} %{size_download} %{time_total}' ` +
    `--max-time ${timeoutSecs} -- ${shSingleQuote(url)}`
  );
}

export interface CurlProbeOutput {
  status: number;
  bodyBytes: number;
  latencyMs: number;
}

/** Parse the `%{http_code} %{size_download} %{time_total}` line curl emits. */
export function parseCurlProbeOutput(stdout: string): CurlProbeOutput {
  const parts = stdout.trim().split(/\s+/);
  const status = parseInt(parts[0] ?? "", 10);
  const bodyBytes = parseInt(parts[1] ?? "", 10);
  const timeTotal = parseFloat(parts[2] ?? "");
  return {
    status: Number.isFinite(status) ? status : 0,
    bodyBytes: Number.isFinite(bodyBytes) ? bodyBytes : 0,
    latencyMs: Number.isFinite(timeTotal) ? Math.round(timeTotal * 1000) : 0,
  };
}

/** `ok` = matches `expectStatus` when given, else any 2xx/3xx. */
export function evaluateHttpOk(status: number, expectStatus?: number): boolean {
  if (expectStatus !== undefined) return status === expectStatus;
  return status >= 200 && status < 400;
}

// ---------------------------------------------------------------------------
// tcp_ping
// ---------------------------------------------------------------------------

export const TcpPingInputSchema = z.object({
  host: z.string().min(1).describe("hostname or IP to connect to (charset-validated)"),
  port: z.number().int().min(1).max(65535).describe("TCP port"),
  timeoutMs: z.number().int().positive().optional().describe("connect timeout (clamped to the cap)"),
});

export type TcpPingInput = z.infer<typeof TcpPingInputSchema>;

export interface TcpPingResult {
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number;
  from: "host";
}

/**
 * `tcp_ping` — a single TCP connect from the Windows host, no payload sent. Zero
 * credentials, no node round-trip; observe floor.
 */
export async function tcpPingHandler(input: TcpPingInput, cfg: Config): Promise<TcpPingResult> {
  if (!validateProbeHost(input.host)) {
    throw new Error(`Invalid host: ${JSON.stringify(input.host)}`);
  }
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, cfg);
  const { reachable, latencyMs } = await tcpConnect(input.host, input.port, timeoutMs);
  return { host: input.host, port: input.port, reachable, latencyMs, from: "host" };
}

function tcpConnect(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ reachable: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - start });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// http_probe
// ---------------------------------------------------------------------------

export const HttpProbeInputSchema = z.object({
  url: z.string().min(1).describe("http(s) URL to probe"),
  expectStatus: z
    .number()
    .int()
    .optional()
    .describe("makes it an assertion: ok=false unless the status matches; default any 2xx/3xx"),
  timeoutMs: z.number().int().positive().optional().describe("request timeout (clamped to the cap)"),
  fromVmid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("run the probe INSIDE this LXC via pct exec curl (companion tier); omit to probe from the host"),
});

export type HttpProbeInput = z.infer<typeof HttpProbeInputSchema>;

export interface HttpProbeResult {
  url: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  bodyBytes: number;
  from: string; // "host" | "vmid:<n>"
}

/**
 * `http_probe` — one HTTP request, structured `{status, ok, latencyMs, bodyBytes}`.
 * Host-side by default (Node http/https, observe); `fromVmid` shells `curl` inside
 * the LXC (companion, asserted at runtime).
 */
export async function httpProbeHandler(
  input: HttpProbeInput,
  transport: SshTransport,
  cfg: Config,
  tier: Tier
): Promise<HttpProbeResult> {
  const parsed = parseProbeUrl(input.url);
  if (!parsed.ok) throw new Error(`http_probe: ${parsed.error}`);
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, cfg);

  if (input.fromVmid !== undefined) {
    if (!tierAtLeast(tier, "companion")) {
      throw new Error(
        `http_probe fromVmid runs inside a guest via pct exec and requires the 'companion' tier, ` +
          `but the server is running at '${tier}'. Omit fromVmid to probe from the host (observe).`
      );
    }
    const inner = buildCurlProbeCommand(input.url, Math.ceil(timeoutMs / 1000));
    const r = await transport.exec(buildPctExecCommand(input.fromVmid, inner), cfg.ssh.commandTimeoutMs);
    if (r.exitCode !== 0) {
      throw new Error(
        `http_probe (CT${input.fromVmid}) failed (exit ${r.exitCode}): ${r.stderr.trim() || "no output"}`
      );
    }
    const out = parseCurlProbeOutput(r.stdout);
    return {
      url: input.url,
      status: out.status,
      ok: evaluateHttpOk(out.status, input.expectStatus),
      latencyMs: out.latencyMs,
      bodyBytes: out.bodyBytes,
      from: `vmid:${input.fromVmid}`,
    };
  }

  const out = await httpRequest(input.url, timeoutMs);
  return {
    url: input.url,
    status: out.status,
    ok: evaluateHttpOk(out.status, input.expectStatus),
    latencyMs: out.latencyMs,
    bodyBytes: out.bodyBytes,
    from: "host",
  };
}

function httpRequest(url: string, timeoutMs: number): Promise<CurlProbeOutput> {
  // Always resolves — a connection-class failure becomes a status-0 result rather
  // than a rejection (ADR-023 §2), so there is no reject path.
  return new Promise((resolve) => {
    const start = Date.now();
    const isHttps = url.startsWith("https:");
    const lib = isHttps ? https : http;
    // Reachability/status check, not a TLS-trust check: do not verify the cert
    // (homelab services routinely use self-signed certs). Documented honest limit.
    const opts = isHttps ? { rejectUnauthorized: false } : {};
    const req = lib.get(url, opts, (res) => {
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          bodyBytes: bytes,
          latencyMs: Date.now() - start,
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    // ADR-023 §2 — http_probe is a reachability/status check. A connection-class
    // failure (refused/unresolved/timed-out/host-unreachable) is an honest "no",
    // not an exception: resolve to status 0 / ok=false exactly like tcp_ping does
    // for a closed port, instead of throwing. Throwing here previously escaped the
    // handler and got decorated by the SSH-transport error mapper into a bogus
    // "SSH connection refused … npm run doctor" message — this probe never touches
    // SSH. Resolving keeps the failure off that path entirely.
    req.on("error", () => {
      resolve({ status: 0, bodyBytes: 0, latencyMs: Date.now() - start });
    });
  });
}
