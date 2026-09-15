#!/bin/sh
# OmniSight — Production deployment script
#
# Deploys a specific SHA from GHCR to the production Docker Compose stack.
# Flow: record current → pull images → migrate → start → health → record new.
#
# Required environment:
#   IMAGE_TAG          — immutable commit SHA (e.g. 3f93785...)
#   GHCR_REPO          — web image prefix (e.g. ghcr.io/rimoniit6/omnisight-web)
#   GHCR_REPO_LIVE_UPDATES — live-updates image prefix
#
# The script reads .env for runtime secrets (DATABASE_URL, JWT_SECRET, etc.).
#
# Usage:
#   IMAGE_TAG=abc123 GHCR_REPO=ghcr.io/rimoniit6/omnisight-web \
#     GHCR_REPO_LIVE_UPDATES=ghcr.io/rimoniit6/omnisight-web-live-updates \
#     ./scripts/deploy.sh

set -e

DEPLOY_DIR="${DEPLOY_DIR:-.deploy}"
COMPOSE_FILE="docker-compose.production.yml"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

# ── Validate required env ───────────────────────────────────────────────────
if [ -z "${IMAGE_TAG:-}" ]; then
  echo "ERROR: IMAGE_TAG is required (immutable commit SHA)"
  exit 1
fi
if [ -z "${GHCR_REPO:-}" ]; then
  echo "ERROR: GHCR_REPO is required (e.g. ghcr.io/owner/repo)"
  exit 1
fi
if [ -z "${GHCR_REPO_LIVE_UPDATES:-}" ]; then
  echo "ERROR: GHCR_REPO_LIVE_UPDATES is required"
  exit 1
fi

export IMAGE_TAG GHCR_REPO GHCR_REPO_LIVE_UPDATES

# ── Ensure .env exists ──────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.production.example and fill in secrets."
  exit 1
fi

# ── Ensure deploy state directory ────────────────────────────────────────────
mkdir -p "$DEPLOY_DIR"

# ── Record current SHA (before deployment) ──────────────────────────────────
CURRENT_SHA=""
if [ -f "${DEPLOY_DIR}/current" ]; then
  CURRENT_SHA=$(cat "${DEPLOY_DIR}/current")
  echo "[deploy] Current deployed SHA: ${CURRENT_SHA}"
  echo "$CURRENT_SHA" > "${DEPLOY_DIR}/previous"
else
  echo "[deploy] No previous deployment found (first deploy)"
fi

echo "[deploy] Deploying SHA: ${IMAGE_TAG}"
echo "[deploy] Web image: ${GHCR_REPO}:${IMAGE_TAG}"
echo "[deploy] Live-updates image: ${GHCR_REPO_LIVE_UPDATES}:${IMAGE_TAG}"

# ── Pull images ─────────────────────────────────────────────────────────────
echo "[deploy] Pulling images from GHCR..."
docker pull "${GHCR_REPO}:${IMAGE_TAG}" || {
  echo "ERROR: Failed to pull web image"
  exit 1
}
docker pull "${GHCR_REPO_LIVE_UPDATES}:${IMAGE_TAG}" || {
  echo "ERROR: Failed to pull live-updates image"
  exit 1
}
echo "[deploy] Images pulled successfully."

# ── Validate images exist locally ────────────────────────────────────────────
echo "[deploy] Validating image availability..."
docker image inspect "${GHCR_REPO}:${IMAGE_TAG}" > /dev/null 2>&1 || {
  echo "ERROR: Web image ${GHCR_REPO}:${IMAGE_TAG} not found locally"
  exit 1
}
docker image inspect "${GHCR_REPO_LIVE_UPDATES}:${IMAGE_TAG}" > /dev/null 2>&1 || {
  echo "ERROR: Live-updates image ${GHCR_REPO_LIVE_UPDATES}:${IMAGE_TAG} not found locally"
  exit 1
}

# ── Run database migration ──────────────────────────────────────────────────
echo "[deploy] Running Prisma migration..."
docker compose -f "$COMPOSE_FILE" run --rm web-migrate || {
  echo "ERROR: Migration failed. NOT starting new version."
  echo "[deploy] Previous SHA: ${CURRENT_SHA:-none}"
  exit 1
}
echo "[deploy] Migration: success"

# ── Start/recreate services ─────────────────────────────────────────────────
echo "[deploy] Starting services with SHA: ${IMAGE_TAG}..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build web live-updates || {
  echo "ERROR: Failed to start services."
  echo "[deploy] Attempting to restore previous version..."
  if [ -n "${CURRENT_SHA:-}" ]; then
    export IMAGE_TAG="$CURRENT_SHA"
    docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build web live-updates || true
  fi
  exit 1
}

# ── Health verification ──────────────────────────────────────────────────────
echo "[deploy] Running health checks (timeout: ${HEALTH_TIMEOUT}s)..."
WEB_OK=false
LU_OK=false

# Wait for web
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
    WEB_OK=true
    echo "[deploy] Web health: OK (after ${i}s)"
    break
  fi
  i=$((i + HEALTH_INTERVAL))
  sleep "$HEALTH_INTERVAL"
done

# Wait for live-updates
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf http://127.0.0.1:3010/health > /dev/null 2>&1; then
    LU_OK=true
    echo "[deploy] Live-updates health: OK (after ${i}s)"
    break
  fi
  i=$((i + HEALTH_INTERVAL))
  sleep "$HEALTH_INTERVAL"
done

# ── Verify readiness ─────────────────────────────────────────────────────────
if [ "$WEB_OK" = true ]; then
  READY_RESPONSE=$(curl -sf http://127.0.0.1:3000/api/health/ready 2>&1 || echo '{"status":"not_ready"}')
  echo "[deploy] Web readiness: ${READY_RESPONSE}"
fi

# ── Verify container SHA ─────────────────────────────────────────────────────
for CONTAINER in omnisight_web omnisight_live_updates; do
  STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "not_found")
  IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo "unknown")
  echo "[deploy] ${CONTAINER}: status=${STATUS} image=${IMAGE}"
done

# ── Final verdict ────────────────────────────────────────────────────────────
if [ "$WEB_OK" = true ] && [ "$LU_OK" = true ]; then
  echo "$IMAGE_TAG" > "${DEPLOY_DIR}/current"
  echo "[deploy] Deployment: SUCCESS"
  echo "[deploy] Deployed SHA: ${IMAGE_TAG}"
  echo "[deploy] Previous SHA: ${CURRENT_SHA:-none}"
  exit 0
else
  echo "[deploy] Deployment: FAILED"
  echo "[deploy] Web health: ${WEB_OK}"
  echo "[deploy] Live-updates health: ${LU_OK}"

  # Attempt rollback to previous version
  if [ -n "${CURRENT_SHA:-}" ]; then
    echo "[deploy] Attempting rollback to ${CURRENT_SHA}..."
    export IMAGE_TAG="$CURRENT_SHA"
    docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build web live-updates || true

    # Wait for rollback health
    sleep 10
    ROLLBACK_WEB=false
    ROLLBACK_LU=false
    i=0
    while [ "$i" -lt 30 ]; do
      curl -sf http://127.0.0.1:3000/api/health > /dev/null 2>&1 && ROLLBACK_WEB=true
      curl -sf http://127.0.0.1:3010/health > /dev/null 2>&1 && ROLLBACK_LU=true
      if [ "$ROLLBACK_WEB" = true ] && [ "$ROLLBACK_LU" = true ]; then
        echo "[deploy] Rollback: SUCCESS (restored ${CURRENT_SHA})"
        echo "$CURRENT_SHA" > "${DEPLOY_DIR}/current"
        break
      fi
      i=$((i + 5))
      sleep 5
    done

    if [ "$ROLLBACK_WEB" = false ] || [ "$ROLLBACK_LU" = false ]; then
      echo "[deploy] Rollback: PARTIAL — manual intervention required"
    fi
  fi

  exit 1
fi
