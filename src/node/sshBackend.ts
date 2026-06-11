/**
 * SshBackend (ADR-007 §3) — NodeOps over the existing SSH exec + text parsers.
 *
 * Behavior-neutral: it issues the SAME `qm`/`pct` commands the ADR-003/005 tools
 * already used and reuses their pure parsers. Available only at companion+ (where
 * an SSH key exists); the ApiBackend is preferred wherever it can answer. Kept as
 * the API-less fallback and for parity in SSH-only deployments.
 */
import type { SshTransport } from "../ssh/transport.js";
import type {
  NodeOps,
  Guest,
  GuestType,
  Snapshot,
  TaskRef,
  NodeStatusInfo,
  StorageStatusInfo,
  AptUpdateInfo,
} from "./nodeOps.js";
import { parsePctList } from "../tools/pctHelpers.js";
import { parseQmList, parseLoadAvg, parseFreeBytes, parsePvesmStatus } from "../tools/censusParsers.js";
import {
  type GuestType as SshGuestType,
  parseSnapshotList,
  parseGuestStatus,
  buildGuestStatusCommand,
  buildGuestStopCommand,
  buildGuestStartCommand,
  buildSnapshotListCommand,
  buildSnapshotCreateCommand,
  buildSnapshotRollbackCommand,
  buildSnapshotDeleteCommand,
} from "../tools/snapshots.js";

/** NodeOps guest type ("qemu"/"lxc") → the SSH builders' "qm"/"pct". */
function sshType(type: GuestType): SshGuestType {
  return type === "lxc" ? "pct" : "qm";
}

export class SshBackend implements NodeOps {
  readonly kind = "ssh" as const;

  constructor(
    private readonly transport: SshTransport,
    private readonly timeoutMs: number
  ) {}

  private async exec(cmd: string): Promise<string> {
    const res = await this.transport.exec(cmd, this.timeoutMs);
    if (res.exitCode !== 0) {
      throw new Error(`\`${cmd}\` failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  async listGuests(): Promise<Guest[]> {
    const out: Guest[] = [];
    const qm = parseQmList(await this.exec("qm list"));
    for (const v of qm) out.push({ vmid: v.vmid, name: v.name, type: "qemu", status: v.status });
    const pct = parsePctList(await this.exec("pct list"));
    for (const c of pct) out.push({ vmid: c.vmid, name: c.name, type: "lxc", status: c.status });
    return out.sort((a, b) => a.vmid - b.vmid);
  }

  async guestStatus(vmid: number, type: GuestType): Promise<{ status: string }> {
    const out = await this.exec(buildGuestStatusCommand(sshType(type), vmid));
    return { status: parseGuestStatus(out) };
  }

  async startGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    await this.exec(buildGuestStartCommand(sshType(type), vmid));
    return { upid: `ssh:start:${type}:${vmid}` };
  }

  async stopGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    await this.exec(buildGuestStopCommand(sshType(type), vmid));
    return { upid: `ssh:stop:${type}:${vmid}` };
  }

  async rebootGuest(vmid: number, type: GuestType): Promise<TaskRef> {
    await this.exec(`${sshType(type)} reboot ${vmid}`);
    return { upid: `ssh:reboot:${type}:${vmid}` };
  }

  async listSnapshots(vmid: number, type: GuestType): Promise<Snapshot[]> {
    const out = await this.exec(buildSnapshotListCommand(sshType(type), vmid));
    return parseSnapshotList(out).map((s) => ({
      name: s.name,
      description: s.description || undefined,
    }));
  }

  async createSnapshot(
    vmid: number,
    type: GuestType,
    name: string,
    opts?: { description?: string; vmstate?: boolean }
  ): Promise<TaskRef> {
    await this.exec(
      buildSnapshotCreateCommand(sshType(type), vmid, name, {
        description: opts?.description,
        vmstate: opts?.vmstate,
      })
    );
    return { upid: `ssh:snapshot:${type}:${vmid}:${name}` };
  }

  async rollbackSnapshot(vmid: number, type: GuestType, name: string): Promise<TaskRef> {
    await this.exec(buildSnapshotRollbackCommand(sshType(type), vmid, name));
    return { upid: `ssh:rollback:${type}:${vmid}:${name}` };
  }

  async deleteSnapshot(vmid: number, type: GuestType, name: string): Promise<TaskRef> {
    await this.exec(buildSnapshotDeleteCommand(sshType(type), vmid, name));
    return { upid: `ssh:delsnapshot:${type}:${vmid}:${name}` };
  }

  async nodeStatus(): Promise<NodeStatusInfo> {
    const loadavg = parseLoadAvg(await this.exec("cat /proc/loadavg"));
    const mem = parseFreeBytes(await this.exec("free -b"));
    return { loadavg, memoryTotal: mem.totalBytes, memoryUsed: mem.usedBytes };
  }

  async storageStatus(): Promise<StorageStatusInfo[]> {
    return parsePvesmStatus(await this.exec("pvesm status")).map((s) => ({
      storage: s.name,
      type: s.type,
      enabled: true,
      active: s.active,
      totalBytes: s.totalBytes,
      usedBytes: s.usedBytes,
      availBytes: s.availBytes,
    }));
  }

  async aptUpdates(): Promise<AptUpdateInfo[]> {
    // `apt-get -s` simulates; the server NEVER runs `apt update` (A5.1).
    const out = await this.exec("apt-get -s upgrade");
    const updates: AptUpdateInfo[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^Inst\s+(\S+)\s+\[[^\]]*\]\s+\(([^\s)]+)/);
      if (m) updates.push({ package: m[1]!, version: m[2]! });
    }
    return updates;
  }
}
