/**
 * Pure parsers for the homelab census (ADR-002).
 *
 * Each function turns the (read-only) output of a fixed probe command into a
 * structured shape. They are tolerant: malformed or empty input yields an
 * empty/zeroed result rather than throwing, so a single odd line never breaks
 * a section. Real-output fixtures live in censusParsers.test.ts.
 *
 * Unit note: `pvesm status` and `pct/qm config` size fields are reported by
 * Proxmox in KiB (1024-byte blocks); we convert to bytes where the census
 * shape promises *Bytes. `df -B1` is already in bytes.
 */

export interface NodeInfo {
  version: string;
  uptime: string;
  cpu: number;
  memBytes: number;
  memUsedBytes: number;
  load: number[];
}

export interface StorageInfo {
  name: string;
  type: string;
  active: boolean;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
}

export interface FilesystemInfo {
  target: string;
  sizeBytes: number;
  usedBytes: number;
  availBytes: number;
}

export interface NetworkIface {
  iface: string;
  state: string;
  addrs: string[];
}

export interface BridgeInfo {
  name: string;
  ports: string[];
  address?: string;
}

export type GuestConfig = Record<string, string>;

export interface QmRow {
  vmid: number;
  name: string;
  status: string;
  memMB?: number;
  bootDiskGB?: number;
  pid?: number;
}

export interface TailscaleSummary {
  self: string;
  peerCount: number;
}

export interface ZpoolHealth {
  healthy: boolean;
  detail: string;
}

export interface DockerContainer {
  name: string;
  image: string;
  status: string;
}

const KIB = 1024;

function toInt(s: string | undefined): number {
  const n = parseInt((s ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function nonEmptyLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0);
}

/** Parse `pveversion` → the manager version string (e.g. "8.1.4"). */
export function parsePveVersion(output: string): string {
  const first = output.split("\n")[0]?.trim() ?? "";
  // Format: pve-manager/8.1.4/abcdef (running kernel: 6.5.11-7-pve)
  const m = first.match(/pve-manager\/([^/\s]+)/);
  return m ? m[1]! : first;
}

/** Parse `free -b` → total/used bytes for the Mem row. */
export function parseFreeBytes(output: string): { totalBytes: number; usedBytes: number } {
  for (const line of nonEmptyLines(output)) {
    const m = line.match(/^Mem:\s+(\d+)\s+(\d+)/);
    if (m) return { totalBytes: toInt(m[1]), usedBytes: toInt(m[2]) };
  }
  return { totalBytes: 0, usedBytes: 0 };
}

/** Parse `/proc/loadavg` → [1m, 5m, 15m]. */
export function parseLoadAvg(output: string): number[] {
  const parts = output.trim().split(/\s+/);
  return parts.slice(0, 3).map((p) => {
    const f = parseFloat(p);
    return Number.isFinite(f) ? f : 0;
  });
}

/**
 * Parse a `pct config <vmid>` / `qm config <vmid>` blob into key/value pairs.
 * Lines are "key: value"; values may themselves contain colons/commas.
 */
export function parseGuestConfig(output: string): GuestConfig {
  const cfg: GuestConfig = {};
  for (const line of nonEmptyLines(output)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) cfg[key] = value;
  }
  return cfg;
}

/**
 * Parse `qm list`. Columns: VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID.
 * PID is "-" or absent for stopped VMs.
 */
export function parseQmList(output: string): QmRow[] {
  const rows: QmRow[] = [];
  for (const line of nonEmptyLines(output)) {
    const trimmed = line.trim();
    if (!/^\d/.test(trimmed)) continue; // skip header / blanks
    const parts = trimmed.split(/\s+/);
    const row: QmRow = {
      vmid: toInt(parts[0]),
      name: parts[1] ?? "",
      status: parts[2] ?? "",
    };
    if (parts[3] !== undefined) row.memMB = toInt(parts[3]);
    if (parts[4] !== undefined) row.bootDiskGB = toInt(parts[4]);
    if (parts[5] !== undefined && parts[5] !== "-") row.pid = toInt(parts[5]);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse `pvesm status`. Columns: Name Type Status Total Used Available %.
 * Total/Used/Available are KiB blocks → converted to bytes.
 */
export function parsePvesmStatus(output: string): StorageInfo[] {
  const out: StorageInfo[] = [];
  for (const line of nonEmptyLines(output)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    if (/^name$/i.test(parts[0]!)) continue; // header
    const [name, type, status, total, used, avail] = parts;
    out.push({
      name: name!,
      type: type!,
      active: status === "active",
      totalBytes: toInt(total) * KIB,
      usedBytes: toInt(used) * KIB,
      availBytes: toInt(avail) * KIB,
    });
  }
  return out;
}

/**
 * Parse `df -B1 --output=target,size,used,avail`. Already in bytes.
 * Header line is "Mounted on  1B-blocks  Used  Avail".
 */
export function parseDf(output: string): FilesystemInfo[] {
  const out: FilesystemInfo[] = [];
  for (const line of nonEmptyLines(output)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const avail = parts[parts.length - 1]!;
    const used = parts[parts.length - 2]!;
    const size = parts[parts.length - 3]!;
    const target = parts.slice(0, parts.length - 3).join(" ");
    if (!/^\d+$/.test(size)) continue; // skips header ("1B-blocks" etc.)
    out.push({
      target,
      sizeBytes: toInt(size),
      usedBytes: toInt(used),
      availBytes: toInt(avail),
    });
  }
  return out;
}

/** Parse `ip -br addr` (or `ip -br link`). Columns: iface state [addrs...]. */
export function parseIpBrief(output: string): NetworkIface[] {
  const out: NetworkIface[] = [];
  for (const line of nonEmptyLines(output)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [iface, state, ...rest] = parts;
    out.push({
      iface: iface!.replace(/@.*$/, ""), // strip "eth0@if12" suffixes
      state: state!,
      addrs: rest.filter(Boolean),
    });
  }
  return out;
}

/**
 * Parse bridge stanzas from /etc/network/interfaces. Only `vmbr*` ifaces are
 * summarized; raw content is never returned.
 */
export function parseInterfacesBridges(output: string): BridgeInfo[] {
  const bridges: BridgeInfo[] = [];
  let current: BridgeInfo | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const ifaceMatch = line.match(/^\s*iface\s+(vmbr\d+)\b/);
    if (ifaceMatch) {
      current = { name: ifaceMatch[1]!, ports: [] };
      bridges.push(current);
      continue;
    }
    if (line.match(/^\s*iface\s+/) || line.match(/^\s*auto\s+/)) {
      if (!ifaceMatch) current = null; // left the vmbr stanza
      continue;
    }
    if (!current) continue;
    const ports = line.match(/^\s*bridge[_-]ports\s+(.+)$/);
    if (ports) {
      current.ports = ports[1]!.trim().split(/\s+/).filter((p) => p && p !== "none");
      continue;
    }
    const addr = line.match(/^\s*address\s+(.+)$/);
    if (addr) current.address = addr[1]!.trim();
  }
  return bridges;
}

/** Parse `tailscale status --json` → self identity + peer count. Tolerant of malformed JSON. */
export function parseTailscaleStatus(output: string): TailscaleSummary | null {
  try {
    const data = JSON.parse(output) as {
      Self?: { DNSName?: string; HostName?: string };
      Peer?: Record<string, unknown>;
    };
    const self = data.Self?.DNSName?.replace(/\.$/, "") ?? data.Self?.HostName ?? "";
    const peerCount = data.Peer ? Object.keys(data.Peer).length : 0;
    return { self, peerCount };
  } catch {
    return null;
  }
}

/** Parse `zpool status -x` → healthy flag + detail. Absence of ZFS yields healthy:true. */
export function parseZpoolStatusX(output: string): ZpoolHealth {
  const text = output.trim();
  if (text === "" || /all pools are healthy/i.test(text) || /no pools available/i.test(text)) {
    return { healthy: true, detail: text || "no pools" };
  }
  return { healthy: false, detail: text };
}

/** Parse `systemctl list-units --failed --no-legend --plain` → failed unit names. */
export function parseFailedUnits(output: string): string[] {
  const units: string[] = [];
  for (const line of nonEmptyLines(output)) {
    const first = line.trim().split(/\s+/)[0];
    if (first && first !== "0") units.push(first);
  }
  return units;
}

/** Parse `docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"`. */
export function parseDockerPs(output: string): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const line of nonEmptyLines(output)) {
    const [name, image, status] = line.split("\t");
    if (!name) continue;
    out.push({ name: name.trim(), image: (image ?? "").trim(), status: (status ?? "").trim() });
  }
  return out;
}
