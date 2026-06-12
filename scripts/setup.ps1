&#xFEFF;<#
.SYNOPSIS
  Thin PowerShell wrapper — delegates to the cross-platform Node.js setup script.

.DESCRIPTION
  Calls scripts/setup.mjs with forwarded parameters. Run without arguments for
  interactive mode; pass flags for automated/repeated runs.

  Tiers:
    observe    API token only, Proxmox-RBAC-enforced
    operate    + guest lifecycle, Proxmox-RBAC-enforced
    companion  + root SSH key, MCP-server-enforced

  root is NEVER selectable here. Enable it on a companion install by setting:
    MCP_HOST_ROOT_ENABLED = I-understand-Claude-gets-root-and-can-break-this-node
  Any other value (including "true") is disabled. No runtime escalation.

.EXAMPLE
  # Interactive:
  .\scripts\setup.ps1

  # Flag-based:
  .\scripts\setup.ps1 -Tier observe   -NodeHost 192.168.1.100
  .\scripts\setup.ps1 -Tier companion -NodeHost 192.168.1.100
  .\scripts\setup.ps1 -Tier operate   -NodeHost 192.168.1.100 -BootstrapMode paste
  .\scripts\setup.ps1 -Tier observe   -NodeHost 192.168.1.100 -DryRun
#>
[CmdletBinding()]
param(
    [ValidateSet("observe", "operate", "companion")]
    [string]$Tier,

    [string]$NodeHost,

    [ValidateSet("auto", "paste")]
    [string]$BootstrapMode,

    [string]$SshKeyPath,

    [switch]$DryRun,

    [switch]$RotateToken
)

$nodeArgs = @()
if ($Tier)          { $nodeArgs += "--tier=$Tier" }
if ($NodeHost)      { $nodeArgs += "--node-host=$NodeHost" }
if ($BootstrapMode) { $nodeArgs += "--bootstrap-mode=$BootstrapMode" }
if ($SshKeyPath)    { $nodeArgs += "--ssh-key-path=$SshKeyPath" }
if ($DryRun)        { $nodeArgs += "--dry-run" }
if ($RotateToken)   { $nodeArgs += "--rotate-token" }

& node "$PSScriptRoot\setup.mjs" @nodeArgs
exit $LASTEXITCODE
