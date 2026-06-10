import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { Ssh2Transport } from "./ssh/ssh2Client.js";
import { AuditLog } from "./audit/log.js";
import { BackupStore } from "./backup/store.js";

import { ExecuteInputSchema, executeHandler } from "./tools/execute.js";
import { ReadFileInputSchema, readFileHandler } from "./tools/readFile.js";
import { WriteFileInputSchema, writeFileHandler } from "./tools/writeFile.js";
import { ListDirectoryInputSchema, listDirectoryHandler } from "./tools/listDirectory.js";
import { PctExecInputSchema, pctExecHandler } from "./tools/pctExec.js";
import { PctListInputSchema, pctListHandler } from "./tools/pctList.js";
import { RevertFileInputSchema, revertFileHandler } from "./tools/revertFile.js";
import { ListBackupsInputSchema, listBackupsHandler } from "./tools/listBackups.js";

const server = new McpServer({
  name: "homelab-ssh-mcp",
  version: "0.1.0",
});

const sshTransport = new Ssh2Transport(config.ssh);
const audit = new AuditLog(config.audit.logPath);
const backupStore = new BackupStore(config.backup);

function errResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}

server.registerTool(
  "execute",
  {
    description: "Run a shell command on the Proxmox host as root",
    inputSchema: ExecuteInputSchema,
  },
  async (input) => {
    try {
      const result = await executeHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "read_file",
  {
    description: "Read a file from the Proxmox host filesystem",
    inputSchema: ReadFileInputSchema,
  },
  async (input) => {
    try {
      const result = await readFileHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: result.content }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "write_file",
  {
    description:
      "Write/overwrite a file on the Proxmox host. Backs up the prior version and appends an audit log entry.",
    inputSchema: WriteFileInputSchema,
  },
  async (input) => {
    try {
      const result = await writeFileHandler(input, sshTransport, audit, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "list_directory",
  {
    description: "List the contents of a directory on the Proxmox host",
    inputSchema: ListDirectoryInputSchema,
  },
  async (input) => {
    try {
      const result = await listDirectoryHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result.entries) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "pct_exec",
  {
    description: "Run a command inside an LXC container via pct exec",
    inputSchema: PctExecInputSchema,
  },
  async (input) => {
    try {
      const result = await pctExecHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "pct_list",
  {
    description: "List LXC containers and their status via pct list",
    inputSchema: PctListInputSchema,
  },
  async (input) => {
    try {
      const result = await pctListHandler(input, sshTransport);
      return { content: [{ type: "text", text: JSON.stringify(result.containers) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "revert_file",
  {
    description:
      "Restore a file on the Proxmox host to a previous version from a local backup blob. " +
      "Pass the backupPath returned by a prior write_file call (or from list_backups).",
    inputSchema: RevertFileInputSchema,
  },
  async (input) => {
    try {
      const result = await revertFileHandler(input, sshTransport, audit, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "list_backups",
  {
    description:
      "List available backup versions for a file on the Proxmox host. " +
      "Returns each version's backupPath, timestamp, kind, size, and whether it is revertible.",
    inputSchema: ListBackupsInputSchema,
  },
  async (input) => {
    try {
      const result = await listBackupsHandler(input, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

process.on("SIGINT", async () => {
  await sshTransport.close();
  process.exit(0);
});
