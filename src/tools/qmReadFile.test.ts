import { describe, it, expect } from "vitest";
import { qmReadFileHandler } from "./qmReadFile.js";
import { buildAgentFileReadCommand } from "./qmFiles.js";
import { FakeTransport } from "../ssh/fakeTransport.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    ssh: { host: "h", port: 22, username: "root", privateKeyPath: "", keepaliveInterval: 0, reconnectDelay: 0, commandTimeoutMs: 5000, skipHostVerification: true },
    backup: { baseDir: "", largeFileBytesThreshold: 1024 * 1024, largeFilePolicy: "diff", perFileVersionCap: 10, globalSizeCapBytes: 100 * 1024 * 1024, diskPressureFailSafe: "warn" },
    audit: { logPath: "" },
    container: { newFileMode: "0644", newFileUid: 0, newFileGid: 0, nodeTempDir: "/tmp" },
    snapshot: { perGuestCap: 3, vmstate: false },
    tools: { readFileMaxBytes: 16, dryRunDiffMaxLines: 200, qmWriteMaxBytes: 60000 },
    guardrails: { commandDenylist: [], pathAllowlist: undefined, pathDenylist: [] },
  } as unknown as Config;
}

/** Wire the three execs a successful qm_read_file makes: ping, hostname, file-read. */
function primeAgent(t: FakeTransport, vmid: number, node: string): void {
  t.setExecResult(`qm agent ${vmid} ping`, { stdout: "", stderr: "", exitCode: 0 });
  t.setExecResult("hostname", { stdout: `${node}\n`, stderr: "", exitCode: 0 });
}

describe("qmReadFileHandler", () => {
  it("reads a file's content via the guest agent", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/app.conf"), {
      stdout: JSON.stringify({ content: "hello", truncated: false }),
      stderr: "",
      exitCode: 0,
    });

    const res = await qmReadFileHandler(
      { vmid: 200, path: "/etc/app.conf", encoding: "utf8" },
      t,
      makeConfig()
    );
    expect(res.content).toBe("hello");
    expect(res.bytes).toBe(5);
    expect(res.offset).toBe(0);
    expect(res.truncated).toBe(false);
  });

  it("surfaces the agent's truncated flag honestly", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/app.conf"), {
      stdout: JSON.stringify({ content: "abc", truncated: 1 }),
      stderr: "",
      exitCode: 0,
    });
    const res = await qmReadFileHandler({ vmid: 200, path: "/etc/app.conf", encoding: "utf8" }, t, makeConfig());
    expect(res.truncated).toBe(true);
  });

  it("throws a clear error when the file does not exist", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/missing"), {
      stdout: "", stderr: "No such file or directory", exitCode: 1,
    });
    await expect(
      qmReadFileHandler({ vmid: 200, path: "/etc/missing", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/not found inside VM 200/i);
  });

  it("refuses a non-windowed read over the byte cap", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/big.conf"), {
      stdout: JSON.stringify({ content: "x".repeat(64), truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    await expect(
      qmReadFileHandler({ vmid: 200, path: "/etc/big.conf", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/over the 16-byte read cap/i);
  });

  it("returns a window when offset/maxBytes are supplied (bounded by the cap)", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/big.conf"), {
      stdout: JSON.stringify({ content: "0123456789abcdef", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const res = await qmReadFileHandler(
      { vmid: 200, path: "/etc/big.conf", encoding: "utf8", offset: 4, maxBytes: 4 },
      t,
      makeConfig()
    );
    expect(res.content).toBe("4567");
    expect(res.offset).toBe(4);
    expect(res.bytes).toBe(4);
  });

  it("fails closed when the guest agent is unavailable", async () => {
    const t = new FakeTransport();
    t.setExecResult("qm agent 200 ping", { stdout: "", stderr: "agent not running", exitCode: 1 });
    await expect(
      qmReadFileHandler({ vmid: 200, path: "/etc/app.conf", encoding: "utf8" }, t, makeConfig())
    ).rejects.toThrow(/qemu-guest-agent/i);
  });

  it("rejects a path outside the allowlist", async () => {
    const t = new FakeTransport();
    const cfg = makeConfig();
    cfg.guardrails.pathAllowlist = ["/etc"];
    await expect(
      qmReadFileHandler({ vmid: 200, path: "/root/secret", encoding: "utf8" }, t, cfg)
    ).rejects.toThrow(/invalid path/i);
  });

  it("can return base64 encoding", async () => {
    const t = new FakeTransport();
    primeAgent(t, 200, "pve");
    t.setExecResult(buildAgentFileReadCommand("pve", 200, "/etc/app.conf"), {
      stdout: JSON.stringify({ content: "abc", truncated: false }),
      stderr: "",
      exitCode: 0,
    });
    const res = await qmReadFileHandler({ vmid: 200, path: "/etc/app.conf", encoding: "base64" }, t, makeConfig());
    expect(res.content).toBe(Buffer.from("abc").toString("base64"));
    expect(res.encoding).toBe("base64");
  });
});
