import { z } from "zod";
import os from "os";
import path from "path";

const LOCAL_DATA_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "claude-mcp"
);

const ConfigSchema = z.object({
  ssh: z.object({
    host: z.string(),
    port: z.number().default(22),
    username: z.string().default("root"),
    privateKeyPath: z.string(),
    keepaliveInterval: z.number().default(10_000),
    // Base delay for exponential reconnect backoff (ms); cap 60s, jittered.
    reconnectDelay: z.number().default(3_000),
    commandTimeoutMs: z.number().default(30_000),
    // Client-side backstop grace added on top of the node-enforced timeout, for
    // the case where the connection itself is wedged (ADR-004 §2).
    commandTimeoutGraceMs: z.number().default(10_000),
    skipHostVerification: z.boolean().default(false),
    // Explicit host-key pin (recommended). Accepts a bare base64 digest, a
    // "SHA256:..." token, or a full `ssh-keygen -lf` line.
    hostKeyFingerprint: z.string().optional(),
    // Trust-on-first-use store path. Optional so test config literals can omit
    // it; loadConfig always supplies a default.
    knownHostsPath: z.string().optional(),
  }),
  backup: z.object({
    baseDir: z.string(),
    largeFileBytesThreshold: z.number().default(1024 * 1024), // 1 MB
    largeFilePolicy: z.enum(["diff", "metadata-only"]).default("diff"),
    perFileVersionCap: z.number().default(10),
    globalSizeCapBytes: z.number().default(100 * 1024 * 1024), // 100 MB
    diskPressureFailSafe: z.enum(["refuse", "warn"]).default("warn"),
  }),
  audit: z.object({
    logPath: z.string(),
  }),
  census: z.object({
    censusDir: z.string(),
    snapshotRetentionCap: z.number().default(30),
    probeTimeoutMs: z.number().default(10_000),
    // Global wall-clock budget for one describe_homelab call. The per-guest
    // config fan-out (depth: "full") runs sequentially over a single SSH
    // connection; without a ceiling a lab with many guests could turn one tool
    // call into a multi-minute stall. When exceeded, the census stops early and
    // records a budget error rather than hanging.
    budgetMs: z.number().default(120_000),
    storageDriftPercent: z.number().default(10),
    redactionExtraKeys: z.array(z.string()).default([]),
    // R5 — explicit truncation contract. Per-section item cap and a total
    // response byte budget; both surfaced as explicit `truncations` in output,
    // never silently dropped.
    maxItemsPerSection: z.number().default(200),
    maxResponseBytes: z.number().default(512 * 1024),
  }),
  // ADR-003 Part 1 — container file tools (pct pull/push).
  container: z.object({
    // Defaults applied to NEW container files (existing files preserve their
    // own mode/owner via stat). Mode is an octal string for `pct push --perms`.
    newFileMode: z.string().default("0644"),
    newFileUid: z.number().default(0),
    newFileGid: z.number().default(0),
    // Where `mktemp` stages pull/push temp files on the node.
    nodeTempDir: z.string().default("/tmp"),
  }),
  // ADR-003 Part 2 — snapshot guard.
  snapshot: z.object({
    // Per-guest cap on server-managed (`mcp-`) snapshots; node disk is premium.
    perGuestCap: z.number().default(3),
    // A3.2 — include RAM state in VM snapshots (qm --vmstate). Default false:
    // rollback is disk-only (guest resumes as if from power loss).
    vmstate: z.boolean().default(false),
  }),
  // ADR-004 — tool-layer caps.
  tools: z.object({
    // read_file refuses files larger than this (ADR-004 §4); use offset/maxBytes
    // for deliberate windowed reads, or execute with head/tail/grep/wc.
    readFileMaxBytes: z.number().default(2 * 1024 * 1024), // 2 MB
    // Unified-diff line cap for dryRun previews (ADR-004 §6) and diff_config (ADR-005).
    dryRunDiffMaxLines: z.number().default(200),
    // ADR-005 — tail_log line cap (requests above this are clamped).
    tailLinesCap: z.number().default(500),
    // ADR-005 — query_audit result bounds (default returned, hard ceiling).
    queryAuditDefaultLimit: z.number().default(50),
    queryAuditMaxLimit: z.number().default(200),
    // ADR-005 stretch — qm_write_file content cap. The QEMU guest-agent
    // file-write endpoint bounds a single write (~60 KB of raw content); a
    // larger write is refused with a pointer to qm_exec instead of silently
    // truncating in the guest.
    qmWriteMaxBytes: z.number().default(60000),
  }),
  // ADR-005 Part 2 — health_check thresholds (config-driven; no hardcoding).
  health: z.object({
    // Load: 1m loadavg / cores. warn ≥ 0.8×, crit ≥ 1.5×.
    loadWarnRatio: z.number().default(0.8),
    loadCritRatio: z.number().default(1.5),
    // Memory + filesystem/store usage percentages.
    memWarnPercent: z.number().default(85),
    memCritPercent: z.number().default(95),
    fsWarnPercent: z.number().default(80),
    fsCritPercent: z.number().default(90),
    // Failed units: any ⇒ warn; a failed unit on this list escalates to crit.
    failedUnitsCritList: z.array(z.string()).default([]),
    // Pending updates are informational; warn strictly above this count.
    pendingUpdatesWarnCount: z.number().default(50),
    // Per-probe exec timeout for health probes.
    probeTimeoutMs: z.number().default(10_000),
  }),
  guardrails: z.object({
    commandDenylist: z.array(z.string()).default([
      "rm -rf /",
      "rm -rf /*",
      "mkfs",
      "dd if=/dev/zero",
      "dd if=/dev/random",
      "> /dev/sda",
      ":(){ :|:& };:",
      "chmod -R 777 /",
      // NOTE: availability-class commands (shutdown/reboot/halt/poweroff/init 0|6)
      // are handled by the built-in CONFIRM tier (segment, command-position only),
      // NOT this substring denylist — see guardrails/denylist.ts. `chown -R` was
      // removed in ADR-004: it blocked every legitimate recursive chown.
    ]),
    pathAllowlist: z.array(z.string()).optional(),
    pathDenylist: z.array(z.string()).default([
      "/proc",
      "/sys",
      "/dev",
    ]),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    ssh: {
      host: process.env.SSH_HOST ?? "",
      port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT) : 22,
      username: process.env.SSH_USER ?? "root",
      privateKeyPath: process.env.SSH_KEY_PATH ?? "",
      keepaliveInterval: 10_000,
      reconnectDelay: process.env.SSH_RECONNECT_DELAY_MS
        ? parseInt(process.env.SSH_RECONNECT_DELAY_MS)
        : 3_000,
      commandTimeoutMs: 30_000,
      commandTimeoutGraceMs: process.env.SSH_COMMAND_TIMEOUT_GRACE_MS
        ? parseInt(process.env.SSH_COMMAND_TIMEOUT_GRACE_MS)
        : 10_000,
      skipHostVerification: process.env.SSH_SKIP_HOST_VERIFICATION === "true",
      hostKeyFingerprint: process.env.SSH_HOST_KEY_FINGERPRINT || undefined,
      knownHostsPath:
        process.env.SSH_KNOWN_HOSTS_PATH ?? path.join(LOCAL_DATA_DIR, "known_hosts.json"),
    },
    backup: {
      baseDir: process.env.BACKUP_DIR ?? path.join(LOCAL_DATA_DIR, "backups"),
      largeFileBytesThreshold: process.env.LARGE_FILE_BYTES
        ? parseInt(process.env.LARGE_FILE_BYTES)
        : 1024 * 1024,
      largeFilePolicy: (process.env.LARGE_FILE_POLICY ?? "diff") as "diff" | "metadata-only",
      perFileVersionCap: process.env.PER_FILE_VERSION_CAP
        ? parseInt(process.env.PER_FILE_VERSION_CAP)
        : 10,
      globalSizeCapBytes: process.env.GLOBAL_SIZE_CAP_BYTES
        ? parseInt(process.env.GLOBAL_SIZE_CAP_BYTES)
        : 100 * 1024 * 1024,
      diskPressureFailSafe: (process.env.DISK_PRESSURE_FAIL_SAFE ?? "warn") as "refuse" | "warn",
    },
    audit: {
      logPath: process.env.AUDIT_LOG_PATH ?? path.join(LOCAL_DATA_DIR, "audit.jsonl"),
    },
    census: {
      censusDir: process.env.CENSUS_DIR ?? path.join(LOCAL_DATA_DIR, "census"),
      snapshotRetentionCap: process.env.CENSUS_RETENTION_CAP
        ? parseInt(process.env.CENSUS_RETENTION_CAP)
        : 30,
      probeTimeoutMs: process.env.CENSUS_PROBE_TIMEOUT_MS
        ? parseInt(process.env.CENSUS_PROBE_TIMEOUT_MS)
        : 10_000,
      budgetMs: process.env.CENSUS_BUDGET_MS ? parseInt(process.env.CENSUS_BUDGET_MS) : 120_000,
      storageDriftPercent: process.env.CENSUS_STORAGE_DRIFT_PCT
        ? parseInt(process.env.CENSUS_STORAGE_DRIFT_PCT)
        : 10,
      redactionExtraKeys: process.env.REDACTION_EXTRA_KEYS
        ? process.env.REDACTION_EXTRA_KEYS.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      maxItemsPerSection: process.env.CENSUS_MAX_ITEMS_PER_SECTION
        ? parseInt(process.env.CENSUS_MAX_ITEMS_PER_SECTION)
        : 200,
      maxResponseBytes: process.env.CENSUS_MAX_RESPONSE_BYTES
        ? parseInt(process.env.CENSUS_MAX_RESPONSE_BYTES)
        : 512 * 1024,
    },
    container: {
      newFileMode: process.env.CONTAINER_NEW_FILE_MODE ?? "0644",
      newFileUid: process.env.CONTAINER_NEW_FILE_UID
        ? parseInt(process.env.CONTAINER_NEW_FILE_UID)
        : 0,
      newFileGid: process.env.CONTAINER_NEW_FILE_GID
        ? parseInt(process.env.CONTAINER_NEW_FILE_GID)
        : 0,
      nodeTempDir: process.env.NODE_TEMP_DIR ?? "/tmp",
    },
    snapshot: {
      perGuestCap: process.env.SNAPSHOT_PER_GUEST_CAP
        ? parseInt(process.env.SNAPSHOT_PER_GUEST_CAP)
        : 3,
      vmstate: process.env.SNAPSHOT_VMSTATE === "true",
    },
    tools: {
      readFileMaxBytes: process.env.READ_FILE_MAX_BYTES
        ? parseInt(process.env.READ_FILE_MAX_BYTES)
        : 2 * 1024 * 1024,
      dryRunDiffMaxLines: process.env.DRY_RUN_DIFF_MAX_LINES
        ? parseInt(process.env.DRY_RUN_DIFF_MAX_LINES)
        : 200,
      tailLinesCap: process.env.TAIL_LINES_CAP ? parseInt(process.env.TAIL_LINES_CAP) : 500,
      queryAuditDefaultLimit: process.env.QUERY_AUDIT_DEFAULT_LIMIT
        ? parseInt(process.env.QUERY_AUDIT_DEFAULT_LIMIT)
        : 50,
      queryAuditMaxLimit: process.env.QUERY_AUDIT_MAX_LIMIT
        ? parseInt(process.env.QUERY_AUDIT_MAX_LIMIT)
        : 200,
      qmWriteMaxBytes: process.env.QM_WRITE_MAX_BYTES
        ? parseInt(process.env.QM_WRITE_MAX_BYTES)
        : 60000,
    },
    health: {
      loadWarnRatio: process.env.HEALTH_LOAD_WARN_RATIO
        ? parseFloat(process.env.HEALTH_LOAD_WARN_RATIO)
        : 0.8,
      loadCritRatio: process.env.HEALTH_LOAD_CRIT_RATIO
        ? parseFloat(process.env.HEALTH_LOAD_CRIT_RATIO)
        : 1.5,
      memWarnPercent: process.env.HEALTH_MEM_WARN_PCT ? parseInt(process.env.HEALTH_MEM_WARN_PCT) : 85,
      memCritPercent: process.env.HEALTH_MEM_CRIT_PCT ? parseInt(process.env.HEALTH_MEM_CRIT_PCT) : 95,
      fsWarnPercent: process.env.HEALTH_FS_WARN_PCT ? parseInt(process.env.HEALTH_FS_WARN_PCT) : 80,
      fsCritPercent: process.env.HEALTH_FS_CRIT_PCT ? parseInt(process.env.HEALTH_FS_CRIT_PCT) : 90,
      failedUnitsCritList: process.env.HEALTH_FAILED_UNITS_CRIT
        ? process.env.HEALTH_FAILED_UNITS_CRIT.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      pendingUpdatesWarnCount: process.env.HEALTH_PENDING_UPDATES_WARN
        ? parseInt(process.env.HEALTH_PENDING_UPDATES_WARN)
        : 50,
      probeTimeoutMs: process.env.HEALTH_PROBE_TIMEOUT_MS
        ? parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS)
        : 10_000,
    },
    guardrails: {
      commandDenylist: process.env.COMMAND_DENYLIST
        ? process.env.COMMAND_DENYLIST.split(",")
        : undefined,
      pathAllowlist: process.env.PATH_ALLOWLIST
        ? process.env.PATH_ALLOWLIST.split(",")
        : undefined,
      pathDenylist: process.env.PATH_DENYLIST
        ? process.env.PATH_DENYLIST.split(",")
        : undefined,
    },
  };
  return ConfigSchema.parse(raw);
}

export const config: Config = loadConfig();
