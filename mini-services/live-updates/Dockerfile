# OmniSight — Live Updates WebSocket service (Bun runtime).
#
# Builds a minimal production image for mini-services/live-updates/.
# The build context is the repository root so the Prisma schema is accessible.
#
# Migrations are NEVER run by this service — they are the web container's
# responsibility via the web-migrate one-shot service.

# ── deps ────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

# Install live-updates dependencies using its own package.json + bun.lock.
# Copy only the files needed for a frozen lockfile install.
COPY mini-services/live-updates/package.json mini-services/live-updates/bun.lock ./
RUN bun install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Copy installed node_modules from deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy Prisma schema (required for client generation).
# The schema lives at the repo root, referenced by mini-services/live-updates/package.json.
COPY prisma ./prisma

# Copy live-updates source code.
COPY mini-services/live-updates ./

# Generate Prisma Client. The schema references env("DATABASE_URL") which is
# only needed at runtime — build-time value is a non-secret placeholder.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN bunx prisma generate --schema=prisma/schema.prisma

# ── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy runtime artifacts: node_modules (production only), generated Prisma
# client, and the live-updates source code.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/*.ts ./

# Non-root runtime user.
RUN addgroup -S omnisight \
    && adduser -S -G omnisight -u 1001 omnisight \
    && chown -R omnisight:omnisight /app

# Liveness probe: lightweight HTTP check. Does NOT depend on database
# availability — one unavailable CUSTOMER_DB must not make the service unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3010/health || exit 1

# Run as the unprivileged omnisight user (uid 1001), never root.
USER omnisight

EXPOSE 3010

# The Prisma schema lives at /app/prisma/schema.prisma relative to the
# working directory. resolveDbUrl() walks up looking for prisma/schema.prisma
# — with WORKDIR=/app it finds /app/prisma/schema.prisma immediately.
CMD ["bun", "run", "index.ts"]
