import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { inject } from "vitest";

const dockerAvailable = inject("dockerAvailable");
const describeIfDocker = dockerAvailable ? describe : describe.skip;

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Ssh2Transport } from "../ssh/ssh2Client.js";
import { configSweepHandler } from "./configSweep.js";
import { ConfigHistory } from "../history/configHistory.js";
import { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

// config_sweep end-to-end: real SSH enumerate/hash/fetch → real local git mirror.
// Captures the out-of-band change path the audit log never witnesses. Skips
// without Docker (no SSH host) — git itself is assumed present in CI.

const SWEEP_DIR = "/tmp/mcp-int-sweep";

function makeConfig(historyDir: string): Config {
  return {
    ssh: {
      host: inject("sshHost"),
      port: inject("sshPort"),
      username: "root",
      privateKeyPath: inject("sshKeyPath"),
      keepaliveInterval: 5_000,
      reconnectDelay: 1_000,
      commandTimeoutMs: 10_000,
      commandTimeoutGraceMs: 10_000,
      skipHostVerification: true,
    },
    container: { nodeTempDir: "/tmp" },
    history: {
      configHistoryDir: historyDir,
      pushMode: "local-only",
      remote: undefined,
      hostWatchPaths: [SWEEP_DIR],
      containerWatchPaths: [SWEEP_DIR],
      excludePatterns: ["**/*.lock"],
      sweepFileSizeCapBytes: 1024 * 1024,
    },
  } as unknown as Config;
}

let transport: Ssh2Transport;
let tmpDir: string;

beforeAll(() => {
  transport = new Ssh2Transport({
    host: inject("sshHost"),
    port: inject("sshPort"),
    username: "root",
    privateKeyPath: inject("sshKeyPath"),
    keepaliveInterval: 5_000,
    reconnectDelay: 1_000,
    commandTimeoutMs: 10_000,
    commandTimeoutGraceMs: 10_000,
    skipHostVerification: true,
  });
});

afterAll(async () => {
  await transport.close();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-sweep-"));
});

async function makeDeps() {
  const historyDir = path.join(tmpDir, "history");
  const auditPath = path.join(tmpDir, "audit.jsonl");
  const cfg = makeConfig(historyDir);
  const history = new ConfigHistory(cfg.history);
  await history.init();
  const audit = new AuditLog(auditPath);
  return { cfg, history, audit, historyDir };
}

describeIfDocker("config_sweep end-to-end (real SSH + local git mirror)", () => {
  beforeEach(async () => {
    // Fresh watched directory on the node for each test.
    await transport.exec(`rm -rf ${SWEEP_DIR} && mkdir -p ${SWEEP_DIR}`, 10_000);
  });

  it("captures new files into the mirror with one commit per sweep", async () => {
    const { cfg, history, audit, historyDir } = await makeDeps();
    await transport.writeFile(`${SWEEP_DIR}/alpha.conf`, Buffer.from("alpha=1\n"));
    await transport.writeFile(`${SWEEP_DIR}/beta.conf`, Buffer.from("beta=2\n"));

    const r = await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);

    expect(r.historyCommitted).toBe(true);
    expect(r.targets[0].added).toBe(2);
    expect(fs.readFileSync(path.join(historyDir, `host${SWEEP_DIR}/alpha.conf`), "utf8")).toBe(
      "alpha=1\n"
    );
    const count = spawnSync("git", ["-C", historyDir, "rev-list", "--count", "HEAD"])
      .stdout.toString()
      .trim();
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  it("hash-compare: a re-sweep with no changes fetches nothing", async () => {
    const { cfg, history, audit } = await makeDeps();
    await transport.writeFile(`${SWEEP_DIR}/gamma.conf`, Buffer.from("gamma=3\n"));

    await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);
    const r2 = await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);

    expect(r2.targets[0].added).toBe(0);
    expect(r2.targets[0].changed).toBe(0);
    expect(r2.targets[0].unchanged).toBe(1);
  });

  it("captures an out-of-band edit on the next sweep", async () => {
    const { cfg, history, audit, historyDir } = await makeDeps();
    await transport.writeFile(`${SWEEP_DIR}/delta.conf`, Buffer.from("v1\n"));
    await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);

    // Hand-edit on the node — exactly what the audit log never sees.
    await transport.writeFile(`${SWEEP_DIR}/delta.conf`, Buffer.from("v2-edited\n"));
    const r = await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);

    expect(r.targets[0].changed).toBe(1);
    expect(fs.readFileSync(path.join(historyDir, `host${SWEEP_DIR}/delta.conf`), "utf8")).toBe(
      "v2-edited\n"
    );
  });

  it("records a deletion when a file is removed on the node", async () => {
    const { cfg, history, audit, historyDir } = await makeDeps();
    await transport.writeFile(`${SWEEP_DIR}/epsilon.conf`, Buffer.from("e\n"));
    await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);

    await transport.exec(`rm -f ${SWEEP_DIR}/epsilon.conf`, 10_000);
    const r = await configSweepHandler({ targets: ["host"] }, transport, history, audit, cfg);

    expect(r.targets[0].deleted).toBe(1);
    expect(fs.existsSync(path.join(historyDir, `host${SWEEP_DIR}/epsilon.conf`))).toBe(false);
  });
});
