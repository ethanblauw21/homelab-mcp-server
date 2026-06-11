/**
 * Production ApiHttp (ADR-007 §3) — the real network transport for ApiBackend.
 *
 * Node built-in `https` (not undici, which isn't resolvable here) against the PVE
 * API, authenticated with an API token and secured by the shared pinned-TLS agent
 * (`makePinnedHttpsAgent`) — fail-closed cert pinning, never a blind
 * rejectUnauthorized. JSON in, parsed JSON out, with the HTTP status preserved so
 * ApiBackend can map 401/403/5xx structurally. The pure ApiBackend logic is tested
 * against fixtures; this glue is validated against the live node at setup.
 */
import https from "https";
import { URL } from "url";
import type { ApiHttp, ApiResponse } from "./apiBackend.js";
import { buildTokenHeader } from "./apiBackend.js";
import { makePinnedHttpsAgent } from "../trust/tlsPin.js";
import type { Config } from "../config.js";

export function makeApiHttp(api: Config["api"]): ApiHttp {
  if (!api.baseUrl) throw new Error("API backend requires PVE_API_BASE_URL");
  if (!api.tokenId || !api.tokenSecret) {
    throw new Error("API backend requires PVE_API_TOKEN_ID and PVE_API_TOKEN_SECRET");
  }
  const agent = makePinnedHttpsAgent(api);
  const auth = buildTokenHeader(api.tokenId, api.tokenSecret);
  const base = api.baseUrl.replace(/\/$/, "");

  return ({ method, path, body }): Promise<ApiResponse> => {
    return new Promise((resolve, reject) => {
      const url = new URL(base + path);
      const payload = body ? new URLSearchParams(toForm(body)).toString() : undefined;
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 8006,
          path: url.pathname + url.search,
          method,
          agent,
          headers: {
            Authorization: auth,
            Accept: "application/json",
            ...(payload
              ? {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
          timeout: api.requestTimeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = text;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              /* keep raw text for the error mapper */
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error(`API request timed out after ${api.requestTimeoutMs}ms`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}

/** PVE form bodies are application/x-www-form-urlencoded; coerce values to strings. */
function toForm(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) out[k] = String(v);
  return out;
}
