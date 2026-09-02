# OmniSight — Web Admin Panel

> AI-powered workforce intelligence platform. Self-hosted, privacy-first.

---

## Overview

OmniSight is an organization workforce-management and workforce-intelligence platform consisting of a central **Admin Panel** (this repository — `omnisight-web`) and a **Windows Desktop Agent** (`omnisight-agent`).

The Admin Panel is a Next.js 16 application that provides:

- **Employee Activity Monitoring** — real-time activity feed, application/website tracking, productivity categorization
- **Screenshot Capture & OCR** — periodic screenshots with blur detection, flagging, and optional OCR text extraction
- **Keyboard Telemetry** — aggregate keystroke counting (count-only, no raw keylogging)
- **Location Tracking** — Windows-native GPS with IP-based fallback, 5 km movement threshold, Leaflet map UI
- **USB Device Monitoring** — insert/remove/block events with vendor, serial, VID/PID identification
- **Webcam Sessions** — on-demand admin-initiated webcam with WebRTC relay (metadata only, no frame storage)
- **AI Insights & Anomaly Detection** — automated productivity analysis, burnout risk, unusual patterns
- **Sentiment Analysis** — employee/project-level mood scoring with optional AI provider integration
- **Project Management** — create, assign, time-track, auto-sync from agent activity
- **Consent Management** — versioned policies, state machine, audit trail, expiration processing
- **App Policies** — whitelist/blacklist with SHA256/publisher verification, policy violation tracking
- **Audio Transcription** — admin-uploaded audio with Whisper-based transcription (Python microservice)
- **Multi-Organization** — full tenant isolation, org switching, membership-based RBAC
- **Branding** — platform-wide and per-org logo/SVG/color/title customization
- **Reports** — PDF/Excel/CSV generation for productivity, attendance, activity, and device data
- **Realtime Updates** — Socket.io mini-service for live dashboards, notifications, and presence
- **Comprehensive RBAC** — Super Admin, Organization Admin, Manager, Viewer with 50+ granular permissions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser / Admin UI                       │
│                    React 19 + Tailwind 4                     │
│                    shadcn/ui + Radix UI                      │
├─────────────────────────────────────────────────────────────┤
│                        Next.js 16                            │
│                     App Router + API                         │
├──────────────────────┬──────────────────────────────────────┤
│  REST API (130+)     │  Socket.io Realtime (port 3010)     │
│  JWT + Session Auth  │  org-scoped events                  │
├──────────────────────┴──────────────────────────────────────┤
│                   Prisma 6 + PostgreSQL                     │
│                   43+ models, tenant isolation              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              OmniSight Desktop Agent (Electron)              │
│              Windows · Activity · Screenshots                │
│              Location · USB · Keyboard · Webcam              │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| State | Zustand, TanStack React Query v5 |
| Database | PostgreSQL via Prisma 6 |
| Auth | Custom JWT (HMAC-SHA256 + bcrypt + AES-256-GCM encryption) |
| Realtime | Socket.io (separate Bun micro-service) |
| Maps | Leaflet + react-leaflet |
| Charts | Recharts |
| PDF | PDFKit |
| Export | xlsx (Excel), PDFKit (PDF), CSV |
| Testing | Node test runner (`tsx --test`), Playwright (E2E) |
| Build | TypeScript 5, ESLint 9 |
| Transcription | Python FastAPI + OpenAI Whisper |

## Repository Structure

```
omnisight-web/
├── prisma/                        # Schema + migrations
│   ├── schema.prisma              # 43+ models
│   └── migrations/                # PostgreSQL migrations
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── api/                   # 130+ REST API routes
│   │   │   ├── auth/              # Login, logout, sessions, users
│   │   │   ├── agent/             # Agent enrollment, heartbeat, activity, etc.
│   │   │   ├── super-admin/       # Platform administration
│   │   │   ├── employees/         # Employee CRUD
│   │   │   ├── devices/           # Device management
│   │   │   ├── projects/          # Project management
│   │   │   ├── screenshots/       # Screenshot serving
│   │   │   ├── consent/           # Consent management
│   │   │   ├── analytics/         # Dashboard analytics
│   │   │   ├── reports/           # Report generation
│   │   │   ├── branding/          # Branding management
│   │   │   ├── health/            # Health check
│   │   │   └── ...                # 30+ more route groups
│   │   ├── (dashboard)/           # Dashboard layout
│   │   └── uploads/               # Local file serving
│   ├── components/                # React components
│   │   ├── ui/                    # shadcn/ui primitives (40+ components)
│   │   ├── dashboard/             # Dashboard widgets, KPI cards, charts
│   │   ├── employees/             # Employee management, telemetry, location map
│   │   ├── devices/               # Device management
│   │   ├── projects/              # Project management, time tracking
│   │   ├── analytics/             # Analytics charts, comparison tools
│   │   ├── activities/            # Activity monitoring
│   │   ├── screenshots/           # Screenshot viewer
│   │   ├── consent/               # Consent management UI
│   │   ├── policies/              # App whitelist/blacklist
│   │   ├── branding/              # Branding configuration
│   │   ├── super-admin/           # Super Admin management
│   │   ├── alerts/                # Alert management
│   │   ├── anomalies/             # Anomaly management
│   │   ├── audit/                 # Audit log viewer
│   │   ├── reports/               # Report generation
│   │   ├── insights/              # AI insights
│   │   ├── sentiment/             # Sentiment analysis
│   │   ├── audio/                 # Audio transcription
│   │   ├── break-status/          # Break mode management
│   │   ├── live-monitor/          # Real-time monitoring
│   │   ├── self-portal/           # Employee self-service
│   │   └── layout/                # App header, sidebar, org switcher
│   ├── lib/                       # Core business logic
│   │   ├── auth.ts                # JWT + bcrypt + session cookies
│   │   ├── permissions.ts         # RBAC definitions (single source of truth)
│   │   ├── api.ts                 # API middleware helpers
│   │   ├── session.ts             # Server-authoritative web sessions
│   │   ├── consent.ts             # Consent state machine
│   │   ├── crypto.ts              # AES-256-GCM encryption at rest
│   │   ├── branding.ts            # Hierarchical branding resolution
│   │   ├── location-service.ts    # 5 km threshold location ingestion
│   │   ├── agent/                 # Agent auth, activation, sessions
│   │   ├── jobs/                  # Background job processors
│   │   ├── storage/               # Storage driver (local + Supabase)
│   │   ├── pdf/                   # PDF report generation
│   │   ├── notifications/         # Notification creation + delivery
│   │   ├── breaks/                # Break mode management
│   │   ├── audio/                 # Audio transcription service
│   │   ├── policies/              # App policy enforcement
│   │   └── ...                    # 50+ utility modules
│   ├── hooks/                     # React hooks
│   └── types/                     # TypeScript types
├── mini-services/
│   ├── live-updates/              # Socket.io realtime (Bun runtime)
│   └── transcription/             # Python Whisper transcription
├── tests/                         # 100+ test files
│   ├── e2e/                       # Playwright E2E tests
│   └── *.test.ts                  # Unit/integration tests
├── scripts/                       # 70+ utility scripts
├── uploads/                       # Local file storage
├── public/                        # Static assets
├── docs/                          # Documentation
└── Caddyfile                      # Reverse proxy config (port 81)
```

## Requirements

### Development

- **Node.js** ≥ 20
- **PostgreSQL** 14+ (or Supabase)
- **npm** (or pnpm/bun)
- **Python 3.9+** (only for audio transcription microservice)
- **FFmpeg** (only for audio transcription)

### Production

- **Node.js** ≥ 20
- **PostgreSQL** 14+ (Supabase recommended for Vercel deployments)
- **Bun** runtime (for the live-updates mini-service)
- **Caddy** (recommended reverse proxy, see `Caddyfile`)

## Quick Start

### 1. Clone and install

```bash
git clone <repository-url> omnisight-web
cd omnisight-web
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/omnisight?schema=public"
DIRECT_URL="postgresql://USER:PASSWORD@HOST:5432/omnisight?schema=public"
JWT_SECRET="<generate with: openssl rand -base64 48>"
SUPER_ADMIN_EMAIL="admin@yourcompany.com"
SUPER_ADMIN_PASSWORD="<strong password, 12+ chars>"
SUPER_ADMIN_NAME="System Administrator"
ENCRYPTION_KEY="<generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\">"
```

### 3. Set up database

```bash
# Run migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Bootstrap the first Super Admin
npx tsx scripts/bootstrap-super-admin.ts
```

### 4. Start development

```bash
npm run dev
```

This starts both:
- **Next.js admin app** on `http://localhost:3000`
- **Realtime service** on `http://localhost:3010`

### 5. (Optional) Seed demo data

```bash
# Comprehensive demo: 10 orgs, 120+ users, 2000+ activities
npm run db:seed:demo

# Large-scale demo: 14 orgs, used by integrity tests
npm run db:seed:mega
```

### 6. Open the application

Visit `http://localhost:3000` and log in with the Super Admin credentials.

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Next.js + live-updates service) |
| `npm run dev:app` | Start Next.js only (port 3000) |
| `npm run dev:live` | Start live-updates service only (port 3010) |
| `npm run build` | Production build |
| `npm start` | Start production server (port 3000) |
| `npm run lint` | ESLint |
| `npm run bootstrap:super-admin` | Create/verify Super Admin account |
| `npm run db:seed:dev` | Seed Super Admin only |
| `npm run db:seed:demo` | Comprehensive demo data (10 orgs, 120+ users) |
| `npm run db:seed:mega` | Large-scale multi-org demo (14 orgs) |
| `npm run db:deploy` | Run pending Prisma migrations |
| `npm run db:migrate` | Create new migration |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:reset` | Reset database |
| `npm run db:push:dev` | Push schema to dev database |
| `npm run db:production-clean` | Clean production data |
| `npm run jobs` | Run background jobs |

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL pooled connection string (port 6543 for Supabase) |
| `DIRECT_URL` | No | falls back to `DATABASE_URL` | PostgreSQL direct connection for migrations (port 5432) |
| `JWT_SECRET` | Yes | — | HMAC-SHA256 signing key (≥ 16 chars, 32+ recommended) |
| `JWT_EXPIRES_IN` | No | `7d` | Session lifetime (`<number><s\|m\|h\|d>`) |
| `SESSION_COOKIE_NAME` | No | `worklens_token` | httpOnly session cookie name |
| `SUPER_ADMIN_EMAIL` | Yes | — | Super Admin bootstrap email |
| `SUPER_ADMIN_PASSWORD` | Yes | — | Super Admin bootstrap password (≥ 12 chars) |
| `SUPER_ADMIN_NAME` | No | `System Administrator` | Super Admin display name |
| `ENCRYPTION_KEY` | Yes (prod) | auto-generated (dev) | 32-byte hex key for AES-256-GCM secret encryption |
| `STORAGE_DRIVER` | No | `local` | `local` or `supabase` |
| `SUPABASE_URL` | Conditional | — | Required when `STORAGE_DRIVER=supabase` |
| `SUPABASE_SERVICE_ROLE_KEY` | Conditional | — | Required when `STORAGE_DRIVER=supabase` (server-only) |
| `NEXT_PUBLIC_LIVE_UPDATES_URL` | No | `http://localhost:3010` (dev) | WebSocket URL for browser realtime connection |
| `LIVE_UPDATES_PORT` | No | `3010` | Port for the live-updates mini-service |
| `ALLOWED_ORIGIN` | No | `http://localhost:3000` | Allowed browser origin for socket CORS |
| `JOBS_INTERVAL_SECONDS` | No | `3600` | Background maintenance jobs interval |
| `PROJECT_TIME_SYNC_INTERVAL_SECONDS` | No | `60` | Project time sync interval (min: 15) |
| `PRESENCE_ONLINE_THRESHOLD_MS` | No | `300000` | Employee online-presence threshold (5 min) |
| `TRANSCRIPTION_API_KEY` | No | — | API key for the transcription microservice |
| `WHISPER_MODEL` | No | `base` | Whisper model for transcription |
| `AGENT_SERVER_URL` | No | — | Server URL baked into agent installer builds |
| `PG_TEST_BASE_URL` | No | — | Test-only: local Postgres for test databases |

See `.env.example` for complete documentation with security notes.

## Database

PostgreSQL via Prisma ORM with 43+ models covering:

| Domain | Models |
|--------|--------|
| **Organization** | Organization, Department, OrganizationMembership, OrganizationSetting |
| **Users & Auth** | AppUser, UserSession, AuditLog |
| **Employees** | Employee, AgentAccount |
| **Devices** | Device, DeviceClaim, AgentToken, AgentSession |
| **Monitoring** | Activity, Screenshot, LocationEvent, KeyboardActivity, UsbEvent |
| **Webcam** | WebcamSession, AgentCommand |
| **Projects** | Project, ProjectMember, TimeEntry, ProjectTimeSync |
| **Consent** | ConsentPolicy, Consent, ConsentLog |
| **Policies** | AppListEntry, PolicyViolation |
| **AI** | AiInsight, Anomaly, SentimentRecord |
| **Notifications** | Notification, Alert, NotificationPreference |
| **Reports** | Report |
| **Branding** | PlatformBranding, OrganizationBranding |
| **Audio** | AudioRecording, AudioTranscription |
| **System** | SystemSetting, RateLimitCounter, JobRun |

### Key commands

```bash
npx prisma migrate deploy    # Apply migrations (production)
npx prisma migrate dev       # Create new migration (development)
npx prisma generate          # Generate Prisma client
npx prisma studio            # Open Prisma Studio (web UI)
npx prisma db push           # Push schema changes (dev only)
npx prisma migrate reset     # Reset database (dev only)
```

## Authentication

- **Web login**: Email + password → JWT (HMAC-SHA256) + httpOnly session cookie
- **Server-authoritative sessions**: Each login creates a `UserSession` row; JWT carries `sessionId` for server-side revocation
- **Password hashing**: bcrypt (12 rounds)
- **Rate limiting**: Dual-layer brute-force protection (per-email + per-IP+email) with PostgreSQL-backed token bucket
- **Agent authentication**: Two paths — Device Claim (PATH A) and Agent Login (PATH B)
- **Encryption at rest**: AES-256-GCM for stored secrets (AI API keys)

See [docs/SECURITY.md](docs/SECURITY.md) for details.

## Roles & Permissions

| Role | Scope | Description |
|------|-------|-------------|
| `super_admin` | Platform | Full access across all organizations. Manages organizations, users, platform settings, branding. |
| `org_admin` | Organization | Full organization management — employees, devices, projects, policies, settings, branding. |
| `manager` | Organization | Operational management — create/update employees, projects, view reports and analytics. |
| `viewer` | Organization | Read-only access to dashboard, analytics, reports, and data views. |

Legacy role aliases (`owner`, `admin`) are mapped to `org_admin` for backward compatibility.

The RBAC system is defined in `src/lib/permissions.ts` as the single source of truth with 50+ granular permissions.

## Multi-Organization Architecture

- Users hold `OrganizationMembership` records linking them to one or more organizations
- The JWT carries `organizationId` and `activeOrganizationId` (set via org switch)
- All data queries are scoped to the active organization
- Super Admin has cross-organization access
- Organization switching is server-authoritative (validated against membership)
- Suspended/archived organizations are rejected at the API level

## Agent Enrollment

Two enrollment paths:

### PATH A: Device Claim (Traditional)
1. Agent discovers device → creates `DeviceClaim` with hashed secret
2. Admin approves claim → assigns employee → issues `AgentToken`
3. Agent authenticates with device credentials → receives 24-hour token

### PATH B: Agent Login
1. Admin creates `AgentAccount` (agentId + password) for an employee
2. Agent enters credentials → receives short-lived `AgentSession`
3. Agent discovers device → admin approves → issues `AgentToken`

**Single active device rule**: One employee may have many registered devices, but only one device may hold a valid active `AgentToken` at a time.

## Monitoring Features

| Feature | Data Collected | Storage | Admin View |
|---------|---------------|---------|------------|
| Activity | Application name, URL (domain only), category, duration | PostgreSQL | Activity feed, charts |
| Screenshots | PNG image, dimensions, blur score, OCR text | Local/Supabase Storage + PostgreSQL | Screenshot gallery |
| Location | Latitude, longitude, accuracy, source (native/IP) | PostgreSQL | Map view (Leaflet) |
| Keyboard | Aggregate keystroke count, active typing seconds | PostgreSQL | Telemetry view |
| USB | Device name, VID/PID, vendor, serial, drive letter | PostgreSQL | USB events table |
| Webcam | Session metadata (no frames stored) | PostgreSQL | Session log |
| Sentiment | Score, mood, signals, AI insight | PostgreSQL | Sentiment analysis |

## Privacy & Consent

- **Break Mode**: Admin, self-service, or agent-initiated; pauses monitoring
- **Consent State Machine**: pending → granted → revoked/expired (with version tracking)
- **Policy Versioning**: Versioned consent policies; employees must re-consent to new versions
- **Consent Enforcement**: Server-side validation before any data collection
- **Audit Trail**: Immutable consent log with full history
- **Data Minimization**: Only necessary data is collected; no raw URLs, no raw keystrokes

## Project Management

- Create projects with name, description, status, priority, deadline, color
- Assign employees with roles (lead, member, reviewer, stakeholder)
- Auto-sync: agent activity is automatically attributed to projects via the project-time engine
- Manual time entries supported
- Sentiment analysis per project
- Department-scoped projects

## Branding

- **Platform branding**: Logo (file upload or inline SVG), favicon, primary color, browser title, tagline
- **Organization overrides**: Per-org branding that inherits from platform defaults
- **SVG sanitization**: Comprehensive XSS prevention for inline SVG logos
- **Logo size presets**: Original, small, medium, large, custom

## Realtime

The live-updates service (`mini-services/live-updates/`) runs as a separate Bun process:

- Real-time activity feed events
- Employee presence tracking (online/offline/break)
- Device status updates
- Notification delivery
- Dashboard data invalidation
- Cursor-based polling for efficient updates

In development, `npm run dev` starts both services. In production, the live-updates service runs independently and connects to the same database.

## Background Jobs

| Job | Purpose |
|-----|---------|
| Consent expiration | Processes expired consents (granted → expired) |
| Retention cleanup | Removes old screenshots, activity, location data |
| Rate limit cleanup | Sweeps stale rate limit counters |
| Project time sync | Syncs agent activity to project time entries |
| Agent token sweep | Removes expired agent tokens |
| Device status update | Marks devices offline after heartbeat timeout |
| Anomaly detection | Analyzes activity patterns for anomalies |
| Sentiment calculation | Computes employee/project sentiment scores |
| Web session cleanup | Removes expired web sessions |

## Testing

```bash
# Run all unit/integration tests
npm test

# Run specific test suites
npm run test:consent
npm run test:location
npm run test:projects
npm run test:super-admin
npm run test:super-admin-orgs
npm run test:agent-account
npm run test:agent-account-admin
npm run test:agent-login
npm run test:health
npm run test:sentiment
npm run test:project-sentiment
npm run test:members-add
npm run test:consent-seed
npm run test:consent-summary

# E2E tests (requires Playwright)
npx playwright test
```

See [docs/TESTING.md](docs/TESTING.md) for details.

## Production Build

```bash
npm run build
npm start
```

The build produces a standalone output (except on Vercel where the platform adapter handles bundling).

## Production Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for comprehensive deployment instructions.

Quick summary:

1. Set all environment variables
2. Run `npx prisma migrate deploy`
3. Run `npx prisma generate`
4. Run `npx tsx scripts/bootstrap-super-admin.ts`
5. Run `npm run build`
6. Start the live-updates service: `cd mini-services/live-updates && bun index.ts`
7. Start the app: `npm start`
8. Set up Caddy/reverse proxy for port 81 (WebSocket transform for realtime)

## Security

- JWT HMAC-SHA256 with server-authoritative session revocation
- bcrypt password hashing (12 rounds)
- AES-256-GCM encryption at rest for stored secrets
- CSRF protection via httpOnly cookies + SameSite=Lax
- Content Security Policy (environment-aware: dev allows unsafe-eval, prod does not)
- Security headers: X-Frame-Options DENY, HSTS, X-Content-Type-Options nosniff
- Rate limiting (dual-layer: per-email + per-IP+email)
- SVG sanitization for logo uploads
- Placeholder secret detection (rejects known default values)
- Tenant isolation via organization-scoped queries
- Audit logging for all sensitive operations

See [docs/SECURITY.md](docs/SECURITY.md) for details.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common issues and solutions.

## Documentation

- [Documentation Index](docs/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Admin Guide](docs/ADMIN_GUIDE.md)
- [Agent Integration](docs/AGENT_INTEGRATION.md)

## Known Limitations

- The `AppUser.organizationId` field is deprecated for multi-org but retained for backward compatibility
- Seat limits were removed (employee capacity is unlimited per organization)
- Device integrity checks (binary verification, debugger detection) are not implemented
- Email monitoring capability exists in the consent framework but is not implemented in the Agent
- Code signing for the Agent installer is not currently configured

## License

Proprietary — Internal use only.
