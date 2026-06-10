# scripts/test-ssh.ps1
# Quick SSH connectivity smoke-test — run before registering the MCP server.
# Usage:  .\scripts\test-ssh.ps1 -SshHost 192.168.1.100
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshHost,

    [string]$SshKeyPath = "$env:USERPROFILE\.ssh\homelab_mcp",

    [int]$SshPort = 22
)

if (-not (Test-Path $SshKeyPath)) {
    Write-Error "SSH key not found at '$SshKeyPath'. Run scripts\generate-ssh-key.ps1 first."
    exit 1
}

Write-Host "Testing SSH to root@${SshHost}:${SshPort} ..."

$output = & ssh `
    -i $SshKeyPath `
    -p $SshPort `
    -o StrictHostKeyChecking=no `
    -o BatchMode=yes `
    -o ConnectTimeout=10 `
    "root@$SshHost" `
    "echo ssh-ok && uname -a && pveversion" 2>&1

if ($LASTEXITCODE -eq 0 -and ($output -match "ssh-ok")) {
    Write-Host ""
    Write-Host "SSH OK"
    Write-Host $output
    Write-Host ""
    Write-Host "Ready to register the MCP server:"
    Write-Host "  .\scripts\register-mcp.ps1 -SshHost $SshHost"
} else {
    Write-Error "SSH failed (exit $LASTEXITCODE):`n$output"
    Write-Host ""
    Write-Host "Troubleshooting:"
    Write-Host "  1. Is the public key in /root/.ssh/authorized_keys on the node?"
    Write-Host "     Run: scripts\generate-ssh-key.ps1 and follow the install instructions."
    Write-Host "  2. Is sshd running?  ss -tlnp | grep 22"
    Write-Host "  3. Is the host reachable?  ping $SshHost"
    exit 1
}
