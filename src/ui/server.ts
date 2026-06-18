import http from "http";
import { config } from "../config.js";
import { type Tier } from "../tiers/registry.js";
import { resolveTier } from "../tiers/rootFlag.js";
import { ArtifactReader } from "./artifacts.js";
import { UiExecutor } from "./executor.js";
import { SnapshotStore } from "./snapshotStore.js";
import { routeUiRequest, isLoopbackAddress, type UiRouterDeps, type UiStatus } from "./router.js";

/**
 * ADR-010 §6 — the localhost UI sidecar: a SECOND standing process, separate from
 * the stdio MCP server. It serves the credential-free renderer (GET /api/*) always,
 * and the bounded human-tool executor (POST /action/*) only when UI_ENABLE_ACTIONS
 * is set. It is a built-in Node `http` server with JSON endpoints — no framework,
 * no extra deps (action item 6, "deliberately boring stack").
 *
 * TWO non-negotiable safety properties, enforced here at startup:
 *   1. LOOPBACK ONLY. The bind address must be a loopback address; the server
 *      refuses to start otherwise. This surface must never be reachable off-host.
 *   2. STRICT-BY-DEFAULT. enableActions defaults to false; the executor then wires
 *      no tools and holds no node credentials (we don't even open SSH / the native
 *      store in that mode). Live actions are opt-in via UI_ENABLE_ACTIONS=true.
 */

async function main(): Promise<void> {
  const tier: Tier = resolveTier(config.tier.level, config.tier.rootEnabled);
  const enableActions = config.ui.enableActions;
  const bindAddress = config.ui.bindAddress;
  const port = config.ui.port;

  // (1) Loopback guard — fail closed, loud, before any socket is opened.
  if (!isLoopbackAddress(bindAddress)) {
    process.stderr.write(
      `FATAL: UI bind address '${bindAddress}' is not a loopback address. The ADR-010 sidecar is ` +
        "localhost-only by design and refuses to bind a routable interface. Set UI_BIND_ADDRESS to " +
        "127.0.0.1 (the default).\n"
    );
    process.exit(1);
  }

  // The renderer half — credential-free, always available. It builds its own
  // read-only stores from config (census/health/drift snapshots, audit log, git log).
  const reader = new ArtifactReader(config);

  // The drift sink: when an action-enabled UI runs verify_integrity, persist the
  // report to the SAME dir the renderer reads, so the drift panel refreshes live.
  const driftSink = new SnapshotStore<unknown>(config.ui.driftDir, config.ui.driftRetentionCap);

  // The executor half — bounded, tier-bound, audited. In strict mode (the default)
  // it wires NOTHING, so we construct none of the node-touching deps below.
  let executor: UiExecutor;
  const cleanups: Array<() => void | Promise<void>> = [];

  if (enableActions) {
    // Defer the credentialed imports so a strict-mode run never even loads the SSH
    // client / native SQLite binding.
    const { Ssh2Transport } = await import("../ssh/ssh2Client.js");
    const { AuditLog } = await import("../audit/log.js");
    const { ConfigHistory } = await import("../history/configHistory.js");
    const { IntegrityEngine } = await import("../integrity/integrityEngine.js");
    const { openIntegrityStore } = await import("../tools/integrity.js");
    const { assertNonOverlap } = await import("../integrity/forestShape.js");

    assertNonOverlap(config.history.hostWatchPaths, config.integrity.containerBackingPaths);

    const sshTransport = new Ssh2Transport(config.ssh);
    const audit = new AuditLog(config.audit.logPath);
    const integrityStore = openIntegrityStore(config);
    const engine = new IntegrityEngine(integrityStore, sshTransport, config, audit);
    const configHistory = new ConfigHistory(config.history);
    await configHistory.init();

    executor = new UiExecutor({
      tier,
      enableActions: true,
      config,
      audit,
      engine,
      transport: sshTransport,
      configHistory,
      driftSink,
    });

    cleanups.push(() => integrityStore.close());
    cleanups.push(() => sshTransport.close());
  } else {
    executor = new UiExecutor({ tier, enableActions: false, config });
  }

  const status: UiStatus = {
    host: config.api.node || config.ssh.host || "homelab",
    tier,
    actionsEnabled: executor.actionsEnabled,
    availableActions: executor.availableTools(),
  };

  const deps: UiRouterDeps = { reader, executor, status };

  const httpServer = http.createServer((req, res) => {
    void handle(req, res, deps);
  });

  httpServer.listen(port, bindAddress, () => {
    process.stderr.write(
      `homelab-ui v0.2.0 | http://${bindAddress}:${port} | tier: ${tier} | ` +
        `mode: ${enableActions ? "live actions" : "renderer-only"} | actions: [${status.availableActions.join(", ")}]\n`
    );
  });

  const shutdown = async () => {
    httpServer.close();
    for (const c of cleanups) {
      try {
        await c();
      } catch {
        /* best-effort */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: UiRouterDeps): Promise<void> {
  try {
    const method = req.method ?? "GET";
    // The Host header is irrelevant for routing (we bound loopback); base is a
    // throwaway so the URL parser can split path + query.
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = method === "POST" ? await readBody(req) : "";
    const out = await routeUiRequest(method, url.pathname, url.searchParams, body, deps);
    res.writeHead(out.status, { "content-type": out.contentType });
    res.end(out.body);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Action payloads are tiny (a scope string, a level). Cap to refuse abuse.
      if (size > 64 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

main().catch((err) => {
  process.stderr.write(`FATAL: UI sidecar failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
