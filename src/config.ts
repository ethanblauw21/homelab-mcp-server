import { z } from "zod";
import os from "os";
import path from "path";
import { parseRootFlag } from "./tiers/rootFlag.js";

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
  // ADR-007 — permission tiers. The tier model is data (see tiers/registry.ts);
  // this only carries the operator's selection + the root acknowledgment.
  tier: z.object({
    // Selectable in setup: observe (API token, RBAC-enforced) / operate (API
    // token + custom role) / companion (+ root SSH key, MCP-enforced). root is
    // NOT selectable here — it is reached only via the acknowledgment flag below.
    // Default companion preserves the ADR-001 install (root SSH, no tier var) per
    // the ADR-007 migration; setup.ps1 always writes an explicit tier and
    // recommends observe for new installs.
    level: z.enum(["observe", "operate", "companion"]).default("companion"),
    // True ONLY when MCP_HOST_ROOT_ENABLED holds the exact acknowledgment string
    // (tiers/rootFlag.ts). Any other value, including "true", is disabled.
    rootEnabled: z.boolean().default(false),
  }),
  // ADR-007 — PVE API backend (the API path of the hybrid transport). Required
  // for observe/operate (no SSH key exists at those tiers); optional but preferred
  // at companion/root (API rides every tier for what it can express).
  api: z.object({
    // e.g. "https://10.0.0.10:8006". Empty disables the API backend (SSH-only).
    baseUrl: z.string().optional(),
    // Token id "user@realm!tokenname" + secret. Privilege-separated per tier.
    tokenId: z.string().optional(),
    tokenSecret: z.string().optional(),
    // Pinned TLS cert fingerprint ("SHA256:..."), captured at setup. Fail-closed
    // on mismatch (shared pinnedTrust module — same model as the SSH host key).
    tlsFingerprint: z.string().optional(),
    // TOFU store for the API cert, mirroring known_hosts.json for SSH.
    knownCertsPath: z.string().optional(),
    // PVE node name for /nodes/<node>/... paths. Resolved at setup or from census.
    node: z.string().optional(),
    requestTimeoutMs: z.number().default(15_000),
  }),
  backup: z.object({
    baseDir: z.string(),
    largeFileBytesThreshold: z.number().default(1024 * 1024), // 1 MB
    largeFilePolicy: z.enum(["diff", "metadata-only"]).default("diff"),
    perFileVersionCap: z.number().default(10),
    globalSizeCapBytes: z.number().default(100 * 1024 * 1024), // 100 MB
    diskPressureFailSafe: z.enum(["refuse", "warn"]).default("warn"),
    // ADR-008 §6 — vzdump (guest_backup). The node storage that holds archives,
    // and the per-guest cap on server-managed (mcp-) archives. Default 1: vzdump
    // archives are large and node disk is premium (human-made archives are
    // invisible to retention, per the snapshot ownership rule).
    nodeBackupStorage: z.string().default("local"),
    guestArchivePerGuestCap: z.number().default(1),
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
  // ADR-006 — git-backed config history (mirror repo + sweeps).
  history: z.object({
    // The single local mirror repo. Lives beside the backup store on the Windows
    // host; its trust level equals the backup blob store's (unredacted content).
    configHistoryDir: z.string(),
    // Push is a tri-mode config with a zero-exposure default. local-only never
    // touches a remote; push-lan/push-encrypted move unredacted data (documented
    // at this config site). A plain unencrypted cloud remote is NOT a supported
    // mode and must not be added — the repo contains unredacted secrets.
    pushMode: z.enum(["local-only", "push-lan", "push-encrypted"]).default("local-only"),
    // Remote URL for push-lan (SSH/file remote on the NAS) or push-encrypted
    // (git-remote-gcrypt URL). Ignored in local-only.
    remote: z.string().optional(),
    // Watched sets for config_sweep. Host default includes /etc (and thus
    // /etc/pve, which pmxcfs surfaces under /etc). Per-container default /etc.
    hostWatchPaths: z.array(z.string()).default(["/etc"]),
    containerWatchPaths: z.array(z.string()).default(["/etc"]),
    // Exclude globs applied in the (pure) sweep planner: lockfiles, sockets, and
    // mtab-style runtime symlinks that are noise or hostile to mirroring.
    excludePatterns: z.array(z.string()).default([
      "**/*.lock",
      "**/*.sock",
      "/etc/mtab",
      "/etc/.pwd.lock",
      "/etc/lvm/cache/*",
    ]),
    // Per-file size cap for sweeps; over-cap files are SKIPPED and noted in the
    // manifest, never silently dropped.
    sweepFileSizeCapBytes: z.number().default(1024 * 1024), // 1 MB
  }),
  // ADR-009 — Merkle integrity forest. Watched sets are SHARED with history.*
  // (the forest hashes the same paths config_sweep mirrors); this section adds the
  // forest-specific knobs. Reads only, companion+.
  integrity: z.object({
    // SQLite node store on the client (off the premium node disk, by design).
    dbPath: z.string(),
    // Configured default verify depth (setup: last-edited→l1 / coarse→l2 / fine→l3).
    // verify_integrity can override per call; "smart" runs L1-gated escalation.
    level: z.enum(["l1", "l2", "l3"]).default("l2"),
    // L2 "important config" membership — a leaf is in the L2 tree iff its path
    // matches one of these globs. Kept deliberately broad (config-ish extensions
    // + a few well-known extensionless files).
    configFileGlobs: z.array(z.string()).default([
      "**/*.conf",
      "**/*.cfg",
      "**/*.yml",
      "**/*.yaml",
      "**/*.ini",
      "**/*.toml",
      "**/*.json",
      "**/*.env",
      "**/*config",
      "**/sshd_config",
      "**/fstab",
      "**/hosts",
      "**/crontab",
    ]),
    // Auto-accept policy (§6). maxUnexplainedL3 bounds the unexplained non-config
    // tail that folds without a human; L2 config drift never auto-folds unless
    // explicitly loosened; sensitive paths never auto-fold regardless.
    maxUnexplainedL3: z.number().default(20),
    allowL2AutoAccept: z.boolean().default(false),
    sensitiveGlobs: z.array(z.string()).default(["/etc/pve"]),
    // Non-overlap invariant (§1): the host watcher must NOT point at
    // container-backing storage, or the same bytes hash twice (raw vs pct view).
    // Asserted at forest-config load; a host watch path under any of these throws.
    containerBackingPaths: z.array(z.string()).default([
      "/var/lib/vz",
      "/var/lib/pve",
      "/dev/zvol",
      "/dev/pve",
    ]),
  }),
  // ADR-010 — localhost UI sidecar. A SECOND, standing, human-facing process
  // (`npm run ui`), separate from the stdio MCP server. The renderer half reads
  // only client-side artifacts (no credentials); the executor half runs ONLY the
  // bounded §5 human-tool set and is OFF by default (strict renderer-only).
  ui: z.object({
    // Loopback-only by hard rule (§Security). The server refuses any non-loopback
    // bind address — remote access is explicitly out of ADR-010's scope.
    bindAddress: z.string().default("127.0.0.1"),
    port: z.number().default(7311),
    // Strict renderer-only is the default-safe mode (action item 7): live
    // human-tool buttons are disabled and the executor is never constructed, so
    // the standing process holds zero node credentials — the ADR-001 property in
    // its empty-set form. Setting this true opts into the bounded executor.
    enableActions: z.boolean().default(false),
    // Cached-state snapshot stores for the two panels whose source tools are NOT
    // otherwise persisted (health_check, verify_integrity). The MCP server writes
    // these on each run so the UI shows the last state with no live session.
    healthDir: z.string(),
    driftDir: z.string(),
    healthRetentionCap: z.number().default(30),
    driftRetentionCap: z.number().default(30),
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
    tier: {
      // MCP_TIER absent ⇒ companion (legacy migration). An out-of-range value
      // (e.g. "root") is rejected by the enum on purpose — root is flag-only.
      level: (process.env.MCP_TIER ?? "companion") as "observe" | "operate" | "companion",
      rootEnabled: parseRootFlag(process.env.MCP_HOST_ROOT_ENABLED),
    },
    api: {
      baseUrl: process.env.PVE_API_BASE_URL || undefined,
      tokenId: process.env.PVE_API_TOKEN_ID || undefined,
      tokenSecret: process.env.PVE_API_TOKEN_SECRET || undefined,
      tlsFingerprint: process.env.PVE_API_TLS_FINGERPRINT || undefined,
      knownCertsPath:
        process.env.PVE_API_KNOWN_CERTS_PATH ?? path.join(LOCAL_DATA_DIR, "known_certs.json"),
      node: process.env.PVE_API_NODE || undefined,
      requestTimeoutMs: process.env.PVE_API_TIMEOUT_MS
        ? parseInt(process.env.PVE_API_TIMEOUT_MS)
        : 15_000,
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
      nodeBackupStorage: process.env.NODE_BACKUP_STORAGE ?? "local",
      guestArchivePerGuestCap: process.env.GUEST_ARCHIVE_PER_GUEST_CAP
        ? parseInt(process.env.GUEST_ARCHIVE_PER_GUEST_CAP)
        : 1,
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
    history: {
      configHistoryDir:
        process.env.CONFIG_HISTORY_DIR ?? path.join(LOCAL_DATA_DIR, "config-history"),
      pushMode: (process.env.GIT_HISTORY_PUSH_MODE ?? "local-only") as
        | "local-only"
        | "push-lan"
        | "push-encrypted",
      remote: process.env.GIT_HISTORY_REMOTE || undefined,
      hostWatchPaths: process.env.HISTORY_HOST_WATCH_PATHS
        ? process.env.HISTORY_HOST_WATCH_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      containerWatchPaths: process.env.HISTORY_CONTAINER_WATCH_PATHS
        ? process.env.HISTORY_CONTAINER_WATCH_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      excludePatterns: process.env.HISTORY_EXCLUDE_PATTERNS
        ? process.env.HISTORY_EXCLUDE_PATTERNS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      sweepFileSizeCapBytes: process.env.HISTORY_SWEEP_FILE_SIZE_CAP_BYTES
        ? parseInt(process.env.HISTORY_SWEEP_FILE_SIZE_CAP_BYTES)
        : 1024 * 1024,
    },
    integrity: {
      dbPath: process.env.INTEGRITY_DB_PATH ?? path.join(LOCAL_DATA_DIR, "integrity.db"),
      level: (process.env.INTEGRITY_LEVEL ?? "l2") as "l1" | "l2" | "l3",
      configFileGlobs: process.env.INTEGRITY_CONFIG_GLOBS
        ? process.env.INTEGRITY_CONFIG_GLOBS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      maxUnexplainedL3: process.env.INTEGRITY_MAX_UNEXPLAINED_L3
        ? parseInt(process.env.INTEGRITY_MAX_UNEXPLAINED_L3)
        : 20,
      allowL2AutoAccept: process.env.INTEGRITY_ALLOW_L2_AUTO_ACCEPT === "true",
      sensitiveGlobs: process.env.INTEGRITY_SENSITIVE_GLOBS
        ? process.env.INTEGRITY_SENSITIVE_GLOBS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      containerBackingPaths: process.env.INTEGRITY_CONTAINER_BACKING_PATHS
        ? process.env.INTEGRITY_CONTAINER_BACKING_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    },
    ui: {
      bindAddress: process.env.UI_BIND_ADDRESS ?? "127.0.0.1",
      port: process.env.UI_PORT ? parseInt(process.env.UI_PORT) : 7311,
      enableActions: process.env.UI_ENABLE_ACTIONS === "true",
      healthDir: process.env.UI_HEALTH_DIR ?? path.join(LOCAL_DATA_DIR, "health"),
      driftDir: process.env.UI_DRIFT_DIR ?? path.join(LOCAL_DATA_DIR, "drift"),
      healthRetentionCap: process.env.UI_HEALTH_RETENTION_CAP
        ? parseInt(process.env.UI_HEALTH_RETENTION_CAP)
        : 30,
      driftRetentionCap: process.env.UI_DRIFT_RETENTION_CAP
        ? parseInt(process.env.UI_DRIFT_RETENTION_CAP)
        : 30,
    },
  };
  return ConfigSchema.parse(raw);
}

export const config: Config = loadConfig();
