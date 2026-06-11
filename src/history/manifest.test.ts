import { describe, it, expect } from "vitest";
import {
  buildStatBatchCommand,
  parseStatBatch,
  serializeManifest,
  parseManifest,
  emptyManifest,
} from "./manifest.js";

describe("buildStatBatchCommand", () => {
  it("returns null for an empty path list", () => {
    expect(buildStatBatchCommand([])).toBeNull();
  });

  it("builds a host stat with quoted paths and -- guard", () => {
    expect(buildStatBatchCommand(["/etc/hosts", "/etc/issue"])).toBe(
      "stat -c '%a %u %g %n' -- '/etc/hosts' '/etc/issue'"
    );
  });

  it("wraps in pct exec sh -c for a container", () => {
    expect(buildStatBatchCommand(["/etc/hosts"], 104)).toBe(
      "pct exec 104 -- sh -c 'stat -c '\\''%a %u %g %n'\\'' -- '\\''/etc/hosts'\\'''"
    );
  });
});

describe("parseStatBatch", () => {
  it("parses a normal batch", () => {
    const out = "644 0 0 /etc/hosts\n600 0 0 /etc/shadow\n";
    expect(parseStatBatch(out)).toEqual({
      "/etc/hosts": { mode: "644", uid: 0, gid: 0 },
      "/etc/shadow": { mode: "600", uid: 0, gid: 0 },
    });
  });

  it("preserves spaces in the path (%n is the last, greedy field)", () => {
    const out = "644 1000 1000 /etc/my dir/a file.conf\n";
    expect(parseStatBatch(out)).toEqual({
      "/etc/my dir/a file.conf": { mode: "644", uid: 1000, gid: 1000 },
    });
  });

  it("skips unrecognized lines rather than guessing", () => {
    const out = "stat: cannot stat '/etc/nope': No such file or directory\n755 0 0 /usr/bin\n";
    expect(parseStatBatch(out)).toEqual({ "/usr/bin": { mode: "755", uid: 0, gid: 0 } });
  });

  it("tolerates CRLF line endings", () => {
    expect(parseStatBatch("644 0 0 /etc/hosts\r\n")).toEqual({
      "/etc/hosts": { mode: "644", uid: 0, gid: 0 },
    });
  });
});

describe("manifest round-trip", () => {
  it("serializes with sorted keys and parses back", () => {
    const m = {
      files: {
        "/etc/zzz": { mode: "644", uid: 0, gid: 0 },
        "/etc/aaa": { mode: "600", uid: 0, gid: 0 },
      },
    };
    const text = serializeManifest(m);
    // Sorted: /etc/aaa appears before /etc/zzz.
    expect(text.indexOf("/etc/aaa")).toBeLessThan(text.indexOf("/etc/zzz"));
    expect(parseManifest(text)).toEqual(m);
  });

  it("includes skipped entries only when present", () => {
    const text = serializeManifest({
      files: {},
      skipped: { "/etc/big.img": "oversize" },
    });
    expect(parseManifest(text).skipped).toEqual({ "/etc/big.img": "oversize" });
    expect(serializeManifest(emptyManifest())).not.toContain("skipped");
  });

  it("parseManifest returns an empty manifest on corrupt JSON", () => {
    expect(parseManifest("{not json")).toEqual(emptyManifest());
  });
});
