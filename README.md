# OmniSight

> Previously branded as **WorkLensAI** — technical identifiers from that era (cookie names, environment variables, native module names) are intentionally preserved for compatibility.

**OmniSight** is a self-hosted AI workforce intelligence and employee monitoring platform. It combines a web-based **Admin Console** (Next.js) with a **Windows Desktop Agent** (Electron + native N-API addon) that reports activity, website use, screenshots, keyboard statistics, location, and webcam sessions to a PostgreSQL-backed server — all gated by an explicit employee **consent** system and organization-scoped **RBAC**.

This README describes the product **as implemented in this repository**. Anything not present in the code is listed as *planned* or *not available* — never claimed as shipped.

---

## Key capabilities

| Area | What exists |
|---|---|
| **Admin console** | Single-page web app: Dashboard, Employees, Departments, Devices, Activities, Screenshots, Break Monitor, Live Monitor, Analytics, AI Insights, Sentiment, AI Provider, Agent Approvals, Guests, Notifications, Alerts, Audit Logs, Policies, Anomaly Detection, Consent, Projects, Reports, Daily Report, Settings, Organization, Employee Portal |
| **Desktop agent** | Windows-only Electron agent (`omnisight-agent` v1.1.0) with a native C++ N-API addon (`worklens_capture.node`) |
| **Activity monitoring** | Application + website activity (bare domains only), idle detection, work-session tracking; auto-attributed to projects |
| **Screenshot monitoring** | Periodic PNG/JPEG/WebP captures, server-side storage, OCR text search, AI vision analysis, flagging |
| **Keyboard telemetry** | Aggregate-only statistics (keystroke counts per interval) — raw keys are never captured by design |
| **Location / webcam** | Location fixes (coordinates only, no addresses); on-demand webcam sessions relayed live, frames never persisted |
| **Telemetry** | USB events, policy violations, break/privacy mode, agent heartbeat/presence |
| **AI insights** | 6 AI providers (OpenAI, Anthropic, Google, Mistral, Ollama, custom), BYOK keys encrypted at rest, deterministic data-summary fallback when AI is unavailable |
| **Consent & privacy** | 8 consent types, versioned consent policies, break (privacy) mode, per-org monitoring configuration, data retention jobs |
| **Authentication & security** | JWT (HS256) + httpOnly cookie, role hierarchy, agent token triple (AgentSession / AgentToken / claim secrets), rate limiting, SSRF protection, AES-256-GCM secret encryption |
| **Realtime** | Socket.IO live-updates mini-service with org-scoped rooms, live monitor, presence, live activity ticker |

## Feature status at a glance

See [FEATURES.md](./FEATURES.md) for the complete matrix. Highlights:

- **Implemented & verified** (by tests in `tests/` and certification reports in `docs/audits/`): authentication, RBAC, multi-org isolation, employees, devices, zero-touch enrollment, guests, activity/website/screenshot/keyboard/location telemetry, webcam relay, break mode, consent + policies, AI insights with honest fallback, sentiment, anomalies, notifications, alerts, audit logs, reports + PDF exports, projects + auto project-time sync, realtime live updates, retention jobs, import/export.
- **Partially implemented**: website tracking via browser extension (`websiteNativeTracking` is best-effort), agent anomaly/tamper reporting (dormant client wiring), agent auto-update (feed mechanism exists; disabled until `WL_UPDATE_URL` is configured), several notification types (only 4 have active producers).
- **Planned / not available**: employee self-service login (the "Employee Portal" is a *manager* view of an employee's data), Teams model (Departments stand in), task/todo tracking, billing, non-Windows agents, 2FA, scheduled (automatic) AI analysis, email/SMS/push notification channels.

## Architecture overview

```
Admin Console (Next.js SPA, :3000)
      │  JWT (httpOnly cookie "worklens_token")
      ▼
API / Server (Next.js App Router /api/*)
      │                        │
      ├── PostgreSQL (Prisma 6, 41 models, 22 migrations)
      ├── AI Providers (BYOK — OpenAI, Anthropic, Google, Mistral, Ollama, custom)
      ├── Realtime mini-service (Socket.IO, :3010, org-scoped rooms)
      ├── Background jobs (consent expiry, retention, project-time sync, anomaly detection)
      └── File storage (uploads/screenshots)
              │
              ▼
      Windows Desktop Agent (Electron)
          ├── Activity Collector        ├── Screenshot Collector
          ├── Keyboard Collector        ├── Location Collector
          ├── Webcam Collector          ├── Website Collector (+ browser extension)
          ├── USB Collector             ├── Policy Enforcer
          └── Native addon (worklens_capture.node, N-API)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router, `output: "standalone"`), React 19, TypeScript 5, Tailwind CSS 4, shadcn/ui (Radix), Zustand, TanStack Query, Recharts, socket.io-client, framer-motion |
| Backend | Next.js API routes, custom JWT (HS256, Web Crypto), bcryptjs (cost 12), Zod |
| Database | PostgreSQL (only supported DB) via Prisma 6 (41 models, 22 migrations) |
| Realtime | `mini-services/live-updates` — Socket.IO server run with Bun, port 3010, cursor-based DB polling |
| Desktop agent | Electron 33, TypeScript, N-API C++ addon (`node-gyp`, MSVC v143, Windows SDK 10.0.26100), electron-builder (NSIS), native messaging host for the browser extension |
| AI | Provider APIs (OpenAI-compatible, Anthropic Messages, Google Gemini, Ollama) called via an SSRF-guarded fetch helper |
| Reverse proxy (included) | Caddyfile (ports 3000/3010) |

## Repository structure

```
├── src/                  # Next.js app (app router + components + lib)
│   ├── app/api/          # ~150 API route files (auth, agent, admin, telemetry…)
│   ├── components/       # UI pages and shadcn/ui components
│   └── lib/              # Domain logic: auth, consent, policies, ai-insights, jobs…
├── omnisight-agent/        # Windows Electron agent (own package.json)
│   ├── native/           # N-API C++ addon (activity, keyboard, location, webcam…)
│   ├── native-host/      # Native messaging host launcher (browser extension bridge)
│   └── scripts/          # build-prod, native host build, e2e…
├── mini-services/
│   └── live-updates/     # Socket.IO realtime service (Bun)
├── browser-extension/    # Manifest V3 website domain tracker (Chrome/Edge/Firefox)
├── prisma/               # schema.prisma + 22 migrations
├── scripts/              # dev, db, verification, certification tooling
├── tests/                # ~60 Node test suites (tsx --test)
├── uploads/              # runtime storage (screenshots/) — gitignored
└── docs/                 # architecture docs, audit trail, certifications
```

## Requirements

- **Node.js** — 22.5+ recommended (the SQLite→PostgreSQL migration script uses `node:sqlite`; no `engines` field is declared)
- **Package managers** — `npm` (primary, lockfile committed) and `bun` (used for the live-updates mini-service and `dev:live`)
- **Database** — PostgreSQL (SQLite is *not* supported in production; `db/*.db` files are legacy dev artifacts)
- **Windows** — for the desktop agent: Windows 10/11 x64; building the native addon requires MSVC v143 (Visual Studio Build Tools) and Windows SDK 10.0.26100; runtime uses DPAPI, WinRT geolocation, Media Foundation
- **Git** — to clone the repository

## Quick installation

```bash
# 1. Clone
git clone <your-repository-url> OmniSight
cd OmniSight

# 2. Install dependencies (root + live-updates service)
npm install
(cd mini-services/live-updates && npm install)

# 3. Configure environment
cp .env.example .env
# edit .env: DATABASE_URL, JWT_SECRET, SUPER_ADMIN_EMAIL/PASSWORD, ENCRYPTION_KEY

# 4. Create the database schema and bootstrap the Super Admin
npx prisma migrate deploy
npx prisma generate
npm run bootstrap:super-admin

# 5. Start development servers (Next.js :3000 + live-updates :3010)
npm run dev
```

Full details, including every environment variable, the desktop agent build, and production deployment: [INSTALLATION.md](./INSTALLATION.md).

## Basic usage

1. Log in at `http://localhost:3000` with the Super Admin account.
2. On first login (org-less Super Admin) the app prompts you to **create the organization**.
3. Open **Settings → Users** to create admin/manager/viewer accounts, or **Organization** to configure monitoring (heartbeat, screenshots, website tracking…).
4. Open **Consent** to publish consent policies, then grant each employee's consents (or let the agent request them).
5. Add employees (**Employees**), then install the **OmniSight Agent** on Windows machines. The agent can be:
   - **Zero-touch**: build the installer using the CLI (`AGENT_SERVER_URL=... node omnisight-agent/scripts/build-prod.mjs`) with the server URL baked in; agents discover the server and request device approval (**Agent Approvals**), or
   - **Enrollment code**: generate one in **Organization**, bake it into the installer, or set `WL_ENROLLMENT_CODE` on the machine.
6. Approve devices in **Agent Approvals** (employee or guest mode).
7. Monitor activity in **Dashboard / Live Monitor**, review **Screenshots**, and run **AI Insights / Sentiment** after configuring an AI provider in **AI Provider**.

Step-by-step walkthroughs for every workflow: [USAGE.md](./USAGE.md).

## Documentation

| Document | Audience | Contents |
|---|---|---|
| [FEATURES.md](./FEATURES.md) | Everyone | Complete feature inventory with status, roles, APIs, models, limitations |
| [INSTALLATION.md](./INSTALLATION.md) | Sysadmins | Fresh-machine install, all environment variables, DB setup, agent build |
| [USAGE.md](./USAGE.md) | Admins/end users | Step-by-step workflows for the whole product |
| [ADMIN-GUIDE.md](./ADMIN-GUIDE.md) | Administrators | Full administrator manual |
| [COMPANY-GUIDE.md](./COMPANY-GUIDE.md) | Company operators | End-to-end company adoption and operations guide |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Developers | System architecture, components, data flow |
| [API.md](./API.md) | Developers | Complete API reference (auth, roles, request/response) |
| [SECURITY.md](./SECURITY.md) | Admins/developers | Security mechanisms and known limitations |
| [PRIVACY.md](./PRIVACY.md) | Admins/employees | What data is collected, consent model, retention |
| [omnisight-agent.md](./omnisight-agent.md) | Admins/developers | Windows agent: collectors, native addon, packaging |
| [AI-GUIDE.md](./AI-GUIDE.md) | Admins | AI providers, BYOK, fallback behavior, privacy |
| [EMPLOYEE-GUIDE.md](./EMPLOYEE-GUIDE.md) | Employees | What the agent captures and how consent works |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Everyone | Common failures, diagnosis, fixes |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Developers | Local dev workflow, testing, database changes, agent dev |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Sysadmins | Production architecture, verified vs recommended |
| [DOCUMENTATION-AUDIT.md](./DOCUMENTATION-AUDIT.md) | Everyone | Documentation status, repository facts, verification |

## Security notes

- Sessions are JWT (HS256) in an **httpOnly, SameSite=Lax** cookie (`worklens_token`); no token in `localStorage`.
- Roles: `super_admin` > `owner` > `admin` > `manager` > `viewer`; enforced at the API layer (`src/proxy.ts` + per-route helpers), with 404-concealment for cross-organization resources.
- Agent credentials are separated: device-bound `AgentToken` (24 h), login-only `AgentSession` (24 h), one-time claim secrets (SHA-256 hashed). Single-active-device-per-employee is enforced with a DB row lock.
- AI provider keys and other secrets are encrypted at rest (AES-256-GCM) with `ENCRYPTION_KEY`; JWT and encryption keys are independent.
- Outbound AI calls are SSRF-guarded; rate limiting is applied centrally and per-route.
- Security headers (CSP, X-Frame-Options, HSTS, Permissions-Policy) are set by `next.config.ts`.

See [SECURITY.md](./SECURITY.md) — including **known limitations**.

## Known limitations

- **Windows-only agent**; no macOS/Linux agents.
- **Raw keystroke content, clipboard, webcam frames and full URLs are never captured** (by design; enforced server-side and agent-side).
- AI analysis is **on-demand only** (manual runs); there is no scheduled AI pipeline.
- Employee-facing **self-service login does not exist**; the Employee Portal page is a manager/admin view of one employee's data.
- Realtime mini-service runs as a single instance; Caddy proxies only literal `:3010`.
- In-memory rate limiting is per-process (multi-instance deployments need a shared store).
- Notification channels are in-app only (no email/SMS/push).
- The browser-extension website tracker is a best-effort extra source; the agent's own website collector works without it.

## Project status

Active development. Current version: `0.2.1` (package.json). The repository includes 22 database migrations, ~60 test suites in `tests/`, and a certification trail in `docs/audits/` (the latest sections are certified *production-ready*; earlier audits document issues that were subsequently fixed). PostgreSQL is the only supported database for production use.# OmniSight_live
# omnisight-web
