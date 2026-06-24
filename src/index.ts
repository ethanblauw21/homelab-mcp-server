import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { Ssh2Transport } from "./ssh/ssh2Client.js";
import { AuditLog } from "./audit/log.js";
import { BackupStore } from "./backup/store.js";
import { strictifyInputSchema } from "./util/strictSchema.js";

import { ExecuteInputSchema, executeHandler } from "./tools/execute.js";
import { ReadFileInputSchema, readFileHandler } from "./tools/readFile.js";
import { WriteFileInputSchema, writeFileHandler } from "./tools/writeFile.js";
import { EditFileInputSchema, editFileHandler } from "./tools/editFile.js";
import { ListDirectoryInputSchema, listDirectoryHandler } from "./tools/listDirectory.js";
import { PctExecInputSchema, pctExecHandler } from "./tools/pctExec.js";
import { PctListInputSchema, pctListHandler } from "./tools/pctList.js";
import { RevertFileInputSchema, revertFileHandler } from "./tools/revertFile.js";
import { RollbackBreaker } from "./guardrails/rollbackBreaker.js";
import { ListBackupsInputSchema, listBackupsHandler } from "./tools/listBackups.js";
import { DescribeHomelabInputSchema, describeHomelabHandler } from "./tools/describeHomelab.js";
import { DescribeGuestInputSchema, describeGuestHandler } from "./tools/describeGuest.js";
import { CensusStore } from "./tools/censusStore.js";
import { PctReadFileInputSchema, pctReadFileHandler } from "./tools/pctReadFile.js";
import { PctWriteFileInputSchema, pctWriteFileHandler } from "./tools/pctWriteFile.js";
import { PctEditFileInputSchema, pctEditFileHandler } from "./tools/pctEditFile.js";
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
import { QmEditFileInputSchema, qmEditFileHandler } from "./tools/qmEditFile.js";
import { DockerPsInputSchema, dockerPsHandler } from "./tools/dockerPs.js";
import { DockerExecInputSchema, dockerExecHandler } from "./tools/dockerExec.js";
import { DockerLogsInputSchema, dockerLogsHandler } from "./tools/dockerLogs.js";
import { DockerReadFileInputSchema, dockerReadFileHandler } from "./tools/dockerReadFile.js";
import { DockerWriteFileInputSchema, dockerWriteFileHandler } from "./tools/dockerWriteFile.js";
import { DockerEditFileInputSchema, dockerEditFileHandler } from "./tools/dockerEditFile.js";
import { DockerInspectInputSchema, dockerInspectHandler } from "./tools/dockerInspect.js";
import { DockerStatsInputSchema, dockerStatsHandler } from "./tools/dockerStats.js";
import { ComposeDiscoverInputSchema, composeDiscoverHandler } from "./tools/composeDiscover.js";
import { HealthCheckInputSchema, healthCheckHandler, type HealthCheckResult } from "./tools/healthCheck.js";
import { SnapshotStore } from "./ui/snapshotStore.js";
import { TailLogInputSchema, tailLogHandler } from "./tools/tailLog.js";
import { QueryAuditInputSchema, queryAuditHandler } from "./tools/queryAudit.js";
import { AuditDb, openAuditDb } from "./audit/auditDb.js";
import { assertFeedTarget } from "./feed/feedGuard.js";
import { DiffConfigInputSchema, diffConfigHandler } from "./tools/diffConfig.js";
import { ConfigHistory } from "./history/configHistory.js";
import { ConfigSweepInputSchema, configSweepHandler } from "./tools/configSweep.js";
import { isToolEnabled, type Tier } from "./tiers/registry.js";
import { resolveTier, rootBanner } from "./tiers/rootFlag.js";
import type { NodeOps } from "./node/nodeOps.js";
import { ApiBackend } from "./node/apiBackend.js";
import { makeApiHttp } from "./node/apiClient.js";
import { SshBackend } from "./node/sshBackend.js";
import {
  GuestStartInputSchema,
  guestStartHandler,
  GuestStopInputSchema,
  guestStopHandler,
  GuestRestartInputSchema,
  guestRestartHandler,
} from "./tools/lifecycle.js";
import {
  GuestBackupInputSchema,
  guestBackupHandler,
  GuestBackupRestoreInputSchema,
  guestBackupRestoreHandler,
} from "./tools/backupTools.js";
import { ComposeRedeployInputSchema, composeRedeployHandler } from "./tools/composeRedeploy.js";
import { ComposePreflightInputSchema, composePreflightHandler } from "./tools/composePreflightHandler.js";
import {
  ServiceStatusInputSchema,
  serviceStatusHandler,
  ServiceLogsInputSchema,
  serviceLogsHandler,
  ServiceRestartInputSchema,
  serviceRestartHandler,
} from "./tools/serviceTools.js";
import {
  TcpPingInputSchema,
  tcpPingHandler,
  HttpProbeInputSchema,
  httpProbeHandler,
} from "./tools/probes.js";
import { SearchFileRegexInputSchema, searchFileRegexHandler } from "./tools/searchFileRegex.js";
import {
  ComputeTreeInputSchema,
  computeTreeHandler,
  VerifyIntegrityInputSchema,
  verifyIntegrityHandler,
  AcceptTruthInputSchema,
  acceptTruthHandler,
  openIntegrityStore,
} from "./tools/integrity.js";
import { IntegrityEngine } from "./integrity/integrityEngine.js";
import type { NodeStore } from "./integrity/nodeStore.js";
import { assertNonOverlap } from "./integrity/forestShape.js";

const server = new McpServer({
  name: "homelab-ssh-mcp",
  version: "0.2.0",
});

// ADR-007 — resolve the active permission tier. `level` (observe/operate/companion)
// comes from MCP_TIER; the root flag (exact-string-gated) is the ONLY way to reach
// root. There is no runtime escalation path. Tools above the active tier are never
// registered, so the model never sees a tool it cannot run.
const activeTier: Tier = resolveTier(config.tier.level, config.tier.rootEnabled);
const isRootTier = activeTier === "root";

// One-line startup identity: answers "is the right thing running?" before someone asks.
const hostDisplay = config.api.baseUrl
  ? (() => { try { return new URL(config.api.baseUrl).hostname; } catch { return config.api.baseUrl; } })()
  : config.ssh.host || "unconfigured";
process.stderr.write(`homelab-mcp v0.2.0 | tier: ${activeTier} | host: ${hostDisplay}\n`);

if (config.tier.rootEnabled) {
  // Loud, every start. stdout is the MCP channel — diagnostics go to stderr.
  process.stderr.write(rootBanner() + "\n");
}

const sshTransport = new Ssh2Transport(config.ssh);
const audit = new AuditLog(config.audit.logPath);
// ADR-022 — the derived audit.db projection. Mirror each append into it (best-
// effort, fail-soft — see AuditLog.append), giving query_audit an indexed + FTS
// fast path. The JSONL stays the system of record; on first run we backfill the
// index from existing history so prior records are immediately searchable.
let auditDb: AuditDb | undefined;
if (config.audit.dbEnabled) {
  auditDb = openAuditDb(config);
  audit.setProjector(auditDb);
  if (auditDb.count() === 0) {
    const existing = audit.readAll();
    if (existing.length > 0) auditDb.rebuildFrom(existing);
  }
}
const backupStore = new BackupStore(config.backup);
// ADR-021 — one process-lifetime rollback circuit breaker, injected into the three
// rollback handlers. Session == process for a stdio MCP server, so the in-memory
// per-target counters reset on restart (the strongest breaker reset).
const rollbackBreaker = new RollbackBreaker(config.guardrails.rollbackBreaker);
const censusStore = new CensusStore(config.census.censusDir, config.census.snapshotRetentionCap);
// ADR-006 — config-history mirror repo. Initialized below (detects git; stays
// disabled and no-ops if git is absent). Mutation commits are best-effort; the
// config_sweep tool is registered only when the subsystem is enabled.
const configHistory = new ConfigHistory(config.history);

// ADR-010 §2 — cached-state sinks for the localhost UI sidecar. `health_check` and
// `verify_integrity` are otherwise computed live and never written to disk; here the
// stdio (agent) path persists each result to the same dirs the UI renderer reads, so
// the dashboard shows the last agent-run health/drift with no live session. Both
// payloads carry no secret-bearing fields (metrics/statuses; forest paths + hashes).
const healthSink = new SnapshotStore<HealthCheckResult>(config.ui.healthDir, config.ui.healthRetentionCap);
const driftSink = new SnapshotStore<unknown>(config.ui.driftDir, config.ui.driftRetentionCap);

// ADR-007 §3 — NodeOps backend selection. The API backend rides every tier and is
// preferred whenever fully configured (it's the only path that works at observe/
// operate, which have no SSH key); otherwise fall back to the SSH backend
// (companion+). "The transport follows the tool, not the tier."
const nodeOps: NodeOps =
  config.api.baseUrl && config.api.tokenId && config.api.tokenSecret && config.api.node
    ? new ApiBackend(makeApiHttp(config.api), { node: config.api.node })
    : new SshBackend(sshTransport, config.ssh.commandTimeoutMs);

function errResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  let hint = "";
  if (/ECONNREFUSED|connect ECONNREFUSED/i.test(msg)) {
    hint = " — SSH connection refused. Verify SSH_HOST is correct and the node is up. Run `npm run doctor` to diagnose.";
  } else if (/ETIMEDOUT|timed out|backstop fired/i.test(msg)) {
    hint = " — connection timed out. Run `npm run doctor` to check connectivity.";
  } else if (/no such file.*\.ssh|ENOENT.*\.ssh|cannot open.*private key/i.test(msg)) {
    hint = " — SSH key file not found. Check SSH_KEY_PATH or re-run setup.";
  } else if (/host key verification failed|hostVerifier/i.test(msg)) {
    hint = " — host key mismatch. Check SSH_HOST_KEY_FINGERPRINT (see stderr for details). Re-run `npm run setup` to re-capture.";
  } else if (/backup storage.*cap|over cap.*disk.pressure/i.test(msg)) {
    hint = " — raise GLOBAL_SIZE_CAP_BYTES or move BACKUP_DIR to a larger disk.";
  } else if (/container.*not running|not running.*container/i.test(msg)) {
    hint = " — start the container first with guest_start, or use host-level tools.";
  }
  return { isError: true as const, content: [{ type: "text" as const, text: hint ? `${msg}${hint}` : msg }] };
}

/**
 * Tier-gated registration (ADR-007 §1): register a tool only when the active tier
 * is at or above its declared minimum. This is the enforcement boundary for the
 * MCP-enforced tiers and the zero-attack-surface guarantee for absent tiers.
 *
 * Typed AS `server.registerTool` so each call site keeps its own Zod-shape
 * inference; the gate short-circuits before the SDK ever sees a too-high tool.
 */
const register = ((name: string, def: unknown, cb: unknown) => {
  if (!isToolEnabled(name, activeTier)) return undefined;
  // ADR-023 #3/#7 — stricten every tool's input schema at the registration boundary
  // so an unknown/hallucinated param errors loudly instead of being silently stripped.
  const d = def as { inputSchema?: unknown };
  if (d && d.inputSchema !== undefined) d.inputSchema = strictifyInputSchema(d.inputSchema);
  return (server.registerTool as (n: string, d: unknown, c: unknown) => unknown)(name, def, cb);
}) as typeof server.registerTool;

register(
  "execute",
  {
    description: "Run a shell command on the Proxmox host as root",
    inputSchema: ExecuteInputSchema,
  },
  async (input) => {
    try {
      const result = await executeHandler(input, sshTransport, audit, config, isRootTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

register(
  "write_file",
  {
    description:
      "Write/overwrite a file on the Proxmox host. Backs up the prior version and appends an audit log entry.",
    inputSchema: WriteFileInputSchema,
  },
  async (input) => {
    try {
      const result = await writeFileHandler(input, sshTransport, audit, backupStore, config, configHistory, isRootTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "edit_file",
  {
    description:
      "Edit a host file by find-and-replace (oldString→newString) instead of resending the whole file (ADR-011). " +
      "oldString must be unique unless replaceAll. File must already exist and be text. Same backup/audit/diff pipeline as write_file.",
    inputSchema: EditFileInputSchema,
  },
  async (input) => {
    try {
      const result = await editFileHandler(input, sshTransport, audit, backupStore, config, configHistory, isRootTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

register(
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

register(
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

register(
  "revert_file",
  {
    description:
      "Restore a file on the Proxmox host to a previous version from a local backup blob. " +
      "Pass the backupPath returned by a prior write_file call (or from list_backups).",
    inputSchema: RevertFileInputSchema,
  },
  async (input) => {
    try {
      const result = await revertFileHandler(input, sshTransport, audit, backupStore, config, configHistory, rollbackBreaker);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "list_backups",
  {
    description:
      "List available backup versions for a file on the Proxmox host. " +
      "Returns each version's backupPath, timestamp, kind, size, and whether it is revertible.",
    inputSchema: ListBackupsInputSchema,
  },
  async (input) => {
    try {
      // ADR-014 §1 — hand list_backups the SSH transport only at companion+ (where
      // an SSH credential exists, gauged by pct_exec being enabled) so it can hash
      // the live file and report honest revertibility. Below that it stays local-only.
      const sshForRevertibility = isToolEnabled("pct_exec", activeTier) ? sshTransport : undefined;
      const result = await listBackupsHandler(input, backupStore, config, sshForRevertibility);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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
      const result = await describeHomelabHandler(
        input,
        sshTransport,
        censusStore,
        config,
        Date.now,
        nodeOps,
        activeTier
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "describe_guest",
  {
    description:
      "Read-only single-guest census (ADR-017 §4): identity + run-state + snapshotCapable, " +
      "and (LXC) the redacted config, Docker roster, and failed systemd units — scoped to one " +
      "VMID so you pay for that guest, not the whole node. Reuses the census parsers/redaction; " +
      "no new node access. Optional `sections` narrows further (config, docker, units).",
    inputSchema: DescribeGuestInputSchema,
  },
  async (input) => {
    try {
      const result = await describeGuestHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

register(
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

register(
  "pct_edit_file",
  {
    description:
      "Edit a file inside an LXC container by find-and-replace (oldString→newString) instead of resending " +
      "the whole file (ADR-011). oldString must be unique unless replaceAll. File must already exist and be " +
      "text. Same backup/audit/diff pipeline as pct_write_file; requires the container to be running.",
    inputSchema: PctEditFileInputSchema,
  },
  async (input) => {
    try {
      const result = await pctEditFileHandler(input, sshTransport, audit, backupStore, config, configHistory);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

register(
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

register(
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
      const result = await snapshotRollbackHandler(input, sshTransport, audit, config, rollbackBreaker);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

register(
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

register(
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

register(
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

register(
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

register(
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

register(
  "qm_edit_file",
  {
    description:
      "Edit a file inside a VM by find-and-replace (oldString→newString) instead of resending the whole " +
      "file (ADR-011). oldString must be unique unless replaceAll. File must already exist and be text. " +
      "Same backup/audit pipeline + guest-agent write cap as qm_write_file; requires the guest agent.",
    inputSchema: QmEditFileInputSchema,
  },
  async (input) => {
    try {
      const result = await qmEditFileHandler(input, sshTransport, audit, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-008 — Docker layer (companion tier). All five ride the LXC `pct exec`
// plumbing; the daemon socket is never exposed. docker_read_file is faithful
// (no redaction); docker_logs is always redacted; docker_write_file runs the
// full backup + audit pipeline but is excluded from the git mirror (no
// descriptor-stable host/pct path), like qm.
register(
  "docker_ps",
  {
    description:
      "List Docker containers running inside an LXC container (docker ps). Read-only, not audited. " +
      "Returns each container's name, image, status, and compose project.",
    inputSchema: DockerPsInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerPsHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "docker_exec",
  {
    description:
      "Run a command inside a Docker container (docker exec) hosted in an LXC container. The inner " +
      "command passes the same two-tier denylist as execute/pct_exec/qm_exec; CONFIRM-tier commands " +
      "require confirm: true. Audited (records vmid + container).",
    inputSchema: DockerExecInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerExecHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "docker_logs",
  {
    description:
      "Read the tail of a Docker container's logs (docker logs) hosted in an LXC container. Strict " +
      "input validation (since grammar, line cap). Output ALWAYS passes through secret redaction " +
      "before return. Read-only.",
    inputSchema: DockerLogsInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerLogsHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "docker_read_file",
  {
    description:
      "Read a file from inside a Docker container hosted in an LXC container. Uses the bind-mount fast " +
      "path when the path is bind-mounted (reads the LXC source directly), else relays via docker cp. " +
      "Enforces the same read cap + offset/maxBytes window as the other read tools. Not redacted " +
      "(fidelity is the point); requires the LXC container to be running.",
    inputSchema: DockerReadFileInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerReadFileHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "docker_write_file",
  {
    description:
      "Write/overwrite a file inside a Docker container hosted in an LXC container. Uses the bind-mount " +
      "fast path (preserves perms) when possible, else relays via docker cp and restores ownership " +
      "best-effort. Runs the full backup + audit pipeline (dryRun previews a diff with no side effects). " +
      "Returns a diff-on-write. Requires the LXC container to be running.",
    inputSchema: DockerWriteFileInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerWriteFileHandler(input, sshTransport, audit, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "docker_edit_file",
  {
    description:
      "Edit a file inside a Docker container by find-and-replace (oldString→newString) instead of resending " +
      "the whole file (ADR-011). oldString must be unique unless replaceAll. File must already exist and be " +
      "text. Same bind-mount/docker-cp + backup/audit/diff pipeline as docker_write_file; requires the LXC " +
      "container to be running.",
    inputSchema: DockerEditFileInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerEditFileHandler(input, sshTransport, audit, backupStore, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-016 — Docker introspection (companion tier, read-only, not audited). The
// dominant dogfooding pattern (hand-rolled `pct_exec docker inspect/stats` loops)
// gets first-class structured tools on the same `pct exec docker …` boundary.
register(
  "docker_inspect",
  {
    description:
      "Structured single-container view via docker inspect inside an LXC. Returns image + resolved " +
      "image id (the pin), status/health, restart policy, networks, mounts, published ports, and " +
      "compose labels; env keeps names but redacts secret VALUES by default. Pass fields[] to narrow " +
      "the projection. Read-only, not audited.",
    inputSchema: DockerInspectInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerInspectHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "docker_stats",
  {
    description:
      "Point-in-time resource snapshot via docker stats --no-stream inside an LXC: per-container CPU%, " +
      "memory used/limit/%, net and block IO, sorted by memory descending. A single sample, not a live " +
      "feed. Read-only, not audited.",
    inputSchema: DockerStatsInputSchema,
  },
  async (input) => {
    try {
      const result = await dockerStatsHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "compose_discover",
  {
    description:
      "Read-only compose project map from the running containers' compose labels inside an LXC: " +
      "[{ project, configFile, services: [{ name, image, ports }] }]. Produces the composePath that " +
      "compose_redeploy/compose_preflight need. Sees only running containers (a down project is " +
      "invisible). Read-only, not audited.",
    inputSchema: ComposeDiscoverInputSchema,
  },
  async (input) => {
    try {
      const result = await composeDiscoverHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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
      const result = await healthCheckHandler(input, sshTransport, config, nodeOps, activeTier, healthSink);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

register(
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
      const result = queryAuditHandler(input, audit, config, auditDb);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
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

// ADR-007 — guest lifecycle tools (operate tier, API-native via NodeOps). At
// observe/operate these ride the API backend and Proxmox RBAC is the real
// enforcement; the registry gates registration so they appear only at operate+.
register(
  "guest_start",
  {
    description:
      "Start a guest (LXC container or VM) by vmid. API-native operate-tier control; the guest type " +
      "is auto-detected. Audited.",
    inputSchema: GuestStartInputSchema,
  },
  async (input) => {
    try {
      const result = await guestStartHandler(input, nodeOps, audit, config, isRootTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "guest_stop",
  {
    description:
      "Stop a guest (LXC container or VM) by vmid. Confirm-gated: a stop is an immediate power-off, " +
      "not a graceful shutdown. Use guest_restart for a graceful cycle. Audited.",
    inputSchema: GuestStopInputSchema,
  },
  async (input) => {
    try {
      const result = await guestStopHandler(input, nodeOps, audit, config, isRootTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "guest_restart",
  {
    description:
      "Restart a guest (LXC container or VM) by vmid via a graceful reboot (shutdown + start). " +
      "Auto-detects guest type. Audited.",
    inputSchema: GuestRestartInputSchema,
  },
  async (input) => {
    try {
      const result = await guestRestartHandler(input, nodeOps, audit, config, isRootTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-008 §6 — outcome-level rollback for snapshot-incapable guests (companion
// tier; vzdump via NodeOps — API where configured, SSH otherwise). The mcp-
// ownership boundary + retention + confirm gate make these MCP-enforced.
register(
  "guest_backup",
  {
    description:
      "Create a vzdump archive of a guest (the rollback path for guests that cannot snapshot, e.g. GPU " +
      "passthrough). Confirm-gated: vzdump is heavy and suspend/stop modes interrupt service. Archives are " +
      "note-tagged mcp- and retention-capped per guest (default 1); human-made archives are never touched.",
    inputSchema: GuestBackupInputSchema,
  },
  async (input) => {
    try {
      const result = await guestBackupHandler(input, nodeOps, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "guest_backup_restore",
  {
    description:
      "Restore a guest from a server-managed (mcp-) vzdump archive. DESTRUCTIVE: REPLACES THE ENTIRE GUEST " +
      "(disk + config) from the archive. Requires confirm: true; only mcp- archives are eligible; a running " +
      "guest is refused unless stopIfRunning: true (then it is stopped, restored, and restarted).",
    inputSchema: GuestBackupRestoreInputSchema,
  },
  async (input) => {
    try {
      const result = await guestBackupRestoreHandler(input, nodeOps, audit, config, rollbackBreaker);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "compose_redeploy",
  {
    description:
      "Redeploy a Docker Compose stack inside an LXC: docker compose -f <composePath> up -d (run on the LXC " +
      "host via pct exec). Confirm-gated (recreates containers, disrupts services). Pair with revert_file on " +
      "the compose file for a seconds-scale stack rollback (no vzdump needed). Companion tier; audited.",
    inputSchema: ComposeRedeployInputSchema,
  },
  async (input) => {
    try {
      const result = await composeRedeployHandler(input, sshTransport, audit, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-012 — compose_preflight: static hazard analysis BEFORE a stack deploy. The
// read-only, never-audited counterpart to compose_redeploy (predict the bad
// outcome cheaply, like dryRun/diff_config/health_check). Companion tier.
register(
  "compose_preflight",
  {
    description:
      "Statically analyze a proposed Docker Compose change for deploy hazards BEFORE you deploy: internal-port " +
      "collisions across a shared network namespace, the netns-provider recreate deadlock (a tailscale-style " +
      "provider edit that wedges an in-place up -d), and declared ports already bound in the guest. Pass " +
      "composeContent to preflight an edit you have in hand (proposed vs on-disk). Read-only, not audited; run it " +
      "before compose_redeploy. Companion tier.",
    inputSchema: ComposePreflightInputSchema,
  },
  async (input) => {
    try {
      const result = await composePreflightHandler(input, sshTransport, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-020 §1 — systemd front door (service_status/_logs/_restart). Floor is
// companion (an LXC unit via pct exec); a HOST unit additionally requires root,
// asserted at runtime in the handlers via assertTargetTier. The payoff is the
// clean, parse-free audit row (service_restart) a free-form execute can't give.
register(
  "service_status",
  {
    description:
      "Parsed systemd unit status {active, sub, enabled, since, mainPid} via systemctl show. Host unit " +
      "(root tier) or an LXC unit (vmid, companion). Read-only, not audited.",
    inputSchema: ServiceStatusInputSchema,
  },
  async (input) => {
    try {
      const result = await serviceStatusHandler(input, sshTransport, config, activeTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "service_logs",
  {
    description:
      "Bounded, ALWAYS-redacted journal tail for a systemd unit (tail_log with a unit-only contract). Host " +
      "unit (root tier) or an LXC unit (vmid, companion). since accepts ISO or '<n> (min|hour|day) ago'.",
    inputSchema: ServiceLogsInputSchema,
  },
  async (input) => {
    try {
      const result = await serviceLogsHandler(input, sshTransport, config, activeTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "service_restart",
  {
    description:
      "Restart a systemd unit (systemctl restart). Confirm-gated (interrupts the running service); host unit " +
      "(root tier) or an LXC unit (vmid, companion). Audited with a structured {tool, unit, vmid} record.",
    inputSchema: ServiceRestartInputSchema,
  },
  async (input) => {
    try {
      const result = await serviceRestartHandler(input, sshTransport, audit, config, activeTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-020 §2 — reachability probes. Host-side by default (Node net/http, zero
// credentials, no node round-trip) ⇒ observe; http_probe's fromVmid runs inside
// an LXC via pct exec and asserts companion at runtime. Read-only, not audited.
register(
  "tcp_ping",
  {
    description:
      "One TCP connect from the Windows host to host:port → {reachable, latencyMs}. No payload sent, zero " +
      "credentials. The reachability check that pairs with a lifecycle/deploy verb. Read-only, not audited.",
    inputSchema: TcpPingInputSchema,
  },
  async (input) => {
    try {
      const result = await tcpPingHandler(input, config);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

register(
  "http_probe",
  {
    description:
      "Probe an http(s) URL → {status, ok, latencyMs, bodyBytes, from}. expectStatus makes ok an assertion. " +
      "Default probes from the Windows host (observe); fromVmid runs curl INSIDE an LXC (companion) to reach " +
      "container-network services. NOT a TLS-trust check (self-signed certs are accepted). Read-only, not audited.",
    inputSchema: HttpProbeInputSchema,
  },
  async (input) => {
    try {
      const result = await httpProbeHandler(input, sshTransport, config, activeTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-020 §3 — content-addressed regex read (grep -C balloon). Floor companion
// (LXC/Docker path); a HOST path requires root, asserted via assertTargetTier.
register(
  "search_file_regex",
  {
    description:
      "Search a file for an extended regex and return each match plus N context lines each side (grep -C " +
      "balloon): [{lineNo, matchLine, before, after}], capped with a truncated marker. Content-addressed " +
      "windowing — find first, return only the neighborhood (vs read_file's blind byte window). Host path " +
      "(root), LXC path (vmid, companion), or Docker path (vmid+container, companion). Read-only, not audited.",
    inputSchema: SearchFileRegexInputSchema,
  },
  async (input) => {
    try {
      const result = await searchFileRegexHandler(input, sshTransport, config, activeTier);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) { return errResult(err); }
  }
);

// ADR-009 — Merkle integrity forest (companion tier). The SQLite node store holds
// the baseline/working Merkle trees on this Windows host; only open it (native dep)
// when the tier actually registers an integrity tool. The engine reads file content
// over the same SSH transport (host SFTP / pct pull) the other companion tools use.
let integrityStore: NodeStore | undefined;
if (isToolEnabled("verify_integrity", activeTier)) {
  // Fail fast (§4): the host subtree and the container subtrees must never describe
  // the same bytes, or a file would be hashed twice (raw host view vs pct view).
  assertNonOverlap(config.history.hostWatchPaths, config.integrity.containerBackingPaths);
  integrityStore = openIntegrityStore(config);
  const integrityEngine = new IntegrityEngine(integrityStore, sshTransport, config, audit);

  register(
    "compute_tree",
    {
      description:
        "Build/refresh the Merkle integrity baseline at a tracking level (L1 mtime, L2 config content, " +
        "L3 full content) over the host + running containers. Mutates only the LOCAL node store on this " +
        "Windows host — never the node. Audited. First-run seeding; use verify_integrity to detect drift.",
      inputSchema: ComputeTreeInputSchema,
    },
    async (input) => {
      try {
        const result = await computeTreeHandler(input, integrityEngine, audit, config);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) { return errResult(err); }
    }
  );

  register(
    "verify_integrity",
    {
      description:
        "Read-only drift report: diff the current Merkle forest against the baseline and classify each " +
        "changed leaf explained (an audit afterHash matches — the server caused it) vs unexplained " +
        "(human/package/out-of-band). 'smart' level runs L1 first and only reads file content where L1 " +
        "flags a touch. With autoAccept: true, applies the audited auto-accept policy after reporting.",
      inputSchema: VerifyIntegrityInputSchema,
    },
    async (input) => {
      try {
        const result = await verifyIntegrityHandler(input, integrityEngine, config, driftSink);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) { return errResult(err); }
    }
  );

  register(
    "accept_truth",
    {
      description:
        "Explicit human override: fold the current state (a scope, or the whole forest) into all three " +
        "Merkle baselines at once, so a subsequent verify_integrity shows no drift. Use after reviewing " +
        "and approving out-of-band changes. Audited with before/after super-root hashes.",
      inputSchema: AcceptTruthInputSchema,
    },
    async (input) => {
      try {
        const result = await acceptTruthHandler(input, integrityEngine, config);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) { return errResult(err); }
    }
  );
}

// ADR-006 — initialize the config-history mirror (detect git, bootstrap repo).
// On absence the subsystem stays disabled and config_sweep is NOT registered, so
// the model never sees a tool it cannot run. Mutation commits remain best-effort.
await configHistory.init();

// ADR-022 §2 — semantic change-history feed (pull-first). PULL needs no code on
// this side: the external rust file-system indexer reads the git mirror on its own
// cadence (never on the write's critical path). When enabled we surface the mirror
// path to point it at, and fail-closed (`assertFeedTarget`) on a non-loopback push
// endpoint — the content feed carries UNREDACTED config and the change-event feed
// best-effort-redacted diffs, so both must stay on-host / same trust zone (§3). The
// PUSH emitter itself is deferred/external-blocked (the indexer's streamed-ingestion
// tool does not exist yet); `buildChangeEvent` + `assertFeedTarget` (src/feed/) are
// the ready seam it will use when it lands.
if (config.feed.indexerContentEnabled) {
  const contentPath = config.feed.indexerContentPath ?? config.history.configHistoryDir;
  if (config.feed.indexerPushEndpoint) {
    assertFeedTarget(config.feed.indexerPushEndpoint); // refuse a non-loopback target at startup
  }
  process.stderr.write(
    `[feed] ADR-022 pull content feed ENABLED — point the rust file-system indexer at the ` +
      `config-history mirror: ${contentPath} (must stay on-host / same trust zone — it holds ` +
      `UNREDACTED config; ADR-022 §3). The push change-event emitter is deferred (external).\n`
  );
}

if (configHistory.enabled) {
  register(
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
  integrityStore?.close();
  auditDb?.close();
  await sshTransport.close();
  process.exit(0);
});
