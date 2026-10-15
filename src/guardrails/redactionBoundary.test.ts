/**
 * ADR-026 — the boundary is the guarantee, so these tests pin it three ways:
 *   1. STRUCTURE: `index.ts` registers every tool through `register`, and `register`
 *      wraps every callback with `withRedaction` (the only `registerTool` call).
 *   2. CLASSIFICATION: every tool in TOOL_MIN_TIER is either exercised below against
 *      a leaky fake backend or listed in OTHER_TOOLS_REASON with a reason — adding a tool
 *      without deciding which fails CI.
 *   3. BEHAVIOUR: each exercised dump tool's handler runs against a transport that
 *      returns secret-laden fixtures for EVERY exec/read; its formatted result (or
 *      thrown error) then passes the same `withRedaction` wrapper `index.ts` uses,
 *      and no fixture secret may survive.
 * All secrets here are fake.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { withRedaction } from "./redactionBoundary.js";
import { DIUN_ENV, FAKE_WEBHOOK_TOKEN, FAKE_WEBHOOK_ID, REDACT_FIXTURES } from "./redactionFixtures.js";
import { TOOL_MIN_TIER } from "../tiers/registry.js";
import type { ExecResult, FileEntry, SshTransport } from "../ssh/transport.js";
import { config as defaultConfig, type Config } from "../config.js";
import { AuditLog } from "../audit/log.js";
import { executeHandler, ExecuteInputSchema } from "../tools/execute.js";
import { pctExecHandler, PctExecInputSchema } from "../tools/pctExec.js";
import { dockerExecHandler, DockerExecInputSchema } from "../tools/dockerExec.js";
import { qmExecHandler, QmExecInputSchema } from "../tools/qmExec.js";
import { dockerInspectHandler, DockerInspectInputSchema } from "../tools/dockerInspect.js";
import { dockerLogsHandler, DockerLogsInputSchema } from "../tools/dockerLogs.js";
import { tailLogHandler, TailLogInputSchema } from "../tools/tailLog.js";
import { serviceLogsHandler, ServiceLogsInputSchema } from "../tools/serviceTools.js";
import { searchFileRegexHandler, SearchFileRegexInputSchema } from "../tools/searchFileRegex.js";
import { composeDiscoverHandler, ComposeDiscoverInputSchema } from "../tools/composeDiscover.js";
import { readFileHandler, ReadFileInputSchema } from "../tools/readFile.js";
import { describeGuestHandler, DescribeGuestInputSchema } from "../tools/describeGuest.js";
import { dockerPsHandler, DockerPsInputSchema } from "../tools/dockerPs.js";
import { pctReadFileHandler, PctReadFileInputSchema } from "../tools/pctReadFile.js";
import { dockerReadFileHandler, DockerReadFileInputSchema } from "../tools/dockerReadFile.js";
import { queryAuditHandler, QueryAuditInputSchema } from "../tools/queryAudit.js";
import { buildAuditRecord } from "../audit/record.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The leaky backend: every channel returns secrets.
// ---------------------------------------------------------------------------

const FAKE_PW = "fake-boundary-pw-0001";
const FAKE_GHP = "ghp_FAKEboundary0123456789FAKEboundary01";
const LEAK_TEXT = [
  ...DIUN_ENV,
  `DB_PASSWORD=${FAKE_PW}`,
  `Authorization: Bearer ${FAKE_GHP}`,
  `level=info msg="cloned with ${FAKE_GHP}"`,
].join("\n");
const SECRETS = [FAKE_WEBHOOK_TOKEN, FAKE_WEBHOOK_ID, FAKE_PW, "FAKEboundary0123456789FAKEboundary01"];

const INSPECT_JSON = JSON.stringify([
  {
    Id: "c19aa4ecdf03d73e1d5c901da33744cb7eb4d921f89bafed1ca264601d7fa224",
    Name: "/diun",
    Image: "sha256:e324b793eb32dfb7f74d3a39421ebf090141caaadee69b8f78da63112408ee25",
    State: { Status: "running", Running: true },
    Config: {
      Image: "crazymax/diun:latest",
      Env: [...DIUN_ENV, `DB_PASSWORD=${FAKE_PW}`],
      Labels: { "com.docker.compose.project": "1", "diun.notif.webhook": FAKE_WEBHOOK_TOKEN },
      Cmd: ["serve", `--token=${FAKE_PW}`],
      Entrypoint: ["diun"],
      Healthcheck: { Test: ["CMD", "curl", "-H", `Authorization: Bearer ${FAKE_GHP}`, "http://localhost"] },
    },
    Args: [`--password`, FAKE_PW],
    HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "bridge" },
    Mounts: [],
    NetworkSettings: { Networks: {}, Ports: {} },
  },
]);

const DOCKER_PS_ROW = JSON.stringify({
  ID: "c19aa4ecdf03",
  Names: "diun",
  Image: "crazymax/diun:latest",
  Status: "Up 2 days",
  State: "running",
  Ports: "",
  Command: `"diun serve --token=${FAKE_PW}"`,
  Labels: `com.docker.compose.project=1,com.docker.compose.service=diun,com.docker.compose.project.config_files=/data/compose/1/docker-compose.yml,diun.notif.webhook=${FAKE_WEBHOOK_TOKEN}`,
});

class LeakyTransport implements SshTransport {
  // Answers the shape each handler asks for, every answer carrying the secrets.
  async exec(command: string): Promise<ExecResult> {
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: `warn: DB_PASSWORD=${FAKE_PW}`, exitCode: 0 });
    if (/docker inspect/.test(command) && !/--format/.test(command)) return ok(INSPECT_JSON);
    if (/docker ps --no-trunc --format/.test(command)) return ok(DOCKER_PS_ROW);
    if (/pct status/.test(command)) return ok("status: running\n");
    if (/pct list/.test(command)) return ok("VMID       Status     Lock         Name\n101        running                 dockerBoss\n");
    if (/qm list/.test(command)) return ok("      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID\n");
    if (/qm guest exec/.test(command)) return ok(JSON.stringify({ exited: 1, exitcode: 0, "out-data": LEAK_TEXT }));
    if (/qm agent \d+ ping|guest-ping/.test(command)) return ok("");
    if (/grep -a -n -E/.test(command)) return ok(LEAK_TEXT.split("\n").map((l, i) => `${i + 1}:${l}`).join("\n"));
    return ok(LEAK_TEXT);
  }
  async stat() {
    return { size: Buffer.byteLength(LEAK_TEXT) };
  }
  async readFile(): Promise<Buffer> {
    return Buffer.from(LEAK_TEXT);
  }
  async writeFile(): Promise<void> {}
  async list(): Promise<FileEntry[]> {
    return [];
  }
  async close(): Promise<void> {}
}

let tmp: string;
let cfg: Config;
let audit: AuditLog;
const t = new LeakyTransport();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redaction-boundary-"));
  // The real defaults (so no handler trips on a missing knob), with a throwaway audit log.
  cfg = { ...defaultConfig, audit: { ...defaultConfig.audit, logPath: path.join(tmp, "audit.jsonl"), dbEnabled: false } };
  audit = new AuditLog(cfg.audit.logPath);
});

/** Mirrors index.ts: JSON results (or raw content) → withRedaction → text the model sees. */
async function throughBoundary(run: () => Promise<unknown>, raw = false): Promise<string> {
  const cb = withRedaction(async () => {
    const result = await run();
    const text = raw ? (result as { content: string }).content : JSON.stringify(result);
    return { content: [{ type: "text", text }] };
  });
  try {
    const res = await cb();
    return res.content.map((c) => c.text).join("\n");
  } catch (err) {
    return `THROWN: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// 3. Behaviour — every exercised dump tool, against the leaky backend.
// ---------------------------------------------------------------------------

const EXERCISED: Record<string, { raw?: boolean; run: () => Promise<unknown> }> = {
  execute: { run: () => executeHandler(ExecuteInputSchema.parse({ command: "env" }), t, audit, cfg) },
  pct_exec: { run: () => pctExecHandler(PctExecInputSchema.parse({ vmid: 101, command: "env" }), t, audit, cfg) },
  docker_exec: {
    run: () => dockerExecHandler(DockerExecInputSchema.parse({ vmid: 101, container: "diun", command: "env" }), t, audit, cfg),
  },
  qm_exec: { run: () => qmExecHandler(QmExecInputSchema.parse({ vmid: 200, command: "env" }), t, audit, cfg) },
  docker_inspect: { run: () => dockerInspectHandler(DockerInspectInputSchema.parse({ vmid: 101, container: "diun" }), t, cfg) },
  docker_logs: { run: () => dockerLogsHandler(DockerLogsInputSchema.parse({ vmid: 101, container: "diun" }), t, cfg) },
  docker_ps: { run: () => dockerPsHandler(DockerPsInputSchema.parse({ vmid: 101 }), t, cfg) },
  tail_log: { run: () => tailLogHandler(TailLogInputSchema.parse({ vmid: 101, unit: "diun.service" }), t, cfg) },
  service_logs: {
    run: () => serviceLogsHandler(ServiceLogsInputSchema.parse({ vmid: 101, unit: "diun.service" }), t, cfg, "companion"),
  },
  search_file_regex: {
    run: () =>
      searchFileRegexHandler(SearchFileRegexInputSchema.parse({ vmid: 101, path: "/etc/diun/env", pattern: "." }), t, cfg, "companion"),
  },
  compose_discover: { run: () => composeDiscoverHandler(ComposeDiscoverInputSchema.parse({ vmid: 101 }), t, cfg) },
  describe_guest: { run: () => describeGuestHandler(DescribeGuestInputSchema.parse({ vmid: 101 }), t, cfg) },
  read_file: { raw: true, run: () => readFileHandler(ReadFileInputSchema.parse({ path: "/etc/diun.env" }), t, cfg) },
  pct_read_file: { run: () => pctReadFileHandler(PctReadFileInputSchema.parse({ vmid: 101, path: "/etc/diun.env" }), t, cfg) },
  docker_read_file: {
    run: () => dockerReadFileHandler(DockerReadFileInputSchema.parse({ vmid: 101, container: "diun", path: "/etc/diun.env" }), t, cfg),
  },
  query_audit: {
    run: async () => {
      // A pre-ADR-026 record whose note was stored before the stronger rules existed.
      fs.appendFileSync(
        cfg.audit.logPath,
        JSON.stringify({ ...buildAuditRecord({ tool: "execute", cmd: "env" }), note: LEAK_TEXT }) + "\n"
      );
      return queryAuditHandler(QueryAuditInputSchema.parse({ limit: 10 }), audit, cfg);
    },
  },
};

/**
 * Tools NOT run against the leaky backend here, with why. They are still behind
 * the boundary (part 1 proves every registered tool is) — this list only records
 * that their handler isn't individually exercised.
 */
const OTHER_TOOLS_REASON: Record<string, string> = {
  write_file: "mutation; returns a diff — covered by the write guard + boundary",
  edit_file: "mutation front door to write_file",
  pct_write_file: "mutation; returns a diff",
  pct_edit_file: "mutation front door to pct_write_file",
  qm_read_file: "needs the guest-agent pvesh round trip; boundary-only",
  qm_write_file: "mutation; returns a diff",
  qm_edit_file: "mutation front door to qm_write_file",
  docker_write_file: "mutation; returns a diff",
  docker_edit_file: "mutation front door to docker_write_file",
  list_directory: "names/sizes only",
  docker_stats: "cpu/mem metrics only",
  pct_list: "status table",
  qm_list: "status table",
  qm_agent_ping: "boolean",
  revert_file: "mutation; returns a diff",
  list_backups: "local backup metadata",
  diff_config: "needs a backup store fixture; diff text is boundary-redacted",
  snapshot_create: "mutation", snapshot_list: "names/dates", snapshot_rollback: "mutation", snapshot_delete: "mutation",
  describe_homelab: "census; config sections redacted by the census parsers + boundary",
  health_check: "metrics",
  config_sweep: "summary counts only",
  compute_tree: "hashes", verify_integrity: "paths + hashes", accept_truth: "hashes",
  guest_start: "lifecycle", guest_stop: "lifecycle", guest_restart: "lifecycle",
  guest_backup: "lifecycle", guest_backup_restore: "lifecycle", guest_backup_list: "archive volids",
  compose_redeploy: "mutation; compose output is boundary-redacted",
  compose_preflight: "needs a compose fixture; boundary-redacted",
  service_status: "parsed systemctl fields",
  service_restart: "mutation",
  tcp_ping: "reachability", http_probe: "status code + byte count",
  docker_restart: "mutation", image_updates: "digests + versions", compose_update: "mutation",
};

describe("ADR-026 boundary — classification (a new tool must be classified)", () => {
  it("every TOOL_MIN_TIER tool is exercised or listed with a reason", () => {
    const classified = new Set([...Object.keys(EXERCISED), ...Object.keys(OTHER_TOOLS_REASON)]);
    const unclassified = Object.keys(TOOL_MIN_TIER).filter((n) => !classified.has(n));
    expect(unclassified, "add the new tool to EXERCISED (preferred) or OTHER_TOOLS_REASON").toEqual([]);
    const stale = [...classified].filter((n) => !(n in TOOL_MIN_TIER));
    expect(stale).toEqual([]);
  });
});

describe("ADR-026 boundary — dump tools against a leaky backend", () => {
  for (const [name, c] of Object.entries(EXERCISED)) {
    it(`${name}: no fixture secret reaches the model`, async () => {
      const out = await throughBoundary(c.run, c.raw);
      if (process.env.REDACTION_BOUNDARY_DEBUG) console.log(`## ${name}\n${out.slice(0, 300)}`);
      for (const s of SECRETS) expect(out, `${name} leaked ${s}:\n${out.slice(0, 600)}`).not.toContain(s);
    });
  }

  it("docker_inspect (the Diun regression) keeps env/label NAMES and masks values", async () => {
    const out = await throughBoundary(EXERCISED.docker_inspect!.run);
    expect(out).toContain("DIUN_NOTIF_DISCORD_WEBHOOKURL");
    expect(out).toContain("America/Chicago");
    expect(out).toMatch(/<redacted len=\d+/);
  });
});

// ---------------------------------------------------------------------------
// 1. Structure — index.ts can't register around the redactor.
// ---------------------------------------------------------------------------

describe("ADR-026 boundary — index.ts wiring", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "index.ts"), "utf8");

  it("has exactly one registerTool call, and it receives the withRedaction-wrapped callback", () => {
    expect(src.match(/registerTool/g)?.length ?? 0).toBe(3); // the typeof, the cast, the call — all inside `register`
    expect(src).toMatch(/const redacted = withRedaction\(cb/);
    expect(src).toMatch(/\(name, def, redacted\)/);
    expect(src).not.toMatch(/server\.(tool|resource|prompt|registerResource|registerPrompt)\(/);
  });

  it("registers every TOOL_MIN_TIER tool through `register(`", () => {
    const registered = new Set([...src.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    const missing = Object.keys(TOOL_MIN_TIER).filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The wrapper itself.
// ---------------------------------------------------------------------------

describe("withRedaction", () => {
  it("redacts results, error results and thrown messages", async () => {
    const ok = await withRedaction(async () => ({ content: [{ type: "text", text: LEAK_TEXT }] }))();
    const isErr = await withRedaction(async () => ({ isError: true, content: [{ type: "text", text: LEAK_TEXT }] }))();
    const thrown = await withRedaction(async () => {
      throw new Error(`bad config: ${LEAK_TEXT}`);
    })().catch((e: Error) => e.message);
    for (const s of SECRETS) {
      expect(ok.content[0]!.text).not.toContain(s);
      expect(isErr.content[0]!.text).not.toContain(s);
      expect(thrown).not.toContain(s);
    }
    expect(isErr.isError).toBe(true);
  });

  it("every REDACT_FIXTURES secret is removed through the wrapper too", async () => {
    for (const f of REDACT_FIXTURES) {
      const r = await withRedaction(async () => ({ content: [{ type: "text", text: f.input }] }))();
      for (const s of f.secrets) expect(r.content[0]!.text).not.toContain(s);
    }
  });
});
