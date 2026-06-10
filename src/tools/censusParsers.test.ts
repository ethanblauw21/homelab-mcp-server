import { describe, it, expect } from "vitest";
import {
  parsePveVersion,
  parseFreeBytes,
  parseLoadAvg,
  parseGuestConfig,
  parseQmList,
  parsePvesmStatus,
  parseDf,
  parseIpBrief,
  parseInterfacesBridges,
  parseTailscaleStatus,
  parseZpoolStatusX,
  parseFailedUnits,
  parseDockerPs,
} from "./censusParsers.js";

describe("parsePveVersion", () => {
  it("extracts the manager version", () => {
    expect(
      parsePveVersion("pve-manager/8.1.4/ec5affc9e41f1d79 (running kernel: 6.5.11-7-pve)")
    ).toBe("8.1.4");
  });
  it("falls back to the raw first line when format is unexpected", () => {
    expect(parsePveVersion("weird-output")).toBe("weird-output");
  });
});

describe("parseFreeBytes", () => {
  it("parses the Mem row", () => {
    const out = [
      "               total        used        free      shared  buff/cache   available",
      "Mem:     16766517248  4233470720  8000000000      123456  4533046528  12000000000",
      "Swap:     8589930496           0  8589930496",
    ].join("\n");
    const r = parseFreeBytes(out);
    expect(r.totalBytes).toBe(16766517248);
    expect(r.usedBytes).toBe(4233470720);
  });
  it("returns zeros when no Mem row", () => {
    expect(parseFreeBytes("garbage")).toEqual({ totalBytes: 0, usedBytes: 0 });
  });
});

describe("parseLoadAvg", () => {
  it("parses the three load figures", () => {
    expect(parseLoadAvg("0.15 0.10 0.05 1/432 12345")).toEqual([0.15, 0.1, 0.05]);
  });
});

describe("parseGuestConfig", () => {
  it("parses pct config key/value lines including complex values", () => {
    const out = [
      "arch: amd64",
      "cores: 2",
      "hostname: gluetun",
      "memory: 1024",
      "net0: name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:DD:EE:FF,ip=dhcp",
      "rootfs: local-lvm:vm-101-disk-0,size=8G",
    ].join("\n");
    const cfg = parseGuestConfig(out);
    expect(cfg.cores).toBe("2");
    expect(cfg.hostname).toBe("gluetun");
    expect(cfg.net0).toBe("name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:DD:EE:FF,ip=dhcp");
  });
  it("tolerates blank/odd lines", () => {
    expect(parseGuestConfig("\n\nnotakeyvalue\n")).toEqual({});
  });
});

describe("parseQmList", () => {
  it("parses running and stopped VMs", () => {
    const out = [
      "      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID",
      "       100 truenas              running    8192             32.00 1234",
      "       101 winserver            stopped    4096             64.00 -",
    ].join("\n");
    const rows = parseQmList(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ vmid: 100, name: "truenas", status: "running", pid: 1234 });
    expect(rows[1]).toMatchObject({ vmid: 101, name: "winserver", status: "stopped" });
    expect(rows[1]!.pid).toBeUndefined();
  });
  it("returns [] for an empty list", () => {
    expect(parseQmList("VMID NAME STATUS")).toEqual([]);
  });
});

describe("parsePvesmStatus", () => {
  it("parses storage rows and converts KiB→bytes", () => {
    const out = [
      "Name             Type     Status           Total            Used       Available        %",
      "local             dir     active        100660736         7475200        93185536    7.43%",
      "local-lvm     lvmthin     active        419430400               0       419430400    0.00%",
      "backup            dir  inactive               0               0               0    0.00%",
    ].join("\n");
    const rows = parsePvesmStatus(out);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      name: "local",
      type: "dir",
      active: true,
      totalBytes: 100660736 * 1024,
      usedBytes: 7475200 * 1024,
    });
    expect(rows[2]!.active).toBe(false);
  });
});

describe("parseDf", () => {
  it("parses 1-byte-block usage with multi-word targets", () => {
    const out = [
      "Mounted on     1B-blocks         Used        Avail",
      "/           103077232640   7654000000  95423232640",
      "/boot/efi      535805952      6627328    529178624",
    ].join("\n");
    const rows = parseDf(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      target: "/",
      sizeBytes: 103077232640,
      usedBytes: 7654000000,
      availBytes: 95423232640,
    });
    expect(rows[1]!.target).toBe("/boot/efi");
  });
});

describe("parseIpBrief", () => {
  it("parses iface/state/addrs and strips @ifN suffixes", () => {
    const out = [
      "lo               UNKNOWN        127.0.0.1/8 ::1/128",
      "eth0@if12        UP             ",
      "vmbr0            UP             10.0.0.10/24 fe80::1/64",
      "tailscale0       UNKNOWN        100.64.0.1/32",
    ].join("\n");
    const rows = parseIpBrief(out);
    expect(rows[0]).toEqual({ iface: "lo", state: "UNKNOWN", addrs: ["127.0.0.1/8", "::1/128"] });
    expect(rows[1]).toEqual({ iface: "eth0", state: "UP", addrs: [] });
    expect(rows[2]!.addrs).toContain("10.0.0.10/24");
  });
});

describe("parseInterfacesBridges", () => {
  it("summarizes vmbr bridges with ports and address, ignoring physical ifaces", () => {
    const out = [
      "auto lo",
      "iface lo inet loopback",
      "",
      "iface eno1 inet manual",
      "",
      "auto vmbr0",
      "iface vmbr0 inet static",
      "        address 10.0.0.10/24",
      "        gateway 10.0.0.1",
      "        bridge-ports eno1",
      "        bridge-stp off",
      "        bridge-fd 0",
      "",
      "auto vmbr1",
      "iface vmbr1 inet manual",
      "        bridge-ports none",
    ].join("\n");
    const bridges = parseInterfacesBridges(out);
    expect(bridges).toHaveLength(2);
    expect(bridges[0]).toMatchObject({ name: "vmbr0", ports: ["eno1"], address: "10.0.0.10/24" });
    expect(bridges[1]).toMatchObject({ name: "vmbr1", ports: [] });
  });
});

describe("parseTailscaleStatus", () => {
  it("extracts self DNS name and peer count", () => {
    const json = JSON.stringify({
      Self: { HostName: "pve", DNSName: "pve.tail1234.ts.net." },
      Peer: { a: {}, b: {}, c: {} },
    });
    expect(parseTailscaleStatus(json)).toEqual({ self: "pve.tail1234.ts.net", peerCount: 3 });
  });
  it("returns null on malformed JSON", () => {
    expect(parseTailscaleStatus("not json")).toBeNull();
  });
  it("handles missing Peer", () => {
    expect(parseTailscaleStatus(JSON.stringify({ Self: { HostName: "pve" } }))).toEqual({
      self: "pve",
      peerCount: 0,
    });
  });
});

describe("parseZpoolStatusX", () => {
  it("treats 'all pools are healthy' as healthy", () => {
    expect(parseZpoolStatusX("all pools are healthy").healthy).toBe(true);
  });
  it("treats absence of ZFS as healthy", () => {
    expect(parseZpoolStatusX("").healthy).toBe(true);
    expect(parseZpoolStatusX("no pools available").healthy).toBe(true);
  });
  it("flags a degraded pool", () => {
    const out = "  pool: tank\n state: DEGRADED\nstatus: One or more devices ...";
    const r = parseZpoolStatusX(out);
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("DEGRADED");
  });
});

describe("parseFailedUnits", () => {
  it("parses failed unit names", () => {
    const out = [
      "  pve-firewall.service loaded failed failed Proxmox VE firewall",
      "  smartd.service       loaded failed failed Self Monitoring",
    ].join("\n");
    expect(parseFailedUnits(out)).toEqual(["pve-firewall.service", "smartd.service"]);
  });
  it("returns [] when none failed", () => {
    expect(parseFailedUnits("")).toEqual([]);
  });
});

describe("parseDockerPs", () => {
  it("parses tab-delimited container rows", () => {
    const out = [
      "gluetun\tqmcgaw/gluetun:latest\tUp 3 days (healthy)",
      "portainer\tportainer/portainer-ce:latest\tUp 3 days",
    ].join("\n");
    const rows = parseDockerPs(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: "gluetun",
      image: "qmcgaw/gluetun:latest",
      status: "Up 3 days (healthy)",
    });
  });
});
