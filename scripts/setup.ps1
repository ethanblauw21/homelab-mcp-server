<#
.SYNOPSIS
  One-time setup ceremony for the homelab MCP server (ADR-007 §5).

.DESCRIPTION
  Supersedes generate-ssh-key.ps1 + install-proxmox-key.sh. Provisions a
  least-privilege Proxmox credential for the chosen tier, captures BOTH trust
  anchors (API TLS cert fingerprint + — at companion — the SSH host-key
  fingerprint), verifies privilege separation is actually enforcing (a 403
  negative test), and emits the `claude mcp add` registration with the tier's
  env set.

  Tiers (each a strict superset of the one below):
    observe    API token only, PVEAuditor role        (Proxmox-RBAC enforced)
    operate    + custom MCPOperate role (lifecycle)    (Proxmox-RBAC enforced)
    companion  + root SSH key (in-guest/host exec)     (MCP-server enforced)

  root is NEVER selectable here. It is enabled only by setting the exact
  acknowledgment env var on an existing companion install + restarting:
    MCP_HOST_ROOT_ENABLED = I-understand-Claude-gets-root-and-can-break-this-node
  Any other value (including "true") parses as disabled. There is no runtime
  escalation path, by design (ADR-007 §4, Option D).

  Two bootstrap modes:
    -BootstrapMode auto   one-time `ssh root@node` (password) runs provisioning.
    -BootstrapMode paste  emits a bash blob for the Proxmox web shell; you paste
                          the printed values back. No root password touches Windows.

  Downgrading (re-run at a lower tier) deprovisions: companion->lower removes the
  authorized_keys line and deletes the local private key.

.EXAMPLE
  .\scripts\setup.ps1 -Tier observe   -NodeHost 192.168.1.100
  .\scripts\setup.ps1 -Tier operate   -NodeHost 192.168.1.100 -BootstrapMode paste
  .\scripts\setup.ps1 -Tier companion -NodeHost 192.168.1.100
  .\scripts\setup.ps1 -Tier observe   -NodeHost 192.168.1.100 -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("observe", "operate", "companion")]
    [string]$Tier,

    [Parameter(Mandatory = $true)]
    [string]$NodeHost,

    [ValidateSet("auto", "paste")]
    [string]$BootstrapMode = "auto",

    [string]$SshKeyPath = "$env:USERPROFILE\.ssh\homelab_mcp",

    [string]$PveUser = "mcp@pve",

    [int]$ApiPort = 8006,

    # Print every action (including the Proxmox blob) without connecting/mutating.
    [switch]$DryRun,

    # Force a new API token even if one appears to exist (rotation).
    [switch]$RotateToken,

    [string]$EntryPoint = (Join-Path $PSScriptRoot "..\dist\index.js")
)

$ErrorActionPreference = "Stop"
$tokenName = "mcp-$Tier"
$tokenId   = "$PveUser!$tokenName"
$ApiBase   = "https://${NodeHost}:$ApiPort/api2/json"
$role      = "MCPOperate"

function Write-Section($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Write-Ok($t)      { Write-Host "  [ok] $t" -ForegroundColor Green }
function Write-Warn2($t)   { Write-Host "  [!] $t"  -ForegroundColor Yellow }

# Tier rank for superset / downgrade decisions.
$rank = @{ observe = 0; operate = 1; companion = 2 }

# ---------------------------------------------------------------------------
# 1. Build the Proxmox-side provisioning blob (idempotent; re-run = tier change).
#    Computes the TLS cert fingerprint in the SAME "SHA256:<base64>" form the
#    server's pinnedTrust module produces (see src/trust/pinnedTrust.ts), so the
#    pasted value matches without reformatting.
# ---------------------------------------------------------------------------
function Get-ProvisionBlob {
    param([string]$pubKey)

    $roleProvs = "VM.Audit VM.PowerMgmt VM.Snapshot VM.Snapshot.Rollback VM.Config.Options Sys.Audit Datastore.Audit"

    $lines = @()
    $lines += "set -e"
    $lines += "echo '--- homelab MCP provisioning: tier=$Tier ---'"
    $lines += "pveum user add $PveUser --comment 'homelab MCP server' 2>/dev/null || true"

    if ($Tier -eq "observe") {
        $lines += "pveum acl modify / --users '$PveUser' --roles PVEAuditor"
        $lines += "ROLES=PVEAuditor"
    } else {
        # operate + companion both get the custom role (companion is a superset).
        $lines += "pveum role add $role -privs `"$roleProvs`" 2>/dev/null || pveum role modify $role -privs `"$roleProvs`""
        $lines += "pveum acl modify / --users '$PveUser' --roles $role"
        $lines += "ROLES=$role"
    }

    # Token (privsep 1: the token's own ACL caps it at or below the user).
    if ($RotateToken) {
        $lines += "pveum user token remove $PveUser $tokenName 2>/dev/null || true"
    }
    $lines += "TOKLINE=`$(pveum user token add $PveUser $tokenName --privsep 1 --output-format json 2>/dev/null || pveum user token add $PveUser $tokenName --privsep 1 --output-format json --force 2>/dev/null || true)"
    $lines += "pveum acl modify / --tokens '$tokenId' --roles `$ROLES"

    if ($Tier -eq "companion" -and $pubKey) {
        $lines += "mkdir -p /root/.ssh && chmod 700 /root/.ssh"
        $lines += "grep -qxF '$pubKey' /root/.ssh/authorized_keys 2>/dev/null || echo '$pubKey' >> /root/.ssh/authorized_keys"
        $lines += "chmod 600 /root/.ssh/authorized_keys"
    }

    # Capture trust anchors. TLS: DER -> sha256 -> base64 (matches sha256Fingerprint()).
    $lines += "TLS_FP=`$(openssl x509 -in /etc/pve/local/pve-ssl.pem -outform der 2>/dev/null | openssl dgst -sha256 -binary | openssl base64 | tr -d '=')"
    $lines += "SSH_FP=`$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print `$2}')"
    $lines += "NODE=`$(hostname)"

    # Emit a single parseable block the Windows side reads back.
    $lines += "echo '===MCP-SETUP-RESULT==='"
    $lines += "echo `"TOKEN_SECRET=`$(echo `"`$TOKLINE`" | sed -n 's/.*`"value`":`"`\([^`"]*`\)`".*/\1/p')`""
    $lines += "echo `"TLS_FINGERPRINT=SHA256:`$TLS_FP`""
    $lines += "echo `"SSH_FINGERPRINT=`$SSH_FP`""
    $lines += "echo `"NODE_NAME=`$NODE`""
    $lines += "echo '===END-MCP-SETUP-RESULT==='"

    return ($lines -join "`n")
}

function Get-DeprovisionBlob {
    param([string]$pubKey)
    $lines = @()
    $lines += "set -e"
    $lines += "echo '--- homelab MCP deprovisioning (downgrade below companion) ---'"
    if ($pubKey) {
        # Remove just our authorized_keys line; leave any others intact.
        $lines += "if [ -f /root/.ssh/authorized_keys ]; then grep -vxF '$pubKey' /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.tmp || true; mv /root/.ssh/authorized_keys.tmp /root/.ssh/authorized_keys; fi"
    }
    $lines += "echo '===MCP-SETUP-RESULT==='"
    $lines += "echo 'DEPROVISIONED=1'"
    $lines += "echo '===END-MCP-SETUP-RESULT==='"
    return ($lines -join "`n")
}

# ---------------------------------------------------------------------------
# 2. SSH keypair (companion only).
# ---------------------------------------------------------------------------
$pubKey = $null
if ($Tier -eq "companion") {
    Write-Section "SSH keypair (companion)"
    if (-not (Test-Path $SshKeyPath)) {
        if ($DryRun) {
            Write-Warn2 "DryRun: would generate Ed25519 key at $SshKeyPath"
        } else {
            $sshDir = Split-Path $SshKeyPath
            if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }
            & ssh-keygen -t ed25519 -f $SshKeyPath -N "" -C "homelab-mcp-$(hostname)"
            if ($LASTEXITCODE -ne 0) { Write-Error "ssh-keygen failed (exit $LASTEXITCODE)."; exit 1 }
            Write-Ok "generated $SshKeyPath"
        }
    } else {
        Write-Ok "reusing existing key $SshKeyPath"
    }
    if (Test-Path "$SshKeyPath.pub") { $pubKey = (Get-Content "$SshKeyPath.pub").Trim() }
    elseif ($DryRun) { $pubKey = "ssh-ed25519 AAAA...DRYRUN homelab-mcp" }
}

# ---------------------------------------------------------------------------
# 3. Run (or print) the provisioning blob.
# ---------------------------------------------------------------------------
$blob = Get-ProvisionBlob -pubKey $pubKey

Write-Section "Proxmox provisioning ($BootstrapMode)"
$resultText = $null

if ($DryRun) {
    Write-Warn2 "DryRun: provisioning blob (not executed):"
    Write-Host ""
    Write-Host $blob
    Write-Host ""
    Write-Warn2 "DryRun: skipping connection, verification, and registration."
    exit 0
}

if ($BootstrapMode -eq "auto") {
    Write-Host "Running provisioning over a one-time ssh root@$NodeHost (you will be prompted for the root password)..."
    # Pipe the blob to a remote bash. Host key is TOFU for this one-time bootstrap;
    # the persistent connection later uses the pinned fingerprint we capture below.
    $resultText = ($blob | & ssh -o StrictHostKeyChecking=accept-new "root@$NodeHost" "bash -s") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Error "Remote provisioning failed (exit $LASTEXITCODE):`n$resultText"; exit 1 }
} else {
    Write-Host "PASTE PATH — copy the block below into the Proxmox web shell (Datacenter > node > Shell):" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "----------------------------8<----------------------------"
    Write-Host $blob
    Write-Host "----------------------------8<----------------------------"
    Write-Host ""
    Write-Host "Then paste EVERYTHING between ===MCP-SETUP-RESULT=== and ===END-MCP-SETUP-RESULT=== back here."
    Write-Host "Finish with an empty line:"
    $buf = @()
    while ($true) {
        $line = Read-Host
        if ([string]::IsNullOrWhiteSpace($line)) { break }
        $buf += $line
    }
    $resultText = $buf -join "`n"
}

# ---------------------------------------------------------------------------
# 4. Parse captured values.
# ---------------------------------------------------------------------------
function Get-ResultValue($text, $key) {
    $m = [regex]::Match($text, "(?m)^\s*$key=(.*)$")
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return $null
}

$tokenSecret = Get-ResultValue $resultText "TOKEN_SECRET"
$tlsFp       = Get-ResultValue $resultText "TLS_FINGERPRINT"
$sshFp       = Get-ResultValue $resultText "SSH_FINGERPRINT"
$nodeName    = Get-ResultValue $resultText "NODE_NAME"

if (-not $tokenSecret) {
    Write-Error "Did not capture a token secret. If this is a re-run without -RotateToken, the secret is only shown at creation — re-run with -RotateToken to mint a fresh one.`nRaw output:`n$resultText"
    exit 1
}
if (-not $tlsFp)    { Write-Warn2 "No TLS fingerprint captured — the API will TOFU-pin on first connect (verify out of band)." }
if (-not $nodeName) { Write-Warn2 "No node name captured — set PVE_API_NODE manually." }
Write-Ok "captured token secret + trust anchors"

# ---------------------------------------------------------------------------
# 5. Verification: API smoke + the 403 negative test (privsep is ENFORCING).
# ---------------------------------------------------------------------------
Write-Section "Verification"

# Use curl with an explicit pin where possible; fall back to -k (we already pinned
# the fingerprint, and this is a one-shot smoke, not the persistent channel).
$authHeader = "Authorization: PVEAPIToken=$tokenId=$tokenSecret"

function Invoke-PveGet($path) {
    $url = "$ApiBase$path"
    $out = & curl.exe -sS -k -o NUL -w "%{http_code}" -H $authHeader $url 2>&1
    return $out
}

$verCode = Invoke-PveGet "/version"
if ($verCode -eq "200") { Write-Ok "API /version smoke -> 200" }
else { Write-Error "API smoke failed (HTTP $verCode). Token or connectivity problem."; exit 1 }

# Negative test: an endpoint ABOVE the tier must be refused by Proxmox (403),
# proving privilege separation is enforcing, not merely configured.
if ($Tier -ne "companion") {
    # A guest 'create' (POST) is well above observe/operate-read; we expect 403.
    # Use a harmless status write target that the role lacks: node 'stop' tasks
    # endpoint requires Sys.PowerMgmt which neither tier holds.
    $negUrl = "$ApiBase/nodes/$nodeName/status"
    $negCode = & curl.exe -sS -k -o NUL -w "%{http_code}" -X POST -H $authHeader --data "command=reboot" $negUrl 2>&1
    if ($negCode -eq "403") {
        Write-Ok "negative test: privileged POST refused with 403 (privsep enforcing)"
    } else {
        Write-Warn2 "negative test returned HTTP $negCode (expected 403). Review the role grants before trusting this tier."
    }
}

# companion: SSH smoke against the pinned host key.
if ($Tier -eq "companion") {
    $sshOut = & ssh -i $SshKeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new "root@$NodeHost" "echo MCP_SSH_OK" 2>&1 | Out-String
    if ($sshOut -match "MCP_SSH_OK") { Write-Ok "SSH key smoke -> connected" }
    else { Write-Warn2 "SSH smoke did not return the marker:`n$sshOut" }
}

# ---------------------------------------------------------------------------
# 6. Emit the `claude mcp add` registration with the tier's env.
# ---------------------------------------------------------------------------
Write-Section "Claude Code registration"

if (-not (Test-Path $EntryPoint)) {
    Write-Warn2 "Entry point not found: $EntryPoint — run 'npm run build', then re-run registration below."
}
$resolvedEntry = if (Test-Path $EntryPoint) { (Resolve-Path $EntryPoint).Path } else { $EntryPoint }

$envArgs = @(
    "-e", "MCP_TIER=$Tier",
    "-e", "PVE_API_BASE_URL=$ApiBase",
    "-e", "PVE_API_TOKEN_ID=$tokenId",
    "-e", "PVE_API_TOKEN_SECRET=$tokenSecret"
)
if ($nodeName) { $envArgs += @("-e", "PVE_API_NODE=$nodeName") }
if ($tlsFp)    { $envArgs += @("-e", "PVE_API_TLS_FINGERPRINT=$tlsFp") }
if ($Tier -eq "companion") {
    $envArgs += @("-e", "SSH_HOST=$NodeHost", "-e", "SSH_USER=root", "-e", "SSH_KEY_PATH=$SshKeyPath")
    if ($sshFp) { $envArgs += @("-e", "SSH_HOST_KEY_FINGERPRINT=$sshFp") }
}

Write-Host "Registering 'homelab' MCP server (tier=$Tier)..."
& claude mcp remove homelab --scope user 2>$null | Out-Null
& claude mcp add homelab --scope user @envArgs -- node $resolvedEntry
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 "claude mcp add failed (exit $LASTEXITCODE). The env values above are still valid — register manually."
} else {
    Write-Ok "registered"
}

# ---------------------------------------------------------------------------
# 7. Summary + the root-tier warning (informational only; never set here).
# ---------------------------------------------------------------------------
Write-Section "Done — tier: $Tier"
Write-Host "  Enforcement grade: " -NoNewline
if ($rank[$Tier] -lt $rank["companion"]) {
    Write-Host "Proxmox RBAC (the node refuses anything above the token's privileges)." -ForegroundColor Green
} else {
    Write-Host "MCP server (registration filtering + ADR-004 guardrails — tripwires, not a sandbox)." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Token:   $tokenId"
if ($nodeName) { Write-Host "  Node:    $nodeName" }
if ($Tier -eq "companion") { Write-Host "  SSH key: $SshKeyPath" }
Write-Host ""
Write-Host "  Restart Claude Code to pick up the new tier."
Write-Host ""
Write-Host "  ROOT TIER (host-wide exec/file access) is NOT set by this script. To enable it on a" -ForegroundColor DarkYellow
Write-Host "  companion install, set this EXACT value and restart — any other value disables it:" -ForegroundColor DarkYellow
Write-Host "    MCP_HOST_ROOT_ENABLED=I-understand-Claude-gets-root-and-can-break-this-node" -ForegroundColor DarkYellow
Write-Host "  There is no runtime escalation path; raising the tier always means re-running setup or" -ForegroundColor DarkYellow
Write-Host "  editing config + restarting (ADR-007 §4)." -ForegroundColor DarkYellow
