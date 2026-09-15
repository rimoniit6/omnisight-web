#!/bin/sh
# OmniSight — Health verification script
#
# Checks all health endpoints after deployment. Exits non-zero on failure.
# Usage:
#   ./scripts/health-check.sh
#   IMAGE_TAG=<sha> ./scripts/health-check.sh

set -e

WEB_URL="${WEB_URL:-http://127.0.0.1:3000}"
LIVE_UPDATES_URL="${LIVE_UPDATES_URL:-http://127.0.0.1:3010}"
TIMEOUT="${HEALTH_TIMEOUT:-60}"
INTERVAL="${HEALTH_INTERVAL:-5}"
WEB_OK=false
LU_OK=false

echo "[health-check] Verifying deployment..."

# ── Wait for web /api/health ────────────────────────────────────────────────
echo "[health-check] Waiting for web /api/health..."
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  if curl -sf "${WEB_URL}/api/health" > /dev/null 2>&1; then
    WEB_OK=true
    echo "[health-check] Web /api/health: OK (after ${i}s)"
    break
  fi
  i=$((i + INTERVAL))
  sleep "$INTERVAL"
done

if [ "$WEB_OK" = false ]; then
  echo "[health-check] FAIL: web /api/health did not become healthy within ${TIMEOUT}s"
  echo "[health-check] Last response:"
  curl -s "${WEB_URL}/api/health" 2>&1 || true
  exit 1
fi

# ── Verify web /api/health/ready ────────────────────────────────────────────
echo "[health-check] Checking web /api/health/ready..."
READY_RESPONSE=$(curl -sf "${WEB_URL}/api/health/ready" 2>&1) || {
  echo "[health-check] FAIL: /api/health/ready returned non-200"
  exit 1
}
echo "[health-check] /api/health/ready: ${READY_RESPONSE}"

# ── Wait for live-updates /health ───────────────────────────────────────────
echo "[health-check] Waiting for live-updates /health..."
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  if curl -sf "${LIVE_UPDATES_URL}/health" > /dev/null 2>&1; then
    LU_OK=true
    echo "[health-check] Live-updates /health: OK (after ${i}s)"
    break
  fi
  i=$((i + INTERVAL))
  sleep "$INTERVAL"
done

if [ "$LU_OK" = false ]; then
  echo "[health-check] FAIL: live-updates /health did not become healthy within ${TIMEOUT}s"
  echo "[health-check] Last response:"
  curl -s "${LIVE_UPDATES_URL}/health" 2>&1 || true
  exit 1
fi

# ── Verify live-updates /health response ────────────────────────────────────
LU_RESPONSE=$(curl -sf "${LIVE_UPDATES_URL}/health" 2>&1)
echo "[health-check] Live-updates /health: ${LU_RESPONSE}"

# ── Verify container SHA (if Docker is available) ───────────────────────────
if command -v docker > /dev/null 2>&1; then
  if [ -n "${IMAGE_TAG:-}" ]; then
    echo "[health-check] Verifying container images use SHA: ${IMAGE_TAG}"

    WEB_IMAGE=$(docker inspect --format='{{.Config.Image}}' omnisight_web 2>/dev/null || echo "")
    LU_IMAGE=$(docker inspect --format='{{.Config.Image}}' omnisight_live_updates 2>/dev/null || echo "")

    if echo "$WEB_IMAGE" | grep -q "${IMAGE_TAG}"; then
      echo "[health-check] Web image: MATCH (${WEB_IMAGE})"
    else
      echo "[health-check] WARN: Web image mismatch — expected *:${IMAGE_TAG}, got: ${WEB_IMAGE}"
    fi

    if echo "$LU_IMAGE" | grep -q "${IMAGE_TAG}"; then
      echo "[health-check] Live-updates image: MATCH (${LU_IMAGE})"
    else
      echo "[health-check] WARN: Live-updates image mismatch — expected *:${IMAGE_TAG}, got: ${LU_IMAGE}"
    fi
  fi

  # Verify both containers are running
  for CONTAINER in omnisight_web omnisight_live_updates; do
    STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "not_found")
    if [ "$STATUS" = "running" ]; then
      echo "[health-check] ${CONTAINER}: running"
    else
      echo "[health-check] FAIL: ${CONTAINER} status=${STATUS}"
      exit 1
    fi
  done
fi

echo "[health-check] All health checks passed."
