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
import { DescribeHomelabInputSchema, describeHomelabHandler } from "./tools/describeHomelab.js";
import { CensusStore } from "./tools/censusStore.js";
import { PctReadFileInputSchema, pctReadFileHandler } from "./tools/pctReadFile.js";
import { PctWriteFileInputSchema, pctWriteFileHandler } from "./tools/pctWriteFile.js";
import {
  SnapshotCreateInputSchema,
  snapshotCreateHandler,
  SnapshotListInputSchema,
  snapshotListHandler,
  SnapshotRollbackInputSchema,
  snapshotRollbackHandler,
  SnapshotDeleteInputSchema,
  snapshotDeleteHandler,
} from "./tools/snapshotTools.js";
import { QmListInputSchema, qmListHandler } from "./tools/qmList.js";
import { QmAgentPingInputSchema, qmAgentPingHandler } from "./tools/qmAgentPing.js";
import { QmExecInputSchema, qmExecHandler } from "./tools/qmExec.js";
import { QmReadFileInputSchema, qmReadFileHandler } from "./tools/qmReadFile.js";
import { QmWriteFileInputSchema, qmWriteFileHandler } from "./tools/qmWriteFile.js";
import { HealthCheckInputSchema, healthCheckHandler } from "./tools/healthCheck.js";
import { TailLogInputSchema, tailLogHandler } from "./tools/tailLog.js";
import { QueryAuditInputSchema, queryAuditHandler } from "./tools/queryAudit.js";
import { DiffConfigInputSchema, diffConfigHandler } from "./tools/diffConfig.js";
import { ConfigHistory } from "./history/configHistory.js";
import { ConfigSweepInputSchema, configSweepHandler } from "./tools/configSweep.js";

const server = new McpServer({
  name: "homelab-ssh-mcp",
  version: "0.1.0",
});

const sshTransport = new Ssh2Transport(config.ssh);
const audit = new AuditLog(config.audit.logPath);
const backupStore = new BackupStore(config.backup);
const censusStore = new CensusStore(config.census.censusDir, config.census.snapshotRetentionCap);
// ADR-006 — config-history mirror repo. Initialized below (detects git; stays
// disabled and no-ops if git is absent). Mutation commits are best-effort; the
// config_sweep tool is registered only when the subsystem is enabled.
const configHistory = new ConfigHistory(config.history);

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
      const result = await writeFileHandler(input, sshTransport, audit, backupStore, config, configHistory);
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
      const result = await revertFileHandler(input, sshTransport, audit, backupStore, config, configHistory);
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

server.registerTool(
  "describe_homelab",
  {
    description:
      "Read-only homelab census: walks the Proxmox node via a fixed set of probe " +
      "commands and returns a structured, secret-redacted inventory (node, storage, " +
      "network, containers, vms, services, tailscale). Optionally persists a snapshot " +
      "and reports drift vs the previous one. No caller-supplied commands.",
    inputSchema: DescribeHomelabInputSchema,
  },
  async (input) => {
    try {
      const result = await describeHomelabHandler(input, sshTransport, censusStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "pct_read_file",
  {
    description:
      "Read a file from inside an LXC container (binary-safe via pct pull). " +
      "Requires the container to be running.",
    inputSchema: PctReadFileInputSchema,
  },
  async (input) => {
    try {
      const result = await pctReadFileHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: result.content }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "pct_write_file",
  {
    description:
      "Write/overwrite a file inside an LXC container (via pct push). Backs up the prior version, " +
      "preserves the existing file's permissions and owner, and appends an audit log entry. " +
      "Requires the container to be running.",
    inputSchema: PctWriteFileInputSchema,
  },
  async (input) => {
    try {
      const result = await pctWriteFileHandler(input, sshTransport, audit, backupStore, config, configHistory);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "snapshot_create",
  {
    description:
      "Create a server-managed (mcp-) snapshot of a guest (LXC or VM). Auto-detects guest type. " +
      "Enforces a per-guest retention cap, deleting the oldest mcp- snapshot first if needed. " +
      "Use before a risky operation; delete on success or roll back on failure.",
    inputSchema: SnapshotCreateInputSchema,
  },
  async (input) => {
    try {
      const result = await snapshotCreateHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "snapshot_list",
  {
    description:
      "List snapshots for a guest (LXC or VM), flagging which are server-managed (mcp-).",
    inputSchema: SnapshotListInputSchema,
  },
  async (input) => {
    try {
      const result = await snapshotListHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "snapshot_rollback",
  {
    description:
      "Roll a guest back to a server-managed (mcp-) snapshot. DESTRUCTIVE: discards all guest state " +
      "since the snapshot. Requires confirm: true. Only mcp-* snapshots are eligible. A running guest " +
      "is refused unless stopIfRunning: true. NOTE: VM snapshots are taken without RAM state by default, " +
      "so a VM rollback is disk-only — the guest resumes as if from power loss, not from the snapshot moment.",
    inputSchema: SnapshotRollbackInputSchema,
  },
  async (input) => {
    try {
      const result = await snapshotRollbackHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "snapshot_delete",
  {
    description:
      "Delete a server-managed (mcp-) snapshot of a guest. Only mcp-* snapshots are eligible; " +
      "human-made snapshots are protected.",
    inputSchema: SnapshotDeleteInputSchema,
  },
  async (input) => {
    try {
      const result = await snapshotDeleteHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "qm_list",
  {
    description: "List QEMU/KVM virtual machines and their status via qm list.",
    inputSchema: QmListInputSchema,
  },
  async (input) => {
    try {
      const result = await qmListHandler(input, sshTransport);
      return { content: [{ type: "text", text: JSON.stringify(result.vms) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "qm_agent_ping",
  {
    description:
      "Check whether a VM's QEMU guest agent is responsive (qm agent <vmid> ping). " +
      "Returns { available, error? }; agent-dependent tools require this to pass.",
    inputSchema: QmAgentPingInputSchema,
  },
  async (input) => {
    try {
      const result = await qmAgentPingHandler(input, sshTransport);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "qm_exec",
  {
    description:
      "Run a command inside a VM via the QEMU guest agent (qm guest exec). Requires the guest " +
      "agent (qemu-guest-agent) to be installed and running. The inner command passes the same " +
      "two-tier denylist as execute/pct_exec; CONFIRM-tier commands require confirm: true. " +
      "Honest exit semantics: a non-terminating agent timeout cannot guarantee in-guest kill.",
    inputSchema: QmExecInputSchema,
  },
  async (input) => {
    try {
      const result = await qmExecHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "qm_read_file",
  {
    description:
      "Read a file from inside a VM via the QEMU guest agent (agent/file-read). Requires the guest " +
      "agent. Text-oriented (binary is lossy); enforces the same read cap + offset/maxBytes window as " +
      "read_file/pct_read_file. For large files use offset/maxBytes or qm_exec with head/tail/grep/wc.",
    inputSchema: QmReadFileInputSchema,
  },
  async (input) => {
    try {
      const result = await qmReadFileHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "qm_write_file",
  {
    description:
      "Write a file inside a VM via the QEMU guest agent (agent/file-write). Requires the guest agent. " +
      "Runs the full backup + audit pipeline (dryRun previews a diff with no side effects). Bounded by " +
      "the guest-agent write cap; no permission preservation (file lands with the guest's default umask).",
    inputSchema: QmWriteFileInputSchema,
  },
  async (input) => {
    try {
      const result = await qmWriteFileHandler(input, sshTransport, audit, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "health_check",
  {
    description:
      "Read-only node health check: runs a fixed set of probes (load, memory, ZFS, filesystem/" +
      "storage usage, failed systemd units, onboot-but-stopped guests, pending apt updates) and " +
      "rolls them up to ok/warn/crit against configured thresholds. Sections are error-isolated; " +
      "apt staleness is read via apt-get -s (simulate), never apt update.",
    inputSchema: HealthCheckInputSchema,
  },
  async (input) => {
    try {
      const result = await healthCheckHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "tail_log",
  {
    description:
      "Read the tail of a systemd unit journal (journalctl) or a log file (tail), on the host or " +
      "inside an LXC container. Strict input validation (unit charset, since grammar, path allowlist, " +
      "line cap). Output ALWAYS passes through secret redaction before return.",
    inputSchema: TailLogInputSchema,
  },
  async (input) => {
    try {
      const result = await tailLogHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "query_audit",
  {
    description:
      "Query the local audit log. Filter by tool, vmid, path substring, time range, or large-change " +
      "flag; returns a summary (counts by tool/vmid, time span) plus the newest-first matching records " +
      "(bounded by a configurable limit). Read-only, not itself audited.",
    inputSchema: QueryAuditInputSchema,
  },
  async (input) => {
    try {
      const result = queryAuditHandler(input, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

server.registerTool(
  "diff_config",
  {
    description:
      "Preview what reverting a file would change: reconstructs a backup's content and diffs it " +
      "against the file's current content (current → backup). Resolve by backupPath, or by path " +
      "(+vmid for containers) to use the latest backup. Read-only, not audited; the revert it " +
      "precedes is what gets logged.",
    inputSchema: DiffConfigInputSchema,
  },
  async (input) => {
    try {
      const result = await diffConfigHandler(input, sshTransport, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-006 — initialize the config-history mirror (detect git, bootstrap repo).
// On absence the subsystem stays disabled and config_sweep is NOT registered, so
// the model never sees a tool it cannot run. Mutation commits remain best-effort.
await configHistory.init();

if (configHistory.enabled) {
  server.registerTool(
    "config_sweep",
    {
      description:
        "Sweep a watched config set (host /etc + running containers by default) into the git-backed " +
        "config-history mirror. Hash-compares before fetching so only changed/new files are pulled; " +
        "records deletions, refreshes the perms manifest, and makes one commit per sweep. Captures " +
        "out-of-band changes (hand edits, package upgrades) that the audit log and backups never see. " +
        "Read-only against the node; stopped containers are skipped with a note.",
      inputSchema: ConfigSweepInputSchema,
    },
    async (input) => {
      try {
        const result = await configSweepHandler(input, sshTransport, configHistory, audit, config);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) { return errResult(err); }
    }
  );
}

const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

process.on("SIGINT", async () => {
  await sshTransport.close();
  process.exit(0);
});
