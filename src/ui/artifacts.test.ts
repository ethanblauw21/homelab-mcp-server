import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ArtifactReader, snapshotAgeLabel } from "./artifacts.js";
import { SnapshotStore } from "./snapshotStore.js";
import type { Config } from "../config.js";

/** ADR-010 §2 — the renderer half: pure age labels, credential-free, cached-only. */

describe("snapshotAgeLabel (pure honest-UI rule)", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");

  it("tells the user to run the tool when there is no snapshot", () => {
    expect(snapshotAgeLabel(null, now)).toMatch(/no snapshot yet/i);
  });

  it("renders relative ages and always includes the raw timestamp", () => {
    expect(snapshotAgeLabel("2026-06-14T11:59:30.000Z", now)).toMatch(/30 seconds ago/);
    expect(snapshotAgeLabel("2026-06-14T11:00:00.000Z", now)).toMatch(/1 hour ago/);
    expect(snapshotAgeLabel("2026-06-13T12:00:00.000Z", now)).toMatch(/1 day ago/);
    // The exact ts is always appended so a cached panel can never imply liveness.
    expect(snapshotAgeLabel("2026-06-14T11:00:00.000Z", now)).toContain("2026-06-14T11:00:00.000Z");
  });

  it("clamps a future timestamp to 'just now' rather than going negative", () => {
    expect(snapshotAgeLabel("2026-06-14T12:00:30.000Z", now)).toMatch(/just now/);
  });

  it("degrades gracefully on an unparseable timestamp", () => {
    expect(snapshotAgeLabel("not-a-date", now)).toMatch(/not-a-date/);
  });
});

describe("ArtifactReader — credential-free by source (the §2 hard rule)", () => {
  it("never imports an SSH or API client", () => {
    // A source-scan is the enforcement: the renderer must hold NO node credentials.
    // Scan the import SPECIFIERS only — the head comment legitimately *names* the
    // forbidden modules to document the rule, so a raw substring scan false-positives.
    const src = fs.readFileSync(path.join(__dirname, "artifacts.ts"), "utf8");
    const specifiers = [...src.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of specifiers) {
      for (const forbidden of ["ssh2Client", "apiClient", "apiBackend", "sshBackend", "ssh2"]) {
        expect(
          spec.toLowerCase().includes(forbidden.toLowerCase()),
          `artifacts.ts imports a credentialed module (${spec})`
        ).toBe(false);
      }
    }
    // Sanity: the scan actually found imports (guards against a regex that matches nothing).
    expect(specifiers.length).toBeGreaterThan(3);
  });
});

describe("ArtifactReader — cached panels", () => {
  let dir: string;
  let cfg: Config;
  const now = new Date("2026-06-14T12:00:00.000Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-artifacts-"));
    cfg = {
      census: { censusDir: path.join(dir, "census"), snapshotRetentionCap: 5 },
      ui: {
        healthDir: path.join(dir, "health"),
        healthRetentionCap: 5,
        driftDir: path.join(dir, "drift"),
        driftRetentionCap: 5,
      },
      audit: { logPath: path.join(dir, "audit.jsonl") },
      history: { configHistoryDir: path.join(dir, "history") },
      tools: { queryAuditDefaultLimit: 50, queryAuditMaxLimit: 200 },
    } as unknown as Config;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports available:false with a 'run the tool' note when no health snapshot exists", () => {
    const reader = new ArtifactReader(cfg, () => now);
    const panel = reader.healthPanel();
    expect(panel.available).toBe(false);
    expect(panel.data).toBeNull();
    expect(panel.ageLabel).toMatch(/no snapshot yet/i);
  });

  it("loads the LAST persisted drift report (cache, not a live verify) with an age label", () => {
    // Simulate an agent-run verify persisting a report an hour ago.
    const store = new SnapshotStore<unknown>(cfg.ui.driftDir, 5, () => new Date("2026-06-14T11:00:00.000Z"));
    store.save({ level: "l2", drift: [{ path: "host/etc/hosts", status: "unexplained" }] });

    const reader = new ArtifactReader(cfg, () => now);
    const panel = reader.driftPanel();
    expect(panel.available).toBe(true);
    expect(panel.ageLabel).toMatch(/1 hour ago/);
    expect((panel.data as { drift: unknown[] }).drift).toHaveLength(1);
  });

  it("changeFeedPanel degrades to available:false when there is no git repo", async () => {
    const reader = new ArtifactReader(cfg, () => now);
    const panel = await reader.changeFeedPanel();
    expect(panel.available).toBe(false);
    expect(panel.ageLabel).toMatch(/no config-history repo/i);
  });
});
