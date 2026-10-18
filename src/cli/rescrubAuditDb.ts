#!/usr/bin/env node
/**
 * ADR-027 — `node dist/cli/rescrubAuditDb.js [--db <path>] [--key <path>] [--apply] [--no-backup] [--list]`
 *
 * One-time re-redaction of audit.db rows written before ADR-026. DRY RUN by
 * default: it prints how many rows would change, by column and tool, and touches
 * nothing. `--apply` writes the changes; before that it copies audit.db to
 * `audit.db.pre-rescrub-<timestamp>` (unless `--no-backup`). That copy still holds
 * the old, unredacted text — delete it once you have checked the result.
 *
 * Stop every MCP session that uses this audit.db first (the server writes to it).
 * Output never contains row text — only ids, timestamps, tools and counts.
 */
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { rescrubAuditDb } from "../audit/auditDbRescrub.js";
import { setRedactionFingerprintKey } from "../guardrails/redaction.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (flag: string): boolean => process.argv.includes(flag);

if (has("--help") || has("-h")) {
  process.stdout.write(
    "usage: node dist/cli/rescrubAuditDb.js [--db <audit.db>] [--key <redaction.key>] [--apply] [--no-backup] [--list]\n" +
      "Dry run unless --apply. Default --db: $AUDIT_DB_PATH, else <LOCALAPPDATA or ~/AppData/Local>/claude-mcp/audit.db.\n"
  );
  process.exit(0);
}

const localData = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "claude-mcp");
const dbPath = arg("--db") ?? process.env.AUDIT_DB_PATH ?? path.join(localData, "audit.db");
const keyPath = arg("--key") ?? process.env.REDACTION_KEY_PATH ?? path.join(path.dirname(dbPath), "redaction.key");
const apply = has("--apply");

if (!fs.existsSync(dbPath)) {
  process.stderr.write(`audit.db not found at ${dbPath} (pass --db).\n`);
  process.exit(2);
}

// Use the install's key so new markers carry the same fp= as live output. Read
// only: this tool never creates a key.
if (fs.existsSync(keyPath)) {
  const hex = fs.readFileSync(keyPath, "utf8").trim();
  if (/^[0-9a-f]{64}$/.test(hex)) setRedactionFingerprintKey(Buffer.from(hex, "hex"));
  else process.stderr.write(`warning: ${keyPath} is malformed; new markers will carry no fp=.\n`);
} else {
  process.stderr.write(`warning: no redaction key at ${keyPath}; new markers will carry no fp=.\n`);
}

let backup: string | undefined;
if (apply && !has("--no-backup")) {
  backup = `${dbPath}.pre-rescrub-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

const db = new Database(dbPath, { fileMustExist: true, readonly: !apply });
db.pragma("busy_timeout = 5000");
try {
  let report = rescrubAuditDb(db, { apply: false });
  if (apply && report.changed > 0) {
    if (backup) {
      db.pragma("wal_checkpoint(TRUNCATE)");
      fs.copyFileSync(dbPath, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    report = rescrubAuditDb(db, { apply: true });
  } else {
    backup = undefined;
  }
  if (report.applied) db.exec("VACUUM");
  const { rows, ...summary } = report;
  process.stdout.write(`${apply ? "APPLY" : "DRY RUN"} — ${dbPath}\n`);
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (has("--list")) for (const r of rows) process.stdout.write(`${r.ts}  ${r.tool}  ${r.id}  [${r.columns.join(",")}]  +${r.redactions}\n`);
  if (!apply && report.changed > 0) process.stdout.write("Nothing was written. Re-run with --apply to rewrite these rows.\n");
  if (backup) {
    process.stdout.write(
      `Backup: ${backup}\nIt still holds the OLD, unredacted text. Check the result, then delete it.\n`
    );
  }
} finally {
  db.close();
}
