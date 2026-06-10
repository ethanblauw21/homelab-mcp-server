#!/bin/sh
set -e

if [ -n "$SSH_PUBLIC_KEY" ]; then
  echo "$SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
else
  echo "ERROR: SSH_PUBLIC_KEY env var is required" >&2
  exit 1
fi

exec /usr/sbin/sshd -D -e
