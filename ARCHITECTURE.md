# OmniSight — Architecture

> Previously branded as **WorkLensAI** — technical identifiers from that era (cookie names, environment variables, native module names) are intentionally preserved for compatibility.

Describes the system as implemented. Every component below exists in this repository.

Related docs: [README.md](./README.md) · [API.md](./API.md) · [omnisight-agent.md](./omnisight-agent.md) · [DEVELOPMENT.md](./DEVELOPMENT.md)

---

## 1. System overview

```
Admin Console (Next.js SPA, :3000)
      │  JWT (httpOnly cookie "worklens_token")
      ▼
API / Server (Next.js App Router /api/*)
      │                        │
      ├── PostgreSQL (Prisma 6 — 41 models, 22 migrations)
      ├── AI Providers (BYOK — OpenAI, Anthropic, Google, Mistral, Ollama, custom)
      ├── Realtime mini-service (Socket.IO, :3010, org-scoped rooms)
      ├── Background jobs (consent expiry, retention, project-time sync, anomaly detection)
      └── File storage (uploads/screenshots)
              │
              ▼
      Windows Desktop Agent (Electron 33)
          ├── Activity Collector        ├── Screenshot Collector
          ├── Keyboard Collector        ├── Location Collector
          ├── Webcam Collector          ├── Website Collector (+ browser extension)
          ├── USB Collector             ├── Policy Enforcer
          └── Native addon (worklens_capture.node — N-API C++)
```

## 2. Frontend

- **Single-page application.** `src/app/page.tsx` is the only route; state-based routing via a Zustand store (`src/lib/store.ts`, `currentPage` of 28 `PageType` values). All page components are loaded with `dynamic(..., { ssr: false })`.
- **State/data**: TanStack Query for server state (with WebSocket-driven invalidation), Zustand for auth/UI state, `next-themes` for theming.
- **Auth client**: JWT held in memory only; the httpOnly session cookie is set by the server. `hydrate()` re-validates on reload.
- **Realtime client**: `websocket-provider.tsx` — Socket.IO client (transports websocket+polling), endpoint candidates: `NEXT_PUBLIC_LIVE_UPDATES_URL` → `/?XTransformPort=3010` (Caddy) → direct `:3010`; exposes `isConnected`, latency, an 80-entry event log, and typed event handlers.
- **RBAC in UI**: `PAGE_MIN_ROLE` in `src/lib/navigation.ts` gates menu items and pages (UX only; the API is authoritative).

## 3. Backend (API / Server)

- Next.js App Router API routes under `src/app/api/**` (~150 route files), `output: "standalone"`.
- **Request pipeline** (`src/proxy.ts`, Next `proxy` export matching `/api/:path*`):
  1. Central **rate limiting** (in-memory sliding window, keyed by IP / agent-token / user-Bearer with IP fallback).
  2. **Authentication** (JWT from Bearer or cookie) with a public whitelist (`/api/auth/login`, `/api/health*`, `/api/agent/*` self-validating agent tokens, `/api/device-claims/[id]/cancel`).
  3. **CSRF origin check** (non-GET/HEAD/OPTIONS requests with an `Origin` header must match `Host`).
  4. **Role prefix rules** (`ROLE_RULES`): `/api/settings`, `/api/organization`, `/api/agent-registrations`, `/api/auth/users`, `/api/ai-provider`, `/api/import` → admin+; `/api/export`, `/api/audit-logs/export`, `/api/self`, `/api/consent` → manager+.
- **Route-level helpers** (`src/lib/api.ts`): `requireSessionOrg`, `requireManagerOrg`, `requireAdminOrg`, `requireSuperAdmin` — org identity always comes from the verified JWT; cross-org resources are concealed as 404, cross-org write references as 422.
- **Logging**: dependency-free structured single-line JSON logger with secret redaction (`src/lib/logger.ts`).

## 4. Database

- **PostgreSQL** (the only supported DB), Prisma 6 (`prisma-client-js`), 41 models, 22 migrations (2026-08-10 → 2026-08-17).
- No Prisma enums — all enumerations are `String` columns with documented values in schema comments.
- Key models: `Organization`, `Department`, `Employee`, `AgentAccount`, `Device`, `DeviceClaim`, `Guest`, `Activity`, `KeyboardActivity`, `LocationEvent`, `Screenshot`, `WebcamSession`, `AgentCommand`, `UsbEvent`, `PolicyViolation`, `Anomaly`, `ConsentPolicy`, `Consent`, `ConsentLog`, `Notification`, `NotificationPreference`, `Alert`, `AuditLog`, `Report`, `AiInsight`, `SentimentRecord`, `Project`, `ProjectMember`, `TimeEntry`, `ProjectTimeSync` (+ cursor), `BreakSession`, `AppUser`, `SystemSetting`, `OrganizationSetting`, `JobRun`, `AgentRegistration`, `AgentToken`, `AgentSession`, `AppListEntry`.
- Concurrency: `SELECT ... FOR UPDATE` on `Employee` during agent authenticate (single-active-device rule); atomic conditional `UPDATE` for consent transitions; `updateMany`-based leases for jobs; partial unique indexes for one-active-break and one-active-guest-per-device.

## 5. Authentication

Three independent auth domains (each validated by its own function; cross-use is impossible):

| Domain | Token | Purpose |
|---|---|---|
| Web/admin | JWT HS256 (Web Crypto), cookie `worklens_token` + Bearer | Admin console sessions; 7 d expiry (`JWT_EXPIRES_IN`) |
| Agent login | `AgentSession` — 64-char opaque random, 24 h | Authenticates discovery + logout only |
| Agent device | `AgentToken` — 64-char opaque random, 24 h, device-bound | Authenticates all telemetry endpoints |

Credentials: `AgentAccount` (bcrypt, admin-created), legacy `Employee.agentPassword` (bcrypt, auto-upgraded), one-time claim secrets (SHA-256 hashed), enrollment codes (SHA-256 hashed, org binding).

## 6. RBAC

- Roles: `super_admin` (50) > `owner` (40) > `admin` (30) > `manager` (20) > `viewer` (10). Unknown role → level 0 (denied).
- Enforcement: proxy role rules + route-level `require*Org` helpers + per-operation checks.
- Tenant isolation: `organizationId` always derived from the JWT; multi-org isolation is enforced in-route (tested by `tests/multi-org-isolation.test.ts`).

## 7. Desktop agent

Electron 33 app (`omnisight-agent/`, CommonJS + TS strict), three processes/areas:

- **Main process** (`src/main/main.ts`): tray (no Quit item), single-instance lock, lifecycle phases (unregistered → pending_approval → starting → running → paused → stopped → error), graceful shutdown coordinator, native messaging host mode (`--native-messaging-host`).
- **Preload/renderer**: sandboxed status window (8 views: onboard/login/pending/rejected/revoked/conflict/offline/status), bridge exposes only `getStatus/onStatus/onAuthRequired/login/joinAsGuest/cancelRegistration/retryConnect`.
- **Services**: orchestrator, heartbeat, consent refresh (60 s), config refresh (10 min), queue uploader (batch ≤ 100, at-least-once), screenshot spool (encrypted at rest), command poller, webcam controller, browser-activity monitor, website bridge (loopback TCP + token), native messaging host, update service (HTTPS feed, 4 h).
- **Collectors**: activity (10 s), screenshot (config minutes, ≥ 30 s), keyboard (30 s ticks → 1-min buckets), location (5 min), webcam (command-driven), website (event + 15 s tick), USB (15 s diff), policy enforcer (10 s sweep).
- **Native addon** (`native/`, N-API v8, C++17): `foregroundWindow`, `idleSeconds`, `captureWindow`, `keyboardStart/Stop/Reset/Snapshot`, `processList`, `processTerminate`, `usbList`, `locationGetPosition`, `cameraEnumerate/Open/Stop/Active/TakeFrame`. Missing addon → `available: false` and collectors **fail closed** (never fabricate).

## 8. Native modules

| Module | Location | Purpose |
|---|---|---|
| `worklens_capture.node` | `omnisight-agent/native/` (built to `native/build/Release/`) | N-API addon: window capture, keyboard counting, USB, location, camera, process APIs |
| `worklens-native-host.exe` | `omnisight-agent/native-host/` | Native messaging host (`com.worklensai.website`) relaying browser-extension domain events to the agent over loopback |
| Browser extension | `browser-extension/` | Manifest V3 "OmniSight Website Tracker" — tracks active tab domains only |

## 9. Telemetry pipeline

```
Collectors (agent, fail-closed gates: config AND consent AND capability)
   → AgentToken-authenticated POST /api/agent/* (server re-checks consent + config, 403 on failure)
   → Prisma writes (server-derived employee/device/org)
   → PostgreSQL
   → Admin read APIs (org-scoped) + realtime broadcast (domain-only for websites)
   → Analytics / AI / reports
```

Privacy invariants enforced at every layer: websites = bare domains only; keyboard = counts only; location = coordinates only; webcam = in-memory frames only; screenshots = validated images with retention.

## 10. AI pipeline

```
Admin configures provider (SystemSetting 'ai_*', key encrypted AES-256-GCM)
   → On-demand analysis (insights, sentiment, daily summary, screenshot vision)
   → buildInsightDataset (measured, aggregated, consent-gated, org-scoped)
   → callAIProvider (SSRF-guarded safeFetch, 30 s timeout, 10 MB cap)
   → strict schema validation (z.strictObject; evidence must match measured dataset)
   → persist with provenance (provider/model/mode)
   → provider unavailable → deterministic DATA_SUMMARY from the same dataset (honest label)
```

See [AI-GUIDE.md](./AI-GUIDE.md) for the complete AI architecture.

## 11. Realtime architecture

- `mini-services/live-updates`: raw HTTP server + Socket.IO, port `LIVE_UPDATES_PORT` (3010), CORS `ALLOWED_ORIGIN`. JWT HS256 handshake (same `JWT_SECRET`); sockets join `org:<id>` rooms; **all broadcasts are room-scoped**.
- Polling engine: 5 s interval, single `Date` cursor (raised after queries), 15 DB models, per-model `take` caps, transition-only emissions for status-like models via in-memory maps.
- Client: single shared socket → typed events → centralized React Query invalidation map (`src/lib/ws-invalidation.ts`) → pages refresh without polling.

## 12. Security boundaries

| Boundary | Mechanism |
|---|---|
| Network | Caddy reverse proxy (ports 3000/3010); security headers from `next.config.ts` (CSP, X-Frame-Options DENY, HSTS, nosniff, Permissions-Policy) |
| API | JWT auth + role rules + rate limiting + CSRF origin check + SSRF-guarded outbound fetches |
| Tenant | Org from verified JWT only; cross-org → 404/422 |
| Agent | Three-token separation; fail-closed device/employee/org checks |
| Secrets | AES-256-GCM at rest (`ENCRYPTION_KEY`); bcrypt passwords; SHA-256 hashed one-time secrets |
| Storage | `uploads/` outside web root; authenticated serving with `nosniff`; screenshot magic-byte validation |
| Data minimization | Domain-only URLs, aggregate-only keystrokes, in-memory-only webcam frames |

## 13. Deployment topology (verified/supported)

```
Caddy (included Caddyfile, :81) ──► :3000 Next.js (standalone build)
                              └──► :3010 live-updates (Socket.IO)
PostgreSQL                        uploads/ (screenshots)
```

See [DEPLOYMENT.md](./DEPLOYMENT.md).
