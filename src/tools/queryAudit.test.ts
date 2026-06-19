import { describe, it, expect } from "vitest";
import {
  filterAuditRecords,
  summarizeAuditRecords,
  queryAuditHandler,
  projectAuditCmd,
} from "./queryAudit.js";
import type { AuditRecord } from "../audit/record.js";
import type { AuditLog } from "../audit/log.js";
import type { Config } from "../config.js";

function rec(p: Partial<AuditRecord>): AuditRecord {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    ts: p.ts ?? "2026-06-10T00:00:00.000Z",
    tool: p.tool ?? "execute",
    ...p,
  } as AuditRecord;
}

const RECORDS: AuditRecord[] = [
  rec({ ts: "2026-06-01T10:00:00.000Z", tool: "write_file", path: "/etc/hosts", isLargeChange: false }),
  rec({ ts: "2026-06-05T10:00:00.000Z", tool: "qm_exec", vmid: 100, cmd: "uptime" }),
  rec({ ts: "2026-06-08T10:00:00.000Z", tool: "write_file", path: "/etc/network/interfaces", isLargeChange: true }),
  rec({ ts: "2026-06-09T10:00:00.000Z", tool: "qm_exec", vmid: 100, cmd: "df" }),
  rec({ ts: "2026-06-10T10:00:00.000Z", tool: "pct_exec", vmid: 101 }),
];

function makeConfig(): Config {
  return { tools: { queryAuditDefaultLimit: 50, queryAuditMaxLimit: 200 } } as unknown as Config;
}

function fakeAudit(records: AuditRecord[]): AuditLog {
  return { readAll: () => records } as unknown as AuditLog;
}

describe("filterAuditRecords", () => {
  it("filters by tool, vmid, and largeOnly independently", () => {
    expect(filterAuditRecords(RECORDS, { tool: "qm_exec" })).toHaveLength(2);
    expect(filterAuditRecords(RECORDS, { vmid: 100 })).toHaveLength(2);
    expect(filterAuditRecords(RECORDS, { largeOnly: true })).toHaveLength(1);
  });

  it("filters by pathContains and ISO since/until ranges", () => {
    expect(filterAuditRecords(RECORDS, { pathContains: "network" })).toHaveLength(1);
    const ranged = filterAuditRecords(RECORDS, {
      since: "2026-06-05T00:00:00.000Z",
      until: "2026-06-09T23:59:59.000Z",
    });
    expect(ranged).toHaveLength(3);
  });

  it("combines predicates (AND semantics)", () => {
    const r = filterAuditRecords(RECORDS, { tool: "qm_exec", vmid: 100, since: "2026-06-06T00:00:00.000Z" });
    expect(r).toHaveLength(1);
    expect(r[0]?.cmd).toBe("df");
  });

  it("filters by ADR-009 hash anchors (hashScopeContains, unknownScopeOnly, hashEquals)", () => {
    const hashed: AuditRecord[] = [
      rec({ tool: "write_file", path: "/etc/app.conf", hashScope: "/etc/app.conf", afterHash: "deadbeef", beforeHash: "cafe" }),
      rec({ tool: "execute", cmd: "sed -i ...", hashScope: "unknown" }),
      rec({ tool: "pct_exec", vmid: 101, hashScope: "unknown" }),
    ];
    expect(filterAuditRecords(hashed, { hashScopeContains: "app.conf" })).toHaveLength(1);
    expect(filterAuditRecords(hashed, { unknownScopeOnly: true })).toHaveLength(2);
    expect(filterAuditRecords(hashed, { hashEquals: "deadbeef" })).toHaveLength(1); // matches afterHash
    expect(filterAuditRecords(hashed, { hashEquals: "cafe" })).toHaveLength(1); // matches beforeHash
    expect(filterAuditRecords(hashed, { hashEquals: "nope" })).toHaveLength(0);
  });
});

describe("summarizeAuditRecords", () => {
  it("counts by tool/vmid and spans the timestamp range", () => {
    const s = summarizeAuditRecords(RECORDS);
    expect(s.total).toBe(5);
    expect(s.byTool).toEqual({ write_file: 2, qm_exec: 2, pct_exec: 1 });
    expect(s.byVmid).toEqual({ "100": 2, "101": 1 });
    expect(s.firstTs).toBe("2026-06-01T10:00:00.000Z");
    expect(s.lastTs).toBe("2026-06-10T10:00:00.000Z");
  });

  it("handles an empty set", () => {
    const s = summarizeAuditRecords([]);
    expect(s).toEqual({ total: 0, byTool: {}, byVmid: {}, firstTs: null, lastTs: null });
  });
});

describe("queryAuditHandler", () => {
  it("returns newest-first records and a summary over the full filtered set", () => {
    const res = queryAuditHandler({ tool: "qm_exec" }, fakeAudit(RECORDS), makeConfig());
    expect(res.summary.total).toBe(2);
    expect(res.records.map((r) => r.cmd)).toEqual(["df", "uptime"]); // newest first
  });

  it("clamps limit to the configured max and applies the default", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      rec({ ts: `2026-06-10T00:00:${String(i).padStart(2, "0")}.000Z`, tool: "execute" })
    );
    const audit = fakeAudit(many);
    // default limit 50
    expect(queryAuditHandler({}, audit, makeConfig()).records).toHaveLength(50);
    // requested 9999 clamps to max 200
    expect(queryAuditHandler({ limit: 9999 }, audit, makeConfig()).records).toHaveLength(200);
    // summary still reflects everything
    expect(queryAuditHandler({ limit: 9999 }, audit, makeConfig()).summary.total).toBe(300);
  });
});

describe("projectAuditCmd (ADR-017 §1 cmd projection)", () => {
  const LONG = "docker exec qbittorrent sh -c 'cat /config/qBittorrent/qBittorrent.conf | grep -i password'";
  const SET: AuditRecord[] = [
    rec({ tool: "qm_exec", cmd: LONG }),
    rec({ tool: "qm_exec", cmd: "df" }),
    rec({ tool: "write_file", path: "/etc/hosts" }), // no cmd
  ];

  it("is a no-op when no cmdMaxChars is given (default-invariance)", () => {
    const out = projectAuditCmd(SET, {});
    expect(out).toBe(SET); // same reference — provably additive
    expect(out[0]?.cmd).toBe(LONG);
  });

  it("cmdFull forces verbatim even with cmdMaxChars set", () => {
    const out = projectAuditCmd(SET, { cmdMaxChars: 10, cmdFull: true });
    expect(out).toBe(SET);
    expect(out[0]?.cmd).toBe(LONG);
  });

  it("truncates an over-long cmd to a head window + accurate dropped-count marker", () => {
    const out = projectAuditCmd(SET, { cmdMaxChars: 20 });
    const dropped = LONG.length - 20;
    expect(out[0]?.cmd).toBe(`${LONG.slice(0, 20)}…(+${dropped} chars)`);
    // does NOT mutate the input
    expect(SET[0]?.cmd).toBe(LONG);
  });

  it("leaves a cmd at/under the window and an absent cmd untouched", () => {
    const out = projectAuditCmd(SET, { cmdMaxChars: 100 });
    expect(out[1]?.cmd).toBe("df"); // under window, unchanged
    expect(out[2]?.cmd).toBeUndefined(); // no cmd, passthrough
    // boundary: exactly equal length is not truncated
    expect(projectAuditCmd([rec({ cmd: "abcde" })], { cmdMaxChars: 5 })[0]?.cmd).toBe("abcde");
  });

  it("the handler projects only the returned page, never the summary", () => {
    const res = queryAuditHandler({ tool: "qm_exec", cmdMaxChars: 5 }, fakeAudit(SET), makeConfig());
    expect(res.records.find((r) => r.cmd?.startsWith("docke"))?.cmd).toMatch(/^docke…\(\+\d+ chars\)$/);
    expect(res.summary.total).toBe(2); // summary unaffected by projection
  });
});
