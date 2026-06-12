# Changelog

All notable changes are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

---

## [0.2.0] – 2026-06-11

### Added

- **Cross-platform setup** (`scripts/setup.mjs`): Node.js ceremony script that works on Windows, macOS, and Linux. The existing `setup.ps1` is now a thin PowerShell wrapper; `setup.sh` is the equivalent bash wrapper. Both delegate to the same Node.js logic.
- **`npm run doctor`** (`scripts/doctor.mjs`): pre-flight CLI that checks Node version, `claude` CLI presence, built artifact, required env vars, and (at companion tier) SSH key and host reachability. Answers "why isn't this working?" before it gets asked.
- **Startup identity line**: the server now prints one line to stderr on every start — `homelab-mcp v0.2.0 | tier: companion | host: 10.0.0.10` — so "is the right thing running?" has an immediate answer.
- **Actionable error messages**: SSH connection refused, host key mismatch, SSH key file not found, disk pressure refuse, and stopped container errors now include a "what to do next" hint and a pointer to `npm run doctor` where relevant.
- **GitHub Actions CI** (`.github/workflows/ci.yml`): unit tests on Windows, macOS, and Ubuntu against Node 20 and 22; integration tests on Ubuntu with Docker.
- **LICENSE** (MIT).

### Changed

- `package.json`: version → 0.2.0; description updated to reflect the tier model; `keywords` added (`mcp`, `proxmox`, `homelab`, `lxc`, `claude`, `model-context-protocol`, `proxmox-ve`, `self-hosted`); `bin` field added for `npx` discoverability; `setup` and `doctor` scripts added.
- `src/index.ts`: version string updated to 0.2.0; startup banner and improved `errResult` hints added.

---

## [0.1.0] – 2026-06-09

### Added

Initial release covering ADR-001 through ADR-007:

- **ADR-001**: SSH transport (`ssh2`), six initial tools (`execute`, `read_file`, `write_file`, `list_directory`, `pct_exec`, `pct_list`), denylist guardrails, backup pipeline, audit log.
- **ADR-002**: `describe_homelab` census: secret redaction, drift detection, tier-aware sections reporting `unavailableAtTier` below companion.
- **ADR-003**: Container file I/O (`pct_read_file`, `pct_write_file`), snapshot guard (`snapshot_create`, `snapshot_list`, `snapshot_rollback`, `snapshot_delete`), gzipped reverse-diff backup pipeline.
- **ADR-004**: Transport hardening — pinned trust (SSH host key), timeout enforcement with `coreutils timeout`, two-tier denylist with CONFIRM gate, atomic audit log.
- **ADR-005**: VM parity — `qm_list`, `qm_agent_ping`, `qm_exec`, `qm_read_file`, `qm_write_file`, `health_check`, `tail_log`, `query_audit`, `diff_config`.
- **ADR-006**: Git-backed config history — mutation commits, `config_sweep` tool (capture path B), serialized `GitEngine`, tri-mode push (`local-only` / `push-lan` / `push-encrypted`).
- **ADR-007**: Permission tier model (`observe` / `operate` / `companion` / `root`), hybrid transport (`ApiBackend` REST + `SshBackend` SSH), root flag with exact acknowledgment string, protected set (absolute DENY at all tiers for `/etc/pve` destructive ops and `pvecm` cluster membership), `guest_start` / `guest_stop` / `guest_restart` lifecycle tools, shared `pinnedTrust` for API TLS cert.
