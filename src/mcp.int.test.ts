import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inject } from "vitest";

const dockerAvailable = inject("dockerAvailable");
const describeIfDocker = dockerAvailable ? describe : describe.skip;
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distEntry = path.join(rootDir, "dist", "index.js");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: {
      ...process.env,
      SSH_HOST: inject("sshHost"),
      SSH_PORT: String(inject("sshPort")),
      SSH_KEY_PATH: inject("sshKeyPath"),
      SSH_SKIP_HOST_VERIFICATION: "true",
      BACKUP_DIR: path.join(rootDir, ".int-test-backups"),
      AUDIT_LOG_PATH: path.join(rootDir, ".int-test-audit.jsonl"),
      // ADR-007: tools above the active tier are not registered at all. This
      // suite exercises the host tools (execute/read_file/list_directory) — the
      // only ones meaningfully runnable against the bare Alpine harness (no
      // pct/qm) — so it must run at the root tier. The default level is
      // companion, so without the exact root acknowledgment string the host
      // tools never register and every call below MCP-errors.
      MCP_HOST_ROOT_ENABLED: "I-understand-Claude-gets-root-and-can-break-this-node",
    },
  });

  client = new Client({ name: "int-test-client", version: "0.0.1" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

describeIfDocker("MCP stdio protocol", () => {
  describe("tool registration", () => {
    it("registers the core tools at the root tier", async () => {
      // Superset check, not exact equality: the root-tier tool set grows with
      // every ADR (008 added docker_*, 009 the integrity tools, …). Asserting a
      // fixed list re-breaks this suite on each ADR — assert the core ADR-001
      // surface is present and let the set grow underneath it.
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      for (const core of [
        "execute",
        "read_file",
        "write_file",
        "list_directory",
        "pct_exec",
        "pct_list",
        "revert_file",
        "list_backups",
      ]) {
        expect(names.has(core)).toBe(true);
      }
    });

    it("each tool has a description and inputSchema", async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  describe("execute tool", () => {
    it("runs echo and returns stdout in result", async () => {
      const result = await client.callTool({
        name: "execute",
        arguments: { command: "echo mcp-test" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.stdout.trim()).toBe("mcp-test");
      expect(parsed.exitCode).toBe(0);
    });

    it("returns structured output for a non-zero exit", async () => {
      const result = await client.callTool({
        name: "execute",
        arguments: { command: "exit 1" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.exitCode).toBe(1);
    });

    it("rejects a denylisted command with isError", async () => {
      const result = await client.callTool({
        name: "execute",
        arguments: { command: "rm -rf /" },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("read_file tool", () => {
    it("reads /etc/hostname", async () => {
      const result = await client.callTool({
        name: "read_file",
        arguments: { path: "/etc/hostname" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text.trim().length).toBeGreaterThan(0);
    });

    it("returns isError for a traversal path", async () => {
      const result = await client.callTool({
        name: "read_file",
        arguments: { path: "/etc/../etc/passwd" },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("list_directory tool", () => {
    it("lists /tmp and returns an array", async () => {
      const result = await client.callTool({
        name: "list_directory",
        arguments: { path: "/tmp" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const entries = JSON.parse(text);
      expect(Array.isArray(entries)).toBe(true);
    });
  });

  describe("pct_list tool", () => {
    it("returns a result even when pct is not available (Alpine container)", async () => {
      // pct won't exist in Alpine — we get an error result, not a crash
      const result = await client.callTool({ name: "pct_list", arguments: {} });
      // Either success (if somehow available) or isError — never an unhandled exception
      expect(result.content).toBeDefined();
    });
  });

  describe("Zod input validation", () => {
    it("rejects execute with missing command field", async () => {
      const result = await client.callTool({
        name: "execute",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    });

    it("rejects read_file with a relative path", async () => {
      const result = await client.callTool({
        name: "read_file",
        arguments: { path: "relative/path" },
      });
      expect(result.isError).toBe(true);
    });

    it("rejects pct_exec with a non-integer vmid", async () => {
      const result = await client.callTool({
        name: "pct_exec",
        arguments: { vmid: "not-a-number", command: "ls" },
      });
      expect(result.isError).toBe(true);
    });
  });
});
