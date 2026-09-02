# OmniSight Architecture

## System Overview

OmniSight is a multi-tenant workforce intelligence platform with two main components:

1. **Web Admin Panel** (`omnisight-web`) — Next.js 16 application for administrators
2. **Desktop Agent** (`omnisight-agent`) — Electron application running on employee Windows devices

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Browser (Admin UI)                        │
│                  React 19 · Tailwind 4 · shadcn/ui             │
│                     Zustand · React Query                       │
├──────────────────────────┬──────────────────────────────────────┤
│                          │                                      │
│   ┌──────────────────┐   │   ┌──────────────────────────────┐  │
│   │   Next.js 16     │   │   │  Socket.io Client            │  │
│   │   App Router      │   │   │  (realtime events)           │  │
│   │   130+ API routes │   │   │                              │  │
│   └────────┬─────────┘   │   └──────────────┬───────────────┘  │
│            │              │                  │                   │
└────────────┼──────────────┼──────────────────┼───────────────────┘
             │              │                  │
             │              │                  │ WebSocket
             │              │                  ▼
             │              │   ┌──────────────────────────────┐
             │              │   │  Live-Updates Service         │
             │              │   │  (Bun runtime, port 3010)     │
             │              │   │  Socket.io server             │
             │              │   │  PostgreSQL polling           │
             │              │   └──────────────┬───────────────┘
             │              │                  │
             ▼              ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL Database                         │
│                  Prisma 6 ORM · 43+ models                      │
│                  Tenant isolation via org scope                  │
└─────────────────────────────────────────────────────────────────┘
             ▲
             │  REST API
             │
┌─────────────────────────────────────────────────────────────────┐
│              OmniSight Desktop Agent (Electron)                  │
│              Windows · Node.js · Native Bridge                   │
├─────────────────────────────────────────────────────────────────┤
│  Activity · Screenshots · Location · USB · Keyboard · Webcam    │
│  Heartbeat · Commands · Consent Enforcement · App Policies      │
└─────────────────────────────────────────────────────────────────┘
```

## Component Architecture

### Next.js Application

The admin panel follows the Next.js 16 App Router pattern:

```
src/app/
├── api/                    # REST API routes (server-side)
│   ├── auth/               # Authentication endpoints
│   ├── agent/              # Agent-facing API endpoints
│   ├── super-admin/        # Platform admin endpoints
│   └── ...                 # Feature-specific endpoints
├── (dashboard)/            # Dashboard layout (protected)
├── layout.tsx              # Root layout
├── page.tsx                # Root page (redirects to dashboard)
└── global-error.tsx        # Error boundary
```

### API Layer

All API routes are in `src/app/api/` and follow a consistent pattern:

1. **Authentication**: `authenticateRequest()` validates JWT + session
2. **Authorization**: `requireAdminOrg()`, `requireSessionOrg()`, `requireSuperAdmin()`
3. **Business logic**: Domain-specific handlers
4. **Response**: Consistent JSON format

### Client Architecture

```
src/components/             # React components
├── ui/                     # shadcn/ui primitives (40+ components)
├── layout/                 # App header, sidebar, org switcher
├── dashboard/              # Dashboard widgets
├── [feature]/              # Feature-specific components
│
src/hooks/                  # React hooks (data fetching, state)
src/lib/                    # Shared utilities
├── store.ts                # Zustand store
└── api.ts                  # Client-side API helpers
```

### State Management

- **Zustand**: Global client state (UI state, sidebar, preferences)
- **TanStack React Query**: Server state (data fetching, caching, mutations)
- **URL state**: Search params for filters and pagination

## Data Flow

### Admin Login Flow

```
Browser → POST /api/auth/login (email + password)
  → Rate limit check (dual-layer)
  → Find user by email (case-insensitive)
  → Verify bcrypt password
  → Resolve active membership (OrganizationMembership)
  → Create UserSession row
  → Sign JWT (userId, email, role, orgId, sessionId)
  → Set httpOnly session cookie
  → Return user + organization data
```

### Agent Enrollment Flow (PATH A — Device Claim)

```
Agent → POST /api/agent/discover (deviceId, deviceInfo)
  → Validate AgentSession (login-only token)
  → Create DeviceClaim (hashed claim secret)
  → Return claim ID to agent

Admin → Approve claim via UI
  → Assign employee to device
  → Create/update Device record
  → Mark claim as approved

Agent → POST /api/agent/authenticate (deviceId, deviceSecret)
  → Verify claim is approved
  → Verify claim secret (constant-time comparison)
  → Acquire active device slot (FOR UPDATE lock)
  → Create AgentToken (24h expiry)
  → Return token to agent
```

### Activity Ingestion Flow

```
Agent → POST /api/agent/activity (Bearer token)
  → validateAgentToken() (checks token, employee, device, org status)
  → Verify consent (hasActiveConsent)
  → Create Activity records
  → Trigger live-updates event
  → Return success
```

### Screenshot Pipeline

```
Agent → POST /api/agent/screenshot (Bearer token + image data)
  → validateAgentToken()
  → Verify screenshot consent
  → Validate image (format, dimensions, size)
  → Store to local filesystem or Supabase Storage
  → Create Screenshot record
  → Trigger live-updates event
  → Return success
```

### Location Pipeline

```
Agent → POST /api/agent/location (Bearer token + coordinates)
  → validateAgentToken()
  → Verify location consent
  → 5 km movement threshold check (Haversine)
  → Acquire row lock (FOR UPDATE) for concurrency
  → Create LocationEvent if above threshold
  → Trigger live-updates event
  → Return acceptance status
```

## Database Architecture

### Multi-Tenant Isolation

Every data model includes an `organizationId` field. All queries are scoped to the active organization derived from the JWT session. The system enforces:

1. **JWT-level**: `organizationId` and `activeOrganizationId` are HMAC-signed claims
2. **Session-level**: `UserSession.activeOrganizationId` is server-authoritative
3. **Query-level**: All API routes filter by organization scope
4. **Membership-level**: Active `OrganizationMembership` required for access

### Key Relationships

```
Organization
├── Department[]
├── Employee[]
│   ├── Device[]
│   │   ├── DeviceClaim
│   │   └── AgentToken
│   ├── AgentAccount (1:1)
│   ├── Activity[]
│   ├── Screenshot[]
│   ├── LocationEvent[]
│   ├── KeyboardActivity[]
│   ├── Consent[]
│   ├── ProjectMember[]
│   └── TimeEntry[]
├── Project[]
├── ConsentPolicy[]
├── AppListEntry[] (policies)
├── Notification[]
├── AuditLog[]
└── OrganizationBranding?
```

## Realtime Architecture

The live-updates service (`mini-services/live-updates/`) is a separate Bun process that:

1. Connects to the same PostgreSQL database
2. Validates JWT tokens using the same `JWT_SECRET`
3. Accepts Socket.io connections from browsers
4. Polls database cursors for new events
5. Broadcasts org-scoped events to connected clients

### Event Types

- `activity-new` — New activity recorded
- `screenshot-new` — New screenshot captured
- `location-update` — Location event accepted
- `device-status` — Device online/offline change
- `notification` — New notification created
- `employee-presence` — Employee online/offline/break status
- `dashboard-invalidate` — Dashboard data changed

### Cursor-Based Polling

The service uses database cursors (`createdAt` timestamps) to efficiently poll for new data without scanning entire tables. Each event type has its own cursor, and the cursor store is persistent across restarts.

## Security Architecture

### Authentication Layers

1. **JWT verification**: HMAC-SHA256 signature validation
2. **Session validation**: Server-side `UserSession` row check (not revoked, not expired)
3. **Organization validation**: Active membership verification
4. **Role authorization**: Permission-based access control

### Secret Management

- **JWT_SECRET**: HMAC-SHA256 signing key (≥ 16 chars)
- **ENCRYPTION_KEY**: AES-256-GCM key for encrypting stored secrets (independent from JWT_SECRET)
- **Agent tokens**: 64-char cryptographically random (randomBytes, never Math.random)
- **Claim secrets**: 32-byte base64url, stored as SHA-256 hash

### Security Headers

Applied via Next.js `next.config.ts`:

- `Content-Security-Policy` (environment-aware)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` (2-year max-age)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (camera, microphone, geolocation disabled)

## Background Job Architecture

Background jobs run via a lease-based system (`JobRun` model) to prevent concurrent execution across multiple instances:

1. **Lease acquisition**: `UPDATE JobRun SET status='running', leaseExpiresAt=... WHERE job='name' AND (status='idle' OR leaseExpiresAt < now())`
2. **Job execution**: Process runs with crash-safe timeout
3. **Lease release**: Update status to 'completed' or 'failed'

Jobs run on a configurable interval (default: hourly) and include consent expiration, retention cleanup, rate limit sweeping, project time sync, and anomaly detection.

## Technology Decisions

| Decision | Rationale |
|----------|-----------|
| Next.js 16 App Router | Server components, API routes in one framework |
| PostgreSQL | ACID compliance, full-text search, JSON support, row-level locking |
| Prisma 6 | Type-safe ORM, migration system, good DX |
| Custom JWT | No external auth dependency, full control over session lifecycle |
| Socket.io | WebSocket abstraction with fallback, rooms for org scoping |
| Bun (live-updates) | Fast startup, native TypeScript, hot reload |
| shadcn/ui | Accessible, customizable, Radix-based primitives |
| Zustand | Lightweight state management, no providers |
| React Query | Server state management, caching, optimistic updates |
