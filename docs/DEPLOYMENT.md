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

### Option 1: Self-Hosted (VPS/Dedicated Server)

### Option 2: Vercel + Supabase

### Option 3: Docker (docker-compose)
The repository ships a multi-stage `Dockerfile` (Next.js standalone output) and
a `docker-compose.yml` that runs PostgreSQL + the app. See
**Self-Hosted Licensing, Monitoring & Metrics** → **Docker Quick Start** below.

---

## Self-Hosted Deployment

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

Set all required environment variables:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/omnisight?schema=public"
DIRECT_URL="postgresql://user:password@localhost:5432/omnisight?schema=public"

# Authentication
JWT_SECRET="<64-char random string>"
SUPER_ADMIN_EMAIL="admin@yourcompany.com"
SUPER_ADMIN_PASSWORD="<strong password>"
SUPER_ADMIN_NAME="System Administrator"

# Encryption
ENCRYPTION_KEY="<64-char hex string>"

# Storage
STORAGE_DRIVER=local

# Realtime
NEXT_PUBLIC_LIVE_UPDATES_URL="wss://yourdomain.com"
ALLOWED_ORIGIN="https://yourdomain.com"

# Production
NODE_ENV=production

# Self-hosted licensing (license-gated mode)
SELF_HOSTED=true
# Required when SELF_HOSTED=true. Format OMNISIGHT-XXXX-XXXX-XXXX.
LICENSE_KEY="OMNISIGHT-XXXX-XXXX-XXXX"
# Keep true in production so an invalid/expired key refuses to start.
SELF_HOSTED_REQUIRE_LICENSE=true

# App URLs
NEXT_PUBLIC_APP_URL="https://yourdomain.com"
APP_URL="https://yourdomain.com"

# Prometheus metrics (secures /api/metrics). Disabled if unset.
METRICS_TOKEN="<a long random string>"
```

### 4. Database Setup

```bash
# Apply migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Bootstrap Super Admin
npx tsx scripts/bootstrap-super-admin.ts

# Ensure the Enterprise_SelfHosted plan exists (required to issue license keys).
# Production-safe (unlike the full seed, which refuses in production).
SEED_ALLOWED=1 npx tsx scripts/ensure-self-hosted-plan.ts
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

## Self-Hosted Licensing, Monitoring & Metrics

### License keys (Self-Hosted / On-Premise)

When `SELF_HOSTED=true` the platform is license-gated. A valid license key is
required before the app is considered fully licensed.

- **Key format:** `OMNISIGHT-XXXX-XXXX-XXXX` (3 groups of 4 uppercase
  alphanumerics). Keys are generated by a **Super Admin** from
  **Admin → Licenses** and are stored once per organization.
- **Startup check:** at boot the app validates the key configured in
  `LICENSE_KEY` (see `verifySelfHostedLicenseAtStartup`). If
  `SELF_HOSTED_REQUIRE_LICENSE=true` and the key is invalid/expired, the server
  **refuses to start**.
- **Validation endpoint:** the internal/public `POST /api/license/validate`
  proves a key is current. Cloud mode never calls it. The key is **never
  echoed** back in responses or logs.
- **Revocation:** a Super Admin can revoke a key; a revoked key fails
  validation and clears the org's active license pointer.
- **Status page:** org sessions can view their licensing status at
  **`/self-hosted/license-status`**.

Prerequisite — every self-hosted install must have the `Enterprise_SelfHosted`
plan row present (it is what issues keys). After applying migrations, run the
production-safe bootstrap once:

```bash
SEED_ALLOWED=1 npx tsx scripts/ensure-self-hosted-plan.ts
```

### Docker Quick Start

A multi-stage `Dockerfile` (Next.js standalone) and `docker-compose.yml`
(PostgreSQL + app) are provided:

```bash
cp .env.production.example .env   # then fill in SELF_HOSTED, LICENSE_KEY, secrets
docker compose up -d --build
```

The app container:

1. Applies Prisma migrations on entry.
2. Bootstraps the `Enterprise_SelfHosted` plan when `SEED_ALLOWED=1` (set this
   the first time you start a fresh database).
3. Serves on `0.0.0.0:${PORT:-3000}`.

`docker-entrypoint.sh` and `scripts/ensure-self-hosted-plan.ts` implement this.
Note: the full `seed.ts` deliberately refuses to run under
`NODE_ENV=production`; use the production-safe plan bootstrap above instead.

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
