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

### Option 3: Docker (manual — no Dockerfile provided)

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
```

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
