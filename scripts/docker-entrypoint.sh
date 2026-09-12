#!/bin/sh
# OmniSight container entrypoint.
#
# 1. Apply Prisma migrations (idempotent, non-destructive).
# 2. Start the Next.js standalone server on PORT (default 3000).
#
# REMOVED (LicenseKey / self-hosted architecture):
#   The entrypoint previously ran `scripts/ensure-self-hosted-plan.ts` when
#   SEED_ALLOWED=1 to upsert an `Enterprise_SelfHosted` plan row. Self-Hosted /
#   PRIVATE is not a V1 service model, that script is deleted, and the
#   container must NOT recreate such a plan (nor any plan / pricing / demo
#   data) at startup.
#
# Reference data and the Super Admin account are created ONLY by the explicit
# seed commands documented in the project README — never implicitly on boot.

set -e

echo "[entrypoint] DATABASE_URL present: ${DATABASE_URL:+yes}"
echo "[entrypoint] Applying Prisma migrations..."
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Starting OmniSight on 0.0.0.0:${PORT:-3000}..."
exec node server.js
