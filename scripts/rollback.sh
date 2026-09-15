#!/bin/sh
# OmniSight — Rollback script
#
# Restores the previous known-good SHA from .deploy/previous.
# Does NOT roll back database migrations (they are forward-only).
#
# Usage:
#   ./scripts/rollback.sh
#   ROLLBACK_SHA=<sha> ./scripts/rollback.sh   # override with specific SHA
#
# Required environment:
#   GHCR_REPO          — web image prefix
#   GHCR_REPO_LIVE_UPDATES — live-updates image prefix

set -e

DEPLOY_DIR="${DEPLOY_DIR:-.deploy}"
COMPOSE_FILE="docker-compose.production.yml"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

# ── Determine rollback SHA ──────────────────────────────────────────────────
if [ -n "${ROLLBACK_SHA:-}" ]; then
  echo "[rollback] Using specified SHA: ${ROLLBACK_SHA}"
elif [ -f "${DEPLOY_DIR}/previous" ]; then
  ROLLBACK_SHA=$(cat "${DEPLOY_DIR}/previous")
  echo "[rollback] Rolling back to previous SHA: ${ROLLBACK_SHA}"
else
  echo "ERROR: No previous SHA available. Set ROLLBACK_SHA manually."
  exit 1
fi

# ── Validate required env ───────────────────────────────────────────────────
if [ -z "${GHCR_REPO:-}" ]; then
  echo "ERROR: GHCR_REPO is required"
  exit 1
fi
if [ -z "${GHCR_REPO_LIVE_UPDATES:-}" ]; then
  echo "ERROR: GHCR_REPO_LIVE_UPDATES is required"
  exit 1
fi

export IMAGE_TAG="$ROLLBACK_SHA" GHCR_REPO GHCR_REPO_LIVE_UPDATES

# ── Ensure .env exists ──────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env file not found"
  exit 1
fi

# ── Pull the rollback image (may already be cached) ──────────────────────────
echo "[rollback] Pulling images for SHA: ${ROLLBACK_SHA}..."
docker pull "${GHCR_REPO}:${ROLLBACK_SHA}" 2>/dev/null || echo "[rollback] Web image already available locally"
docker pull "${GHCR_REPO_LIVE_UPDATES}:${ROLLBACK_SHA}" 2>/dev/null || echo "[rollback] Live-updates image already available locally"

# ── Record current SHA before rollback ──────────────────────────────────────
CURRENT_SHA=""
if [ -f "${DEPLOY_DIR}/current" ]; then
  CURRENT_SHA=$(cat "${DEPLOY_DIR}/current")
  echo "[rollback] Current SHA: ${CURRENT_SHA}"
fi

# ── Restart services with rollback SHA ──────────────────────────────────────
echo "[rollback] Restarting services with SHA: ${ROLLBACK_SHA}..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build web live-updates || {
  echo "ERROR: Failed to restart services during rollback"
  exit 1
}

# ── Health verification ──────────────────────────────────────────────────────
echo "[rollback] Verifying health after rollback..."
WEB_OK=false
LU_OK=false

i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
    WEB_OK=true
    echo "[rollback] Web health: OK (after ${i}s)"
    break
  fi
  i=$((i + HEALTH_INTERVAL))
  sleep "$HEALTH_INTERVAL"
done

i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf http://127.0.0.1:3010/health > /dev/null 2>&1; then
    LU_OK=true
    echo "[rollback] Live-updates health: OK (after ${i}s)"
    break
  fi
  i=$((i + HEALTH_INTERVAL))
  sleep "$HEALTH_INTERVAL"
done

# ── Verify container images ─────────────────────────────────────────────────
for CONTAINER in omnisight_web omnisight_live_updates; do
  STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "not_found")
  IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo "unknown")
  echo "[rollback] ${CONTAINER}: status=${STATUS} image=${IMAGE}"
done

# ── Final verdict ────────────────────────────────────────────────────────────
if [ "$WEB_OK" = true ] && [ "$LU_OK" = true ]; then
  echo "$ROLLBACK_SHA" > "${DEPLOY_DIR}/current"
  echo "[rollback] Rollback: SUCCESS"
  echo "[rollback] Restored SHA: ${ROLLBACK_SHA}"
  echo "[rollback] Previous SHA was: ${CURRENT_SHA:-unknown}"
  echo "[rollback] NOTE: Database migrations are NOT automatically reversed."
  echo "[rollback] If a forward migration was applied, it remains in the database."
  exit 0
else
  echo "[rollback] Rollback: FAILED"
  echo "[rollback] Web health: ${WEB_OK}"
  echo "[rollback] Live-updates health: ${LU_OK}"
  echo "[rollback] Manual intervention required."
  exit 1
fi
