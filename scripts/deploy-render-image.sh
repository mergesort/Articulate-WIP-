#!/usr/bin/env bash
set -euo pipefail

# Build and push a Linux image, then trigger Render deploy without source-code sync.
# Requires:
# - Docker logged into your registry
# - Either RENDER_DEPLOY_HOOK_URL or (RENDER_SERVICE_ID + render CLI auth)
#
# Example:
# IMAGE_REPO=docker.io/yourname/plinky-monolith-archive \
# RENDER_DEPLOY_HOOK_URL="https://api.render.com/deploy/srv-xxx?key=yyy" \
# ./scripts/deploy-render-image.sh

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE_REPO="${IMAGE_REPO:-}"
if [[ -z "$IMAGE_REPO" ]]; then
  echo "Missing IMAGE_REPO (e.g. docker.io/<user>/plinky-monolith-archive)" >&2
  exit 1
fi

IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"
PLATFORM="${PLATFORM:-linux/amd64}"

echo "==> Building and pushing ${IMAGE_REF} (${PLATFORM})"
docker buildx build \
  --platform "${PLATFORM}" \
  -t "${IMAGE_REF}" \
  --push \
  .

if [[ -n "${RENDER_DEPLOY_HOOK_URL:-}" ]]; then
  echo "==> Triggering Render deploy hook"
  ENCODED_IMAGE="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1], safe=""))' "${IMAGE_REF}")"
  if [[ "${RENDER_DEPLOY_HOOK_URL}" == *\?* ]]; then
    DEPLOY_URL="${RENDER_DEPLOY_HOOK_URL}&imgURL=${ENCODED_IMAGE}"
  else
    DEPLOY_URL="${RENDER_DEPLOY_HOOK_URL}?imgURL=${ENCODED_IMAGE}"
  fi
  curl -fsSL -X POST "${DEPLOY_URL}" >/dev/null
  echo "==> Deploy hook submitted for image ${IMAGE_REF}"
  exit 0
fi

if [[ -n "${RENDER_SERVICE_ID:-}" ]]; then
  if ! command -v render >/dev/null 2>&1; then
    echo "Missing 'render' CLI. Install it and run 'render auth login'." >&2
    exit 1
  fi
  echo "==> Triggering Render deploy via CLI for ${RENDER_SERVICE_ID}"
  render deploys create "${RENDER_SERVICE_ID}" \
    --image "${IMAGE_REF}" \
    --wait \
    --confirm
  exit 0
fi

echo "Image pushed, but no deploy method was configured." >&2
echo "Set RENDER_DEPLOY_HOOK_URL or RENDER_SERVICE_ID." >&2
exit 1
