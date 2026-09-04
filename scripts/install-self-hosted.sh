#!/usr/bin/env bash
#
# OmniSight — Self-Hosted / On-Premise installer
#
# Provisions a license-gated OmniSight deployment on your own server.
# Cloud/sandbox installs do not need this — it exists for on-prem customers
# who deploy with SELF_HOSTED=true and hold an OMNISIGHT license key.
#
# Flow:
#   1. Validate the self-hosted env (SELF_HOSTED + LICENSE_KEY).
#   2. Install production dependencies.
#   3. Apply DB migrations (prisma migrate deploy — production-safe, non-destructive).
#   4. Seed default plans including Enterprise_SelfHosted (idempotent).
#   5. Build the Next.js production bundle.
#   6. Start the server (foreground).
#
# Usage:
#   SELF_HOSTED=true LICENSE_KEY=OMNISIGHT-XXXX-XXXX-XXXX ./scripts/install-self-hosted.sh
#
# Optional env:
#   PORT                            server port (default 3000)
#   SELF_HOSTED_REQUIRE_LICENSE     set true to refuse startup on a bad/absent key
#   SKIP_SEED / SKIP_BUILD          set true to skip the corresponding step

set -euo pipefail

cd "$(dirname "$0")/.."

# ─── 1. Self-hosted env validation ─────────────────────────────────────────
if [[ "${SELF_HOSTED:-}" == "true" ]]; then
  if [[ -z "${LICENSE_KEY:-}" ]]; then
    if [[ "${SELF_HOSTED_REQUIRE_LICENSE:-false}" == "true" ]]; then
      echo "ERROR: SELF_HOSTED=true + SELF_HOSTED_REQUIRE_LICENSE=true but LICENSE_KEY is not set." >&2
      echo "       Set LICENSE_KEY to the OMNISIGHT-XXXX-XXXX-XXXX key issued by your vendor." >&2
      exit 1
    fi
    echo "WARN: SELF_HOSTED=true but LICENSE_KEY is unset — license validation will be disabled." >&2
  fi
else
  echo "INFO: SELF_HOSTED is not 'true' — installing in cloud mode (license checks bypassed)."
fi

# ─── 2. Dependencies ───────────────────────────────────────────────────────
echo "==> Installing production dependencies"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev || npm install --omit=dev
else
  npm install --omit=dev
fi

# ─── 3. Migrations (production-safe) ───────────────────────────────────────
echo "==> Generating Prisma client"
npx prisma generate
echo "==> Applying database migrations"
npx prisma migrate deploy

# ─── 4. Seed (idempotent) ──────────────────────────────────────────────────
if [[ "${SKIP_SEED:-}" != "true" ]]; then
  echo "==> Seeding default plans (incl. Enterprise_SelfHosted)"
  SEED_ALLOWED=1 npx tsx src/lib/seed.ts || echo "WARN: seed completed with issues (see above)."
else
  echo "==> Skipping seed (SKIP_SEED=true)"
fi

# ─── 5. Build ──────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD:-}" != "true" ]]; then
  echo "==> Building production bundle"
  npm run build
else
  echo "==> Skipping build (SKIP_BUILD=true)"
fi

# ─── 6. Start ──────────────────────────────────────────────────────────────
echo "==> Starting OmniSight on port ${PORT:-3000}"
exec npm run start -- -p "${PORT:-3000}"
