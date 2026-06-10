import { describe, it, expect, beforeEach } from "vitest";
import { readFileHandler } from "./readFile.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

function makeConfig(maxBytes: number): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, commandTimeoutGraceMs: 10000, skipHostVerification: true },
    backup: { baseDir: "", largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: "" },
    tools: { readFileMaxBytes: maxBytes, dryRunDiffMaxLines: 200 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  };
}

describe("readFileHandler (ADR-004 §4 cap + windowing)", () => {
  let transport: FakeTransport;
  beforeEach(() => {
    transport = new FakeTransport();
  });

  it("reads a small file whole", async () => {
    transport.setFile("/etc/hosts", "127.0.0.1 localhost\n");
    const r = await readFileHandler({ path: "/etc/hosts", encoding: "utf8" }, transport, makeConfig(1024));
    expect(r.content).toBe("127.0.0.1 localhost\n");
    expect(r.offset).toBe(0);
    expect(r.bytes).toBe(20);
  });

  it("refuses a whole-file read over the cap with a helpful error", async () => {
    transport.setFile("/big.log", "x".repeat(5000));
    await expect(
      readFileHandler({ path: "/big.log", encoding: "utf8" }, transport, makeConfig(1000))
    ).rejects.toThrow(/over the 1000-byte read_file cap.*head\/tail\/grep\/wc/s);
  });

  it("allows a windowed read of an oversize file via offset/maxBytes", async () => {
    transport.setFile("/big.log", "ABCDEFGHIJ".repeat(1000)); // 10000 bytes
    const r = await readFileHandler(
      { path: "/big.log", encoding: "utf8", offset: 5, maxBytes: 3 },
      transport,
      makeConfig(1000)
    );
    expect(r.content).toBe("FGH");
    expect(r.offset).toBe(5);
    expect(r.bytes).toBe(3);
  });

  it("clamps a window request to the cap", async () => {
    transport.setFile("/big.log", "y".repeat(5000));
    const r = await readFileHandler(
      { path: "/big.log", encoding: "utf8", offset: 0, maxBytes: 999999 },
      transport,
      makeConfig(100)
    );
    expect(r.bytes).toBe(100);
  });

  it("rejects an invalid path before touching the transport", async () => {
    await expect(
      readFileHandler({ path: "relative/x", encoding: "utf8" }, transport, makeConfig(1024))
    ).rejects.toThrow(/invalid path/i);
  });
});
