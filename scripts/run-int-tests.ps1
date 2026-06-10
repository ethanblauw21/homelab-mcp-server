# scripts/run-int-tests.ps1
# Runs the MCP integration test suite against the real Proxmox SSH host.
# Requires: npm run build already done (the setup auto-rebuilds, but a clean build is faster).
# Usage: npm run test:int:real   OR   .\scripts\run-int-tests.ps1 [-SshHost <ip>] [-SshKeyPath <path>]
[CmdletBinding()]
param(
    [string]$SshHost    = "10.0.0.10",
    [string]$SshKeyPath = "$env:USERPROFILE\.ssh\homelab_mcp"
)

if (-not (Test-Path $SshKeyPath)) {
    Write-Error "SSH key not found at '$SshKeyPath'. Generate it with: .\scripts\generate-ssh-key.ps1"
    exit 1
}

$env:SSH_INT_HOST     = $SshHost
$env:SSH_INT_KEY_PATH = $SshKeyPath

Write-Host "Running integration tests against $SshHost using key $SshKeyPath`n"
npx vitest run --project integration
