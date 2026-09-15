# OmniSight Deployment Guide

## Overview

This guide covers deploying the OmniSight Web Admin Panel to a production environment.

## Prerequisites

- **Node.js** ≥ 20
- **PostgreSQL** 14+ (Supabase recommended for Vercel)
- **Bun** runtime (for the live-updates mini-service)
- **Caddy** or nginx (reverse proxy)
- **SSL certificate** (HTTPS required for production)

## Deployment Options

> **Service models (V1):** the only customer-facing service models are
> **OmniSight Managed** (`MANAGED`) and **Customer Database** (`CUSTOMER_DB`).
> Self-Hosted / Private is **not** a V1 service model and the license-key
> architecture has been removed. These are *deployment options for running the
> platform itself*, not customer service models.

### Option 1: VPS / Dedicated Server

### Option 2: Vercel + Supabase

### Option 3: Docker (docker-compose)
The repository ships a multi-stage `Dockerfile` (Next.js standalone output) and
a `docker-compose.yml` that runs PostgreSQL + the app. See
**Metrics & Monitoring** → **Docker Quick Start** below.

---

## VPS / Dedicated Server Deployment

### 1. Server Setup

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun (for live-updates service)
curl -fsSL https://bun.sh/install | bash

# Install Caddy (reverse proxy)
sudo apt install -y caddy
```

### 2. Clone and Build

```bash
git clone <repository-url> /opt/omnisight
cd /opt/omnisight
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

> `.env.example` and `.env.production.example` are TRACKED templates: they only ever
> contain `CHANGE_ME_*` placeholders. Real secrets live in your local (gitignored)
> `.env`. Production startup REJECTS the placeholders on purpose, and CI runs
> `secrets:scan` (scripts/secret-scan.mjs) to fail on any real-looking secret in a
> tracked file — do not bypass it. Generate fresh secrets for every environment:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/omnisight?schema=public"
DIRECT_URL="postgresql://user:password@localhost:5432/omnisight?schema=public"

# Authentication (generate fresh values, never reuse or commit)
JWT_SECRET=$(openssl rand -base64 48)
SUPER_ADMIN_EMAIL="admin@yourcompany.com"
SUPER_ADMIN_PASSWORD=$(openssl rand -base64 18)
SUPER_ADMIN_NAME="System Administrator"

# Encryption (64-char hex — see rotation note below)
ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">

# Storage
STORAGE_DRIVER=local

# Realtime
NEXT_PUBLIC_LIVE_UPDATES_URL="wss://yourdomain.com"
ALLOWED_ORIGIN="https://yourdomain.com"

# Production
NODE_ENV=production

# NOTE: SELF_HOSTED / LICENSE_KEY / SELF_HOSTED_REQUIRE_LICENSE were removed
# with the LicenseKey architecture (Self-Hosted is not a V1 service model).
# Do not re-add them.

# App URLs
NEXT_PUBLIC_APP_URL="https://yourdomain.com"
APP_URL="https://yourdomain.com"

# Prometheus metrics (secures /api/metrics). Disabled if unset.
METRICS_TOKEN="<a long random string>"
```

#### Secret generation & rotation

- Generation (run once per environment, store in a vault — never in git):
  - `JWT_SECRET`: `openssl rand -base64 48`
  - `ENCRYPTION_KEY`: 64 hex chars from `crypto.randomBytes(32).toString('hex')`
  - `SUPER_ADMIN_PASSWORD`: `openssl rand -base64 18`
- Rotation semantics (be precise, not optimistic):
  - **`JWT_SECRET` rotation invalidates every existing session/token** immediately.
    Plan a maintenance window; all logged-in users must re-authenticate.
  - **`ENCRYPTION_KEY` rotation is NOT seamless.** Existing encrypted data
    (agent credentials, workflow secrets) was encrypted with the old key — a
    plain key swap breaks reads. You must run a controlled re-encryption
    migration (decrypt with the old key, encrypt with the new one) before, or
    concurrently with, switching the env value; backup first.
  - **Super Admin password rotation** forces the operator to re-login and
    revokes sessions that predate the change.
  - After any rotation, re-run `npm run secrets:scan` and verify
    `GET /api/health/ready`.

### 4. Database Setup

```bash
# Apply migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Bootstrap Super Admin
npx tsx scripts/bootstrap-super-admin.ts
```

### 5. Build

```bash
npm run build
```

### 6. Start Services

**Live-updates service:**
```bash
cd mini-services/live-updates
bun index.ts
```

**Main application:**
```bash
npm start
```

### 7. Configure Caddy

Create `/etc/caddy/Caddyfile`:

```
yourdomain.com {
    # WebSocket transform for realtime service
    @transform_port_query {
        query XTransformPort=3010
    }

    handle @transform_port_query {
        reverse_proxy localhost:3010 {
            header_up Host {host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }

    handle {
        reverse_proxy localhost:3000 {
            header_up Host {host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }
}
```

### 8. Process Management

Use systemd or pm2 to keep services running:

```bash
# Example systemd service for the main app
# /etc/systemd/system/omnisight.service
[Unit]
Description=OmniSight Web Admin Panel
After=network.target

[Service]
Type=simple
User=omnisight
WorkingDirectory=/opt/omnisight
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# Example systemd service for live-updates
# /etc/systemd/system/omnisight-live.service
[Unit]
Description=OmniSight Live Updates Service
After=network.target

[Service]
Type=simple
User=omnisight
WorkingDirectory=/opt/omnisight/mini-services/live-updates
ExecStart=/home/omnisight/.bun/bin/bun index.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable omnisight omnisight-live
sudo systemctl start omnisight omnisight-live
```

---

## Vercel + Supabase Deployment

### 1. Supabase Setup

1. Create a Supabase project
2. Get the **pooled** connection string (port 6543, `?pgbouncer=true`) for `DATABASE_URL`
3. Get the **direct** connection string (port 5432) for `DIRECT_URL`
4. Create storage buckets:
   - `screenshots` (private) — for screenshot images
   - `avatars` (public) — for user avatars

### 2. Vercel Setup

1. Connect your Git repository to Vercel
2. Set environment variables in Vercel dashboard
3. Set `STORAGE_DRIVER=supabase`
4. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### 3. Database Migration

Run migrations from your local machine:

```bash
npx prisma migrate deploy
npx prisma generate
npx tsx scripts/bootstrap-super-admin.ts
```

### 4. Deploy

Vercel auto-deploys on push. The build produces a standalone output on non-Vercel environments.

### 5. Live-Updates Service

The live-updates service must run outside Vercel (serverless cannot run long-lived WebSocket processes). Deploy it to a separate VM/container:

```bash
cd mini-services/live-updates
bun index.ts
```

Set `NEXT_PUBLIC_LIVE_UPDATES_URL` to the public URL of the live-updates service.

---

## Post-Deployment Checklist

- [ ] All environment variables set
- [ ] Database migrations applied
- [ ] Super Admin bootstrapped
- [ ] HTTPS enabled
- [ ] Security headers verified
- [ ] Live-updates service running
- [ ] Storage driver configured (local or Supabase)
- [ ] Caddy/reverse proxy configured
- [ ] Process manager configured (systemd/pm2)
- [ ] Firewall configured (ports 80, 443)
- [ ] Backup strategy in place
- [ ] Monitoring configured

## Backup & Recovery

### Database Backup

```bash
# Supabase: use the dashboard backup feature
# Self-hosted:
pg_dump -U postgres omnisight > backup_$(date +%Y%m%d).sql
```

### File Storage Backup

```bash
# Local storage: backup the uploads/ directory
tar -czf uploads_backup_$(date +%Y%m%d).tar.gz uploads/
```

### Recovery

```bash
# Restore database
psql -U postgres omnisight < backup_20260902.sql

# Restore files
tar -xzf uploads_backup_20260902.tar.gz
```

## Update Procedure

```bash
cd /opt/omnisight
git pull
npm install
npx prisma migrate deploy
npx prisma generate
npm run build
sudo systemctl restart omnisight omnisight-live
```

## Rollback

```bash
# Rollback to previous commit
git checkout <previous-commit>
npm install
npx prisma migrate deploy
npm run build
sudo systemctl restart omnisight omnisight-live
```

Note: Database migrations are forward-only. If a migration needs rollback, restore from backup.

---

## Metrics & Monitoring

### Docker Quick Start

A multi-stage `Dockerfile` (Next.js standalone) and `docker-compose.yml`
(PostgreSQL + app) are provided. The compose stack includes:

- **`db`** — PostgreSQL 15 (Alpine), loopback-only on the host.
- **`web-migrate`** — one-shot migration job. Runs `prisma migrate deploy`
  against the database and exits. Must complete successfully before the web
  service starts.
- **`web`** — the Next.js application server.

The app container:

1. Runs as the unprivileged `omnisight` user (uid 1001) — never root.
2. Serves on `0.0.0.0:${PORT:-3000}` inside the container only — the compose
   file publishes it **loopback-only** (`127.0.0.1:3000`).
3. Runs with a read-only root filesystem: runtime writes go to the `uploads`
   volume (`/app/uploads`) and transient tmpfs mounts (`/tmp`,
   `/app/.next/cache`). `cap_drop: [ALL]` + `no-new-privileges` are enabled.

**Migrations are NOT applied automatically on container startup.** They are
executed as an explicit, single-run deployment step by the `web-migrate`
service. This ensures:

- The serving container never independently attempts schema migration.
- Migration failures are visible and prevent the web service from starting.
- Multiple web replicas cannot execute migrations concurrently.

It does **not** create any plan, pricing or demo data on boot. Reference data
(the Plan catalog) and the Super Admin account are created by the explicit
commands documented in the README.

Required environment file (never committed):

```bash
cp .env.production.example .env   # then fill in the secrets
```

`.env` is gitignored and MUST never be committed. The compose services load
it via `env_file: .env`, so each container receives exactly the runtime
variables in it. Two variables are overridden by compose so the containers can
reach the database: `DATABASE_URL` and `DIRECT_URL`, both pointing at the
`db` service (`db:5432`) with the same bootstrap credentials the `db`
service declares. If you change the `POSTGRES_USER/PASSWORD/DB` on the `db`
service, update them in the `web` and `web-migrate` blocks to match.

Start the stack:

```bash
docker compose up -d --build
```

This automatically:
1. Starts PostgreSQL and waits for it to be healthy.
2. Runs the `web-migrate` one-shot migration job.
3. Starts the web server after migration succeeds.

To run migrations manually (e.g. after a code update):

```bash
docker compose run --rm web-migrate
```

To restart the web server without re-running migrations:

```bash
docker compose restart web
```

Verify:

```bash
# Containers run as the expected non-root user (uid 1001):
docker exec omnisight_web id
# -> uid=1001(omnisight) gid=1001(omnisight)

# Health / ready endpoint:
curl -sf http://127.0.0.1:3000/api/health

# PostgreSQL is reachable on the host ONLY via loopback - nothing on the LAN:
ss -ltn | grep -E ':(3000|5433)\s'    # both must show 127.0.0.1 bindings only
```

**Migration failure procedure:**

If the `web-migrate` service fails:
1. **Do NOT** start/restart the web service blindly.
2. Inspect the migration error: `docker compose logs web-migrate`
3. Resolve the issue (database connectivity, permission, schema conflict).
4. Re-run migration: `docker compose run --rm web-migrate`
5. Only after migration succeeds, start the web service.
6. **Never** use `prisma db push` as an emergency workaround — it has no
   migration history and can destroy data.

Networking model: the production gateway is Caddy on the host. The host
`Caddyfile` reverse-proxies to `localhost:3000` (web) and `localhost:3010`
(realtime) via the loopback bindings — do not open `3000`/`5433` to the LAN.
If local development on a separate machine truly requires remote access,
change the compose bindings to `0.0.0.0` deliberately and never on a public
network.

Realtime/live updates: `docker compose up` automatically starts the live-updates
WebSocket service on port 3010 alongside PostgreSQL and the app. The service
uses the `/health` liveness probe and depends on both `db` and `web-migrate`.

Point the app at it via `NEXT_PUBLIC_LIVE_UPDATES_URL` (see *Live-Updates
Service* under Vercel above).

### Prometheus Metrics

`GET /api/metrics` exposes lightweight Prometheus text metrics: process
uptime, heap usage, active subscriptions, trial orgs, invoices by status, and
active/revoked license counts. It exposes **no per-organization or per-user
data**.

Secured by a bearer token — set `METRICS_TOKEN` and point a scraper at it:

```yaml
scrape_configs:
  - job_name: omnisight
    bearer_token: <METRICS_TOKEN>
    metrics_path: /api/metrics
    static_configs:
      - targets: ['app-host:3000']
```

If `METRICS_TOKEN` is unset the endpoint returns **404** (secure by default).

### Error Tracking

Errors are captured by the dependency-free structured logger
(`src/lib/logger.ts`). Every failure logs a `requestId`/IP context and the
sanitized error `name`, `message` and `stack`, and sensitive fields (tokens,
passwords, secrets) are redacted.

OmniSight does **not** ship a third-party error service (Sentry etc.) by
default. To enable remote error aggregation either:

- forward the structured JSON logs to your log pipeline (e.g. Loki/ELK), or
- add a Sentry integration and route `logger.error` through it.

The route handlers catch and log before returning safe error responses, so the
API surface never leaks internals even when monitoring is not configured.
