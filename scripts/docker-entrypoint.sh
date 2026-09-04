#!/bin/sh
# OmniSight self-hosted container entrypoint.
#
# 1. Apply Prisma migrations (idempotent).
# 2. Ensure the Enterprise_SelfHosted plan exists (production-safe bootstrap).
# 3. Start the Next.js standalone server on PORT (default 3000).

set -e

echo "[entrypoint] DATABASE_URL present: ${DATABASE_URL:+yes}"
echo "[entrypoint] Applying Prisma migrations..."
./node_modules/.bin/prisma migrate deploy

if [ "$SEED_ALLOWED" = "1" ]; then
  echo "[entrypoint] Ensuring self-hosted plan..."
  SEED_ALLOWED=1 ./node_modules/.bin/tsx scripts/ensure-self-hosted-plan.ts
else
  echo "[entrypoint] SEED_ALLOWED != 1 — skipping plan bootstrap."
  echo "          (Set SEED_ALLOWED=1 to auto-create the Enterprise_SelfHosted plan on first boot.)"
fi

echo "[entrypoint] Starting OmniSight on 0.0.0.0:${PORT:-3000}..."
exec node server.js
