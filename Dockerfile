# OmniSight — production image (Next.js standalone output).
#
# Multi-stage: bun install -> next build -> lean runtime. The runtime keeps the
# full node_modules + src so the Prisma CLI is available for explicit migration
# commands — the DB is only reachable at runtime, never at build time.
#
# Migrations are NOT applied automatically on container startup. They must be
# executed as an explicit deployment step before starting the serving container.
# The container creates NO plan / pricing / demo data on boot.

# ── deps ────────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Non-secret build-time placeholders; real config is supplied at runtime.
ENV NODE_ENV=production \
    DATABASE_URL="postgresql://omnisight:omnisight@db:5433/omnisight?schema=public" \
    DIRECT_URL="postgresql://omnisight:omnisight@db:5433/omnisight?schema=public" \
    JWT_SECRET="placeholder-build-only-secret-0123456789abcdef" \
    ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
RUN bunx prisma generate
# clean-types, then next build -> emits .next/standalone (next.config.ts sets
# output: standalone when not building on Vercel).
RUN bun run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000

# Full node_modules (incl. dev deps like tsx for the seed), source, Prisma
# migrations and the standalone server bundle. Prisma CLI is present via the
# full node_modules. Migrations are NOT applied automatically — see
# docker compose run --rm web-migrate or npm run db:deploy.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Entrypoint: start the standalone server. Migrations are applied
# separately via the web-migrate service or an explicit deploy command.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh

# Non-root runtime. The app needs exactly one persistent writable directory at
# runtime: the local storage root (/app/uploads) for LocalStorageDriver
# (screenshots + avatars when STORAGE_DRIVER=local). Prisma migrations write to
# the database, never the filesystem. Everything else is read-only at runtime.
RUN addgroup -S omnisight \
    && adduser -S -G omnisight -u 1001 omnisight \
    && mkdir -p /app/uploads \
    && chown -R omnisight:omnisight /app/uploads \
    && chown -R omnisight:omnisight /app/node_modules/@prisma/engines

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

# Run as the unprivileged omnisight user (uid 1001), never root.
USER omnisight

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
