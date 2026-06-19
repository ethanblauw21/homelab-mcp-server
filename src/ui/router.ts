import type { ArtifactReader } from "./artifacts.js";
import type { UiExecutor } from "./executor.js";
import { INDEX_HTML } from "./page.js";
import type { Tier } from "../tiers/registry.js";

/**
 * ADR-010 §4/§6 — the request router. Deliberately boring: a flat dispatch over a
 * handful of GET /api/* renderer reads and POST /action/<tool> executor calls. It
 * holds NO node credentials itself — every read goes through the credential-free
 * `ArtifactReader`, every action through the tier-bound `UiExecutor`.
 *
 * Pure-ish by design: it takes the already-parsed (method, path, query, body) and
 * returns a plain `{ status, contentType, body }`, so it is trivially unit-testable
 * without a live socket. `server.ts` is the thin `http` shell that feeds it.
 *
 * The two error contracts the UI relies on:
 *   - POST /action/* in strict renderer-only mode → 403 (the executor refuses;
 *     mapped here from the thrown strict-mode error).
 *   - POST /action/<unknown-or-agent-tool> → 404 (not a wired human-principal tool).
 */
export interface UiStatus {
  host: string;
  tier: Tier;
  actionsEnabled: boolean;
  availableActions: string[];
}

export interface UiRouterDeps {
  reader: ArtifactReader;
  executor: UiExecutor;
  status: UiStatus;
}

export interface UiResponse {
  status: number;
  contentType: string;
  body: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "localhost"]);

/**
 * ADR-010 §6 — loopback guard (pure, so `server.ts` stays a side-effect-y shell and
 * this stays unit-testable). True iff `localhost`, `::1`, or anything in 127.0.0.0/8.
 * The sidecar refuses to bind anything else: this surface must never be off-host.
 */
export function isLoopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m && m.slice(1).every((g) => Number(g) <= 255)) return m[1] === "127";
  return false;
}

function json(status: number, data: unknown): UiResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(data) };
}

export async function routeUiRequest(
  method: string,
  rawPath: string,
  query: URLSearchParams,
  body: string,
  deps: UiRouterDeps
): Promise<UiResponse> {
  // Normalize a trailing slash (except the root) so /api/drift/ === /api/drift.
  const pathname = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;

  if (method === "GET") {
    if (pathname === "/" || pathname === "/index.html") {
      return { status: 200, contentType: "text/html; charset=utf-8", body: INDEX_HTML };
    }
    if (pathname === "/api/status") {
      return json(200, deps.status);
    }
    if (pathname === "/api/census") {
      return json(200, deps.reader.censusPanel());
    }
    if (pathname === "/api/health") {
      return json(200, deps.reader.healthPanel());
    }
    if (pathname === "/api/drift") {
      return json(200, deps.reader.driftPanel());
    }
    if (pathname === "/api/audit") {
      const limit = parsePositiveInt(query.get("limit"));
      return json(200, deps.reader.auditPanel(limit !== null ? { limit } : {}));
    }
    if (pathname === "/api/changes") {
      const limit = parsePositiveInt(query.get("limit"));
      return json(200, await deps.reader.changeFeedPanel(limit ?? undefined));
    }
    // ADR-015 — derived-metrics panels. All renderer reads; never touch the executor.
    if (pathname === "/api/stats/audit") {
      const windowDays = parsePositiveInt(query.get("windowDays"));
      const bucket = query.get("bucket") === "hour" ? "hour" : query.get("bucket") === "day" ? "day" : undefined;
      return json(200, deps.reader.auditStatsPanel({
        ...(windowDays !== null ? { windowDays } : {}),
        ...(bucket ? { bucket } : {}),
      }));
    }
    if (pathname === "/api/stats/drift") {
      return json(200, deps.reader.driftStatsPanel());
    }
    if (pathname === "/api/stats/backups") {
      return json(200, deps.reader.backupStatsPanel());
    }
    return json(404, { error: `no such route: GET ${pathname}` });
  }

  if (method === "POST" && pathname.startsWith("/action/")) {
    const tool = decodeURIComponent(pathname.slice("/action/".length));
    // Strict renderer-only mode (the default): no tool is wired, so refuse with 403
    // BEFORE touching the executor — the UI shows "renderer-only" and hides buttons,
    // but a hand-crafted POST must still be rejected, not silently accepted.
    if (!deps.executor.actionsEnabled) {
      return json(403, {
        error:
          "UI is in strict renderer-only mode (ADR-010 action item 7); live actions are disabled. " +
          "Set UI_ENABLE_ACTIONS=true and restart the UI.",
      });
    }
    if (!deps.executor.availableTools().includes(tool)) {
      // Either an unknown tool or an agent-principal tool that is never wired here.
      return json(404, {
        error:
          `'${tool}' is not a standing human-principal tool (ADR-010 §1/§5). ` +
          "Agent-principal tools are reachable only through an MCP client session.",
      });
    }
    let input: unknown = {};
    if (body.trim().length) {
      try {
        input = JSON.parse(body);
      } catch {
        return json(400, { error: "request body is not valid JSON" });
      }
    }
    try {
      const result = await deps.executor.run(tool, input);
      return json(200, result ?? {});
    } catch (err) {
      // A handler-level failure (bad scope, engine error) is a 400, not a crash.
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return json(404, { error: `no such route: ${method} ${pathname}` });
}

function parsePositiveInt(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
