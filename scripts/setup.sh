#!/usr/bin/env bash
# Thin wrapper — delegates to the cross-platform Node.js setup script.
#
# Usage (interactive):
#   ./scripts/setup.sh
#
# Usage (flag-based):
#   ./scripts/setup.sh --tier=observe --node-host=192.168.1.100
#   ./scripts/setup.sh --tier=companion --node-host=192.168.1.100 --bootstrap-mode=paste
#   ./scripts/setup.sh --tier=observe --node-host=192.168.1.100 --dry-run
#
# Requires: Node.js 20+, ssh, ssh-keygen (companion tier)
set -euo pipefail
node "$(dirname "$0")/setup.mjs" "$@"
