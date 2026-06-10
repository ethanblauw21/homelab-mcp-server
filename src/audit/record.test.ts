import { describe, it, expect } from "vitest";
import { buildAuditRecord, sha256, serializeRecord } from "./record.js";

describe("sha256", () => {
  it("returns a 64-char hex string", () => {
    expect(sha256(Buffer.from("hello"))).toHaveLength(64);
  });

  it("is deterministic", () => {
    const buf = Buffer.from("test content");
    expect(sha256(buf)).toBe(sha256(buf));
  });

  it("differs for different inputs", () => {
    expect(sha256(Buffer.from("a"))).not.toBe(sha256(Buffer.from("b")));
  });
});

describe("buildAuditRecord", () => {
  it("assigns a unique id", () => {
    const r1 = buildAuditRecord({ tool: "execute" });
    const r2 = buildAuditRecord({ tool: "execute" });
    expect(r1.id).toBeTruthy();
    expect(r1.id).not.toBe(r2.id);
  });

  it("assigns an ISO timestamp", () => {
    const r = buildAuditRecord({ tool: "read_file" });
    expect(() => new Date(r.ts)).not.toThrow();
    expect(new Date(r.ts).toISOString()).toBe(r.ts);
  });

  it("includes all provided fields", () => {
    const r = buildAuditRecord({
      tool: "write_file",
      path: "/etc/hosts",
      prevSha256: "abc",
      newSha256: "def",
      bytes: 100,
      isLargeChange: false,
      isRevertible: true,
    });
    expect(r.tool).toBe("write_file");
    expect(r.path).toBe("/etc/hosts");
    expect(r.prevSha256).toBe("abc");
    expect(r.newSha256).toBe("def");
    expect(r.bytes).toBe(100);
    expect(r.isRevertible).toBe(true);
  });

  it("records pct_exec with vmid", () => {
    const r = buildAuditRecord({ tool: "pct_exec", vmid: 101, cmd: "ls /", exitCode: 0 });
    expect(r.vmid).toBe(101);
    expect(r.cmd).toBe("ls /");
    expect(r.exitCode).toBe(0);
  });
});

describe("serializeRecord", () => {
  it("produces valid JSON followed by a newline", () => {
    const r = buildAuditRecord({ tool: "pct_list" });
    const line = serializeRecord(r);
    expect(line.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("round-trips through JSON", () => {
    const r = buildAuditRecord({ tool: "execute", cmd: "ls /", exitCode: 0 });
    const parsed = JSON.parse(serializeRecord(r));
    expect(parsed.id).toBe(r.id);
    expect(parsed.ts).toBe(r.ts);
    expect(parsed.cmd).toBe("ls /");
  });
});
