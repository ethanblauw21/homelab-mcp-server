import { describe, it, expect } from "vitest";
import {
  MCP_BACKUP_PREFIX,
  isMcpArchive,
  generateBackupNote,
  planArchiveEviction,
  parseArchiveContent,
  assertStorageName,
  assertVolid,
  buildVzdumpCommand,
  buildListBackupsCommand,
  buildRestoreCommand,
  buildArchiveFreeCommand,
  type ArchiveInfo,
} from "./backups.js";

const archive = (over: Partial<ArchiveInfo>): ArchiveInfo => ({
  volid: "local:backup/x",
  vmid: 101,
  mcpManaged: false,
  ...over,
});

describe("isMcpArchive", () => {
  it("recognizes the mcp- prefix, tolerating leading whitespace", () => {
    expect(isMcpArchive("mcp-20260614")).toBe(true);
    expect(isMcpArchive("  mcp-x — note")).toBe(true);
  });
  it("rejects human notes and undefined", () => {
    expect(isMcpArchive("nightly backup")).toBe(false);
    expect(isMcpArchive(undefined)).toBe(false);
    expect(isMcpArchive("")).toBe(false);
    // The prefix must be a real boundary, not a substring elsewhere.
    expect(isMcpArchive("not-mcp-made")).toBe(false);
  });
});

describe("generateBackupNote", () => {
  const when = new Date(Date.UTC(2026, 5, 14, 15, 30, 5)); // 2026-06-14 15:30:05 UTC
  it("emits a compact UTC mcp- timestamp", () => {
    expect(generateBackupNote(when)).toBe("mcp-20260614-153005");
  });
  it("appends a trimmed human note with an em-dash separator", () => {
    expect(generateBackupNote(when, "  before stack edit ")).toBe("mcp-20260614-153005 — before stack edit");
  });
  it("omits the separator for an empty/whitespace note", () => {
    expect(generateBackupNote(when, "   ")).toBe("mcp-20260614-153005");
  });
  it("always starts with the ownership prefix", () => {
    expect(generateBackupNote(when).startsWith(MCP_BACKUP_PREFIX)).toBe(true);
  });
  it("emits a template-free generated prefix (no auto {{ }} for --notes-template)", () => {
    // The auto-generated portion never contains a vzdump template token; a user's
    // own note is passed through verbatim (it is their archive's note).
    expect(generateBackupNote(when)).not.toMatch(/\{\{/);
  });
});

describe("planArchiveEviction", () => {
  it("evicts the oldest mcp- archives beyond (cap - incoming), newest kept", () => {
    const archives = [
      archive({ volid: "local:backup/a", ctime: 100, mcpManaged: true }),
      archive({ volid: "local:backup/b", ctime: 300, mcpManaged: true }),
      archive({ volid: "local:backup/c", ctime: 200, mcpManaged: true }),
    ];
    // cap 1, incoming 1 → allowed 0 → all three evicted.
    expect(planArchiveEviction(archives, 1)).toEqual([
      "local:backup/b", // 300 newest kept-position 0 but allowed=0 so still evicted
      "local:backup/c",
      "local:backup/a",
    ]);
  });
  it("keeps the newest (cap - incoming) and evicts the rest", () => {
    const archives = [
      archive({ volid: "local:backup/old", ctime: 100, mcpManaged: true }),
      archive({ volid: "local:backup/new", ctime: 300, mcpManaged: true }),
      archive({ volid: "local:backup/mid", ctime: 200, mcpManaged: true }),
    ];
    // cap 3, incoming 1 → allowed 2 → keep new+mid, evict old.
    expect(planArchiveEviction(archives, 3)).toEqual(["local:backup/old"]);
  });
  it("never evicts non-mcp archives", () => {
    const archives = [
      archive({ volid: "local:backup/human", ctime: 50, mcpManaged: false }),
      archive({ volid: "local:backup/mcp1", ctime: 100, mcpManaged: true }),
      archive({ volid: "local:backup/mcp2", ctime: 200, mcpManaged: true }),
    ];
    const evicted = planArchiveEviction(archives, 1);
    expect(evicted).not.toContain("local:backup/human");
    expect(evicted).toEqual(["local:backup/mcp2", "local:backup/mcp1"]);
  });
  it("breaks ctime ties deterministically by volid (descending)", () => {
    const archives = [
      archive({ volid: "local:backup/a", ctime: 100, mcpManaged: true }),
      archive({ volid: "local:backup/b", ctime: 100, mcpManaged: true }),
    ];
    // cap 1, incoming 1 → allowed 0 → both evicted, but b (higher volid) sorts first.
    expect(planArchiveEviction(archives, 1)).toEqual(["local:backup/b", "local:backup/a"]);
  });
  it("treats undefined ctime as oldest", () => {
    const archives = [
      archive({ volid: "local:backup/noctime", mcpManaged: true }),
      archive({ volid: "local:backup/withctime", ctime: 100, mcpManaged: true }),
    ];
    // cap 2, incoming 1 → allowed 1 → keep newest (withctime), evict noctime.
    expect(planArchiveEviction(archives, 2)).toEqual(["local:backup/noctime"]);
  });
  it("returns nothing when within cap", () => {
    const archives = [archive({ volid: "local:backup/a", ctime: 100, mcpManaged: true })];
    expect(planArchiveEviction(archives, 5)).toEqual([]);
  });
  it("honors a custom incoming count", () => {
    const archives = [
      archive({ volid: "local:backup/a", ctime: 100, mcpManaged: true }),
      archive({ volid: "local:backup/b", ctime: 200, mcpManaged: true }),
    ];
    // cap 3, incoming 2 → allowed 1 → keep b, evict a.
    expect(planArchiveEviction(archives, 3, 2)).toEqual(["local:backup/a"]);
  });
});

describe("parseArchiveContent", () => {
  it("maps volid/vmid/ctime/size/notes and flags mcp ownership", () => {
    const out = parseArchiveContent([
      { volid: "local:backup/vzdump-lxc-101.tar.zst", vmid: 101, ctime: 1717000000, size: 1024, notes: "mcp-x", format: "tar.zst" },
    ]);
    expect(out).toEqual([
      {
        volid: "local:backup/vzdump-lxc-101.tar.zst",
        vmid: 101,
        ctime: 1717000000,
        sizeBytes: 1024,
        notes: "mcp-x",
        format: "tar.zst",
        mcpManaged: true,
      },
    ]);
  });
  it("falls back to the `comment` field for notes", () => {
    const out = parseArchiveContent([{ volid: "local:backup/a", vmid: 1, comment: "mcp-y" }]);
    expect(out[0]!.notes).toBe("mcp-y");
    expect(out[0]!.mcpManaged).toBe(true);
  });
  it("tolerates numeric strings for size/ctime/vmid", () => {
    const out = parseArchiveContent([{ volid: "local:backup/a", vmid: "101", ctime: "1717000000", size: "2048" }]);
    expect(out[0]).toMatchObject({ vmid: 101, ctime: 1717000000, sizeBytes: 2048 });
  });
  it("skips entries without a volid and non-objects", () => {
    const out = parseArchiveContent([{ vmid: 1 }, null, "x", { volid: "local:backup/keep", vmid: 2 }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.volid).toBe("local:backup/keep");
  });
  it("returns [] for non-array input", () => {
    expect(parseArchiveContent(undefined)).toEqual([]);
    expect(parseArchiveContent({})).toEqual([]);
  });
});

describe("charset guards", () => {
  it("accepts valid storage names and rejects shell metacharacters", () => {
    expect(() => assertStorageName("local-zfs")).not.toThrow();
    expect(() => assertStorageName("local.1_x")).not.toThrow();
    expect(() => assertStorageName("bad name")).toThrow(/Invalid storage/);
    expect(() => assertStorageName("a;rm -rf")).toThrow(/Invalid storage/);
    expect(() => assertStorageName("")).toThrow(/Invalid storage/);
  });
  it("accepts a well-formed backup volid and rejects malformed ones", () => {
    expect(() => assertVolid("local:backup/vzdump-lxc-101-2026.tar.zst")).not.toThrow();
    expect(() => assertVolid("local:backup/sub/dir/file")).not.toThrow();
    expect(() => assertVolid("local:iso/file.iso")).toThrow(/Invalid backup volid/); // not a backup volid
    expect(() => assertVolid("local:backup/$(reboot)")).toThrow(/Invalid backup volid/);
    expect(() => assertVolid("nostorage")).toThrow(/Invalid backup volid/);
  });
});

describe("CLI builders", () => {
  it("builds a vzdump command with single-quoted notes and the storage validated", () => {
    const cmd = buildVzdumpCommand(101, { mode: "snapshot", storage: "local", notes: "mcp-x — note" });
    expect(cmd).toBe("vzdump 101 --storage local --mode snapshot --compress zstd --notes-template 'mcp-x — note'");
  });
  it("defaults compression to zstd but honors an override", () => {
    const cmd = buildVzdumpCommand(101, { mode: "stop", storage: "local", notes: "mcp-x", compress: "gzip" });
    expect(cmd).toContain("--compress gzip");
  });
  it("rejects an injection-bearing storage name before interpolation", () => {
    expect(() => buildVzdumpCommand(101, { mode: "stop", storage: "a;reboot", notes: "mcp" })).toThrow(/Invalid storage/);
  });
  it("builds a pvesh listing command", () => {
    expect(buildListBackupsCommand("pve", "local")).toBe(
      "pvesh get /nodes/pve/storage/local/content --content backup --output-format json"
    );
  });
  it("builds an lxc restore with --force and a single-quoted volid", () => {
    expect(buildRestoreCommand("lxc", 101, "local:backup/a")).toBe("pct restore 101 'local:backup/a' --force");
  });
  it("builds a qemu restore via qmrestore", () => {
    expect(buildRestoreCommand("qemu", 100, "local:backup/a")).toBe("qmrestore 'local:backup/a' 100 --force");
  });
  it("rejects a malformed volid in restore/free before interpolation", () => {
    expect(() => buildRestoreCommand("lxc", 101, "evil; reboot")).toThrow(/Invalid backup volid/);
    expect(() => buildArchiveFreeCommand("evil; reboot")).toThrow(/Invalid backup volid/);
  });
  it("builds a pvesm free command", () => {
    expect(buildArchiveFreeCommand("local:backup/a")).toBe("pvesm free 'local:backup/a'");
  });
});
