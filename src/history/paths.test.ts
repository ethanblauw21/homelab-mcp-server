import { describe, it, expect } from "vitest";
import {
  mirrorMappingForTarget,
  isHistoryTarget,
  mirrorRelPathForSweepFile,
  manifestKeyForSweepTarget,
  repoPrefixForSweepTarget,
} from "./paths.js";

describe("mirrorMappingForTarget", () => {
  it("maps a host file under host/", () => {
    const m = mirrorMappingForTarget({ kind: "host", remotePath: "/etc/hosts" });
    expect(m.repoRelPath).toBe("host/etc/hosts");
    expect(m.manifestKey).toBe("host");
    expect(m.fileKey).toBe("/etc/hosts");
  });

  it("maps a container file under pct/<vmid>/", () => {
    const m = mirrorMappingForTarget({
      kind: "pct",
      vmid: 104,
      remotePath: "/etc/wireguard/wg0.conf",
    });
    expect(m.repoRelPath).toBe("pct/104/etc/wireguard/wg0.conf");
    expect(m.manifestKey).toBe("pct-104");
  });

  it("rejects qm targets (no mirror layout)", () => {
    expect(() =>
      mirrorMappingForTarget({ kind: "qm", vmid: 200, remotePath: "/etc/x" })
    ).toThrow(/not mirrored/i);
  });

  it("rejects a traversal even after the descriptor (.. as a segment)", () => {
    expect(() =>
      mirrorMappingForTarget({ kind: "host", remotePath: "/etc/../../root/.ssh/x" })
    ).toThrow(/traversal/i);
  });

  it("allows a filename that merely contains .. characters", () => {
    const m = mirrorMappingForTarget({ kind: "host", remotePath: "/etc/foo..bar" });
    expect(m.repoRelPath).toBe("host/etc/foo..bar");
  });

  it("rejects a relative path", () => {
    expect(() => mirrorMappingForTarget({ kind: "host", remotePath: "etc/hosts" })).toThrow(
      /absolute/i
    );
  });

  it("rejects a null byte", () => {
    expect(() =>
      mirrorMappingForTarget({ kind: "host", remotePath: "/etc/x\0y" })
    ).toThrow(/null byte/i);
  });

  it("throws when a container target lacks a vmid", () => {
    expect(() => mirrorMappingForTarget({ kind: "pct", remotePath: "/etc/x" })).toThrow(
      /vmid/i
    );
  });
});

describe("isHistoryTarget", () => {
  it("is true for host and pct, false for qm", () => {
    expect(isHistoryTarget({ kind: "host", remotePath: "/x" })).toBe(true);
    expect(isHistoryTarget({ kind: "pct", vmid: 1, remotePath: "/x" })).toBe(true);
    expect(isHistoryTarget({ kind: "qm", vmid: 1, remotePath: "/x" })).toBe(false);
  });
});

describe("sweep target helpers", () => {
  it("derive manifest keys and repo prefixes", () => {
    expect(manifestKeyForSweepTarget("host")).toBe("host");
    expect(manifestKeyForSweepTarget({ vmid: 7 })).toBe("pct-7");
    expect(repoPrefixForSweepTarget("host")).toBe("host");
    expect(repoPrefixForSweepTarget({ vmid: 7 })).toBe("pct/7");
  });

  it("map a sweep file path under its target prefix, traversal-safe", () => {
    expect(mirrorRelPathForSweepFile("host", "/etc/hosts")).toBe("host/etc/hosts");
    expect(mirrorRelPathForSweepFile({ vmid: 9 }, "/etc/a/b.conf")).toBe(
      "pct/9/etc/a/b.conf"
    );
    expect(() => mirrorRelPathForSweepFile("host", "/etc/../x")).toThrow(/traversal/i);
  });
});
