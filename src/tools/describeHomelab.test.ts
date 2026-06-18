import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FakeTransport } from "../ssh/fakeTransport.js";
import { buildPctExecCommand } from "./pctHelpers.js";
import { describeHomelabHandler, DescribeHomelabInputSchema } from "./describeHomelab.js";
import { CensusStore } from "./censusStore.js";
import type { Config } from "../config.js";
import type { NodeOps, Guest, NodeStatusInfo, StorageStatusInfo, AptUpdateInfo } from "../node/nodeOps.js";

/** Minimal API-backend stand-in for the observe/operate census path (§6). */
function fakeNode(overrides: Partial<NodeOps> = {}): NodeOps {
  const base: NodeOps = {
    kind: "api",
    async listGuests(): Promise<Guest[]> {
      return [
        { vmid: 101, name: "gluetun", type: "lxc", status: "running" },
        { vmid: 102, name: "portainer", type: "lxc", status: "stopped" },
        { vmid: 100, name: "truenas", type: "qemu", status: "running" },
      ];
    },
    async guestStatus() {
      return { status: "running" };
    },
    async startGuest() {
      return { upid: "x" };
    },
    async stopGuest() {
      return { upid: "x" };
    },
    async rebootGuest() {
      return { upid: "x" };
    },
    async listSnapshots() {
      return [];
    },
    async createSnapshot() {
      return { upid: "x" };
    },
    async rollbackSnapshot() {
      return { upid: "x" };
    },
    async deleteSnapshot() {
      return { upid: "x" };
    },
    async createBackup() {
      return { upid: "x" };
    },
    async listBackupArchives() {
      return [];
    },
    async restoreBackup() {
      return { upid: "x" };
    },
    async deleteBackupArchive() {
      return { upid: "x" };
    },
    async nodeStatus(): Promise<NodeStatusInfo> {
      return {
        loadavg: [0.1, 0.2, 0.3],
        memoryTotal: 16766517248,
        memoryUsed: 4233470720,
        uptimeSecs: 266400,
        version: "pve-manager/8.1.4",
        cpuCount: 8,
      };
    },
    async storageStatus(): Promise<StorageStatusInfo[]> {
      return [
        { storage: "local", type: "dir", enabled: true, active: true, totalBytes: 100660736, usedBytes: 7475200, availBytes: 93185536 },
      ];
    },
    async aptUpdates(): Promise<AptUpdateInfo[]> {
      return [];
    },
  };
  return { ...base, ...overrides };
}

function makeConfig(censusDir: string, overrides: Partial<Config["census"]> = {}): Config {
  return {
    ssh: {
      host: "10.0.0.10",
      port: 22,
      username: "root",
      privateKeyPath: "",
      keepaliveInterval: 10_000,
      reconnectDelay: 3_000,
      commandTimeoutMs: 30_000,
      skipHostVerification: true,
    },
    backup: {
      baseDir: censusDir,
      largeFileBytesThreshold: 1024,
      largeFilePolicy: "diff",
      perFileVersionCap: 10,
      globalSizeCapBytes: 1024 * 1024,
      diskPressureFailSafe: "warn",
    },
    audit: { logPath: path.join(censusDir, "audit.jsonl") },
    census: {
      censusDir,
      snapshotRetentionCap: 30,
      probeTimeoutMs: 10_000,
      budgetMs: 120_000,
      storageDriftPercent: 10,
      redactionExtraKeys: [],
      maxItemsPerSection: 200,
      maxResponseBytes: 512 * 1024,
      ...overrides,
    },
    guardrails: { commandDenylist: [], pathDenylist: [] },
  } as Config;
}

function baseTransport(): FakeTransport {
  const t = new FakeTransport();
  t.setExecResult("pveversion", { stdout: "pve-manager/8.1.4/abc (running kernel: 6.5.11-7-pve)", stderr: "", exitCode: 0 });
  t.setExecResult("uptime -p", { stdout: "up 3 days, 2 hours\n", stderr: "", exitCode: 0 });
  t.setExecResult("nproc", { stdout: "8\n", stderr: "", exitCode: 0 });
  t.setExecResult("cat /proc/loadavg", { stdout: "0.10 0.20 0.30 1/100 999", stderr: "", exitCode: 0 });
  t.setExecResult("free -b", { stdout: "Mem: 16766517248 4233470720 8000000000 0 0 12000000000\nSwap: 0 0 0", stderr: "", exitCode: 0 });
  t.setExecResult("pvesm status", {
    stdout: "Name Type Status Total Used Available %\nlocal dir active 100660736 7475200 93185536 7.43%",
    stderr: "",
    exitCode: 0,
  });
  t.setExecResult("ip -br addr", { stdout: "lo UNKNOWN 127.0.0.1/8\nvmbr0 UP 10.0.0.10/24", stderr: "", exitCode: 0 });
  t.setExecResult("cat /etc/network/interfaces", {
    stdout: "auto vmbr0\niface vmbr0 inet static\n    address 10.0.0.10/24\n    bridge-ports eno1",
    stderr: "",
    exitCode: 0,
  });
  t.setExecResult("pct list", {
    stdout: "VMID Status Lock Name\n101 running gluetun\n102 stopped portainer",
    stderr: "",
    exitCode: 0,
  });
  t.setExecResult("qm list", {
    stdout: "VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID\n100 truenas running 8192 32.00 1234",
    stderr: "",
    exitCode: 0,
  });
  return t;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "census-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function parse(input: unknown) {
  return DescribeHomelabInputSchema.parse(input);
}

describe("describeHomelabHandler — summary depth", () => {
  it("populates all sections without per-guest config", async () => {
    const t = baseTransport();
    const store = new CensusStore(tmpDir, 30);
    const cfg = makeConfig(tmpDir);
    const snap = await describeHomelabHandler(parse({}), t, store, cfg);

    expect(snap.host).toBe("10.0.0.10");
    expect(snap.depth).toBe("summary");
    expect(snap.sections.node?.version).toBe("8.1.4");
    expect(snap.sections.node?.cpu).toBe(8);
    expect(snap.sections.storage?.[0]).toMatchObject({ name: "local", active: true });
    expect(snap.sections.network?.bridges[0]).toMatchObject({ name: "vmbr0" });
    expect(snap.sections.containers).toHaveLength(2);
    expect(snap.sections.containers?.[0]).toMatchObject({ vmid: 101, name: "gluetun", status: "running" });
    expect(snap.sections.containers?.[0]?.config).toBeUndefined(); // summary => no config
    expect(snap.sections.vms?.[0]).toMatchObject({ vmid: 100, name: "truenas" });
    expect(snap.errors).toEqual([]);
    expect(snap.snapshotPath).toBeTruthy();
    expect(fs.existsSync(snap.snapshotPath!)).toBe(true);
  });

  it("returns tailscale: null when tailscale is absent (no error)", async () => {
    const t = baseTransport(); // tailscale probe returns default empty/exit 0
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ sections: ["tailscale"] }), t, store, makeConfig(tmpDir));
    expect(snap.sections.tailscale).toBeNull();
    expect(snap.errors).toEqual([]);
  });

  it("honors the sections filter", async () => {
    const t = baseTransport();
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ sections: ["node"] }), t, store, makeConfig(tmpDir));
    expect(snap.sections.node).toBeDefined();
    expect(snap.sections.containers).toBeUndefined();
    expect(snap.sections.storage).toBeUndefined();
  });
});

describe("describeHomelabHandler — full depth redaction", () => {
  it("includes redacted per-guest config and counts redactions", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 101", {
      stdout: [
        "arch: amd64",
        "cores: 2",
        "hostname: gluetun",
        "memory: 1024",
        "net0: name=eth0,bridge=vmbr0,ip=dhcp",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    t.setExecResult("pct config 102", {
      stdout: "arch: amd64\ncores: 1\npassword: supersecret",
      stderr: "",
      exitCode: 0,
    });
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ depth: "full", sections: ["containers"] }), t, store, makeConfig(tmpDir));

    const gluetun = snap.sections.containers?.find((c) => c.vmid === 101);
    expect(gluetun?.config?.cores).toBe("2");
    expect(gluetun?.config?.hostname).toBe("gluetun");

    const portainer = snap.sections.containers?.find((c) => c.vmid === 102);
    expect(portainer?.config?.password).toBe("[REDACTED:password]");
    expect(JSON.stringify(snap)).not.toContain("supersecret");
    expect(snap.redactions).toBe(1);

    // ADR-008 §5 — snapshotCapable is populated at full depth. Neither config
    // carries a device or a storage map (storage section not requested), so the
    // heuristic returns best-effort capable.
    expect(gluetun?.snapshotCapable).toEqual({ capable: true });
    expect(portainer?.snapshotCapable).toEqual({ capable: true });
  });

  it("marks a device-passthrough container snapshot-incapable (ADR-008 §5)", async () => {
    const t = baseTransport();
    t.setExecResult("pct config 101", {
      stdout: ["arch: amd64", "rootfs: local-lvm:subvol-101-disk-0,size=8G", "dev0: /dev/dri/renderD128,gid=104"].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    t.setExecResult("pct config 102", { stdout: "arch: amd64\nrootfs: local-lvm:subvol-102-disk-0,size=8G", stderr: "", exitCode: 0 });
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ depth: "full", sections: ["containers"] }), t, store, makeConfig(tmpDir));

    const gpu = snap.sections.containers?.find((c) => c.vmid === 101);
    expect(gpu?.snapshotCapable).toEqual({ capable: false, reason: "device passthrough" });
    const plain = snap.sections.containers?.find((c) => c.vmid === 102);
    expect(plain?.snapshotCapable).toEqual({ capable: true });
  });

  it("marks a dir-backed rootfs snapshot-incapable when the storage section is observed (ADR-008 §5)", async () => {
    const t = baseTransport();
    // local is dir-typed in baseTransport's pvesm output; back CT101's rootfs on it.
    t.setExecResult("pct config 101", { stdout: "arch: amd64\nrootfs: local:subvol-101-disk-0,size=8G", stderr: "", exitCode: 0 });
    t.setExecResult("pct config 102", { stdout: "arch: amd64\nrootfs: local-lvm:subvol-102-disk-0,size=8G", stderr: "", exitCode: 0 });
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(
      parse({ depth: "full", sections: ["storage", "containers"] }),
      t,
      store,
      makeConfig(tmpDir)
    );

    const dirBacked = snap.sections.containers?.find((c) => c.vmid === 101);
    expect(dirBacked?.snapshotCapable?.capable).toBe(false);
    expect(dirBacked?.snapshotCapable?.reason).toMatch(/dir storage/i);
    const lvm = snap.sections.containers?.find((c) => c.vmid === 102);
    expect(lvm?.snapshotCapable).toEqual({ capable: true });
  });
});

describe("describeHomelabHandler — error isolation", () => {
  it("records a section error and keeps other sections intact", async () => {
    const t = baseTransport();
    t.setExecResult("qm list", { stdout: "", stderr: "qm: command failed", exitCode: 2 });
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ sections: ["node", "vms"] }), t, store, makeConfig(tmpDir));

    expect(snap.sections.node?.version).toBe("8.1.4"); // intact
    expect(snap.sections.vms).toEqual([]); // fallback
    expect(snap.errors.some((e) => e.section === "vms" && e.probe === "qm list")).toBe(true);
  });
});

describe("describeHomelabHandler — global time budget", () => {
  it("stops early and records a budget error, skipping snapshot save", async () => {
    const t = baseTransport();
    const store = new CensusStore(tmpDir, 30);
    const cfg = makeConfig(tmpDir, { budgetMs: 0 });
    let tick = 0;
    const now = () => tick++; // deadline = 0; first probe sees now()=1 > 0
    const snap = await describeHomelabHandler(parse({}), t, store, cfg, now);

    expect(snap.errors.some((e) => e.probe === "(budget)")).toBe(true);
    expect(snap.snapshotPath).toBeUndefined(); // not saved on budget hit
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });
});

describe("describeHomelabHandler — services", () => {
  it("reports failed units and docker containers for running containers only", async () => {
    const t = baseTransport();
    t.setExecResult(
      buildPctExecCommand(101, "systemctl list-units --failed --no-legend --plain"),
      { stdout: "smartd.service loaded failed failed Self Monitoring", stderr: "", exitCode: 0 }
    );
    t.setExecResult(
      buildPctExecCommand(
        101,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      ),
      { stdout: "gluetun\tqmcgaw/gluetun:latest\tUp 3 days", stderr: "", exitCode: 0 }
    );
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ sections: ["services"] }), t, store, makeConfig(tmpDir));

    expect(snap.sections.services).toHaveLength(1); // only vmid 101 is running
    expect(snap.sections.services?.[0]).toMatchObject({ vmid: 101, failedUnits: ["smartd.service"] });
    expect(snap.sections.services?.[0]?.docker[0]).toMatchObject({ name: "gluetun" });
  });
});

describe("describeHomelabHandler — tailscale-in-guest detection (#22)", () => {
  it("reports a tailscale container in a guest when the host has no daemon", async () => {
    const t = baseTransport();
    // Host has no tailscale daemon: the status probe returns nothing.
    t.setExecResult("tailscale status --json", { stdout: "", stderr: "command not found", exitCode: 127 });
    // The running container 101 runs a tailscale docker image.
    t.setExecResult(
      buildPctExecCommand(101, "systemctl list-units --failed --no-legend --plain"),
      { stdout: "", stderr: "", exitCode: 0 }
    );
    t.setExecResult(
      buildPctExecCommand(
        101,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      ),
      { stdout: "ts-node\ttailscale/tailscale:v1.62\tUp 2 days", stderr: "", exitCode: 0 }
    );
    const store = new CensusStore(tmpDir, 30);
    // services must be requested too — the fallback scans its collected rows.
    const snap = await describeHomelabHandler(
      parse({ sections: ["services", "tailscale"] }),
      t,
      store,
      makeConfig(tmpDir)
    );
    expect(snap.sections.tailscale).toEqual({
      self: "",
      peerCount: 0,
      detectedInGuests: [{ vmid: 101, container: "ts-node", image: "tailscale/tailscale:v1.62" }],
    });
  });

  it("reports tailscale: null when neither the host nor any guest has it (#22)", async () => {
    const t = baseTransport();
    t.setExecResult("tailscale status --json", { stdout: "", stderr: "command not found", exitCode: 127 });
    t.setExecResult(
      buildPctExecCommand(101, "systemctl list-units --failed --no-legend --plain"),
      { stdout: "", stderr: "", exitCode: 0 }
    );
    t.setExecResult(
      buildPctExecCommand(
        101,
        'command -v docker >/dev/null 2>&1 && docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}" || true'
      ),
      { stdout: "web\tnginx:latest\tUp 5 days", stderr: "", exitCode: 0 }
    );
    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(
      parse({ sections: ["services", "tailscale"] }),
      t,
      store,
      makeConfig(tmpDir)
    );
    expect(snap.sections.tailscale).toBeNull();
  });
});

describe("describeHomelabHandler — vms agent status (ADR-005 A3)", () => {
  it("reports agent responsiveness from ping and enabled from config", async () => {
    const t = baseTransport();
    // Two running VMs + one stopped. 100 responds to ping; 200 does not.
    t.setExecResult("qm list", {
      stdout:
        "VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID\n" +
        "100 truenas running 8192 32.00 1234\n" +
        "200 winvm running 4096 64.00 5678\n" +
        "300 oldvm stopped 2048 16.00 -",
      stderr: "",
      exitCode: 0,
    });
    t.setExecResult("qm agent 100 ping", { stdout: "", stderr: "", exitCode: 0 });
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "QEMU guest agent is not running", exitCode: 255 });
    t.setExecResult("qm config 100", { stdout: "agent: enabled=1,fstrim_cloned_disks=1\ncores: 4", stderr: "", exitCode: 0 });
    t.setExecResult("qm config 200", { stdout: "agent: 0\ncores: 2", stderr: "", exitCode: 0 });

    const store = new CensusStore(tmpDir, 30);
    const snap = await describeHomelabHandler(parse({ depth: "full", sections: ["vms"] }), t, store, makeConfig(tmpDir));

    const v100 = snap.sections.vms?.find((v) => v.vmid === 100);
    const v200 = snap.sections.vms?.find((v) => v.vmid === 200);
    const v300 = snap.sections.vms?.find((v) => v.vmid === 300);

    expect(v100?.agent).toEqual({ enabled: true, running: true });
    // 200 is running but the agent does not answer: running false; config says disabled.
    expect(v200?.agent).toEqual({ enabled: false, running: false });
    // Stopped VM is not pinged; with no config-derived enabled we leave agent unset.
    expect(v300?.agent).toBeUndefined();
  });
});

describe("describeHomelabHandler — API census path (ADR-007 §6, observe tier)", () => {
  it("serves metadata via NodeOps and marks exec-bound sections unavailableAtTier", async () => {
    const store = new CensusStore(tmpDir, 30);
    const cfg = makeConfig(tmpDir);
    // A throwing SSH transport proves the API path never touches SSH below companion.
    const ssh = new FakeTransport();
    const snap = await describeHomelabHandler(parse({}), ssh, store, cfg, Date.now, fakeNode(), "observe");

    // #12 — the API path normalizes "pve-manager/8.1.4" to the bare "8.1.4",
    // matching the SSH path (which parses `pveversion`).
    expect(snap.sections.node?.version).toBe("8.1.4");
    expect(snap.sections.node?.cpu).toBe(8);
    expect(snap.sections.node?.memBytes).toBe(16766517248);
    expect(snap.sections.storage?.[0]).toMatchObject({ name: "local", active: true });
    expect(snap.sections.containers).toHaveLength(2);
    expect(snap.sections.vms?.[0]).toMatchObject({ vmid: 100, name: "truenas" });

    // Exec-bound sections are a structured status, not an error.
    expect(snap.sections.network).toEqual({ unavailableAtTier: "companion" });
    expect(snap.sections.services).toEqual({ unavailableAtTier: "companion" });
    expect(snap.sections.tailscale).toEqual({ unavailableAtTier: "companion" });
    expect(snap.errors).toEqual([]);
  });

  it("derives the snapshot host from the API base URL when SSH_HOST is empty (#12)", async () => {
    const store = new CensusStore(tmpDir, 30);
    const cfg = makeConfig(tmpDir);
    cfg.ssh.host = ""; // observe/operate: SSH typically unconfigured
    (cfg as Config & { api: { baseUrl: string } }).api = { baseUrl: "https://pve.lan:8006" };
    const snap = await describeHomelabHandler(
      parse({ sections: ["node"] }),
      new FakeTransport(),
      store,
      cfg,
      Date.now,
      fakeNode(),
      "observe"
    );
    expect(snap.host).toBe("pve.lan");
  });

  it("isolates an API section failure as a recorded error (403 RBAC)", async () => {
    const store = new CensusStore(tmpDir, 30);
    const node = fakeNode({
      async storageStatus(): Promise<StorageStatusInfo[]> {
        throw new Error("API permission denied (403) on storage status");
      },
    });
    const snap = await describeHomelabHandler(
      parse({ sections: ["node", "storage"] }),
      new FakeTransport(),
      store,
      makeConfig(tmpDir),
      Date.now,
      node,
      "operate"
    );
    expect(snap.sections.node?.cpu).toBe(8); // intact
    expect(snap.sections.storage).toBeUndefined();
    expect(snap.errors.some((e) => e.section === "storage" && /403/.test(e.error))).toBe(true);
  });

  it("treats an unavailable section as not-observed in drift (never 'removed')", async () => {
    const store = new CensusStore(tmpDir, 30);
    const cfg = makeConfig(tmpDir);
    let tick = 1_000;
    // First run: companion (SSH) census has a full network section.
    await describeHomelabHandler(parse({}), baseTransport(), store, cfg, () => tick);
    // Second run: observe tier — network is unavailableAtTier.
    tick = 2_000_000;
    const snap2 = await describeHomelabHandler(
      parse({ compareToPrevious: true }),
      new FakeTransport(),
      store,
      cfg,
      () => tick,
      fakeNode(),
      "observe"
    );
    expect(snap2.drift).toBeDefined();
    // The previous run saw vmbr0; the unavailable marker must NOT report it removed.
    expect(snap2.drift?.network.removed).toEqual([]);
  });
});

describe("describeHomelabHandler — snapshot persistence + drift", () => {
  it("saves snapshots, enforces retention, and computes drift vs previous", async () => {
    const store = new CensusStore(tmpDir, 2);
    const cfg = makeConfig(tmpDir);

    // First run.
    let tick = 1_000;
    await describeHomelabHandler(parse({}), baseTransport(), store, cfg, () => tick);

    // Second run: container 101 stops.
    const t2 = baseTransport();
    t2.setExecResult("pct list", {
      stdout: "VMID Status Lock Name\n101 stopped gluetun\n102 stopped portainer",
      stderr: "",
      exitCode: 0,
    });
    tick = 2_000_000;
    const snap2 = await describeHomelabHandler(parse({ compareToPrevious: true }), t2, store, cfg, () => tick);

    expect(snap2.drift).toBeDefined();
    expect(snap2.drift?.containers.changed).toEqual([{ vmid: 101, from: "running", to: "stopped" }]);

    // Third run to exercise retention cap of 2.
    tick = 3_000_000;
    await describeHomelabHandler(parse({}), baseTransport(), store, cfg, () => tick);
    expect(store.listSnapshots()).toHaveLength(2);
  });
});
