import { describe, it, expect, beforeEach } from "vitest";
import { guestBackupHandler, guestBackupRestoreHandler, guestBackupListHandler } from "./backupTools.js";
import type { NodeOps, Guest, GuestType, TaskRef, BackupArchive, BackupCreateOpts } from "../node/nodeOps.js";
import type { AuditRecord } from "../audit/record.js";

/** A NodeOps fake that records backup-relevant calls and serves a fixed archive listing. */
class FakeNode implements NodeOps {
  readonly kind = "api" as const;
  calls: string[] = [];
  createOpts?: BackupCreateOpts;
  constructor(
    private guests: Guest[],
    private archives: BackupArchive[] = [],
    private status: string = "running"
  ) {}
  async listGuests(): Promise<Guest[]> {
    return this.guests;
  }
  async guestStatus(): Promise<{ status: string }> {
    return { status: this.status };
  }
  async startGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    this.calls.push(`start:${type}:${vmid}`);
    return { upid: "UPID:start" };
  }
  async stopGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    this.calls.push(`stop:${type}:${vmid}`);
    return { upid: "UPID:stop" };
  }
  async rebootGuest(): Promise<TaskRef> {
    return { upid: "" };
  }
  async listSnapshots() {
    return [];
  }
  async createSnapshot() {
    return { upid: "" };
  }
  async rollbackSnapshot() {
    return { upid: "" };
  }
  async deleteSnapshot() {
    return { upid: "" };
  }
  async createBackup(vmid: number, type: GuestType, opts: BackupCreateOpts): Promise<TaskRef> {
    this.calls.push(`create:${type}:${vmid}:${opts.mode}`);
    this.createOpts = opts;
    // Mirror Proxmox: the new archive appears in the listing, carrying the notes we
    // passed (the mcp- ownership tag). A node-LOCAL-time filename — deliberately NOT
    // reconstructable from our UTC note — so the volid must be recovered by listing.
    this.archives.push({
      volid: `${opts.storage}:backup/vzdump-${type}-${vmid}-2026_06_30-local.tar.zst`,
      vmid,
      ctime: 9999,
      notes: opts.notes,
    });
    return { upid: "UPID:vzdump" };
  }
  lastListStorage?: string;
  async listBackupArchives(storage: string, vmid?: number): Promise<BackupArchive[]> {
    this.lastListStorage = storage;
    return vmid === undefined ? this.archives : this.archives.filter((a) => a.vmid === vmid);
  }
  async restoreBackup(vmid: number, type: GuestType, volid: string): Promise<TaskRef> {
    this.calls.push(`restore:${type}:${vmid}:${volid}`);
    return { upid: "UPID:restore" };
  }
  async deleteBackupArchive(_storage: string, volid: string): Promise<TaskRef> {
    this.calls.push(`delete:${volid}`);
    return { upid: "UPID:del" };
  }
  async nodeStatus() {
    return {};
  }
  storages: import("../node/nodeOps.js").StorageStatusInfo[] = [];
  async storageStatus() {
    return this.storages;
  }
  async aptUpdates() {
    return [];
  }
}

/**
 * ADR-023 #9 — a FakeNode that ALSO implements the optional `taskStatus` poll, so
 * the API path's vzdump-completion check is exercised. `seq` is returned one entry
 * per poll (the last entry repeats). Its presence is what makes `guestBackupHandler`
 * poll at all (base FakeNode omits it → poll skipped, the SSH-like synchronous case).
 */
class FakeNodeWithTask extends FakeNode {
  pollCount = 0;
  private seq: Array<{ status: string; exitstatus?: string }>;
  constructor(
    guests: Guest[],
    archives: BackupArchive[],
    seq: Array<{ status: string; exitstatus?: string }>
  ) {
    super(guests, archives);
    this.seq = seq;
  }
  async taskStatus(): Promise<{ status: string; exitstatus?: string }> {
    const i = Math.min(this.pollCount, this.seq.length - 1);
    this.pollCount++;
    return this.seq[i]!;
  }
}

let records: AuditRecord[];
const audit = { append: async (r: AuditRecord) => void records.push(r) } as unknown as import("../audit/log.js").AuditLog;
const cfg = {
  ssh: { host: "node.lan" },
  backup: { nodeBackupStorage: "local", guestArchivePerGuestCap: 1, taskPollIntervalMs: 10, taskTimeoutMs: 1000 },
} as unknown as import("../config.js").Config;

/** No-op sleep so the task poll loop terminates instantly under test. */
const noSleep = async (): Promise<void> => {};

const NOW = new Date(Date.UTC(2026, 5, 14, 15, 30, 5));

const guests: Guest[] = [
  { vmid: 100, name: "vm", type: "qemu", status: "running" },
  { vmid: 101, name: "ct", type: "lxc", status: "running" },
];

const mcpArchive = (volid: string, vmid: number, ctime: number): BackupArchive => ({
  volid,
  vmid,
  ctime,
  notes: "mcp-old",
});

beforeEach(() => {
  records = [];
});

describe("guest_backup", () => {
  it("refuses without confirm and performs no work", async () => {
    const node = new FakeNode(guests);
    await expect(guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: false }, node, audit, cfg, NOW)).rejects.toThrow(
      /confirm: true/
    );
    expect(node.calls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("creates a backup with a generated mcp- note and audits a large change", async () => {
    const node = new FakeNode(guests, []);
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    expect(out.guestType).toBe("lxc");
    expect(out.note).toBe("mcp-20260614-153005");
    expect(out.task).toBe("UPID:vzdump");
    expect(out.evicted).toEqual([]);
    expect(node.createOpts).toMatchObject({ mode: "snapshot", storage: "local", notes: "mcp-20260614-153005" });
    expect(records[0]!.tool).toBe("guest_backup");
    expect(records[0]!.isLargeChange).toBe(true);
  });

  it("appends a human note to the mcp- archive notes", async () => {
    const node = new FakeNode(guests, []);
    const out = await guestBackupHandler({ vmid: 101, mode: "stop", note: "pre-edit", confirm: true }, node, audit, cfg, NOW);
    expect(out.note).toBe("mcp-20260614-153005 — pre-edit");
  });

  it("resolves and returns the created archive's volid by note-match (H9/F9)", async () => {
    const node = new FakeNode(guests, []);
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    // vzdump named the file in node-local time; the volid is recovered by re-listing
    // and matching our exact UTC note, not reconstructed from the timestamp string.
    expect(out.volid).toBe("local:backup/vzdump-lxc-101-2026_06_30-local.tar.zst");
    expect(records[0]!.note).toContain("volid local:backup/vzdump-lxc-101-2026_06_30-local.tar.zst");
  });

  it("returns volid null (best-effort) when the listing carries no matching note", async () => {
    // A pre-existing foreign archive with different notes; the created one would
    // normally match, but simulate a notes mismatch by stubbing list to drop notes.
    const node = new FakeNode(guests, []);
    node.listBackupArchives = async () => [{ volid: "local:backup/x", vmid: 101, notes: "someone-elses" }];
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    expect(out.volid).toBeNull();
  });

  it("creates the new archive FIRST and only then evicts the old mcp- archive (ADR-027)", async () => {
    const node = new FakeNode(guests, [
      mcpArchive("local:backup/old", 101, 100),
      mcpArchive("local:backup/new", 101, 200),
    ]);
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    // cap 1 → keep only the archive just created; both older mcp- archives go, after the create.
    expect(out.status).toBe("completed");
    expect(out.evicted).toEqual(["local:backup/new", "local:backup/old"]);
    expect(node.calls[0]).toMatch(/^create:/);
    expect(node.calls.slice(1)).toEqual(["delete:local:backup/new", "delete:local:backup/old"]);
    expect(out.volid).toBe("local:backup/vzdump-lxc-101-2026_06_30-local.tar.zst");
    expect(node.calls).not.toContain(`delete:${out.volid}`);
  });

  it("never evicts the archive it just created, even with cap 0", async () => {
    const node = new FakeNode(guests, [mcpArchive("local:backup/old", 101, 100)]);
    const cap0 = { ...cfg, backup: { ...cfg.backup, guestArchivePerGuestCap: 0 } } as typeof cfg;
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cap0, NOW);
    expect(out.evicted).toEqual(["local:backup/old"]);
  });

  it("evicts nothing when vzdump fails (SSH-style synchronous throw) and audits the failure", async () => {
    const node = new FakeNode(guests, [mcpArchive("local:backup/old", 101, 100)]);
    node.createBackup = async () => {
      throw new Error("`vzdump 101 ...` failed (exit 255): ERROR: Backup of VM 101 failed - disk full");
    };
    await expect(
      guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW)
    ).rejects.toThrow(/disk full.*No archive was evicted/);
    expect(node.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.failed).toBe(true);
  });

  it("keeps the old archive when the new archive's volid cannot be resolved", async () => {
    const node = new FakeNode(guests, [mcpArchive("local:backup/old", 101, 100)]);
    const list = node.listBackupArchives.bind(node);
    let n = 0;
    // first listing (pre-create) is real; the post-create listing fails
    node.listBackupArchives = async (s, v) => {
      if (n++ > 0) throw new Error("listing unavailable");
      return list(s, v);
    };
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    expect(out.volid).toBeNull();
    expect(out.evicted).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/retention was skipped/);
  });

  it("reports an eviction failure after a successful backup instead of throwing", async () => {
    const node = new FakeNode(guests, [mcpArchive("local:backup/old", 101, 100)]);
    node.deleteBackupArchive = async () => {
      throw new Error("volume is locked");
    };
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    expect(out.status).toBe("completed");
    expect(out.evictionErrors).toEqual(["local:backup/old: volume is locked"]);
    expect(records[0]!.note).toMatch(/eviction failed for local:backup\/old/);
  });

  it("refuses up front when the storage cannot hold one extra archive (nothing deleted or created)", async () => {
    const node = new FakeNode(guests, [{ ...mcpArchive("media:backup/old", 101, 100), sizeBytes: 90 * 2 ** 30 }]);
    node.storages = [
      { storage: "media", type: "dir", enabled: true, active: true, totalBytes: 0, usedBytes: 0, availBytes: 50 * 2 ** 30 },
    ];
    await expect(
      guestBackupHandler({ vmid: 101, mode: "snapshot", storage: "media", confirm: true }, node, audit, cfg, NOW)
    ).rejects.toThrow(/50\.0 GiB free.*90\.0 GiB.*evictBeforeCreate.*Nothing was deleted or created/);
    expect(node.calls).toEqual([]);
  });

  it("proceeds when the storage has room for one extra archive", async () => {
    const node = new FakeNode(guests, [{ ...mcpArchive("media:backup/old", 101, 100), sizeBytes: 10 * 2 ** 30 }]);
    node.storages = [
      { storage: "media", type: "dir", enabled: true, active: true, totalBytes: 0, usedBytes: 0, availBytes: 50 * 2 ** 30 },
    ];
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", storage: "media", confirm: true }, node, audit, cfg, NOW);
    expect(out.evicted).toEqual(["media:backup/old"]);
    expect(out.warnings).toEqual([]);
  });

  it("warns (does not refuse) when free space cannot be checked", async () => {
    const node = new FakeNode(guests, [mcpArchive("local:backup/old", 101, 100)]); // no size, no storage row
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    expect(out.warnings.join(" ")).toMatch(/Could not confirm "local" has room/);
  });

  it("evictBeforeCreate restores the old order deliberately, with a warning", async () => {
    const node = new FakeNode(guests, [mcpArchive("local:backup/old", 101, 100)]);
    const out = await guestBackupHandler(
      { vmid: 101, mode: "snapshot", evictBeforeCreate: true, confirm: true },
      node,
      audit,
      cfg,
      NOW
    );
    expect(node.calls[0]).toBe("delete:local:backup/old");
    expect(node.calls[1]).toMatch(/^create:/);
    expect(out.warnings.join(" ")).toMatch(/deleted before vzdump ran/);
  });

  it("never evicts human-made archives", async () => {
    const node = new FakeNode(guests, [
      { volid: "local:backup/human", vmid: 101, ctime: 50, notes: "nightly" },
    ]);
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    expect(out.evicted).toEqual([]);
    expect(node.calls.some((c) => c.includes("human"))).toBe(false);
  });

  it("errors on an unknown vmid", async () => {
    const node = new FakeNode(guests);
    await expect(guestBackupHandler({ vmid: 999, mode: "snapshot", confirm: true }, node, audit, cfg, NOW)).rejects.toThrow(
      /No guest with vmid 999/
    );
  });

  // --- ADR-023 #9: per-call storage override + vzdump task-completion polling ---

  it("honors a per-call storage override (the fix for the `local` wrong-content-type footgun)", async () => {
    const node = new FakeNode(guests, []);
    const out = await guestBackupHandler(
      { vmid: 101, mode: "snapshot", storage: "media-backup", confirm: true },
      node,
      audit,
      cfg,
      NOW
    );
    expect(out.storage).toBe("media-backup");
    expect(node.createOpts).toMatchObject({ storage: "media-backup" });
  });

  it("refuses a storage name with illegal characters before doing any work", async () => {
    const node = new FakeNode(guests, []);
    await expect(
      guestBackupHandler({ vmid: 101, mode: "snapshot", storage: "bad name", confirm: true }, node, audit, cfg, NOW)
    ).rejects.toThrow();
    expect(node.calls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("polls the vzdump task and reports verified success on the API path (ADR-023 #9)", async () => {
    const node = new FakeNodeWithTask(guests, [], [{ status: "running" }, { status: "stopped", exitstatus: "OK" }]);
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW, noSleep);
    expect(out.taskStatus).toBe("OK");
    expect(node.pollCount).toBe(2); // ran (running) → polled again (stopped OK)
    expect(records[0]!.tool).toBe("guest_backup");
    expect(records[0]!.isLargeChange).toBe(true);
  });

  it("surfaces an async vzdump failure LOUDLY instead of reporting false success (ADR-023 #9 headline)", async () => {
    // The exact live failure: `local` lacks the `backup` content type.
    const node = new FakeNodeWithTask(guests, [], [
      { status: "stopped", exitstatus: "could not get storage information for 'local': wrong content type" },
    ]);
    await expect(
      guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW, noSleep)
    ).rejects.toThrow(/failed: could not get storage information.*wrong content type.*must have the `backup` content type/);
    // The create was issued, but the outcome is recorded as a FAILURE, not a large-change success.
    expect(node.calls.some((c) => c.startsWith("create:"))).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]!.tool).toBe("guest_backup");
    expect(records[0]!.isLargeChange).toBe(false);
    expect(records[0]!.note).toMatch(/FAILED/);
  });

  it("reports a timeout as PENDING, not a failure: no throw, no eviction, no content-type hint (ADR-027)", async () => {
    const node = new FakeNodeWithTask(guests, [mcpArchive("local:backup/old", 101, 100)], [{ status: "running" }]); // never stops
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW, noSleep);
    expect(out.status).toBe("pending");
    expect(out.task).toBe("UPID:vzdump");
    expect(out.taskStatus).toMatch(/still running after 1000ms/);
    expect(out.volid).toBeNull();
    expect(out.evicted).toEqual([]);
    expect(out.pendingEviction).toEqual(["local:backup/old"]);
    expect(node.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/content type/);
    expect(text).toMatch(/guest_backup_list/);
    expect(text).toMatch(/lock: backup/);
    expect(records).toHaveLength(1);
    expect(records[0]!.pending).toBe(true);
    expect(records[0]!.failed).toBeUndefined();
    expect(records[0]!.note).toMatch(/PENDING/);
    expect(records[0]!.note).not.toMatch(/FAILED/);
  });

  it("honours a per-call timeoutMs override for the wait", async () => {
    const node = new FakeNodeWithTask(guests, [], [{ status: "running" }]);
    const out = await guestBackupHandler(
      { vmid: 101, mode: "snapshot", timeoutMs: 120_000, confirm: true },
      node,
      audit,
      cfg,
      NOW,
      noSleep
    );
    expect(out.taskStatus).toMatch(/still running after 120000ms/);
    expect(node.pollCount).toBe(12_000); // 120000 / 10ms interval
  });

  it("passes the wait as the SSH backend's vzdump timeout", async () => {
    const node = new FakeNode(guests, []);
    await guestBackupHandler({ vmid: 101, mode: "snapshot", timeoutMs: 3_600_000, confirm: true }, node, audit, cfg, NOW);
    expect(node.createOpts?.timeoutMs).toBe(3_600_000);
  });

  it("omits the content-type hint when the failure has nothing to do with storage", async () => {
    const node = new FakeNodeWithTask(guests, [], [{ status: "stopped", exitstatus: "job errors" }]);
    const err = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW, noSleep).catch(
      (e: Error) => e
    );
    expect((err as Error).message).toMatch(/failed: job errors/);
    expect((err as Error).message).not.toMatch(/content type/);
  });

  it("retries a status poll that throws, and still completes", async () => {
    const node = new FakeNodeWithTask(guests, [], [{ status: "stopped", exitstatus: "OK" }]);
    const real = node.taskStatus.bind(node);
    let first = true;
    node.taskStatus = async () => {
      if (first) {
        first = false;
        throw new Error("ECONNRESET");
      }
      return real();
    };
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW, noSleep);
    expect(out.status).toBe("completed");
  });
});

describe("guest_backup_restore", () => {
  const archive = "local:backup/vzdump-lxc-101.tar.zst";

  it("refuses without confirm", async () => {
    const node = new FakeNode(guests, [{ volid: archive, vmid: 101, notes: "mcp-x" }]);
    await expect(
      guestBackupRestoreHandler({ vmid: 101, archive, confirm: false, stopIfRunning: false }, node, audit, cfg)
    ).rejects.toThrow(/confirm: true/);
    expect(node.calls).toEqual([]);
  });

  it("refuses an archive that is not found for the guest", async () => {
    const node = new FakeNode(guests, []);
    await expect(
      guestBackupRestoreHandler({ vmid: 101, archive, confirm: true, stopIfRunning: true }, node, audit, cfg)
    ).rejects.toThrow(/not found/);
  });

  it("refuses a non-mcp (human-made) archive", async () => {
    const node = new FakeNode(guests, [{ volid: archive, vmid: 101, notes: "nightly backup" }]);
    await expect(
      guestBackupRestoreHandler({ vmid: 101, archive, confirm: true, stopIfRunning: true }, node, audit, cfg)
    ).rejects.toThrow(/only server-managed \(mcp-\) archives/);
    expect(node.calls).toEqual([]);
  });

  it("refuses a running guest unless stopIfRunning is set", async () => {
    const node = new FakeNode(guests, [{ volid: archive, vmid: 101, notes: "mcp-x" }], "running");
    await expect(
      guestBackupRestoreHandler({ vmid: 101, archive, confirm: true, stopIfRunning: false }, node, audit, cfg)
    ).rejects.toThrow(/running/);
    expect(node.calls).toEqual([]);
  });

  it("stops, restores, and restarts a running guest when stopIfRunning is set", async () => {
    const node = new FakeNode(guests, [{ volid: archive, vmid: 101, notes: "mcp-x" }], "running");
    const out = await guestBackupRestoreHandler(
      { vmid: 101, archive, confirm: true, stopIfRunning: true },
      node,
      audit,
      cfg
    );
    expect(out.restarted).toBe(true);
    expect(node.calls).toEqual([`stop:lxc:101`, `restore:lxc:101:${archive}`, `start:lxc:101`]);
    expect(records[0]!.tool).toBe("guest_backup_restore");
    expect(records[0]!.isLargeChange).toBe(true);
    expect(records[0]!.note).toContain("running (restarted)");
  });

  it("restores a stopped guest without stop/start", async () => {
    const node = new FakeNode(guests, [{ volid: archive, vmid: 101, notes: "mcp-x" }], "stopped");
    const out = await guestBackupRestoreHandler(
      { vmid: 101, archive, confirm: true, stopIfRunning: false },
      node,
      audit,
      cfg
    );
    expect(out.restarted).toBe(false);
    expect(node.calls).toEqual([`restore:lxc:101:${archive}`]);
    expect(records[0]!.note).toContain("stopped");
  });

  it("searches the storage NAMED BY THE VOLID, not the config default (H3/F8)", async () => {
    // The archive lives on media-backup (config default is "local", which lacks the
    // `backup` content type). Restore must derive storage from the volid prefix, else
    // the archive guest_backup created is never findable.
    const mb = "media-backup:backup/vzdump-lxc-101-2026_06_24-19_21_33.tar.zst";
    const node = new FakeNode(guests, [{ volid: mb, vmid: 101, notes: "mcp-x" }], "stopped");
    const out = await guestBackupRestoreHandler(
      { vmid: 101, archive: mb, confirm: true, stopIfRunning: false },
      node,
      audit,
      cfg
    );
    expect(node.lastListStorage).toBe("media-backup");
    expect(cfg.backup.nodeBackupStorage).toBe("local"); // proves it did NOT use the default
    expect(out.restarted).toBe(false);
    expect(node.calls).toEqual([`restore:lxc:101:${mb}`]);
  });

  it("rejects a malformed archive volid before touching the node (H3/F8)", async () => {
    const node = new FakeNode(guests, [], "stopped");
    await expect(
      guestBackupRestoreHandler(
        { vmid: 101, archive: "no-storage-prefix.tar.zst", confirm: true, stopIfRunning: true },
        node,
        audit,
        cfg
      )
    ).rejects.toThrow(/Invalid backup volid/);
    expect(node.calls).toEqual([]);
  });
});

describe("guest_backup_list (H9/F9)", () => {
  const archives: BackupArchive[] = [
    { volid: "media-backup:backup/mcp-old", vmid: 101, ctime: 100, notes: "mcp-20260101-000000" },
    { volid: "media-backup:backup/mcp-new", vmid: 101, ctime: 300, notes: "mcp-20260301-000000 — pre-edit" },
    { volid: "media-backup:backup/human", vmid: 101, ctime: 200, notes: "nightly" },
  ];

  it("lists mcp- archives newest-first and flags ownership, hiding foreign by default", async () => {
    const node = new FakeNode(guests, [...archives]);
    const out = await guestBackupListHandler({ vmid: 101, storage: "media-backup" }, node, cfg);
    expect(node.lastListStorage).toBe("media-backup");
    expect(out.archives.map((a) => a.volid)).toEqual([
      "media-backup:backup/mcp-new",
      "media-backup:backup/mcp-old",
    ]);
    expect(out.archives.every((a) => a.mcpManaged)).toBe(true);
  });

  it("includeForeign surfaces human archives too (still newest-first)", async () => {
    const node = new FakeNode(guests, [...archives]);
    const out = await guestBackupListHandler(
      { vmid: 101, storage: "media-backup", includeForeign: true },
      node,
      cfg
    );
    expect(out.archives.map((a) => a.volid)).toEqual([
      "media-backup:backup/mcp-new",
      "media-backup:backup/human",
      "media-backup:backup/mcp-old",
    ]);
    expect(out.archives.find((a) => a.volid.endsWith("human"))!.mcpManaged).toBe(false);
  });

  it("defaults the storage to the config default and validates it", async () => {
    const node = new FakeNode(guests, []);
    const out = await guestBackupListHandler({}, node, cfg);
    expect(out.storage).toBe("local");
    expect(node.lastListStorage).toBe("local");
    await expect(
      guestBackupListHandler({ storage: "bad name" }, node, cfg)
    ).rejects.toThrow(/Invalid storage/);
  });
});
