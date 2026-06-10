#!/usr/bin/env bash
# scripts/install-proxmox-key.sh
# Install the homelab_mcp public key into Proxmox's /root/.ssh/authorized_keys.
#
# Usage A — remote install (requires password auth or existing SSH access):
#   bash scripts/install-proxmox-key.sh <proxmox-ip>
#
# Usage B — print commands to paste into the Proxmox web shell:
#   bash scripts/install-proxmox-key.sh

set -euo pipefail

# Resolve key path: check Windows home via USERPROFILE (WSL) or fall back to $HOME
if [[ -n "${USERPROFILE:-}" ]]; then
  WIN_HOME=$(wslpath "$USERPROFILE" 2>/dev/null || echo "$HOME")
else
  WIN_HOME="$HOME"
fi
PUBKEY_PATH="${PUBKEY_PATH:-$WIN_HOME/.ssh/homelab_mcp.pub}"

if [[ ! -f "$PUBKEY_PATH" ]]; then
  echo "Public key not found: $PUBKEY_PATH"
  echo "Run scripts/generate-ssh-key.ps1 first to generate the key pair."
  exit 1
fi

PUBKEY=$(cat "$PUBKEY_PATH")
PROXMOX_HOST="${1:-}"

if [[ -n "$PROXMOX_HOST" ]]; then
  echo "Installing key on root@$PROXMOX_HOST ..."
  ssh "root@$PROXMOX_HOST" bash <<EOF
mkdir -p /root/.ssh
chmod 700 /root/.ssh
grep -qxF '$PUBKEY' /root/.ssh/authorized_keys 2>/dev/null || echo '$PUBKEY' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo "Key installed."
EOF
  echo "Done. Test with: ssh -i ~/.ssh/homelab_mcp root@$PROXMOX_HOST echo ok"
else
  echo "No host provided — paste these commands into the Proxmox web shell:"
  echo ""
  echo "  mkdir -p /root/.ssh && chmod 700 /root/.ssh"
  printf "  echo '%s' >> /root/.ssh/authorized_keys\n" "$PUBKEY"
  echo "  chmod 600 /root/.ssh/authorized_keys"
  echo ""
  echo "Or re-run with the host:  bash scripts/install-proxmox-key.sh <proxmox-ip>"
fi
