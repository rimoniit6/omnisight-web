# OmniSight — Web Admin Panel

> AI-powered workforce intelligence platform. Self-hosted, privacy-first.

---

## What is OmniSight?

OmniSight is an organization workforce-management and workforce-intelligence platform consisting of a central Admin Panel (this repository) and a Windows Desktop Agent (`omnisight-agent`).

The **Admin Panel** is a Next.js 16 application that provides:

- Real-time employee activity monitoring
- Screenshot capture and OCR analysis
- Website and application tracking
- Keyboard/activity telemetry
- GPS and IP-based location tracking
- USB device monitoring
- AI-powered insights and anomaly detection
- Project management and time tracking
- Consent management and privacy controls
- Multi-organization support with role-based access

## Product Architecture

```
Administrator
     ↓
OmniSight Web / Admin Panel (Next.js 16)
     ↓
REST API + Socket.io Realtime + PostgreSQL
     ↓
OmniSight Desktop Agent (Electron)
     ↓
Employee Windows Device
     ↓
Activity / Screenshot / Location / Website / Keyboard / USB Telemetry
     ↓
Server (stored in PostgreSQL)
     ↓
Admin Dashboard (real-time updates via Socket.io)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| State | Zustand, TanStack React Query |
| Database | PostgreSQL via Prisma 6 |
| Auth | Custom JWT (bcrypt + AES-256-GCM) |
| Realtime | Socket.io (mini-service) |
| Maps | Leaflet + react-leaflet |
| Charts | Recharts |
| Testing | Vitest (unit/integration), Playwright (E2E) |
| Build | TypeScript 5, ESLint 9 |

## Quick Start

### Prerequisites

- Node.js ≥ 20
- PostgreSQL 14+
- pnpm or npm

### Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL, JWT_SECRET, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD

# Run migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Bootstrap Super Admin
npx tsx scripts/bootstrap-super-admin.ts

# Seed demo data (optional)
npm run db:seed:demo

# Start development
npm run dev
```

Visit `http://localhost:3000`.

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Next.js + live-updates) |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run lint` | ESLint |
| `npm run db:seed:dev` | Seed Super Admin only |
| `npm run db:seed:demo` | Comprehensive demo (10 orgs, 120+ users, 2000+ activities) |
| `npm run db:seed:mega` | Large-scale multi-org demo (14 orgs, used by integrity tests) |
| `npm run bootstrap:super-admin` | Production Super Admin bootstrap |
| `npm run db:deploy` | Run pending migrations |
| `npm run db:reset` | Reset database |
| `npm run jobs` | Run background jobs |

### Running Tests

```bash
# Unit/integration tests
npm test                    # All tests
npm run test:consent        # Consent tests
npm run test:location       # Location tests
npm run test:projects       # Project tests
npm run test:super-admin    # Super Admin tests
npm run test:agent-account  # Agent account tests
npm run test:health         # Health endpoint tests

# E2E tests (requires Playwright + test database)
npx playwright test
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection (pooled, port 6543 for Supabase) |
| `DIRECT_URL` | No | PostgreSQL direct connection (port 5432 for migrations) |
| `JWT_SECRET` | Yes | JWT signing key (≥ 16 chars, 32+ recommended) |
| `SUPER_ADMIN_EMAIL` | Yes | Super Admin bootstrap email |
| `SUPER_ADMIN_PASSWORD` | Yes | Super Admin bootstrap password (≥ 12 chars) |
| `ENCRYPTION_KEY` | Yes (prod) | AES-256-GCM key (32 bytes hex) for secret encryption |
| `STORAGE_DRIVER` | No | `local` (default) or `supabase` |
| `SUPABASE_URL` | No | Supabase project URL (if using Supabase storage) |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Supabase service key (server-only) |
| `NEXT_PUBLIC_LIVE_UPDATES_URL` | No | WebSocket URL for realtime |
| `LIVE_UPDATES_PORT` | No | Realtime service port (default: 3010) |

See `.env.example` for full documentation.

## Database

PostgreSQL via Prisma ORM. 43+ models covering:

- Organizations, Departments, Employees
- Devices, Device Claims, Agent Accounts
- Activities, Screenshots, Keyboard Activity
- Location Events, USB Events, Webcam Sessions
- Projects, Time Entries, Sentiment Records
- Consent Policies, Consents, Consent Logs
- Notifications, Alerts, Audit Logs
- AI Insights, Reports, Anomalies
- Audio Recordings, Transcriptions
- App Lists, Policy Violations

```bash
npx prisma migrate deploy    # Apply migrations
npx prisma generate         # Generate client
npx prisma studio           # Open Prisma Studio
```

## Realtime

Socket.io mini-service (`mini-services/live-updates/`) provides:

- Real-time activity feed
- Employee presence tracking (online/offline/break)
- Device status updates
- Notification delivery
- Dashboard live updates

Runs as a separate process on port 3010.

## Project Structure

```
omnisight-web/
├── prisma/                    # Schema + migrations
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── api/               # 130+ API routes
│   │   └── (dashboard)/       # Dashboard pages
│   ├── components/            # React components
│   │   ├── ui/                # shadcn/ui components
│   │   ├── dashboard/         # Dashboard widgets
│   │   ├── employees/         # Employee management
│   │   ├── devices/           # Device management
│   │   ├── projects/          # Project management
│   │   ├── analytics/         # Analytics charts
│   │   └── ...                # Feature-specific components
│   ├── lib/                   # Core business logic
│   │   ├── auth.ts            # JWT + bcrypt
│   │   ├── permissions.ts     # RBAC definitions
│   │   ├── consent.ts         # Consent state machine
│   │   ├── seed*.ts           # Seed files
│   │   └── ...                # Domain logic
│   ├── hooks/                 # React hooks
│   └── types/                 # TypeScript types
├── mini-services/
│   ├── live-updates/          # Socket.io realtime
│   └── transcription/         # Python Whisper transcription
├── tests/                     # 80+ test files
├── scripts/                   # 70+ utility scripts
└── browser-extension/         # Chrome/Firefox extension
```

## User Roles

| Role | Level | Description |
|------|-------|-------------|
| `super_admin` | Platform | Full access across all organizations |
| `owner` | Organization | Organization owner |
| `admin` | Organization | Full org management |
| `manager` | Organization | Operational management |
| `viewer` | Organization | Read-only access |

## License

Proprietary — Internal use only.
