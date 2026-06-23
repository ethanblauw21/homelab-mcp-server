import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { AuditDb } from "./auditDb.js";
import { filterAuditRecords, type AuditFilters } from "../tools/queryAudit.js";
import type { AuditRecord } from "./record.js";

const OPTS = { storeDiffs: true, redactDiffs: true, diffMaxBytes: 64 * 1024 };

function rec(p: Partial<AuditRecord>): AuditRecord {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    ts: p.ts ?? "2026-06-10T00:00:00.000Z",
    tool: p.tool ?? "execute",
    ...p,
  } as AuditRecord;
}

function freshDb(opts = OPTS): AuditDb {
  return new AuditDb(new Database(":memory:"), opts);
}

const RECORDS: AuditRecord[] = [
  rec({ id: "a", ts: "2026-06-01T10:00:00.000Z", tool: "write_file", path: "/etc/hosts", isLargeChange: false }),
  rec({ id: "b", ts: "2026-06-05T10:00:00.000Z", tool: "qm_exec", vmid: 100, cmd: "uptime" }),
  rec({ id: "c", ts: "2026-06-08T10:00:00.000Z", tool: "write_file", path: "/etc/network/interfaces", isLargeChange: true }),
  rec({ id: "d", ts: "2026-06-09T10:00:00.000Z", tool: "qm_exec", vmid: 100, cmd: "df" }),
  rec({ id: "e", ts: "2026-06-10T10:00:00.000Z", tool: "pct_exec", vmid: 101, hashScope: "unknown" }),
];

function seed(db: AuditDb, records = RECORDS): void {
  for (const r of records) db.insert(r);
}

describe("AuditDb — projection + reconstruction", () => {
  it("round-trips a record byte-identically through the raw column", () => {
    const db = freshDb();
    const r = rec({ id: "x", tool: "write_file", path: "/etc/app.conf", beforeHash: "cafe", afterHash: "beef", vmid: 7 });
    db.insert(r);
    expect(db.queryRecords({})).toEqual([r]);
  });

  it("counts inserts and is idempotent on id (ON CONFLICT DO NOTHING)", () => {
    const db = freshDb();
    db.insert(rec({ id: "dup", cmd: "first" }));
    db.insert(rec({ id: "dup", cmd: "second" }));
    expect(db.count()).toBe(1);
    expect(db.has("dup")).toBe(true);
    expect(db.queryRecords({})[0]?.cmd).toBe("first"); // first write wins
  });

  it("returns records newest-first", () => {
    const db = freshDb();
    seed(db);
    expect(db.queryRecords({}).map((r) => r.id)).toEqual(["e", "d", "c", "b", "a"]);
  });
});

describe("AuditDb.queryRecords — structured filters parity with filterAuditRecords", () => {
  // Every structured filter must return the SAME set the pure JSONL scan does.
  const CASES: { name: string; f: AuditFilters }[] = [
    { name: "tool", f: { tool: "qm_exec" } },
    { name: "vmid", f: { vmid: 100 } },
    { name: "largeOnly", f: { largeOnly: true } },
    { name: "pathContains", f: { pathContains: "network" } },
    { name: "since+until range", f: { since: "2026-06-05T00:00:00.000Z", until: "2026-06-09T23:59:59.000Z" } },
    { name: "unknownScopeOnly", f: { unknownScopeOnly: true } },
    { name: "combined AND", f: { tool: "qm_exec", vmid: 100, since: "2026-06-06T00:00:00.000Z" } },
  ];

  for (const c of CASES) {
    it(`matches the JSONL fallback for ${c.name}`, () => {
      const db = freshDb();
      seed(db);
      const fast = db.queryRecords(c.f).map((r) => r.id).sort();
      const slow = filterAuditRecords(RECORDS, c.f).map((r) => r.id).sort();
      expect(fast).toEqual(slow);
    });
  }

  it("pathContains is case-sensitive, matching String.includes() (instr, not LIKE)", () => {
    const db = freshDb();
    db.insert(rec({ id: "u", tool: "write_file", path: "/etc/HOSTS" }));
    // lowercase query must NOT match the uppercase path — parity with includes()
    expect(db.queryRecords({ pathContains: "hosts" })).toHaveLength(0);
    expect(filterAuditRecords([rec({ path: "/etc/HOSTS" })], { pathContains: "hosts" })).toHaveLength(0);
    expect(db.queryRecords({ pathContains: "HOSTS" })).toHaveLength(1);
  });

  it("hashScopeContains and hashEquals resolve against the indexed columns", () => {
    const db = freshDb();
    db.insert(rec({ id: "h", tool: "write_file", path: "/etc/app.conf", hashScope: "/etc/app.conf", beforeHash: "cafe", afterHash: "deadbeef" }));
    expect(db.queryRecords({ hashScopeContains: "app.conf" })).toHaveLength(1);
    expect(db.queryRecords({ hashEquals: "deadbeef" }).map((r) => r.id)).toEqual(["h"]); // afterHash
    expect(db.queryRecords({ hashEquals: "cafe" }).map((r) => r.id)).toEqual(["h"]); // beforeHash
    expect(db.queryRecords({ hashEquals: "nope" })).toHaveLength(0);
  });
});

describe("AuditDb.queryRecords — FTS5 free-text search", () => {
  it("matches a token in cmd", () => {
    const db = freshDb();
    seed(db);
    expect(db.queryRecords({}, "uptime").map((r) => r.id)).toEqual(["b"]);
  });

  it("matches text in the stored (redacted) diff", () => {
    const db = freshDb();
    db.insert(rec({ id: "wf", tool: "write_file", path: "/etc/nginx.conf" }), "+ server_name example.com");
    expect(db.queryRecords({}, "server_name").map((r) => r.id)).toEqual(["wf"]);
  });

  it("AND-combines multiple tokens (all must be present)", () => {
    const db = freshDb();
    db.insert(rec({ id: "m1", cmd: "docker restart" }), null);
    db.insert(rec({ id: "m2", cmd: "docker logs" }), null);
    expect(db.queryRecords({}, "docker restart").map((r) => r.id)).toEqual(["m1"]);
  });

  it("combines FTS with a structured filter (AND)", () => {
    const db = freshDb();
    db.insert(rec({ id: "f1", tool: "qm_exec", vmid: 100, cmd: "systemctl status" }));
    db.insert(rec({ id: "f2", tool: "qm_exec", vmid: 200, cmd: "systemctl status" }));
    expect(db.queryRecords({ vmid: 100 }, "systemctl").map((r) => r.id)).toEqual(["f1"]);
  });

  it("does not throw on FTS operator-like input (tokens are quoted literals)", () => {
    const db = freshDb();
    db.insert(rec({ id: "o", cmd: "delete OR drop" }));
    expect(() => db.queryRecords({}, "OR drop")).not.toThrow();
    expect(db.queryRecords({}, "drop").map((r) => r.id)).toEqual(["o"]);
  });

  it("a token-free search degrades to no FTS constraint (returns all filtered)", () => {
    const db = freshDb();
    seed(db);
    expect(db.queryRecords({ tool: "qm_exec" }, "  !!!  ")).toHaveLength(2);
  });
});

describe("AuditDb — diff storage policy", () => {
  it("redacts secrets before storing the diff and makes the non-secret text searchable", () => {
    const db = freshDb();
    db.insert(rec({ id: "s", tool: "write_file", path: "/etc/app.conf" }), "+password=supersecret123\n+host=db.local");
    const raw = (db as unknown as { db: Database.Database }).db
      .prepare("SELECT diff, diff_redacted FROM audit WHERE id = 's'")
      .get() as { diff: string; diff_redacted: number };
    expect(raw.diff).not.toContain("supersecret123");
    expect(raw.diff_redacted).toBe(1);
    expect(db.queryRecords({}, "db.local").map((r) => r.id)).toEqual(["s"]); // non-secret still searchable
    expect(db.queryRecords({}, "supersecret123")).toHaveLength(0); // secret is gone
  });

  it("stores no diff text when storeDiffs is disabled", () => {
    const db = freshDb({ ...OPTS, storeDiffs: false });
    db.insert(rec({ id: "n", tool: "write_file", path: "/etc/x" }), "+ something");
    const raw = (db as unknown as { db: Database.Database }).db
      .prepare("SELECT diff FROM audit WHERE id = 'n'")
      .get() as { diff: string | null };
    expect(raw.diff).toBeNull();
  });
});

describe("AuditDb.rebuildFrom", () => {
  it("bulk-loads a record set in one transaction, idempotently", () => {
    const db = freshDb();
    db.rebuildFrom(RECORDS);
    expect(db.count()).toBe(RECORDS.length);
    db.rebuildFrom(RECORDS); // replay is a no-op
    expect(db.count()).toBe(RECORDS.length);
  });

  it("recovers diffs via the diffFor callback when provided", () => {
    const db = freshDb();
    db.rebuildFrom([rec({ id: "r", tool: "write_file", path: "/etc/y" })], () => "+ recovered diff line");
    expect(db.queryRecords({}, "recovered").map((r) => r.id)).toEqual(["r"]);
  });
});
