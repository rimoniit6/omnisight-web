# OmniSight — self-hosted production image (Next.js standalone output).
#
# Multi-stage: bun install -> next build -> lean runtime. The runtime keeps the
# full node_modules + src so the entrypoint can apply Prisma migrations and the
# idempotent self-hosted seed (Enterprise_SelfHosted plan) at first start — the
# DB is only reachable at runtime, never at build time. See
# scripts/install-self-hosted.sh for the equivalent scripted install.

# ── deps ────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Non-secret build-time placeholders; real config is supplied at runtime.
ENV NODE_ENV=production \
    DATABASE_URL="postgresql://omnisight:omnisight@db:5432/omnisight?schema=public" \
    DIRECT_URL="postgresql://omnisight:omnisight@db:5432/omnisight?schema=public" \
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
# full node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Entrypoint: deploy migrations, apply the idempotent self-hosted seed (creates
# the Enterprise_SelfHosted plan), then start the standalone server.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
