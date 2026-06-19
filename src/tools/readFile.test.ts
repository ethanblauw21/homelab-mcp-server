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
    census: { redactionExtraKeys: [] },
  } as unknown as Config;
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

describe("readFileHandler — ADR-019 opt-in redaction at the return boundary", () => {
  let transport: FakeTransport;
  const SECRET = "host=db\npassword=hunter2supersecret\nport=5432\n";
  beforeEach(() => {
    transport = new FakeTransport();
  });

  it("default (no redact flag) is byte-for-byte verbatim with no extra fields", async () => {
    transport.setFile("/etc/app.conf", SECRET);
    const r = await readFileHandler({ path: "/etc/app.conf", encoding: "utf8" }, transport, makeConfig(1024));
    expect(r.content).toBe(SECRET);
    // Default-invariance: the redaction fields must be ABSENT, not false.
    expect("redacted" in r).toBe(false);
    expect("redactionCount" in r).toBe(false);
  });

  it("redact:true masks the secret but preserves structure", async () => {
    transport.setFile("/etc/app.conf", SECRET);
    const r = await readFileHandler(
      { path: "/etc/app.conf", encoding: "utf8", redact: true },
      transport,
      makeConfig(1024)
    );
    expect(r.redacted).toBe(true);
    expect(r.redactionCount).toBeGreaterThan(0);
    expect(r.content).not.toContain("hunter2supersecret");
    expect(r.content).toContain("host=db"); // non-secret structure survives
    expect(r.content).toContain("port=5432");
  });

  it("reports `bytes` from the TRUE pre-redaction length, not the masked string", async () => {
    transport.setFile("/etc/app.conf", SECRET);
    const trueLen = Buffer.byteLength(SECRET);
    const r = await readFileHandler(
      { path: "/etc/app.conf", encoding: "utf8", redact: true },
      transport,
      makeConfig(1024)
    );
    // Even though content shrank, the byte accounting reflects what was actually read.
    expect(r.bytes).toBe(trueLen);
    expect(r.content.length).not.toBe(trueLen);
  });

  it("redact:true on a base64 read is a no-op (redacted:false), blob untouched", async () => {
    transport.setFile("/blob.bin", SECRET);
    const r = await readFileHandler(
      { path: "/blob.bin", encoding: "base64", redact: true },
      transport,
      makeConfig(1024)
    );
    expect(r.redacted).toBe(false);
    expect(r.redactionCount).toBeUndefined();
    expect(Buffer.from(r.content, "base64").toString("utf8")).toBe(SECRET);
  });

  it("redaction is a post-read transform — same node-side read regardless of the flag", async () => {
    // Persisted-artifact isolation, concretely: the bytes pulled from the node are
    // identical with or without the flag; only the returned text differs.
    transport.setFile("/etc/app.conf", SECRET);
    const plain = await readFileHandler({ path: "/etc/app.conf", encoding: "utf8" }, transport, makeConfig(1024));
    const reds = await readFileHandler(
      { path: "/etc/app.conf", encoding: "utf8", redact: true },
      transport,
      makeConfig(1024)
    );
    expect(reds.bytes).toBe(plain.bytes);
  });
});
