import { describe, it, expect, beforeEach } from "vitest";
import { guestBackupHandler, guestBackupRestoreHandler } from "./backupTools.js";
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
    return { upid: "UPID:vzdump" };
  }
  async listBackupArchives(_storage: string, vmid?: number): Promise<BackupArchive[]> {
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
  async storageStatus() {
    return [];
  }
  async aptUpdates() {
    return [];
  }
}

let records: AuditRecord[];
const audit = { append: async (r: AuditRecord) => void records.push(r) } as unknown as import("../audit/log.js").AuditLog;
const cfg = {
  ssh: { host: "node.lan" },
  backup: { nodeBackupStorage: "local", guestArchivePerGuestCap: 1 },
} as unknown as import("../config.js").Config;

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

  it("evicts the oldest mcp- archive BEFORE creating (cap 1, incoming 1 → keep none of the old)", async () => {
    const node = new FakeNode(guests, [
      mcpArchive("local:backup/old", 101, 100),
      mcpArchive("local:backup/new", 101, 200),
    ]);
    const out = await guestBackupHandler({ vmid: 101, mode: "snapshot", confirm: true }, node, audit, cfg, NOW);
    // cap 1, incoming 1 → allowed 0 → both pre-existing mcp- archives evicted, then create.
    expect(out.evicted).toEqual(["local:backup/new", "local:backup/old"]);
    const deleteCalls = node.calls.filter((c) => c.startsWith("delete:"));
    const createIdx = node.calls.findIndex((c) => c.startsWith("create:"));
    // every delete precedes the create
    expect(deleteCalls).toHaveLength(2);
    expect(node.calls.slice(0, 2).every((c) => c.startsWith("delete:"))).toBe(true);
    expect(createIdx).toBe(2);
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
});
