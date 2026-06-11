# scripts/generate-ssh-key.ps1
#
# DEPRECATED (ADR-007 §5): superseded by scripts/setup.ps1, which provisions the
# tier credential, generates the Ed25519 key (companion tier only), installs it,
# captures both trust fingerprints, runs the 403 privsep verification, and emits
# the Claude registration in one ceremony:
#     .\scripts\setup.ps1 -Tier companion -NodeHost <proxmox-ip>
# This standalone key generator is kept only for the SSH-only / manual path.
#
# Generates an Ed25519 SSH key pair for the homelab MCP server.
# Run this once; the public key output goes into Proxmox's /root/.ssh/authorized_keys.
[CmdletBinding()]
param(
    [string]$KeyPath = "$env:USERPROFILE\.ssh\homelab_mcp"
)

$pubKeyPath = "$KeyPath.pub"

if (Test-Path $KeyPath) {
    Write-Host "Key already exists at: $KeyPath"
    Write-Host ""
} else {
    Write-Host "Generating Ed25519 SSH key at: $KeyPath"
    $sshDir = Split-Path $KeyPath
    if (-not (Test-Path $sshDir)) {
        New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
    }

    # Use array form so PowerShell passes "" as a true empty-string argument
    & ssh-keygen -t ed25519 -f $KeyPath -N "" -C "homelab-mcp-$(hostname)"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "ssh-keygen failed (exit $LASTEXITCODE). Is OpenSSH installed?"
        exit 1
    }
    Write-Host ""
    Write-Host "Key generated."
    Write-Host ""
}

Write-Host "Public key (add to /root/.ssh/authorized_keys on Proxmox):"
Write-Host ""
Get-Content $pubKeyPath
Write-Host ""
Write-Host "Quick install via Proxmox web shell:"
Write-Host "  mkdir -p /root/.ssh && chmod 700 /root/.ssh"
$pubKey = Get-Content $pubKeyPath
Write-Host "  echo '$pubKey' >> /root/.ssh/authorized_keys"
Write-Host "  chmod 600 /root/.ssh/authorized_keys"
Write-Host ""
Write-Host "Or run:  scripts\install-proxmox-key.sh <proxmox-ip>  (from WSL/Git Bash)"
