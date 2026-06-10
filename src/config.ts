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
    reconnectDelay: z.number().default(3_000),
    commandTimeoutMs: z.number().default(30_000),
    skipHostVerification: z.boolean().default(false),
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
      "chown -R",
      "shutdown",
      "reboot",
      "halt",
      "poweroff",
      "init 0",
      "init 6",
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
      reconnectDelay: 3_000,
      commandTimeoutMs: 30_000,
      skipHostVerification: process.env.SSH_SKIP_HOST_VERIFICATION === "true",
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
