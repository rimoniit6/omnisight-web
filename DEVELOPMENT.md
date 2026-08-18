# OmniSight — Development

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

For contributors: repository layout, prerequisites, commands, codebase conventions, testing, and how to run each component.

Related docs: [ARCHITECTURE.md](./ARCHITECTURE.md) · [INSTALLATION.md](./INSTALLATION.md) · [API.md](./API.md)

---

## 1. Repository layout

```
├─ src/                        Next.js app (server + admin SPA)
│  ├─ app/                     App Router: page.tsx (SPA host), api/** (API routes)
│  ├─ components/              UI components (shadcn/ui + custom)
│  ├─ lib/                     auth, consent, policies, ai-insights, anomalies, jobs,
│  │                           notifications, screenshots/storage, webcam-relay,
│  │                           agent-process, domain, navigation, store, logger...
│  └─ proxy.ts                 Central middleware: rate limit + auth + CSRF + role rules
├─ prisma/                     schema.prisma (41 models) + migrations/ (22)
├─ scripts/                    copy-standalone.js, seed/dev bootstrap, production cleanup
├─ tests/                      ~60 integration test suites (tsx, throwaway Postgres)
├─ mini-services/live-updates/ Socket.IO realtime service (Bun or Node)
├─ omnisight-agent/              Electron agent (main/preload/renderer + services/collectors)
│  └─ native/                  worklens_capture.node source (C++17, N-API v8)
├─ native-host/                native messaging host (worklens-native-host.exe)
├─ browser-extension/          Manifest V3 "OmniSight Website Tracker"
├─ docs/                       docs/company-guide (staged for deletion), docs/audits
├─ Caddyfile                   reverse-proxy example (81 → 3000, XTransformPort → 3010)
├─ PRODUCTION.md               Phase 3 hardening / ops guide
└─ package.json                workspace root (scripts below)
```

## 2. Prerequisites

- Node.js ≥ 20 (22.5+ recommended — some scripts use `node:sqlite`), npm ≥ 10
- PostgreSQL 14+ (the only supported database)
- Windows + MSVC v143 + Windows SDK 10.0.26100 for the native addon / agent build
- Bun (optional) for `mini-services/live-updates`

## 3. Commands (npm scripts)

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server (`next dev`) — app only |
| `npm run dev:app` | App + live-updates concurrently (convenience) |
| `npm run dev:live` | Start realtime service (`mini-services/live-updates`) |
| `npm run build` | Production build (standalone output) |
| `npm run start` | Serve the standalone build |
| `npm run lint` | ESLint |
| `npm run jobs` | Run one-off background jobs (hourly batch) |
| `npm run bootstrap:super-admin` | Create the initial Super Admin |
| `npm run db:generate` / `db:deploy` / `db:migrate` / `db:push:dev` / `db:reset` / `db:seed:dev` / `db:production-clean` | Prisma workflows (guarded: `CONFIRM_DEV_RESET`, `CONFIRM_PRODUCTION_CLEANUP`, `SEED_ALLOWED`) |
| `npm run dev:agent` / `build:agent` / `package:agent` / `test:agent` | Desktop agent dev/build/package/test |
| `npm run test:*` | ~13 test suites (see §6) |

## 4. Conventions

- **TypeScript strict**; Zod for all API schemas (`z.strictObject` — unknown fields rejected).
- **API routes**: `src/app/api/<group>/<entity>/route.ts`, exporting `GET/POST/PUT/DELETE`; helpers from `src/lib/api.ts` (`requireSessionOrg`, `requireManagerOrg`, `requireAdminOrg`, `requireSuperAdmin`); 404 for cross-org, 422 for bad refs.
- **No Prisma enums** — `String` columns with documented values in the schema comments.
- **Fail-closed everywhere** for consent/config/capability gates.
- **Logging**: dependency-free JSON logger; never log secrets.
- **Frontend**: one `page.tsx` SPA; navigation via Zustand `currentPage` (28 `PageType`s); TanStack Query; realtime invalidation map in `src/lib/ws-invalidation.ts`.
- **Migrations**: additive; a custom migration script (requires Node 22.5+ `node:sqlite`) handles legacy SQLite → Postgres only for the old demo schema — not for production data.

## 5. Testing

```bash
# Integration suites (each spins up throwaway PostgreSQL test DBs via Prisma)
npm run test:auth        # auth, roles, sessions
npm run test:rbac        # role-based access control
npm run test:security    # security, multi-org isolation, rate limits, CSRF
npm run test:telemetry   # agent ingestion + consent gating
npm run test:consent     # consent policies & transitions
npm run test:anomaly     # anomaly rules
npm run test:notifications
npm run test:ai          # AI integration + security
npm run test:projects    # projects & time entries
npm run test:screenshots # screenshots + OCR search
npm run test:agent       # omnisight-agent unit tests (Jest)
```

Tests use throwaway PostgreSQL databases (e.g. `postgresql://...test-*`); they never touch your dev DB. If a suite fails to connect, set `DATABASE_URL` to a disposable Postgres with CREATE DATABASE privileges.

## 6. Codebase maps (where to look)

| Concern | Location |
|---|---|
| Auth (web) | `src/lib/auth.ts`, `src/lib/jwt.ts`, `src/proxy.ts` |
| Agent auth | `src/lib/agent-auth.ts` (`AgentSession`/`AgentToken`) |
| Consent | `src/lib/consent.ts`, `src/lib/policies/` |
| AI | `src/lib/ai-insights/` (providers, dataset, fallback), `src/lib/ai-provider/` |
| Anomalies | `src/lib/anomalies/` |
| Jobs | `src/lib/jobs/` (expire_consents, retention_cleanup, project_time_sync, anomaly_detection) |
| Notifications | `src/lib/notifications/` (registry, producers) |
| Screenshots | `src/lib/screenshots/storage.ts` (magic-byte validation, disk layout) |
| Webcam relay | `src/lib/webcam-relay.ts` (in-memory, TTL 60 s) |
| Realtime | `mini-services/live-updates/` (socket server, polling engine, ws-invalidation map) |
| Desktop agent | `omnisight-agent/src/` (main, services/, collectors/) + `native/` |
| Roles | `src/lib/roles.ts` + `ROLE_RULES` in `src/proxy.ts` |

## 7. Dev workflows

1. **App**: `.env` (copy `.env.example`) → Postgres up → `npm run db:generate` → `npm run db:migrate` → `npm run bootstrap:super-admin` → `npm run dev`.
2. **Realtime**: `npm run dev:live` (needs `JWT_SECRET`, `DATABASE_URL`, `ALLOWED_ORIGIN`, `LIVE_UPDATES_PORT`).
3. **Agent**: `npm run dev:agent` (Windows; native addon prebuilt or run `native/build.ps1`), configure `OMNISIGHT_SERVER_URL`.
4. **Browser extension**: load `browser-extension/` unpacked in Chrome/Edge (Manifest V3), register `native-host/` host manifest, enable `website_native_tracking_enabled`.

## 8. Contribution checklist

- [ ] `npm run lint` passes
- [ ] Relevant `test:*` suites pass against a throwaway Postgres
- [ ] No secrets committed; `.env*` in `.gitignore` (except examples)
- [ ] Schema changes get a migration (`npm run db:migrate -- --name <name>`); keep them additive
- [ ] New API routes follow the auth/role/validation conventions above
- [ ] New UI pages register in `src/lib/navigation.ts` (`PAGE_MIN_ROLE`) and the store's `PageType`
