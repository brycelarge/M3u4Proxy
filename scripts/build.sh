#!/usr/bin/env bash
set -euo pipefail

# ── m3u-manager build script ──────────────────────────────────────────────────
# Usage:
#   ./scripts/build.sh              # build + push with auto version tag
#   ./scripts/build.sh --no-push    # build only, don't push
#   ./scripts/build.sh --tag 1.2.3  # override version tag

IMAGE="ghcr.io/brycelarge/m3u-manager"
PUSH=true
TAG=""

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-push)  PUSH=false; shift ;;
    --tag)      TAG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Resolve version tag ───────────────────────────────────────────────────────
if [[ -z "$TAG" ]]; then
  # Use package.json version
  TAG=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
fi

DATE_TAG=$(date +%Y%m%d)

echo "▶ Building ${IMAGE}:${TAG} (${DATE_TAG})"

# ── Build ─────────────────────────────────────────────────────────────────────
docker build \
  --platform linux/amd64 \
  --tag "${IMAGE}:${TAG}" \
  --tag "${IMAGE}:${DATE_TAG}" \
  --tag "${IMAGE}:latest" \
  .

echo "✔ Build complete"

# ── Push ──────────────────────────────────────────────────────────────────────
if [[ "$PUSH" == "true" ]]; then
  echo "▶ Pushing to registry…"
  docker push "${IMAGE}:${TAG}"
  docker push "${IMAGE}:${DATE_TAG}"
  docker push "${IMAGE}:latest"
  echo "✔ Pushed ${IMAGE}:${TAG}, :${DATE_TAG}, :latest"
else
  echo "  (skipped push — run with no --no-push flag to push)"
fi
