# scripts/register-mcp.ps1
# Registers the homelab MCP server in Claude Code via the official CLI.
# Claude Code stores user-scoped MCP servers in ~/.claude.json (NOT settings.json).
# Requires: npm run build has been run first.
# Usage:  .\scripts\register-mcp.ps1 -SshHost 192.168.1.100
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$SshKeyPath = "$env:USERPROFILE\.ssh\homelab_mcp",

    [string]$EntryPoint = (Join-Path $PSScriptRoot "..\dist\index.js")
)

# Resolve entry point
if (-not (Test-Path $EntryPoint)) {
    Write-Error "Entry point not found: '$EntryPoint'. Run 'npm run build' first."
    exit 1
}
$resolvedEntry = (Resolve-Path $EntryPoint).Path

Write-Host "Registering 'homelab' MCP server with Claude Code..."

# claude mcp add writes to ~/.claude.json under the 'user' scope
& claude mcp add homelab `
    --scope user `
    -e "SSH_HOST=$SshHost" `
    -e "SSH_KEY_PATH=$SshKeyPath" `
    -e "SSH_USER=root" `
    -- node $resolvedEntry

if ($LASTEXITCODE -ne 0) {
    Write-Error "claude mcp add failed (exit $LASTEXITCODE)"
    exit 1
}

Write-Host ""
Write-Host "  SSH host: $SshHost"
Write-Host "  SSH key:  $SshKeyPath"
Write-Host "  Entry:    $resolvedEntry"
Write-Host ""
Write-Host "Run 'claude mcp list' to confirm. Restart Claude Code if already running."
