#!/usr/bin/env node
/**
 * npm run doctor — pre-flight check for the homelab MCP server.
 *
 * Checks: Node version, claude CLI, built artifact, required env vars
 * for the active tier, SSH key existence, and API endpoint reachability.
 * Runs in ~2 seconds and answers "why isn't this working?" before it
 * gets asked.
 *
 * Does not require the server to be running and has zero side effects.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let warned = 0;
let failed = 0;

function ok(label, detail) {
  console.log(`  \x1b[32m[ok]\x1b[0m  ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
}
function warn(label, detail) {
  console.log(`  \x1b[33m[!]\x1b[0m   ${label}${detail ? ` — ${detail}` : ""}`);
  warned++;
}
function fail(label, detail, fix) {
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  if (fix) console.log(`         fix: ${fix}`);
  failed++;
}

function checkExe(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false });
  if (r.error || r.status !== 0) return null;
  return (r.stdout + r.stderr).trim().split("\n")[0];
}

// ---------------------------------------------------------------------------
// Node version
// ---------------------------------------------------------------------------
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor >= 20) {
  ok("Node.js", `v${process.versions.node}`);
} else {
  fail("Node.js", `v${process.versions.node} (need ≥ 20)`, "Install Node.js 20+ from nodejs.org");
}

// ---------------------------------------------------------------------------
// claude CLI
// ---------------------------------------------------------------------------
const claudeVer = checkExe("claude", ["--version"]);
if (claudeVer) {
  ok("claude CLI", claudeVer);
} else {
  fail("claude CLI", "not found on PATH", "Install Claude Code: https://claude.ai/code");
}

// ---------------------------------------------------------------------------
// Built artifact
// ---------------------------------------------------------------------------
const distEntry = path.join(ROOT, "dist", "index.js");
if (existsSync(distEntry)) {
  ok("dist/index.js", "build is present");
} else {
  fail("dist/index.js", "not found", "Run: npm run build");
}

// ---------------------------------------------------------------------------
// Active tier
// ---------------------------------------------------------------------------
const tier = process.env.MCP_TIER || "companion";
ok("active tier", tier);

// ---------------------------------------------------------------------------
// Required env vars per tier
// ---------------------------------------------------------------------------
const apiBase = process.env.PVE_API_BASE_URL;
const apiTokenId = process.env.PVE_API_TOKEN_ID;
const apiTokenSecret = process.env.PVE_API_TOKEN_SECRET;
const apiNode = process.env.PVE_API_NODE;
const tlsFp = process.env.PVE_API_TLS_FINGERPRINT;
const sshHost = process.env.SSH_HOST;
const sshKeyPath = process.env.SSH_KEY_PATH;
const sshFp = process.env.SSH_HOST_KEY_FINGERPRINT;

const needsApi = ["observe", "operate", "companion", "root"].includes(tier);
if (needsApi) {
  if (apiBase) ok("PVE_API_BASE_URL", apiBase);
  else         fail("PVE_API_BASE_URL", "not set", "Re-run setup or set the env var manually");

  if (apiTokenId) ok("PVE_API_TOKEN_ID", apiTokenId);
  else            fail("PVE_API_TOKEN_ID", "not set", "Re-run setup");

  if (apiTokenSecret) ok("PVE_API_TOKEN_SECRET", "(set)");
  else                fail("PVE_API_TOKEN_SECRET", "not set", "Re-run setup");

  if (apiNode) ok("PVE_API_NODE", apiNode);
  else         warn("PVE_API_NODE", "not set — some tools will fail; re-run setup or set manually");

  if (tlsFp) ok("PVE_API_TLS_FINGERPRINT", tlsFp);
  else       warn("PVE_API_TLS_FINGERPRINT", "not set — server will TOFU-pin on first connect; verify out of band");
}

const needsSsh = ["companion", "root"].includes(tier);
if (needsSsh) {
  if (sshHost) ok("SSH_HOST", sshHost);
  else         fail("SSH_HOST", "not set", "Re-run setup");

  if (sshKeyPath) {
    if (existsSync(sshKeyPath)) ok("SSH_KEY_PATH", sshKeyPath);
    else                        fail("SSH_KEY_PATH", `key file not found: ${sshKeyPath}`, "Re-run setup or check the path");
  } else {
    fail("SSH_KEY_PATH", "not set", "Re-run setup");
  }

  if (sshFp) ok("SSH_HOST_KEY_FINGERPRINT", sshFp);
  else       warn("SSH_HOST_KEY_FINGERPRINT", "not set — server will TOFU-pin on first SSH connect; verify out of band");
}

// ---------------------------------------------------------------------------
// API endpoint reachability
// ---------------------------------------------------------------------------
if (apiBase && apiTokenId && apiTokenSecret) {
  console.log("");
  console.log("  checking API endpoint reachability...");
  try {
    const url = new URL("/api2/json/version", apiBase);
    await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 8006,
          path: url.pathname,
          method: "GET",
          headers: { Authorization: `PVEAPIToken=${apiTokenId}=${apiTokenSecret}` },
          rejectUnauthorized: false, // self-signed cert OK for doctor
          timeout: 5000,
        },
        (res) => {
          if (res.statusCode === 200) ok("API /version", `HTTP ${res.statusCode}`);
          else if (res.statusCode === 401) fail("API /version", `HTTP 401 — bad token credentials`, "Re-run setup to mint a new token");
          else if (res.statusCode === 403) fail("API /version", `HTTP 403 — token exists but lacks permissions`, "Re-run setup to fix the role grant");
          else warn("API /version", `HTTP ${res.statusCode} (expected 200)`);
          resolve();
        }
      );
      req.on("error", (err) => {
        fail("API endpoint", `${err.message}`, `Check that PVE_API_BASE_URL (${apiBase}) is reachable`);
        resolve();
      });
      req.on("timeout", () => {
        req.destroy();
        fail("API endpoint", "timed out after 5s", `Is ${apiBase} reachable from this machine?`);
        resolve();
      });
      req.end();
    });
  } catch (e) {
    fail("API endpoint", String(e));
  }
}

// ---------------------------------------------------------------------------
// SSH reachability (companion+)
// ---------------------------------------------------------------------------
if (needsSsh && sshHost && sshKeyPath && existsSync(sshKeyPath)) {
  console.log("");
  console.log("  checking SSH reachability...");
  const r = spawnSync(
    "ssh",
    ["-i", sshKeyPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new", `root@${sshHost}`, "echo MCP_DOCTOR_OK"],
    { encoding: "utf8" }
  );
  if (r.stdout.includes("MCP_DOCTOR_OK")) {
    ok("SSH root@" + sshHost, "connected");
  } else {
    const detail = (r.stderr || r.stdout || "").trim().split("\n")[0];
    fail("SSH root@" + sshHost, detail || "no response", "Check SSH_HOST, key, and authorized_keys on the node");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");
const total = passed + warned + failed;
if (failed === 0 && warned === 0) {
  console.log(`  \x1b[32mAll ${total} checks passed.\x1b[0m`);
} else if (failed === 0) {
  console.log(`  \x1b[33m${passed} passed, ${warned} warning(s). Address warnings before trusting the server.\x1b[0m`);
} else {
  console.log(`  \x1b[31m${failed} check(s) failed. Fix the items marked [FAIL] and re-run.\x1b[0m`);
  process.exit(1);
}
