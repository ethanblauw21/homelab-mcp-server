import { describe, it, expect } from "vitest";
import { ApiBackend, buildTokenHeader, mapApiError, type ApiHttp, type ApiResponse } from "./apiBackend.js";

/** A fixture ApiHttp: matches (method, path) prefixes to recorded responses. */
function fixtureHttp(routes: Array<{ method: string; path: string; res: ApiResponse }>): {
  http: ApiHttp;
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const http: ApiHttp = async (req) => {
    calls.push(req);
    const hit = routes.find((r) => r.method === req.method && req.path === r.path);
    if (!hit) throw new Error(`no fixture for ${req.method} ${req.path}`);
    return hit.res;
  };
  return { http, calls };
}

const NODE = "pve";
const ok = (data: unknown): ApiResponse => ({ status: 200, json: { data } });

describe("buildTokenHeader", () => {
  it("formats PVEAPIToken=<id>=<secret>", () => {
    expect(buildTokenHeader("mcp@pve!observe", "abc-123")).toBe("PVEAPIToken=mcp@pve!observe=abc-123");
  });
});

describe("mapApiError", () => {
  it("maps 401 to an auth error naming the token env vars", () => {
    const e = mapApiError(401, { message: "no ticket" }, "list qemu");
    expect(e.message).toContain("401");
    expect(e.message).toContain("token id/secret rejected");
    expect(e.message).toContain("PVE_API_TOKEN_ID");
  });
  it("maps 403 to an RBAC/tier permission error", () => {
    const e = mapApiError(403, { message: "Permission check failed" }, "start qemu 100");
    expect(e.message).toContain("403");
    expect(e.message).toContain("Proxmox RBAC enforcing your tier");
    expect(e.message).toContain("Permission check failed");
  });
  it("maps 5xx to a node error", () => {
    const e = mapApiError(500, "Internal Server Error", "node status");
    expect(e.message).toContain("500");
    expect(e.message).toContain("node error");
  });
});

describe("ApiBackend.listGuests", () => {
  it("merges qemu + lxc and sorts by vmid", async () => {
    const { http } = fixtureHttp([
      { method: "GET", path: `/nodes/${NODE}/qemu`, res: ok([{ vmid: 200, name: "vm-b", status: "running" }]) },
      { method: "GET", path: `/nodes/${NODE}/lxc`, res: ok([{ vmid: 101, name: "ct-a", status: "stopped" }]) },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const guests = await be.listGuests();
    expect(guests).toEqual([
      { vmid: 101, name: "ct-a", type: "lxc", status: "stopped" },
      { vmid: 200, name: "vm-b", type: "qemu", status: "running" },
    ]);
  });
});

describe("ApiBackend.guestStatus", () => {
  it("reads status/current for a VM", async () => {
    const { http } = fixtureHttp([
      { method: "GET", path: `/nodes/${NODE}/qemu/100/status/current`, res: ok({ status: "running" }) },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    expect(await be.guestStatus(100, "qemu")).toEqual({ status: "running" });
  });
});

describe("ApiBackend lifecycle", () => {
  it("POSTs start/stop/reboot to the right endpoint and returns the UPID", async () => {
    const upid = "UPID:pve:00001:start::";
    const { http, calls } = fixtureHttp([
      { method: "POST", path: `/nodes/${NODE}/lxc/101/status/start`, res: ok(upid) },
      { method: "POST", path: `/nodes/${NODE}/lxc/101/status/stop`, res: ok(upid) },
      { method: "POST", path: `/nodes/${NODE}/lxc/101/status/reboot`, res: ok(upid) },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    expect((await be.startGuest(101, "lxc")).upid).toBe(upid);
    expect((await be.stopGuest(101, "lxc")).upid).toBe(upid);
    expect((await be.rebootGuest(101, "lxc")).upid).toBe(upid);
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "POST"]);
  });
});

describe("ApiBackend snapshots", () => {
  it("lists snapshots and drops the synthetic 'current' node", async () => {
    const { http } = fixtureHttp([
      {
        method: "GET",
        path: `/nodes/${NODE}/qemu/100/snapshot`,
        res: ok([
          { name: "current", description: "You are here!" },
          { name: "mcp-20260610", description: "pre-change", snaptime: 1717000000 },
        ]),
      },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const snaps = await be.listSnapshots(100, "qemu");
    expect(snaps).toEqual([{ name: "mcp-20260610", description: "pre-change", snaptime: 1717000000, parent: undefined }]);
  });

  it("creates a snapshot with vmstate for a VM and forwards the description", async () => {
    const { http, calls } = fixtureHttp([
      { method: "POST", path: `/nodes/${NODE}/qemu/100/snapshot`, res: ok("UPID:snap") },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const ref = await be.createSnapshot(100, "qemu", "mcp-x", { description: "d", vmstate: true });
    expect(ref.upid).toBe("UPID:snap");
    expect(calls[0]!.body).toEqual({ snapname: "mcp-x", description: "d", vmstate: 1 });
  });

  it("does not set vmstate for a container", async () => {
    const { http, calls } = fixtureHttp([
      { method: "POST", path: `/nodes/${NODE}/lxc/101/snapshot`, res: ok("UPID:snap") },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    await be.createSnapshot(101, "lxc", "mcp-x", { vmstate: true });
    expect(calls[0]!.body).toEqual({ snapname: "mcp-x" });
  });

  it("DELETEs a named snapshot", async () => {
    const { http, calls } = fixtureHttp([
      { method: "DELETE", path: `/nodes/${NODE}/lxc/101/snapshot/mcp-x`, res: ok("UPID:del") },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    await be.deleteSnapshot(101, "lxc", "mcp-x");
    expect(calls[0]!.method).toBe("DELETE");
  });
});

describe("ApiBackend error propagation", () => {
  it("throws the structured 403 on a permission-denied lifecycle call", async () => {
    const { http } = fixtureHttp([
      {
        method: "POST",
        path: `/nodes/${NODE}/qemu/100/status/start`,
        res: { status: 403, json: { message: "Permission check failed (/vms/100, VM.PowerMgmt)" } },
      },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    await expect(be.startGuest(100, "qemu")).rejects.toThrow(/403/);
    await expect(be.startGuest(100, "qemu")).rejects.toThrow(/Proxmox RBAC/);
  });
});

describe("ApiBackend node/storage/apt", () => {
  it("parses node status memory + loadavg", async () => {
    const { http } = fixtureHttp([
      {
        method: "GET",
        path: `/nodes/${NODE}/status`,
        res: ok({ loadavg: ["0.10", "0.20", "0.30"], memory: { total: 100, used: 40 }, uptime: 1234 }),
      },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    expect(await be.nodeStatus()).toEqual({
      loadavg: [0.1, 0.2, 0.3],
      memoryTotal: 100,
      memoryUsed: 40,
      uptimeSecs: 1234,
    });
  });

  it("maps storage status flags", async () => {
    const { http } = fixtureHttp([
      {
        method: "GET",
        path: `/nodes/${NODE}/storage`,
        res: ok([{ storage: "local", type: "dir", enabled: 1, active: 1, total: 100, used: 25, avail: 75 }]),
      },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const st = await be.storageStatus();
    expect(st[0]).toEqual({
      storage: "local",
      type: "dir",
      enabled: true,
      active: true,
      totalBytes: 100,
      usedBytes: 25,
      availBytes: 75,
    });
  });

  it("lists apt updates (simulate endpoint)", async () => {
    const { http } = fixtureHttp([
      { method: "GET", path: `/nodes/${NODE}/apt/update`, res: ok([{ Package: "bash", Version: "5.2-1" }]) },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    expect(await be.aptUpdates()).toEqual([{ package: "bash", version: "5.2-1" }]);
  });
});

describe("ApiBackend backups (ADR-008 §6)", () => {
  it("POSTs /vzdump with the notes-template, compress, and remove:0 (mcp- owns rotation)", async () => {
    const { http, calls } = fixtureHttp([
      { method: "POST", path: `/nodes/${NODE}/vzdump`, res: ok("UPID:vzdump") },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const ref = await be.createBackup(101, "lxc", { mode: "snapshot", storage: "local", notes: "mcp-x" });
    expect(ref.upid).toBe("UPID:vzdump");
    expect(calls[0]!.body).toEqual({
      vmid: 101,
      storage: "local",
      mode: "snapshot",
      compress: "zstd",
      "notes-template": "mcp-x",
      remove: 0,
    });
  });

  it("polls a task's terminal status by url-encoded UPID (ADR-023 #9)", async () => {
    const upid = "UPID:pve:00001234:00ABCDEF:64A:vzdump:101:root@pam:";
    const encoded = `/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`;
    const { http, calls } = fixtureHttp([
      { method: "GET", path: encoded, res: ok({ status: "stopped", exitstatus: "OK", upid }) },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const st = await be.taskStatus(upid);
    expect(st).toEqual({ status: "stopped", exitstatus: "OK" });
    expect(calls[0]!.path).toBe(encoded);
  });

  it("reports a running task's status with no exitstatus yet", async () => {
    const upid = "UPID:running";
    const { http } = fixtureHttp([
      { method: "GET", path: `/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`, res: ok({ status: "running" }) },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    expect(await be.taskStatus(upid)).toEqual({ status: "running", exitstatus: undefined });
  });

  it("lists archives on a storage and filters to one vmid", async () => {
    const { http } = fixtureHttp([
      {
        method: "GET",
        path: `/nodes/${NODE}/storage/local/content?content=backup`,
        res: ok([
          { volid: "local:backup/vzdump-lxc-101.tar.zst", vmid: 101, ctime: 100, notes: "mcp-a" },
          { volid: "local:backup/vzdump-lxc-102.tar.zst", vmid: 102, ctime: 200, notes: "nightly" },
        ]),
      },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const all = await be.listBackupArchives("local");
    expect(all).toHaveLength(2);
    const filtered = await be.listBackupArchives("local", 101);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.volid).toBe("local:backup/vzdump-lxc-101.tar.zst");
  });

  it("restores an LXC via POST /lxc with ostemplate+restore+force", async () => {
    const { http, calls } = fixtureHttp([
      { method: "POST", path: `/nodes/${NODE}/lxc`, res: ok("UPID:restore") },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    const ref = await be.restoreBackup(101, "lxc", "local:backup/a");
    expect(ref.upid).toBe("UPID:restore");
    expect(calls[0]!.body).toEqual({ vmid: 101, ostemplate: "local:backup/a", restore: 1, force: 1 });
  });

  it("restores a QEMU via POST /qemu with archive+force", async () => {
    const { http, calls } = fixtureHttp([
      { method: "POST", path: `/nodes/${NODE}/qemu`, res: ok("UPID:restore") },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    await be.restoreBackup(100, "qemu", "local:backup/a");
    expect(calls[0]!.body).toEqual({ vmid: 100, archive: "local:backup/a", force: 1 });
  });

  it("DELETEs an archive by url-encoded volid", async () => {
    const volid = "local:backup/vzdump-lxc-101.tar.zst";
    const { http, calls } = fixtureHttp([
      {
        method: "DELETE",
        path: `/nodes/${NODE}/storage/local/content/${encodeURIComponent(volid)}`,
        res: ok("UPID:del"),
      },
    ]);
    const be = new ApiBackend(http, { node: NODE });
    await be.deleteBackupArchive("local", volid);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toContain(encodeURIComponent(volid));
  });
});
