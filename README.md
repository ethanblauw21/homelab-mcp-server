# homelab-mcp-server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude Code on a Windows machine to a Proxmox VE node over SSH. Exposes six tools for managing the homelab directly from Claude Code conversations.

## Tools

| Tool | Description |
|------|-------------|
| `execute` | Run a shell command on the Proxmox host; returns stdout/stderr/exit code |
| `read_file` | Read a file from the host filesystem |
| `write_file` | Overwrite a file on the host — automatically backs up the prior version |
| `list_directory` | List directory contents |
| `pct_exec` | Run a command inside an LXC container via `pct exec <vmid> -- <cmd>` |
| `pct_list` | List LXC containers and their status |

## Architecture

The server authenticates as `root` over SSH (key auth). All safety is enforced at the tool layer:

- **Denylist** — blocks dangerous commands
- **Path validation** — prevents traversal attacks; enforces an allowlist
- **Backup pipeline** — dedup → gzipped reverse-diff → large-file policy; stored locally on the Windows host
- **Audit log** — append-only JSONL with SHA-256 hashes; supports file revert
- **Retention** — per-file version cap + global size cap with LRU eviction

See [`ADR-001-ssh-mcp-server.md`](ADR-001-ssh-mcp-server.md) for the full design rationale and [`TESTING-STRATEGY-ssh-mcp-server.md`](TESTING-STRATEGY-ssh-mcp-server.md) for the test approach.

## Setup

### Prerequisites

- Node.js 20+
- An SSH key installed on the Proxmox node for `root`
- Claude Code with MCP support

### Install

```bash
npm install
npm run build
```

### Generate SSH key and install on Proxmox

```powershell
.\scripts\generate-ssh-key.ps1
# then copy the public key to the node:
.\scripts\install-proxmox-key.sh
```

### Register with Claude Code

```powershell
.\scripts\register-mcp.ps1
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `PROXMOX_HOST` | Hostname or IP of the Proxmox node |
| `PROXMOX_SSH_KEY_PATH` | Path to the private SSH key (default: `~/.ssh/homelab`) |
| `MCP_BACKUP_DIR` | Override backup directory (default: `%LOCALAPPDATA%\claude-mcp\backups`) |
| `MCP_AUDIT_LOG` | Override audit log path (default: `%LOCALAPPDATA%\claude-mcp\audit.jsonl`) |

## Development

```bash
npm run dev          # tsx watch
npm run build        # tsc compile
npm test             # all unit tests
npm run test:unit    # unit tests only
npm run test:int     # integration tests (requires Docker on Linux/CI)
npm run lint
npm run typecheck
```

Integration tests spin up a Dockerized SSH container automatically and are skipped gracefully if Docker is absent. Run them in CI or on a Linux machine.

## Storage

Backups and the audit log live on the **Windows host** (not the Proxmox node). Defaults:

- Backups: `%LOCALAPPDATA%\claude-mcp\backups\<path-hash>\<ISO-timestamp>`
- Audit log: `%LOCALAPPDATA%\claude-mcp\audit.jsonl`

Point `MCP_BACKUP_DIR` at a synced folder or NAS for extra durability.

## Safety

Do not connect to the live Proxmox node until unit tests pass. Run against a disposable VM first (read-only), then the real node. See `CLAUDE.md` for the full safety checklist.
