#!/usr/bin/env bash
# Deploys the drop-in build to the production server (ignes-cloudpanel).
#
# The firewall (deploy/cloudflare-allowlist.sh) only accepts SSH from the
# operator's IP, so this runs FROM the operator's machine, never from CI.
#
#   bash server/deploy-dropin.sh [user@host]
#
# The config.php on the server (the real keys) is NEVER overwritten: it's
# excluded from the sync. The build (build-dropin.sh) runs first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-dayone-pages@18.118.232.44:/home/dayone-pages/htdocs/dayone-pages.com/}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/claude_deploy_dayone_v2}"

bash "$HERE/server/build-dropin.sh"

rsync -avz --delete \
  -e "ssh -i $KEY -o IdentitiesOnly=yes" \
  --exclude 'config.php' \
  --exclude '_cache/' \
  "$HERE/server/dist/dropin/" \
  "$TARGET"

echo "Deployed to $TARGET (config.php and _cache/ left untouched)."
