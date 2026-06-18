import { describe, it, expect } from "vitest";
import { SshBackend } from "./sshBackend.js";
import { FakeTransport } from "../ssh/fakeTransport.js";

const TIMEOUT = 5000;

/** A FakeTransport preloaded with `hostname` so resolveNode() succeeds. */
function backendWith(results: Record<string, { stdout?: string; exitCode?: number; stderr?: string }>): {
  be: SshBackend;
  ft: FakeTransport;
} {
  const ft = new FakeTransport();
  ft.setExecResult("hostname", { stdout: "pve\n", stderr: "", exitCode: 0 });
  for (const [cmd, res] of Object.entries(results)) {
    ft.setExecResult(cmd, { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.exitCode ?? 0 });
  }
  return { be: new SshBackend(ft, TIMEOUT), ft };
}

describe("SshBackend.createBackup", () => {
  it("runs vzdump with the mcp- notes and returns a synthetic upid", async () => {
    const cmd = "vzdump 101 --storage local --mode snapshot --compress zstd --notes-template 'mcp-x'";
    const { be } = backendWith({ [cmd]: { stdout: "", exitCode: 0 } });
    const ref = await be.createBackup(101, "lxc", { mode: "snapshot", storage: "local", notes: "mcp-x" });
    expect(ref.upid).toBe("ssh:vzdump:101");
  });

  it("throws when vzdump exits non-zero", async () => {
    const cmd = "vzdump 101 --storage local --mode stop --compress zstd --notes-template 'mcp-x'";
    const { be } = backendWith({ [cmd]: { stdout: "", stderr: "no space", exitCode: 1 } });
    await expect(be.createBackup(101, "lxc", { mode: "stop", storage: "local", notes: "mcp-x" })).rejects.toThrow(/failed/);
  });
});

describe("SshBackend.listBackupArchives", () => {
  it("resolves the node via hostname, parses pvesh JSON, and filters by vmid", async () => {
    const listCmd = "pvesh get /nodes/pve/storage/local/content --content backup --output-format json";
    const json = JSON.stringify([
      { volid: "local:backup/vzdump-lxc-101.tar.zst", vmid: 101, ctime: 100, notes: "mcp-a" },
      { volid: "local:backup/vzdump-lxc-102.tar.zst", vmid: 102, ctime: 200, notes: "nightly" },
    ]);
    const { be } = backendWith({ [listCmd]: { stdout: json, exitCode: 0 } });
    const all = await be.listBackupArchives("local");
    expect(all).toHaveLength(2);
    const one = await be.listBackupArchives("local", 101);
    expect(one).toHaveLength(1);
    expect(one[0]!.notes).toBe("mcp-a");
  });

  it("returns [] when pvesh emits non-JSON", async () => {
    const listCmd = "pvesh get /nodes/pve/storage/local/content --content backup --output-format json";
    const { be } = backendWith({ [listCmd]: { stdout: "not json", exitCode: 0 } });
    expect(await be.listBackupArchives("local")).toEqual([]);
  });

  it("refuses an unexpected hostname before building a pvesh path", async () => {
    const ft = new FakeTransport();
    ft.setExecResult("hostname", { stdout: "bad name;rm\n", stderr: "", exitCode: 0 });
    const be = new SshBackend(ft, TIMEOUT);
    await expect(be.listBackupArchives("local")).rejects.toThrow(/unexpected node name/);
  });
});

describe("SshBackend.restoreBackup / deleteBackupArchive", () => {
  it("restores an LXC via pct restore --force", async () => {
    const cmd = "pct restore 101 'local:backup/a' --force";
    const { be } = backendWith({ [cmd]: { stdout: "", exitCode: 0 } });
    const ref = await be.restoreBackup(101, "lxc", "local:backup/a");
    expect(ref.upid).toBe("ssh:restore:lxc:101");
  });

  it("restores a QEMU via qmrestore", async () => {
    const cmd = "qmrestore 'local:backup/a' 100 --force";
    const { be } = backendWith({ [cmd]: { stdout: "", exitCode: 0 } });
    const ref = await be.restoreBackup(100, "qemu", "local:backup/a");
    expect(ref.upid).toBe("ssh:restore:qemu:100");
  });

  it("frees an archive via pvesm free", async () => {
    const cmd = "pvesm free 'local:backup/a'";
    const { be } = backendWith({ [cmd]: { stdout: "", exitCode: 0 } });
    const ref = await be.deleteBackupArchive("local", "local:backup/a");
    expect(ref.upid).toBe("ssh:free:local:backup/a");
  });
});
