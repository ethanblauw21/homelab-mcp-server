import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { AuditDb } from "./auditDb.js";
import { planRescrub, rescrubAuditDb } from "./auditDbRescrub.js";
import type { AuditRecord } from "./record.js";
import { FAKE_DISCORD_WEBHOOK, FAKE_WEBHOOK_TOKEN } from "../guardrails/redactionFixtures.js";

const OPTS = { storeDiffs: true, redactDiffs: true, diffMaxBytes: 64 * 1024 };
const FAKE_PW = "FAKE-hunter2-not-a-real-password";

/** A row as a pre-ADR-026 server would have projected it: cmd/note/diff unredacted. */
function oldRow(db: Database.Database, id: string, rec: Partial<AuditRecord>, diff?: string): void {
  const r = { id, ts: `2026-10-0${id.length}T00:00:00.000Z`, tool: "execute", ...rec } as AuditRecord;
  new AuditDb(db, OPTS).insert(r);
  if (diff !== undefined) db.prepare("UPDATE audit SET diff = ?, diff_redaction_count = 0 WHERE id = ?").run(diff, id);
}

function seeded(): Database.Database {
  const db = new Database(":memory:");
  oldRow(db, "a", { cmd: `curl -X POST ${FAKE_DISCORD_WEBHOOK}` });
  oldRow(db, "bb", { tool: "write_file", path: "/opt/app/.env", note: "wrote .env" }, `+DB_PASSWORD=${FAKE_PW}\n`);
  oldRow(db, "ccc", { cmd: "uptime", note: "fine" });
  return db;
}

const ftsHits = (db: Database.Database, term: string): number =>
  (db.prepare("SELECT count(*) AS n FROM audit_fts WHERE audit_fts MATCH ?").get(`"${term}"`) as { n: number }).n;

describe("audit.db re-redaction (ADR-027)", () => {
  it("dry run reports what would change and writes nothing", () => {
    const db = seeded();
    const before = db.prepare("SELECT raw, cmd, diff FROM audit ORDER BY rowid").all();
    const r = rescrubAuditDb(db, { apply: false });
    expect(r).toMatchObject({ scanned: 3, changed: 2, applied: false });
    expect(r.byColumn).toEqual({ cmd: 1, raw: 1, diff: 1 });
    expect(r.byTool).toEqual({ execute: 1, write_file: 1 });
    expect(db.prepare("SELECT raw, cmd, diff FROM audit ORDER BY rowid").all()).toEqual(before);
    // the report never carries row text
    expect(JSON.stringify(r)).not.toContain(FAKE_WEBHOOK_TOKEN);
    expect(JSON.stringify(r)).not.toContain(FAKE_PW);
  });

  it("apply redacts cmd, diff and the raw copy, and purges the old tokens from the FTS index", () => {
    const db = seeded();
    expect(ftsHits(db, FAKE_PW)).toBe(1);
    const r = rescrubAuditDb(db, { apply: true });
    expect(r.applied).toBe(true);
    const all = JSON.stringify(db.prepare("SELECT * FROM audit").all());
    expect(all).not.toContain(FAKE_WEBHOOK_TOKEN);
    expect(all).not.toContain(FAKE_PW);
    expect(all).toContain("<redacted len=");
    expect(ftsHits(db, FAKE_PW)).toBe(0);
    // raw still parses and still round-trips the record shape
    const raw = JSON.parse((db.prepare("SELECT raw FROM audit WHERE id = 'a'").get() as { raw: string }).raw);
    expect(raw).toMatchObject({ id: "a", tool: "execute" });
    expect(raw.cmd).toMatch(/^curl -X POST https:\/\/discord\.com\/api\/webhooks\/.*<redacted/);
    const d = db.prepare("SELECT diff_redacted, diff_redaction_count FROM audit WHERE id = 'bb'").get();
    expect(d).toEqual({ diff_redacted: 1, diff_redaction_count: 1 });
  });

  it("is idempotent: a second run changes nothing", () => {
    const db = seeded();
    rescrubAuditDb(db, { apply: true });
    expect(rescrubAuditDb(db, { apply: true })).toMatchObject({ changed: 0, applied: false });
  });

  it("planRescrub scrubs an unparsable raw as text", () => {
    const [c] = planRescrub([
      { rowid: 1, id: "x", ts: "t", tool: "execute", cmd: null, note: null, diff: null, diff_redaction_count: null, raw: `not json PASSWORD=${FAKE_PW}` },
    ]);
    expect(c!.columns).toEqual(["raw"]);
    expect(c!.next.raw).not.toContain(FAKE_PW);
  });
});
