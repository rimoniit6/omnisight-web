#!/bin/sh
# OmniSight container entrypoint.
#
# Starts the Next.js standalone server on PORT (default 3000).
#
# Database migrations are NO LONGER applied automatically on startup.
# They must be executed as an explicit, single-run deployment operation
# BEFORE starting the serving container. See:
#   docker compose run --rm web-migrate
#   npm run db:deploy
#
# The container creates NO plan / pricing / demo data on boot. Reference
# data and the Super Admin account are created ONLY by the explicit
# seed commands documented in the project README — never implicitly.

set -e

# Forward an explicit command (e.g. the web-migrate service runs `prisma
# migrate deploy` via the compose `command:`). Without args, start the server.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "[entrypoint] Starting OmniSight on 0.0.0.0:${PORT:-3000}..."
exec node server.js
