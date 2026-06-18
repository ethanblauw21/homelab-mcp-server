import { describe, it, expect, vi } from "vitest";
import { routeUiRequest, isLoopbackAddress, type UiRouterDeps } from "./router.js";
import { INDEX_HTML } from "./page.js";
import type { ArtifactReader } from "./artifacts.js";
import type { UiExecutor } from "./executor.js";

/** ADR-010 §4/§6 — the router: dispatch, strict-mode 403, unknown-tool 404, loopback. */

function fakeReader(): ArtifactReader {
  return {
    censusPanel: () => ({ available: true, snapshotTs: null, ageLabel: "x", data: { census: 1 } }),
    healthPanel: () => ({ available: false, snapshotTs: null, ageLabel: "none", data: null }),
    driftPanel: () => ({ available: true, snapshotTs: null, ageLabel: "x", data: { drift: [] } }),
    auditPanel: (f: { limit?: number }) => ({ summary: { total: 0 }, records: [], echoLimit: f.limit }),
    changeFeedPanel: async (limit?: number) => ({ available: true, snapshotTs: null, ageLabel: "x", data: [], echoLimit: limit }),
  } as unknown as ArtifactReader;
}

function deps(over: { executor?: Partial<UiExecutor>; reader?: ArtifactReader } = {}): UiRouterDeps {
  const executor = {
    actionsEnabled: false,
    availableTools: () => [],
    run: vi.fn(),
    ...over.executor,
  } as unknown as UiExecutor;
  return {
    reader: over.reader ?? fakeReader(),
    executor,
    status: { host: "node", tier: "companion", actionsEnabled: false, availableActions: [] },
  };
}

const q = (s = "") => new URLSearchParams(s);

describe("routeUiRequest — GET renderer routes", () => {
  it("serves the dashboard HTML at /", async () => {
    const r = await routeUiRequest("GET", "/", q(), "", deps());
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toBe(INDEX_HTML);
  });

  it("returns the status payload as JSON", async () => {
    const r = await routeUiRequest("GET", "/api/status", q(), "", deps());
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ tier: "companion", actionsEnabled: false });
  });

  it("routes each /api panel to its reader method", async () => {
    expect(JSON.parse((await routeUiRequest("GET", "/api/census", q(), "", deps())).body).data).toEqual({ census: 1 });
    expect(JSON.parse((await routeUiRequest("GET", "/api/health", q(), "", deps())).body).available).toBe(false);
    expect(JSON.parse((await routeUiRequest("GET", "/api/drift", q(), "", deps())).body).available).toBe(true);
    expect(JSON.parse((await routeUiRequest("GET", "/api/changes", q(), "", deps())).body).available).toBe(true);
  });

  it("passes a valid ?limit through to the audit panel and ignores a bad one", async () => {
    const ok = await routeUiRequest("GET", "/api/audit", q("limit=10"), "", deps());
    expect(JSON.parse(ok.body).echoLimit).toBe(10);
    const bad = await routeUiRequest("GET", "/api/audit", q("limit=-3"), "", deps());
    expect(JSON.parse(bad.body).echoLimit).toBeUndefined();
  });

  it("tolerates a trailing slash on an api route", async () => {
    const r = await routeUiRequest("GET", "/api/drift/", q(), "", deps());
    expect(r.status).toBe(200);
  });

  it("404s an unknown GET route", async () => {
    const r = await routeUiRequest("GET", "/api/nope", q(), "", deps());
    expect(r.status).toBe(404);
  });
});

describe("routeUiRequest — POST /action/* enforcement", () => {
  it("403s every action in strict renderer-only mode (even a wired tool name)", async () => {
    const r = await routeUiRequest("POST", "/action/verify_integrity", q(), "{}", deps());
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/strict renderer-only/i);
  });

  it("404s an agent-principal/unknown tool even when actions are enabled", async () => {
    const d = deps({ executor: { actionsEnabled: true, availableTools: () => ["verify_integrity"] } });
    const r = await routeUiRequest("POST", "/action/execute", q(), "{}", d);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error).toMatch(/not a standing human-principal tool/i);
  });

  it("runs a wired human tool and returns its result", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const d = deps({ executor: { actionsEnabled: true, availableTools: () => ["verify_integrity"], run } });
    const r = await routeUiRequest("POST", "/action/verify_integrity", q(), '{"level":"smart"}', d);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith("verify_integrity", { level: "smart" });
  });

  it("400s a malformed JSON body", async () => {
    const d = deps({ executor: { actionsEnabled: true, availableTools: () => ["verify_integrity"], run: vi.fn() } });
    const r = await routeUiRequest("POST", "/action/verify_integrity", q(), "{not json", d);
    expect(r.status).toBe(400);
  });

  it("maps a handler error to 400, not a crash", async () => {
    const run = vi.fn().mockRejectedValue(new Error("bad scope"));
    const d = deps({ executor: { actionsEnabled: true, availableTools: () => ["accept_truth"], run } });
    const r = await routeUiRequest("POST", "/action/accept_truth", q(), "{}", d);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/bad scope/);
  });
});

describe("isLoopbackAddress — the localhost bind guard", () => {
  it("accepts loopback forms", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
  });

  it("refuses any routable address", () => {
    for (const a of ["0.0.0.0", "192.168.1.50", "10.0.0.1", "::", "example.com", "128.0.0.1"]) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
  });
});
