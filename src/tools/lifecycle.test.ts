import { describe, it, expect, beforeEach } from "vitest";
import {
  guestStartHandler,
  guestStopHandler,
  guestRestartHandler,
} from "./lifecycle.js";
import type { NodeOps, Guest, GuestType, TaskRef } from "../node/nodeOps.js";
import type { AuditRecord } from "../audit/record.js";

class FakeNode implements NodeOps {
  readonly kind = "api" as const;
  calls: string[] = [];
  constructor(private guests: Guest[]) {}
  async listGuests(): Promise<Guest[]> {
    return this.guests;
  }
  async guestStatus(): Promise<{ status: string }> {
    return { status: "running" };
  }
  async startGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    this.calls.push(`start:${type}:${vmid}`);
    return { upid: "UPID:start" };
  }
  async stopGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    this.calls.push(`stop:${type}:${vmid}`);
    return { upid: "UPID:stop" };
  }
  async rebootGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    this.calls.push(`reboot:${type}:${vmid}`);
    return { upid: "UPID:reboot" };
  }
  async listSnapshots() { return []; }
  async createSnapshot() { return { upid: "" }; }
  async rollbackSnapshot() { return { upid: "" }; }
  async deleteSnapshot() { return { upid: "" }; }
  async createBackup() { return { upid: "" }; }
  async listBackupArchives() { return []; }
  async restoreBackup() { return { upid: "" }; }
  async deleteBackupArchive() { return { upid: "" }; }
  async nodeStatus() { return {}; }
  async storageStatus() { return []; }
  async aptUpdates() { return []; }
}

let records: AuditRecord[];
const audit = { append: async (r: AuditRecord) => void records.push(r) } as unknown as import("../audit/log.js").AuditLog;
const cfg = { ssh: { host: "node.lan" } } as unknown as import("../config.js").Config;

beforeEach(() => {
  records = [];
});

const guests: Guest[] = [
  { vmid: 100, name: "vm", type: "qemu", status: "running" },
  { vmid: 101, name: "ct", type: "lxc", status: "stopped" },
];

describe("guest_start", () => {
  it("resolves the guest type and starts it, auditing the backend kind", async () => {
    const node = new FakeNode(guests);
    const out = await guestStartHandler({ vmid: 101 }, node, audit, cfg);
    expect(out).toEqual({ vmid: 101, guestType: "lxc", task: "UPID:start" });
    expect(node.calls).toEqual(["start:lxc:101"]);
    expect(records[0]!.tool).toBe("guest_start");
    expect(records[0]!.note).toContain("via api");
    expect(records[0]!.isLargeChange).toBeFalsy();
  });

  it("errors on an unknown vmid", async () => {
    const node = new FakeNode(guests);
    await expect(guestStartHandler({ vmid: 999 }, node, audit, cfg)).rejects.toThrow(/No guest with vmid 999/);
  });
});

describe("guest_stop", () => {
  it("refuses without confirm and performs no stop", async () => {
    const node = new FakeNode(guests);
    await expect(guestStopHandler({ vmid: 100, confirm: false }, node, audit, cfg)).rejects.toThrow(/confirm: true/);
    expect(node.calls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("stops with confirm and marks a large change", async () => {
    const node = new FakeNode(guests);
    const out = await guestStopHandler({ vmid: 100, confirm: true }, node, audit, cfg);
    expect(out.guestType).toBe("qemu");
    expect(node.calls).toEqual(["stop:qemu:100"]);
    expect(records[0]!.isLargeChange).toBe(true);
  });
});

describe("guest_restart", () => {
  it("reboots the guest", async () => {
    const node = new FakeNode(guests);
    const out = await guestRestartHandler({ vmid: 100 }, node, audit, cfg);
    expect(out.task).toBe("UPID:reboot");
    expect(node.calls).toEqual(["reboot:qemu:100"]);
  });
});

describe("rootTier audit flag", () => {
  it("stamps rootTier:true when running at root tier", async () => {
    const node = new FakeNode(guests);
    await guestStartHandler({ vmid: 100 }, node, audit, cfg, true);
    expect(records[0]!.rootTier).toBe(true);
  });
  it("omits rootTier below root", async () => {
    const node = new FakeNode(guests);
    await guestStartHandler({ vmid: 100 }, node, audit, cfg, false);
    expect(records[0]!.rootTier).toBeUndefined();
  });
});
