import { describe, it, expect, beforeEach } from "vitest";
import { composeRedeployHandler } from "./composeRedeploy.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { AuditRecord } from "../audit/record.js";
import { ScriptTransport, identityRow } from "./dockerUpdateTestkit.js";

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

  // --- ADR-027: the project's --env-file ---

  const unq = (c: string): string => c.replace(/'\\''/g, "'");
  const scanWith = (...rows: string[]) =>
    new ScriptTransport().on(/xargs -r docker inspect/, { stdout: rows.join("\n"), stderr: "", exitCode: 0 });

  it("reuses the environment_file label of the project's containers as --env-file", async () => {
    const t = scanWith(
      identityRow({ name: "a", composeConfigFiles: COMPOSE, composeEnvFiles: "/data/segmem/.env" }),
      identityRow({ name: "b", composeConfigFiles: COMPOSE, composeEnvFiles: "/data/segmem/.env" }),
      identityRow({ name: "other", composeConfigFiles: "/elsewhere.yml", composeEnvFiles: "/other/.env" })
    );
    const out = await composeRedeployHandler({ vmid: 101, composePath: COMPOSE, confirm: true }, t, audit, cfg);
    expect(out.envFiles).toEqual(["/data/segmem/.env"]);
    const up = unq(t.commands.find((c) => c.includes("up -d"))!);
    expect(up).toContain(`docker compose -f '${COMPOSE}' --env-file '/data/segmem/.env' up -d`);
    expect(up).not.toContain("/other/.env");
    expect(records[0]!.note).toMatch(/--env-file \/data\/segmem\/\.env/);
  });

  it("an explicit envFiles wins; [] means none", async () => {
    const t = scanWith(identityRow({ name: "a", composeConfigFiles: COMPOSE, composeEnvFiles: "/data/segmem/.env" }));
    const out = await composeRedeployHandler({ vmid: 101, composePath: COMPOSE, envFiles: [], confirm: true }, t, audit, cfg);
    expect(out.envFiles).toEqual([]);
    expect(t.commands.some((c) => c.includes("xargs -r docker inspect"))).toBe(false);
    const out2 = await composeRedeployHandler({ vmid: 101, composePath: COMPOSE, envFiles: ["/x/.env"], confirm: true }, t, audit, cfg);
    expect(out2.envFiles).toEqual(["/x/.env"]);
  });

  it("refuses a relative or comma-bearing explicit env file before running anything", async () => {
    const t = new ScriptTransport();
    await expect(
      composeRedeployHandler({ vmid: 101, composePath: COMPOSE, envFiles: ["rel.env", "/a,b.env"], confirm: true }, t, audit, cfg)
    ).rejects.toThrow(/Invalid envFiles entries: "rel.env", "\/a,b.env"/);
    expect(t.commands).toEqual([]);
  });

  it("uses no env file and warns when the project's containers disagree", async () => {
    const t = scanWith(
      identityRow({ name: "a", composeConfigFiles: COMPOSE, composeEnvFiles: "/one/.env" }),
      identityRow({ name: "b", composeConfigFiles: COMPOSE, composeEnvFiles: "/two/.env" })
    );
    const out = await composeRedeployHandler({ vmid: 101, composePath: COMPOSE, confirm: true }, t, audit, cfg);
    expect(out.envFiles).toEqual([]);
    expect(out.warnings!.join(" ")).toMatch(/disagree on environment_file/);
  });
});
