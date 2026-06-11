import { describe, it, expect } from "vitest";
import {
  globToRegExp,
  matchesAnyGlob,
  classifyEnumeration,
  diffAgainstMirror,
  parseFindEnumeration,
  parseSha256Sum,
} from "./sweepPlanner.js";

describe("globToRegExp / matchesAnyGlob", () => {
  it("** spans path segments, * does not", () => {
    expect(globToRegExp("**/*.lock").test("/etc/x.lock")).toBe(true);
    expect(globToRegExp("**/*.lock").test("/etc/sub/y.lock")).toBe(true);
    expect(globToRegExp("/etc/*.conf").test("/etc/a.conf")).toBe(true);
    expect(globToRegExp("/etc/*.conf").test("/etc/sub/a.conf")).toBe(false);
  });

  it("anchors fully and matches absolute literals", () => {
    expect(globToRegExp("/etc/mtab").test("/etc/mtab")).toBe(true);
    expect(globToRegExp("/etc/mtab").test("/etc/mtab.bak")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(globToRegExp("/etc/a.b").test("/etc/aXb")).toBe(false);
    expect(globToRegExp("/etc/a.b").test("/etc/a.b")).toBe(true);
  });

  it("matchesAnyGlob ORs the patterns", () => {
    expect(matchesAnyGlob("/etc/x.sock", ["**/*.lock", "**/*.sock"])).toBe(true);
    expect(matchesAnyGlob("/etc/x.conf", ["**/*.lock", "**/*.sock"])).toBe(false);
  });
});

describe("classifyEnumeration", () => {
  it("splits into candidates / excluded / oversize", () => {
    const r = classifyEnumeration({
      enumerated: [
        { path: "/etc/hosts", sizeBytes: 100 },
        { path: "/etc/x.lock", sizeBytes: 10 },
        { path: "/etc/big.img", sizeBytes: 5_000_000 },
      ],
      excludePatterns: ["**/*.lock"],
      sizeCapBytes: 1_000_000,
    });
    expect(r.candidates).toEqual(["/etc/hosts"]);
    expect(r.excluded).toEqual(["/etc/x.lock"]);
    expect(r.skippedOversize).toEqual([{ path: "/etc/big.img", sizeBytes: 5_000_000 }]);
  });

  it("excludes take precedence over the size check", () => {
    const r = classifyEnumeration({
      enumerated: [{ path: "/etc/huge.lock", sizeBytes: 9_999_999 }],
      excludePatterns: ["**/*.lock"],
      sizeCapBytes: 1_000,
    });
    expect(r.excluded).toEqual(["/etc/huge.lock"]);
    expect(r.skippedOversize).toEqual([]);
  });
});

describe("diffAgainstMirror", () => {
  it("classifies changed/new/unchanged and deletions", () => {
    const r = diffAgainstMirror({
      candidates: ["/etc/changed", "/etc/new", "/etc/same"],
      remoteHashes: new Map([
        ["/etc/changed", "hashB"],
        ["/etc/new", "hashN"],
        ["/etc/same", "hashS"],
      ]),
      mirrorHashes: new Map([
        ["/etc/changed", "hashA"],
        ["/etc/same", "hashS"],
        ["/etc/gone", "hashG"],
      ]),
      mirrorPaths: ["/etc/changed", "/etc/same", "/etc/gone"],
      allRemotePaths: ["/etc/changed", "/etc/new", "/etc/same"],
    });
    expect(r.toFetch.sort()).toEqual(["/etc/changed", "/etc/new"]);
    expect(r.unchanged).toEqual(["/etc/same"]);
    expect(r.toDelete).toEqual(["/etc/gone"]);
  });

  it("a candidate whose remote hash is missing is skipped (not fetched)", () => {
    const r = diffAgainstMirror({
      candidates: ["/etc/unhashed"],
      remoteHashes: new Map(),
      mirrorHashes: new Map(),
      mirrorPaths: [],
      allRemotePaths: ["/etc/unhashed"],
    });
    expect(r.toFetch).toEqual([]);
  });

  it("an oversize file still present remotely is NOT deleted from the mirror", () => {
    // /etc/big is excluded from candidates (oversize) but appears in allRemotePaths,
    // so it must not be treated as a deletion.
    const r = diffAgainstMirror({
      candidates: [],
      remoteHashes: new Map(),
      mirrorHashes: new Map([["/etc/big", "h"]]),
      mirrorPaths: ["/etc/big"],
      allRemotePaths: ["/etc/big"],
    });
    expect(r.toDelete).toEqual([]);
  });
});

describe("parseFindEnumeration", () => {
  it("parses tab-separated size/path, preserving spaces", () => {
    const out = "100\t/etc/hosts\n42\t/etc/my dir/a.conf\n";
    expect(parseFindEnumeration(out)).toEqual([
      { sizeBytes: 100, path: "/etc/hosts" },
      { sizeBytes: 42, path: "/etc/my dir/a.conf" },
    ]);
  });

  it("skips malformed lines", () => {
    expect(parseFindEnumeration("notabhere\n\n7\t/ok")).toEqual([
      { sizeBytes: 7, path: "/ok" },
    ]);
  });
});

describe("parseSha256Sum", () => {
  it("parses hash + path (two-space separator), preserving spaces in path", () => {
    const h = "a".repeat(64);
    const out = `${h}  /etc/hosts\n${"b".repeat(64)}  /etc/my dir/a.conf\n`;
    const map = parseSha256Sum(out);
    expect(map.get("/etc/hosts")).toBe(h);
    expect(map.get("/etc/my dir/a.conf")).toBe("b".repeat(64));
  });

  it("ignores non-hash lines", () => {
    expect(parseSha256Sum("sha256sum: /etc/x: Is a directory\n").size).toBe(0);
  });
});
