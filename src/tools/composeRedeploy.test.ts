import { describe, it, expect, beforeEach } from "vitest";
import { composeRedeployHandler } from "./composeRedeploy.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { AuditRecord } from "../audit/record.js";

let records: AuditRecord[];
const audit = { append: async (r: AuditRecord) => void records.push(r) } as unknown as import("../audit/log.js").AuditLog;
const cfg = {
  ssh: { host: "node.lan", commandTimeoutMs: 5000 },
  guardrails: { pathAllowlist: undefined, pathDenylist: ["/etc/pve"] },
} as unknown as import("../config.js").Config;

const COMPOSE = "/opt/stack/docker-compose.yml";
// pct exec 101 -- bash -c '<docker compose -f '\''/opt/stack/docker-compose.yml'\'' up -d>'
const EXPECTED_CMD = "pct exec 101 -- bash -c 'docker compose -f '\\''/opt/stack/docker-compose.yml'\\'' up -d'";

beforeEach(() => {
  records = [];
});

describe("compose_redeploy", () => {
  it("refuses without confirm and runs nothing", async () => {
    const ft = new FakeTransport();
    await expect(
      composeRedeployHandler({ vmid: 101, composePath: COMPOSE, confirm: false }, ft, audit, cfg)
    ).rejects.toThrow(/confirm: true/);
    expect(records).toEqual([]);
  });

  it("rejects a non-absolute compose path", async () => {
    const ft = new FakeTransport();
    await expect(
      composeRedeployHandler({ vmid: 101, composePath: "relative/path.yml", confirm: true }, ft, audit, cfg)
    ).rejects.toThrow(/Invalid compose file path/);
    expect(records).toEqual([]);
  });

  it("rejects a denylisted compose path", async () => {
    const ft = new FakeTransport();
    await expect(
      composeRedeployHandler({ vmid: 101, composePath: "/etc/pve/compose.yml", confirm: true }, ft, audit, cfg)
    ).rejects.toThrow(/Invalid compose file path/);
    expect(records).toEqual([]);
  });

  it("runs docker compose up -d via pct exec and audits a non-revertible large change", async () => {
    const ft = new FakeTransport();
    ft.setExecResult(EXPECTED_CMD, { stdout: "Recreated portainer", stderr: "", exitCode: 0 });
    const out = await composeRedeployHandler({ vmid: 101, composePath: COMPOSE, confirm: true }, ft, audit, cfg);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Recreated");
    expect(records[0]!.tool).toBe("compose_redeploy");
    expect(records[0]!.vmid).toBe(101);
    expect(records[0]!.path).toBe(COMPOSE);
    expect(records[0]!.isLargeChange).toBe(true);
    expect(records[0]!.isRevertible).toBe(false);
  });

  it("propagates a non-zero exit and still audits", async () => {
    const ft = new FakeTransport();
    ft.setExecResult(EXPECTED_CMD, { stdout: "", stderr: "no such file", exitCode: 1 });
    const out = await composeRedeployHandler({ vmid: 101, composePath: COMPOSE, confirm: true }, ft, audit, cfg);
    expect(out.exitCode).toBe(1);
    expect(records[0]!.exitCode).toBe(1);
  });
});
