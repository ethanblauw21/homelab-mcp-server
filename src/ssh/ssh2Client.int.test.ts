import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inject } from "vitest";
import { Ssh2Transport } from "./ssh2Client.js";

const dockerAvailable = inject("dockerAvailable");
const describeIfDocker = dockerAvailable ? describe : describe.skip;

let transport: Ssh2Transport;

beforeAll(() => {
  transport = new Ssh2Transport({
    host: inject("sshHost"),
    port: inject("sshPort"),
    username: "root",
    privateKeyPath: inject("sshKeyPath"),
    keepaliveInterval: 5_000,
    reconnectDelay: 1_000,
    commandTimeoutMs: 10_000,
    skipHostVerification: true,
  });
});

afterAll(async () => {
  await transport.close();
});

describeIfDocker("Ssh2Transport (real SSH container)", () => {
  describe("exec", () => {
    it("runs a command and returns stdout", async () => {
      const result = await transport.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("returns stderr from a failing command", async () => {
      const result = await transport.exec("cat /no/such/file");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/no such file/i);
    });

    it("returns non-zero exit code for a failed command", async () => {
      const result = await transport.exec("exit 42", 5_000);
      expect(result.exitCode).toBe(42);
    });

    it("captures multi-line stdout", async () => {
      const result = await transport.exec("printf 'line1\\nline2\\nline3\\n'");
      expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(3);
    });

    it("times out a slow command", async () => {
      await expect(transport.exec("sleep 10", 500)).rejects.toThrow(/timed out/i);
    });
  });

  describe("readFile / writeFile (SFTP)", () => {
    const testPath = "/tmp/mcp-int-test-rw.txt";

    it("writes a file via SFTP", async () => {
      await transport.writeFile(testPath, Buffer.from("integration test content"));
      // If no error thrown, write succeeded
    });

    it("reads back the written file", async () => {
      const content = await transport.readFile(testPath);
      expect(content.toString()).toBe("integration test content");
    });

    it("throws when reading a non-existent file", async () => {
      await expect(transport.readFile("/tmp/no-such-file-mcp-test.txt")).rejects.toThrow();
    });

    it("round-trips binary content without corruption", async () => {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const binaryPath = "/tmp/mcp-int-binary.bin";
      await transport.writeFile(binaryPath, binary);
      const back = await transport.readFile(binaryPath);
      expect(back).toEqual(binary);
    });
  });

  describe("list (SFTP)", () => {
    it("lists /tmp and returns FileEntry objects", async () => {
      const entries = await transport.list("/tmp");
      expect(Array.isArray(entries)).toBe(true);
      for (const e of entries) {
        expect(e).toHaveProperty("name");
        expect(e).toHaveProperty("type");
        expect(e).toHaveProperty("size");
        expect(e).toHaveProperty("modified");
        expect(e.modified).toBeInstanceOf(Date);
      }
    });

    it("throws when listing a non-existent directory", async () => {
      await expect(transport.list("/no/such/dir")).rejects.toThrow();
    });
  });

  describe("reconnect", () => {
    it("reconnects transparently after close()", async () => {
      // Confirm connected
      const r1 = await transport.exec("echo before-close");
      expect(r1.stdout.trim()).toBe("before-close");

      // Simulate a dropped connection
      await transport.close();

      // Next call should transparently reconnect
      const r2 = await transport.exec("echo after-reconnect");
      expect(r2.stdout.trim()).toBe("after-reconnect");
    });

    it("handles concurrent exec calls during reconnect without interleaving", async () => {
      await transport.close();
      // Fire three concurrent calls — all should see independent results
      const [r1, r2, r3] = await Promise.all([
        transport.exec("echo A"),
        transport.exec("echo B"),
        transport.exec("echo C"),
      ]);
      expect(r1.stdout.trim()).toBe("A");
      expect(r2.stdout.trim()).toBe("B");
      expect(r3.stdout.trim()).toBe("C");
    });
  });
});
