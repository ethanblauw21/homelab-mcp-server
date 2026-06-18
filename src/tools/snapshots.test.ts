import { describe, it, expect } from "vitest";
import {
  isMcpSnapshot,
  sanitizeSnapshotName,
  generateSnapshotName,
  parseSnapshotList,
  planSnapshotEviction,
  buildSnapshotCreateCommand,
  buildSnapshotRollbackCommand,
  buildSnapshotDeleteCommand,
  buildSnapshotListCommand,
  buildGuestStatusCommand,
  buildGuestConfigCommand,
  isSnapshotFeatureError,
  analyzeSnapshotBlockers,
  describeSnapshotBlock,
} from "./snapshots.js";

describe("snapshots — ownership boundary", () => {
  it("isMcpSnapshot only matches the mcp- prefix", () => {
    expect(isMcpSnapshot("mcp-20260609-213000")).toBe(true);
    expect(isMcpSnapshot("preupgrade")).toBe(false);
    expect(isMcpSnapshot("my-mcp-thing")).toBe(false);
  });
});

describe("snapshots — name generation", () => {
  it("generates a sanitized, prefixed, UTC-based name", () => {
    const name = generateSnapshotName(new Date(Date.UTC(2026, 5, 9, 21, 30, 0)));
    expect(name).toBe("mcp-20260609-213000");
    expect(isMcpSnapshot(name)).toBe(true);
  });

  it("zero-pads single-digit components", () => {
    const name = generateSnapshotName(new Date(Date.UTC(2026, 0, 3, 4, 5, 6)));
    expect(name).toBe("mcp-20260103-040506");
  });

  it("sanitizeSnapshotName strips disallowed chars and ensures a leading letter", () => {
    expect(sanitizeSnapshotName("mcp-abc")).toBe("mcp-abc");
    expect(sanitizeSnapshotName("9bad")).toBe("s9bad");
    expect(sanitizeSnapshotName("a b/c")).toBe("a-b-c");
  });
});

describe("snapshots — listsnapshot parsing", () => {
  it("parses pct listsnapshot tree output and flags mcp-managed", () => {
    const out = [
      "`-> preupgrade            2026-06-01 12:00:00     manual before upgrade",
      "`-> mcp-20260609-213000   2026-06-09 21:30:00     automated checkpoint",
      "`-> current                                       You are here!",
    ].join("\n");
    const snaps = parseSnapshotList(out);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toMatchObject({ name: "preupgrade", mcpManaged: false });
    expect(snaps[1]).toMatchObject({ name: "mcp-20260609-213000", mcpManaged: true });
    expect(snaps.find((s) => s.name === "current")).toBeUndefined();
  });

  it("parses qm listsnapshot output", () => {
    const out = "`-> mcp-20260101-000000 2026-01-01 00:00:00 checkpoint";
    const snaps = parseSnapshotList(out);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.mcpManaged).toBe(true);
  });
});

describe("snapshots — retention planner", () => {
  it("evicts oldest mcp- snapshots to stay within cap after the incoming one", () => {
    const names = ["mcp-20260101-000000", "mcp-20260102-000000", "mcp-20260103-000000"];
    // cap 3, 3 existing, 1 incoming → must drop the single oldest
    expect(planSnapshotEviction(names, 3)).toEqual(["mcp-20260101-000000"]);
  });

  it("does not evict when under cap", () => {
    expect(planSnapshotEviction(["mcp-20260101-000000"], 3)).toEqual([]);
  });

  it("evicts multiple when far over cap", () => {
    const names = ["a-1", "a-2", "a-3", "a-4"].map((s) => `mcp-${s}`);
    // cap 2, incoming 1 → allowed 1 → drop oldest 3
    expect(planSnapshotEviction(names, 2)).toEqual(["mcp-a-1", "mcp-a-2", "mcp-a-3"]);
  });
});

describe("snapshots — command builders", () => {
  it("builds container create without --vmstate", () => {
    expect(buildSnapshotCreateCommand("pct", 101, "mcp-x", { description: "note" })).toBe(
      "pct snapshot 101 mcp-x --description 'note'"
    );
  });

  it("builds VM create with --vmstate following config (A3.2)", () => {
    expect(buildSnapshotCreateCommand("qm", 200, "mcp-x", { vmstate: false })).toBe(
      "qm snapshot 200 mcp-x --vmstate 0"
    );
    expect(buildSnapshotCreateCommand("qm", 200, "mcp-x", { vmstate: true })).toBe(
      "qm snapshot 200 mcp-x --vmstate 1"
    );
  });

  it("builds list/rollback/delete/status commands", () => {
    expect(buildSnapshotListCommand("pct", 101)).toBe("pct listsnapshot 101");
    expect(buildSnapshotRollbackCommand("qm", 200, "mcp-x")).toBe("qm rollback 200 mcp-x");
    expect(buildSnapshotDeleteCommand("pct", 101, "mcp-x")).toBe("pct delsnapshot 101 mcp-x");
    expect(buildGuestStatusCommand("qm", 200)).toBe("qm status 200");
  });

  it("builds the guest config command", () => {
    expect(buildGuestConfigCommand("pct", 101)).toBe("pct config 101");
    expect(buildGuestConfigCommand("qm", 200)).toBe("qm config 200");
  });
});

describe("snapshots — feature-failure detection (#15)", () => {
  it("matches the Proxmox 'feature is not available' family, case-insensitively", () => {
    expect(isSnapshotFeatureError("snapshot feature is not available")).toBe(true);
    expect(isSnapshotFeatureError("ERROR: Feature Is Not Available")).toBe(true);
    expect(isSnapshotFeatureError("storage does not support snapshots")).toBe(true);
    expect(isSnapshotFeatureError("snapshot is not supported on this storage")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isSnapshotFeatureError("permission denied")).toBe(false);
    expect(isSnapshotFeatureError("VM 200 not running")).toBe(false);
    expect(isSnapshotFeatureError("")).toBe(false);
  });
});

describe("snapshots — blocker analysis (#15)", () => {
  it("flags an mpN bind mount (host path volume) with its mount point — the CT101 case", () => {
    const cfg = [
      "arch: amd64",
      "hostname: media",
      "rootfs: local-lvm:vm-101-disk-0,size=8G",
      "mp0: /mnt/media,mp=/data",
    ].join("\n");
    const blockers = analyzeSnapshotBlockers(cfg, "pct");
    expect(blockers).toEqual([
      { key: "mp0", kind: "bind-mount", detail: "host dir /mnt/media bind-mounted at /data" },
    ]);
  });

  it("flags an mpN bind mount even without an explicit mp= target", () => {
    const blockers = analyzeSnapshotBlockers("mp1: /srv/share", "pct");
    expect(blockers).toEqual([{ key: "mp1", kind: "bind-mount", detail: "host dir /srv/share" }]);
  });

  it("does NOT flag a storage-backed mpN (snapshottable volume reference)", () => {
    const blockers = analyzeSnapshotBlockers("mp0: local-lvm:vm-101-disk-1,mp=/data", "pct");
    expect(blockers).toEqual([]);
  });

  it("flags a container device passthrough (devN)", () => {
    const blockers = analyzeSnapshotBlockers("dev0: /dev/dri/card0", "pct");
    expect(blockers).toEqual([
      { key: "dev0", kind: "device-passthrough", detail: "device passthrough /dev/dri/card0" },
    ]);
  });

  it("flags qm PCI passthrough and a raw host disk", () => {
    const cfg = ["hostpci0: 0000:01:00,pcie=1", "scsi1: /dev/sdb", "scsi0: local-lvm:vm-200-disk-0"].join(
      "\n"
    );
    const blockers = analyzeSnapshotBlockers(cfg, "qm");
    expect(blockers).toEqual([
      { key: "hostpci0", kind: "device-passthrough", detail: "PCI passthrough 0000:01:00" },
      { key: "scsi1", kind: "raw-disk", detail: "raw host disk /dev/sdb" },
    ]);
  });

  it("returns [] for a fully snapshottable guest", () => {
    const cfg = ["rootfs: local-lvm:vm-101-disk-0,size=8G", "net0: name=eth0,bridge=vmbr0"].join("\n");
    expect(analyzeSnapshotBlockers(cfg, "pct")).toEqual([]);
  });

  it("ignores malformed / valueless lines", () => {
    expect(analyzeSnapshotBlockers("garbage-no-colon\nmp0:\n: novalue", "pct")).toEqual([]);
  });
});

describe("snapshots — describeSnapshotBlock (#15)", () => {
  it("names the blockers and offers vzdump as the fallback", () => {
    const reason = describeSnapshotBlock(
      [{ key: "mp0", kind: "bind-mount", detail: "host dir /mnt/media bind-mounted at /data" }],
      101
    );
    expect(reason).toContain("mp0 (host dir /mnt/media bind-mounted at /data)");
    expect(reason).toContain("is not snapshottable");
    expect(reason).toContain("guest_backup");
  });

  it("pluralizes for multiple blockers", () => {
    const reason = describeSnapshotBlock(
      [
        { key: "mp0", kind: "bind-mount", detail: "host dir /a" },
        { key: "mp1", kind: "bind-mount", detail: "host dir /b" },
      ],
      101
    );
    expect(reason).toContain("are not snapshottable");
  });

  it("gives a generic-but-useful hint when no blocker was identifiable", () => {
    const reason = describeSnapshotBlock([], 101);
    expect(reason).toContain("no blocking volume was identifiable");
    expect(reason).toContain("guest_backup");
  });
});
