#!/usr/bin/env bash
# Forced command for the CI deploy key. Install it root-owned (e.g. /usr/local/bin/lifeos-deploy-entry, mode 0755) and bind the key to it:
#
#   restrict,command="/usr/local/bin/lifeos-deploy-entry",from="<optional runner CIDR>" ssh-ed25519 AAAA… lifeos-github-deploy
#
# The key can then do exactly three things — check, deploy <sha> [dry-run], rollback <sha> [dry-run] — and nothing else: no shell, no port/agent/X11
# forwarding, no arbitrary arguments. The client's requested command arrives in $SSH_ORIGINAL_COMMAND and is validated strictly.
set -Eeuo pipefail
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-/var/www/lifeos/scripts/deploy-production.sh}"
cmd="${SSH_ORIGINAL_COMMAND:-}"

if [[ "$cmd" == "check" ]]; then
  exec "$DEPLOY_SCRIPT" check
elif [[ "$cmd" =~ ^(deploy|rollback)\ ([0-9a-f]{40})(\ dry-run)?$ ]]; then
  args=("${BASH_REMATCH[1]}" --sha "${BASH_REMATCH[2]}")
  if [[ -n "${BASH_REMATCH[3]}" ]]; then args+=(--dry-run); fi
  exec "$DEPLOY_SCRIPT" "${args[@]}"
else
  echo "lifeos-deploy-entry: only 'check', 'deploy <40-hex sha> [dry-run]' and 'rollback <40-hex sha> [dry-run]' are allowed" >&2
  exit 126
fi
