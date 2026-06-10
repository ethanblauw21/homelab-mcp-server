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
