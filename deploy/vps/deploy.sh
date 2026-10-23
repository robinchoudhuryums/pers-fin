#!/usr/bin/env bash
# ============================================================================
# Server half of .github/workflows/deploy-vps.yml. The workflow's SSH key is
# pinned to this script in ~deploy/.ssh/authorized_keys:
#   command="/opt/pers-fin/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… deploy-vps
# so the key can do exactly one thing: deploy an image tag. The tag arrives as
# the SSH command (SSH_ORIGINAL_COMMAND) and a short-lived GHCR token on stdin.
#
# Steps: log in to GHCR → pull the tag → record it in .env → restart the app →
# wait for the container's own healthcheck → on failure, put the previous tag
# back and exit non-zero. Prints statuses only (the repo's logs are public).
set -euo pipefail

cd "$(dirname "$0")"

TAG="${SSH_ORIGINAL_COMMAND:-${1:-}}"
TAG="${TAG#deploy }"
if ! [[ "$TAG" =~ ^([0-9a-f]{7,40}|latest)$ ]]; then
  echo "deploy: refusing tag '${TAG:0:40}' (expected a commit SHA or 'latest')" >&2
  exit 2
fi

OWNER="$(grep -E '^GHCR_OWNER=' .env | cut -d= -f2 || true)"
OWNER="${OWNER:-robinchoudhuryums}"
PREV="$(grep -E '^APP_TAG=' .env | cut -d= -f2 || true)"
PREV="${PREV:-latest}"

if [ ! -t 0 ]; then
  TOKEN="$(cat)"
  if [ -n "$TOKEN" ]; then
    printf '%s' "$TOKEN" | docker login ghcr.io -u "$OWNER" --password-stdin >/dev/null
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  fi
fi

set_tag() { sed -i "s/^APP_TAG=.*/APP_TAG=$1/" .env; grep -q '^APP_TAG=' .env || echo "APP_TAG=$1" >> .env; }

wait_healthy() {
  local id status i
  for i in $(seq 1 40); do
    id="$(docker compose ps -q app)"
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  echo "deploy: app status '$status' after 120s" >&2
  return 1
}

echo "deploy: $PREV -> $TAG"
APP_TAG="$TAG" docker compose pull -q app
set_tag "$TAG"
docker compose up -d app

if wait_healthy; then
  docker image prune -f >/dev/null
  echo "deploy: $TAG healthy"
else
  echo "deploy: rolling back to $PREV" >&2
  set_tag "$PREV"
  docker compose up -d app
  wait_healthy && echo "deploy: rolled back to $PREV (healthy)" >&2
  exit 1
fi
