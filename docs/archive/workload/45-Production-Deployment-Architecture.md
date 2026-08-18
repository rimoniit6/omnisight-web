# WorkLensAI — Production Deployment Architecture

## Architecture Overview

```
                          ┌─────────────────────────┐
                          │     Desktop Agent        │
                          │  (Windows, Electron)     │
                          │  discovery / auth /      │
                          │  heartbeat / config /    │
                          │  consent sync / collect  │
                          └──────────┬──────────────┘
                                     │ HTTPS
                                     ▼
  ┌───────┐  HTTPS   ┌──────────────────────────┐
  │Admin  │──────────►│  Reverse Proxy (Caddy)   │
  │Browser│          │  :81 (HTTPS)              │
  └───────┘          │  proxies to :3000 / :3010 │
                     └─────┬──────────┬──────────┘
                           │          │
              ┌────────────▼──┐  ┌────▼──────────────┐
              │ Next.js App   │  │ Live Updates WS   │
              │ :3000         │  │ :3010             │
              │ admin API +   │  │ socket.io         │
              │ health checks │  │ (mini-services/   │
              │ static files  │  │  live-updates)    │
              └───────┬───────┘  └───────┬───────────┘
                      │                  │
                      └──────┬───────────┘
                             │
                    ┌────────▼────────┐
                    │   SQLite/       │
                    │  PostgreSQL     │
                    │  (prisma)       │
                    └─────────────────┘

                    ┌─────────────────┐
                    │  Uploads/       │
                    │  Screenshots    │
                    │  (filesystem)   │
                    └─────────────────┘
```

## Current State (SQLite)

**The current database provider is SQLite** (`prisma/schema.prisma` line 9: `provider = "sqlite"`). This is adequate for single-server deployments with a small number of employees and devices. For multi-server or high-availability production deployments, PostgreSQL is the intended target.

## Required Servers

| Role | Description | Current Implementation |
|------|-------------|----------------------|
| **Admin Web App** | Next.js application serving the admin UI + API | ✅ `src/` — `output: standalone` |
| **Reverse Proxy** | TLS termination, WebSocket routing, request size limits | ✅ `Caddyfile` on :81 |
| **Database** | SQLite or PostgreSQL | ⚠️ SQLite (current); PostgreSQL (intended but not implemented) |
| **Live Updates** | WebSocket service for real-time dashboard updates | ⚠️ `mini-services/live-updates/` (exists but not certified) |
| **Desktop Agent** | Windows Electron app connecting to the admin API | ✅ `desktop-agent/` |
| **Upload Storage** | Filesystem for screenshot storage | ✅ `uploads/screenshots/` |

## Required Ports

| Port | Service | Public | Notes |
|------|---------|--------|-------|
| 81 | Caddy reverse proxy | ✅ Yes | HTTPS (TLS termination) |
| 3000 | Next.js admin app | ❌ Internal | Caddy proxies to this |
| 3010 | Live Updates WebSocket | ❌ Internal | Caddy transforms via `XTransformPort=3010` |

## Required Environment Variables

See `.env.production.example` for the complete list with descriptions.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Database connection string |
| `JWT_SECRET` | ✅ | 32+ char random value for JWT signing |
| `JWT_EXPIRES_IN` | ✅ | Token expiry (default `7d`) |
| `ENCRYPTION_KEY` | ✅ | 32-byte hex key for AES-256-GCM secret encryption |
| `SUPER_ADMIN_EMAIL` | ✅ | Bootstrap super admin email |
| `SUPER_ADMIN_PASSWORD` | ✅ | Bootstrap super admin password |
| `SESSION_COOKIE_NAME` | ❌ | Default `worklens_token` |
| `WORKLENSAI_SERVER_URL` | ⚠️ | Agent connection URL; default `http://localhost:3000` (dev) |
| `WL_UPDATE_URL` | ❌ | Agent HTTPS update feed (disabled when unset) |
| `JOBS_INTERVAL_SECONDS` | ❌ | Background job cadence (default 3600s) |
| `NODE_OPTIONS` | ❌ | Node.js runtime flags |

## Required Domains & TLS

| Domain | Purpose | Status |
|--------|---------|--------|
| `worklensai.yourcompany.com` | Admin web app + API | ⚠️ Not configured (example only) |

TLS is handled by the reverse proxy (Caddy). Caddy automatically provisions Let's Encrypt certificates when a domain is configured in the `Caddyfile`.

## Required Storage

| Path | Purpose | Size Estimate | Backup Required |
|------|---------|---------------|-----------------|
| `uploads/screenshots/` | Screenshot PNG files | Depends on retention policy | ✅ Yes |
| Database (SQLite file or PostgreSQL) | All application data | Depends on employee count | ✅ Yes |

## Required Background Services

| Service | Description | Status |
|---------|-------------|--------|
| **Consent Expiry** | Marks expired consent rows via `applyConsentTransition` | ✅ `src/lib/jobs/expire-consents.ts` — runs via `instrumentation.ts` |
| **Data Retention** | Purges screenshots/activities older than retention period, anonymizes compliance logs | ✅ `src/lib/jobs/retention.ts` — runs via `instrumentation.ts` |
| **Live Updates** | WebSocket push for real-time dashboard | ⚠️ `mini-services/live-updates/` exists but deployment not certified |

## Required Scheduled Jobs

All jobs run via `src/instrumentation.ts`:
- **Interval**: `JOBS_INTERVAL_SECONDS` (default 3600s = 1 hour)
- **Manual trigger**: `npm run jobs`
- **Jobs executed**: `runScheduledJobs()` which runs consent expiry + retention cleanup

## API Endpoints

| Endpoint | Auth | Rate Limited | Purpose |
|----------|------|--------------|---------|
| `GET /api/health` | None | No | Server health check |
| `GET /api/health/database` | None | No | Database connectivity check |
| `POST /api/auth/login` | None | 10/5min/IP+email | Admin login |
| `POST /api/agent/discover` | None | 20/min/IP+key | Zero-touch device discovery |
| `POST /api/agent/authenticate` | None | 20/min/IP | Device/employee authentication |
| `POST /api/agent/heartbeat` | AgentToken | 600/min/token | Device liveness |
| `POST /api/agent/activity` | AgentToken | 120/min/token | Activity upload |
| `POST /api/agent/screenshot` | AgentToken | 120/min/token | Screenshot upload |
| `GET /api/agent/config` | AgentToken | 120/min/token | Agent configuration |
| `GET/POST /api/agent/consent` | AgentToken | 120/min/token | Consent state |
| All other `/api/*` | Admin JWT | Per-route | Admin CRUD |

## Known Gaps

1. **Database**: SQLite is the current provider. PostgreSQL migration requires a schema change and migration regeneration. This is a pre-production task.
2. **Live Updates WebSocket**: `mini-services/live-updates/` exists but is not deployed or certified as part of this phase.
3. **Dockerfile**: No Dockerfile exists. Deployment uses `next start` from the standalone build.
4. **Monitoring/Alerting**: No external monitoring integration (Prometheus, Datadog, etc.). The `/api/health` endpoints can be used with external uptime monitors.
5. **Backup Automation**: No automated backup scripts exist. Manual procedure documented in workload/46.