# Security

## Threat model

The primary concern is an AI assistant holding server credentials — either misbehaving due to a bug in the server code, or being manipulated by a prompt injection embedded in data the server reads back (log files, config files, command output). The design addresses this at multiple independent layers rather than relying on any single control.

## Layers of defense

### 1. Proxmox RBAC — observe and operate tiers

At `observe` and `operate`, the Proxmox node itself enforces the limits. The API token's ACL determines what it can do, and the node refuses anything beyond that. No bug in the MCP server code and no injected prompt can exceed the token's privileges — the refusal happens at the Proxmox layer, not in software we control.

This is the strongest guarantee the system offers. If you are not sure which tier you need, start here.

### 2. Registration filtering — all tiers

Tools above the active tier are never registered with the MCP server at startup. The model never sees them, which means there is nothing to refuse or be convinced to call at runtime. The attack surface is literally smaller.

### 3. Denylist and confirm gate — companion and above

At companion and root, command execution passes through a two-tier denylist:

- **DENY** — unconditional block regardless of any argument: `rm -rf /`, `mkfs`, `dd` to block devices, fork bomb, `chmod -R 777 /`
- **CONFIRM** — blocked unless the tool call explicitly includes `confirm: true`: `shutdown`, `reboot`, `halt`, `poweroff`, `systemctl reboot/poweroff/halt`, `init 0/6`

The denylist uses segment-anchored matching with whitespace and obfuscation normalization.

**Known limit:** The denylist is a tripwire, not a sandbox. It catches the command in the *command position*. A call like `bash -c "reboot"` hides the dangerous command inside an argument and will not be caught. Root SSH access means a sufficiently compromised or manipulated assistant could cause damage — the guardrails raise the bar, they do not eliminate the risk. This is stated honestly rather than hidden.

### 4. Protected set — all tiers, no override

Destructive operations against `/etc/pve` and cluster membership commands (`pvecm add/addnode/delnode/qdevice`) are unconditional DENY at every tier, including root. `confirm: true` does not override them. No configuration bypasses them. Recovering a node's cluster identity is always a human operation.

### 5. Pinned trust — companion and above

Both transport channels pin their trust anchor before the first exchange:

- **SSH:** SHA-256 host key fingerprint, stored as `SSH_HOST_KEY_FINGERPRINT`. A mismatch refuses the connection — no auto-re-pin, no fallback.
- **API TLS:** SHA-256 certificate fingerprint, stored as `PVE_API_TLS_FINGERPRINT`. Produces a custom `https.Agent` that rejects any certificate that does not match.

First connect without a pin uses TOFU and warns on stderr. There is no silent acceptance.

### 6. Audit trail — all tiers

Every mutating tool call is recorded to an append-only JSONL log before and after execution, with SHA-256 hashes of written content. The log is on the Windows host and is not affected by anything that happens on the Proxmox node. `query_audit` lets you review what was done and when.

### 7. Backup pipeline — all write operations

Every file write is backed up before it happens. `revert_file` restores any previous version. `diff_config` lets you preview a revert before committing to it. No write is unrecoverable.

## Root tier

Root tier adds `execute`, `read_file`, `write_file`, and `list_directory` against the Proxmox host directly. It is the highest-risk configuration and is not selectable from the setup script.

To enable it on a companion install, set this exact env var in the registered MCP server configuration and restart:

```
MCP_HOST_ROOT_ENABLED=I-understand-Claude-gets-root-and-can-break-this-node
```

Any other value — including `true`, `yes`, or `1` — is treated as disabled.

While root is enabled, the server prints a warning banner to stderr on every start, and all audit records carry `rootTier: true`. **There is no runtime escalation path.** A running server cannot raise its own tier. Escalation requires a config change and restart — this is a hard design exclusion to prevent social engineering via prompts that claim escalation is needed.

The recommended practice is to use companion tier for day-to-day work and only enable root for a specific task that genuinely requires it, then remove the flag and restart.

## Reporting vulnerabilities

Open a GitHub issue. For anything that feels sensitive, use the email address in the commit history.
