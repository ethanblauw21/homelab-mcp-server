#!/usr/bin/env node
/**
 * Cross-platform setup ceremony for the homelab MCP server (ADR-007 §5).
 *
 * Called by setup.ps1 (Windows) and setup.sh (Linux/macOS) or directly
 * via `npm run setup`. Requires Node.js 20+, ssh, and ssh-keygen (companion).
 *
 * Usage (interactive — prompts for all inputs):
 *   node scripts/setup.mjs
 *
 * Usage (flag-based — skips prompts):
 *   node scripts/setup.mjs --tier=observe   --node-host=192.168.1.100
 *   node scripts/setup.mjs --tier=companion --node-host=192.168.1.100
 *   node scripts/setup.mjs --tier=observe   --node-host=192.168.1.100 --bootstrap-mode=paste
 *   node scripts/setup.mjs --tier=observe   --node-host=192.168.1.100 --dry-run
 *
 * Tier matrix:
 *   observe    API token (PVEAuditor), Proxmox-RBAC-enforced
 *   operate    API token (MCPOperate role), Proxmox-RBAC-enforced
 *   companion  + root SSH key, MCP-server-enforced
 *   root       NOT selectable here — set MCP_HOST_ROOT_ENABLED on an existing
 *              companion install and restart.
 */
import readline from "readline";
import { spawnSync, execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import https from "https";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[arg.slice(2)] = argv[++i];
    } else {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

const flags = parseArgs(process.argv.slice(2));

let tier           = flags["tier"]           || null;
let nodeHost       = flags["node-host"]      || null;
let bootstrapMode  = flags["bootstrap-mode"] || null;
let sshKeyPath     = flags["ssh-key-path"]   || path.join(os.homedir(), ".ssh", "homelab_mcp");
const pveUser      = flags["pve-user"]       || "mcp@pve";
const apiPort      = parseInt(flags["api-port"] || "8006", 10);
const dryRun       = Boolean(flags["dry-run"]);
const rotateToken  = Boolean(flags["rotate-token"]);
const entryPoint   = flags["entry-point"]    || path.join(ROOT, "dist", "index.js");

const wasInteractive = !flags["tier"];

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function c(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }
function ok(t)   { console.log(`    ${c(32, "[ok]")} ${t}`); }
function warn(t) { console.log(`    ${c(33, "[!]")}  ${t}`); }

const rank = { observe: 0, operate: 1, companion: 2 };
let totalSteps = 0;
let currentStep = 0;
function phase(title) {
  currentStep++;
  console.log("");
  console.log(`  ${c(36, `[${currentStep}/${totalSteps}]`)}  ${title}`);
}

// ---------------------------------------------------------------------------
// Readline helper
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function prompt(q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------
console.log("");
console.log(`  ${c(36, "homelab MCP server  --  setup")}`);
console.log("");

// ---------------------------------------------------------------------------
// Interactive questionnaire
// ---------------------------------------------------------------------------
if (!tier) {
  console.log("  Choose a tier (each is a strict superset of the one below):");
  console.log("");
  console.log("    [1] observe    Read-only: list VMs, containers, storage, health checks");
  console.log("                   Enforced by Proxmox RBAC — the node refuses anything beyond this.");
  console.log("");
  console.log("    [2] operate    + start, stop, restart guests");
  console.log("                   Enforced by Proxmox RBAC.");
  console.log("");
  console.log("    [3] companion  + exec inside guests, file I/O, snapshots, config history");
  console.log("                   Enforced by MCP server guardrails.");
  console.log("");
  console.log(c(90, "  Start at observe if you are not sure."));
  console.log("");
  const choice = await prompt("  Tier [1/2/3]: ");
  const tierMap = { "1": "observe", "2": "operate", "3": "companion",
                    "observe": "observe", "operate": "operate", "companion": "companion" };
  if (!tierMap[choice]) {
    console.error(`Invalid tier choice: '${choice}'. Enter 1, 2, 3, or the tier name.`);
    rl.close(); process.exit(1);
  }
  tier = tierMap[choice];
  console.log("");
}

if (!nodeHost) {
  nodeHost = await prompt("  Proxmox node hostname or IP: ");
  if (!nodeHost) { console.error("Node host is required."); rl.close(); process.exit(1); }
  console.log("");
}

if (wasInteractive && !bootstrapMode) {
  console.log("  Bootstrap mode:");
  console.log("");
  console.log("    [1] auto   one SSH root password prompt, then fully automated");
  console.log("    [2] paste  print a script to run in the Proxmox web shell");
  console.log("               (no root password touches this machine)");
  console.log("");
  const modeChoice = await prompt("  Mode [1/2, default: auto]: ");
  const modeMap = { "1": "auto", "2": "paste", "auto": "auto", "paste": "paste", "": "auto" };
  if (modeMap[modeChoice] === undefined) {
    console.error(`Invalid bootstrap mode: '${modeChoice}'. Enter 1 or 2.`);
    rl.close(); process.exit(1);
  }
  bootstrapMode = modeMap[modeChoice];
  console.log("");
} else if (!bootstrapMode) {
  bootstrapMode = "auto";
}

// ---------------------------------------------------------------------------
// Confirmed config
// ---------------------------------------------------------------------------
totalSteps = (tier === "companion") ? 4 : 3;

console.log(c(90, "  ------------------------------------------"));
console.log(`  Tier    ${tier}`);
console.log(`  Node    ${nodeHost}`);
console.log(`  Mode    ${dryRun ? `${bootstrapMode} (dry run)` : bootstrapMode}`);
console.log(c(90, "  ------------------------------------------"));

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------
const tokenName = `mcp-${tier}`;
const tokenId   = `${pveUser}!${tokenName}`;
const apiBase   = `https://${nodeHost}:${apiPort}/api2/json`;
const roleName  = "MCPOperate";
const rolePrivs = "VM.Audit VM.PowerMgmt VM.Snapshot VM.Snapshot.Rollback VM.Config.Options Sys.Audit Datastore.Audit";

// ---------------------------------------------------------------------------
// Build provisioning blob
// ---------------------------------------------------------------------------
function buildProvisionBlob(pubKey) {
  const lines = ["set -e", `echo '--- homelab MCP provisioning: tier=${tier} ---'`];
  lines.push(`pveum user add ${pveUser} --comment 'homelab MCP server' 2>/dev/null || true`);

  if (tier === "observe") {
    lines.push(`pveum acl modify / --users '${pveUser}' --roles PVEAuditor`);
    lines.push(`ROLES=PVEAuditor`);
  } else {
    lines.push(`pveum role add ${roleName} -privs "${rolePrivs}" 2>/dev/null || pveum role modify ${roleName} -privs "${rolePrivs}"`);
    lines.push(`pveum acl modify / --users '${pveUser}' --roles ${roleName}`);
    lines.push(`ROLES=${roleName}`);
  }

  if (rotateToken) {
    lines.push(`pveum user token remove ${pveUser} ${tokenName} 2>/dev/null || true`);
  }
  lines.push(`TOKLINE=$(pveum user token add ${pveUser} ${tokenName} --privsep 1 --output-format json 2>/dev/null || pveum user token add ${pveUser} ${tokenName} --privsep 1 --output-format json --force 2>/dev/null || true)`);
  lines.push(`pveum acl modify / --tokens '${tokenId}' --roles $ROLES`);

  if (tier === "companion" && pubKey) {
    lines.push(`mkdir -p /root/.ssh && chmod 700 /root/.ssh`);
    lines.push(`grep -qxF '${pubKey}' /root/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> /root/.ssh/authorized_keys`);
    lines.push(`chmod 600 /root/.ssh/authorized_keys`);
  }

  lines.push(`TLS_FP=$(openssl x509 -in /etc/pve/local/pve-ssl.pem -outform der 2>/dev/null | openssl dgst -sha256 -binary | openssl base64 | tr -d '=')`);
  lines.push(`SSH_FP=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}')`);
  lines.push(`NODE=$(hostname)`);
  lines.push(`echo '===MCP-SETUP-RESULT==='`);
  lines.push(`echo "TOKEN_SECRET=$(echo "$TOKLINE" | sed -n 's/.*"value":"\\([^"]*\\)".*/\\1/p')"`);
  lines.push(`echo "TLS_FINGERPRINT=SHA256:$TLS_FP"`);
  lines.push(`echo "SSH_FINGERPRINT=$SSH_FP"`);
  lines.push(`echo "NODE_NAME=$NODE"`);
  lines.push(`echo '===END-MCP-SETUP-RESULT==='`);
  return lines.join("\n");
}

function buildDeprovisionBlob(pubKey) {
  const lines = ["set -e", `echo '--- homelab MCP deprovisioning (downgrade below companion) ---'`];
  if (pubKey) {
    lines.push(`if [ -f /root/.ssh/authorized_keys ]; then grep -vxF '${pubKey}' /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.tmp || true; mv /root/.ssh/authorized_keys.tmp /root/.ssh/authorized_keys; fi`);
  }
  lines.push(`echo '===MCP-SETUP-RESULT==='`);
  lines.push(`echo 'DEPROVISIONED=1'`);
  lines.push(`echo '===END-MCP-SETUP-RESULT==='`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 1 (companion only): SSH keypair
// ---------------------------------------------------------------------------
let pubKey = null;
if (tier === "companion") {
  phase("SSH keypair");
  if (!existsSync(sshKeyPath)) {
    if (dryRun) {
      warn(`DryRun: would generate Ed25519 key at ${sshKeyPath}`);
    } else {
      const keyDir = path.dirname(sshKeyPath);
      mkdirSync(keyDir, { recursive: true });
      const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", sshKeyPath, "-N", "", "-C", `homelab-mcp-${os.hostname()}`], { stdio: "inherit" });
      if (r.status !== 0) { console.error("ssh-keygen failed."); rl.close(); process.exit(1); }
      ok(`generated ${sshKeyPath}`);
    }
  } else {
    ok(`reusing existing key ${sshKeyPath}`);
  }
  const pubPath = `${sshKeyPath}.pub`;
  if (existsSync(pubPath)) pubKey = readFileSync(pubPath, "utf8").trim();
  else if (dryRun) pubKey = "ssh-ed25519 AAAA...DRYRUN homelab-mcp";
}

// ---------------------------------------------------------------------------
// Phase 2 (or 1): Proxmox provisioning
// ---------------------------------------------------------------------------
const blob = buildProvisionBlob(pubKey);
phase("Proxmox provisioning");
let resultText = null;

if (dryRun) {
  warn("DryRun: provisioning blob (not executed):");
  console.log("");
  console.log(blob);
  console.log("");
  warn("DryRun: skipping connection, verification, and registration.");
  rl.close(); process.exit(0);
}

if (bootstrapMode === "auto") {
  console.log(`    Connecting as root@${nodeHost} (you will be prompted for the password)...`);
  const r = spawnSync(
    "ssh",
    ["-o", "StrictHostKeyChecking=accept-new", `root@${nodeHost}`, "bash", "-s"],
    { input: blob, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
  );
  if (r.status !== 0) {
    console.error(`Remote provisioning failed (exit ${r.status})`);
    if (r.stdout) console.error(r.stdout);
    rl.close(); process.exit(1);
  }
  resultText = r.stdout;
  ok("provisioning complete");
} else {
  console.log("");
  console.log(`    ${c(33, "Paste mode — no root password required on this machine.")}`);
  console.log("");
  console.log("    1. Open the Proxmox web shell:");
  console.log(`       Datacenter  →  ${nodeHost}  →  Shell`);
  console.log("");
  console.log("    2. Copy and run the script below:");
  console.log("");
  console.log("    -------- copy from here ----------------------------------------");
  console.log(blob);
  console.log("    -------- to here ------------------------------------------------");
  console.log("");
  console.log("    3. Copy everything between ===MCP-SETUP-RESULT=== and");
  console.log("       ===END-MCP-SETUP-RESULT===, paste it here, then press");
  console.log("       Enter on a blank line:");
  console.log("");
  const lines = [];
  while (true) {
    const line = await prompt("");
    if (!line) break;
    lines.push(line);
  }
  resultText = lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse captured values
// ---------------------------------------------------------------------------
function getVal(text, key) {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*${key}=(.*)`, "m"));
  return m ? m[1].trim() : null;
}

const tokenSecret = getVal(resultText, "TOKEN_SECRET");
const tlsFp       = getVal(resultText, "TLS_FINGERPRINT");
const sshFp       = getVal(resultText, "SSH_FINGERPRINT");
const nodeName    = getVal(resultText, "NODE_NAME");

if (!tokenSecret) {
  console.error(
    "Did not capture a token secret. If this is a re-run without --rotate-token, " +
    "the secret is only shown at creation — re-run with --rotate-token to mint a fresh one.\n" +
    "Raw output:\n" + resultText
  );
  rl.close(); process.exit(1);
}
if (!tlsFp)    warn("No TLS fingerprint captured — the API will TOFU-pin on first connect (verify out of band).");
if (!nodeName) warn("No node name captured — set PVE_API_NODE manually.");
ok("captured token secret + trust anchors");

// ---------------------------------------------------------------------------
// Phase 3 (or 2): Verification
// ---------------------------------------------------------------------------
phase("Verification");

async function httpsStatusCode(method, urlStr, body, authHeader) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port: url.port || apiPort,
      path: url.pathname + url.search,
      method,
      headers: { Authorization: authHeader },
      rejectUnauthorized: false,
      timeout: 8000,
    };
    if (body) {
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => resolve(res.statusCode));
    req.on("error", (e) => { warn(`API request error: ${e.message}`); resolve(null); });
    req.on("timeout", () => { req.destroy(); warn("API request timed out"); resolve(null); });
    if (body) req.write(body);
    req.end();
  });
}

const authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;
const verCode = await httpsStatusCode("GET", `${apiBase}/version`, null, authHeader);
if (verCode === 200) {
  ok("API /version → 200");
} else {
  console.error(`API smoke failed (HTTP ${verCode ?? "error"}). Token or connectivity problem.`);
  rl.close(); process.exit(1);
}

// Negative test: a privileged endpoint must be refused with 403 (proves privilege separation).
if (tier !== "companion" && nodeName) {
  const negCode = await httpsStatusCode(
    "POST",
    `${apiBase}/nodes/${nodeName}/status`,
    "command=reboot",
    authHeader
  );
  if (negCode === 403) {
    ok("privilege separation confirmed (privileged POST refused with 403)");
  } else {
    warn(`negative test returned HTTP ${negCode ?? "error"} (expected 403) — review role grants before trusting this tier.`);
  }
}

// companion: SSH smoke against the installed key.
if (tier === "companion") {
  const r = spawnSync(
    "ssh",
    ["-i", sshKeyPath, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", `root@${nodeHost}`, "echo MCP_SSH_OK"],
    { encoding: "utf8" }
  );
  if ((r.stdout + r.stderr).includes("MCP_SSH_OK")) {
    ok("SSH key accepted");
  } else {
    warn(`SSH smoke did not return the marker:\n${r.stderr || r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 4 (or 3): Claude Code registration
// ---------------------------------------------------------------------------
phase("Claude Code registration");

if (!existsSync(entryPoint)) {
  warn(`Entry point not found: ${entryPoint} — run 'npm run build' first, then re-run setup.`);
}
const resolvedEntry = path.resolve(entryPoint);

const envArgs = [
  "-e", `MCP_TIER=${tier}`,
  "-e", `PVE_API_BASE_URL=${apiBase}`,
  "-e", `PVE_API_TOKEN_ID=${tokenId}`,
  "-e", `PVE_API_TOKEN_SECRET=${tokenSecret}`,
];
if (nodeName)          envArgs.push("-e", `PVE_API_NODE=${nodeName}`);
if (tlsFp)             envArgs.push("-e", `PVE_API_TLS_FINGERPRINT=${tlsFp}`);
if (tier === "companion") {
  envArgs.push("-e", `SSH_HOST=${nodeHost}`, "-e", "SSH_USER=root", "-e", `SSH_KEY_PATH=${sshKeyPath}`);
  if (sshFp) envArgs.push("-e", `SSH_HOST_KEY_FINGERPRINT=${sshFp}`);
}

spawnSync("claude", ["mcp", "remove", "homelab", "--scope", "user"], { encoding: "utf8" });
const addResult = spawnSync(
  "claude",
  ["mcp", "add", "homelab", "--scope", "user", ...envArgs, "--", "node", resolvedEntry],
  { stdio: "inherit", encoding: "utf8" }
);
if (addResult.status !== 0) {
  warn("claude mcp add failed — env values above are still valid; register manually.");
} else {
  ok("registered as 'homelab' (user scope)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const enforcedBy = (rank[tier] ?? 2) < rank["companion"]
  ? "Proxmox RBAC  (the node refuses anything above the token's privileges)"
  : "MCP server guardrails  (registration filter + denylist + confirm gate)";

console.log("");
console.log(`  ${c(32, "Setup complete")}`);
console.log(c(90, "  ------------------------------------------"));
console.log("");
console.log(`  Tier       ${tier}`);
console.log(`  Enforced   ${enforcedBy}`);
console.log(`  Token      ${tokenId}`);
if (nodeName) console.log(`  Node       ${nodeName}`);
if (tier === "companion") console.log(`  SSH key    ${sshKeyPath}`);
console.log("");
console.log(`  ${c(36, "→ Restart Claude Code to activate the 'homelab' server.")}`);
console.log("");
console.log(c(90, "  ------------------------------------------"));
console.log(c(33, "  Root tier (host shell + file access) is NOT enabled by this script."));
console.log(c(33, "  To opt in on a companion install, set this exact env var and restart."));
console.log(c(33, "  Any other value (including 'true') disables it. No runtime escalation."));
console.log("");
console.log(c(33, "    MCP_HOST_ROOT_ENABLED=I-understand-Claude-gets-root-and-can-break-this-node"));
console.log("");
console.log(c(90, "  To upgrade to a higher tier, re-run this script at the new tier."));
console.log(c(90, "  ------------------------------------------"));
console.log("");

rl.close();
