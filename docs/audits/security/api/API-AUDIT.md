# WorkLensAI API Audit Report

**Date:** 2026-08-07 | **Scope:** All 108 API route handlers under `src/app/api` + shared libs | **Mode:** Read-only

## API Score: 16/100 — CRITICAL

| Category | Verdict |
|---|---|
| Authentication coverage | 87 / 108 routes have **no auth at all** (80.6%) |
| RBAC | Only 2 route files use role checks (`auth/users`, `auth/users/[id]`) |
| Input validation | No schema lib (no zod); manual/absent in ~95% of routes |
| Pagination | Present in ~5 routes; unbounded queries elsewhere |
| Rate limiting | **None anywhere** (login, register, agent auth, OCR, AI calls) |
| Response consistency | `{data}`, `{employees}`, `{user}`, raw arrays, `{success}` mixed arbitrarily |

---

## CRITICAL Findings

### C1. 87 of 108 API routes are completely unauthenticated
The entire monitoring platform (employees, devices, screenshots, activities, projects, reports, analytics, alerts, anomalies, audit logs, consent, sentiment, insights, departments, settings, search, notifications, agent-registrations, `self/*`, dashboard, break-status, organization) is publicly reachable. Example: `src/app/api/employees/route.ts:5` — `export async function GET()` with zero token checks.

**Impact:** Full data breach of all PII + monitoring data; mass tampering; system-wide destruction. An unauthenticated attacker can list every employee, read every screenshot, every activity, every audit log, delete records, and change system settings.

**Fix:** Add `middleware.ts` (Next 16) or wrap every handler with `withAuth`/`withAuthAndRole` from `src/lib/api.ts`. No exceptions.

### C2. Unauthenticated endpoint leaks plaintext agent passwords → full agent takeover chain
- `src/app/api/employees/[id]/route.ts:11-20` — `db.employee.findUnique({ where: { id }, include: {...} })` with **no `select` filter** returns the full record, including `agentPassword` (plaintext field, `prisma/schema.prisma:88`).
- `src/app/api/agent/authenticate/route.ts:28` — compares `employee.agentPassword !== password` in **plaintext** and issues a 24h bearer token (line 110-112).

**Attack chain (zero auth required):** `GET /api/employees` → pick any id → `GET /api/employees/[id]` → read `agentPassword` → `POST /api/agent/authenticate` → bearer token → full screen-capture/activity exfiltration via `POST /api/agent/screenshot` (no rate limit, agent routes otherwise check `validateAgentToken`).

**Fix:** `select` whitelist on every employee read; never return `agentPassword`; hash agent passwords with bcrypt (`hashPassword` already exists in `src/lib/auth.ts:159`).

### C3. `auth/me` — missing `await` on async `verifyJWT`
`src/app/api/auth/me/route.ts:13` — `const payload = verifyJWT(token);` (async, not awaited). `payload` is a `Promise<JWTPayload|null>`, so `payload.userId` is `undefined` → user lookup fails → 401 for all valid sessions (or incorrect fallback to first org). Inconsistent with every other route that uses `await verifyJWT(...)`.

**Fix:** `const payload = await verifyJWT(token);`

### C4. Shared auth middleware is dead code; no `middleware.ts` exists
- `src/lib/api.ts` defines `authenticateRequest`, `withAuth`, `withAuthAndRole`, `getPagination` — grep shows **zero imports** from `@/lib/api` across `src/app/api` (no files found).
- No `src/middleware.ts` (Next.js middleware) exists.

Every route re-implements (or skips) auth manually, yielding the 80% unauthenticated surface. The helpers exist and work; they are simply never used.

### C5. Hardcoded default super-admin credentials
`src/lib/auth.ts:193-197` — `getSuperAdminCredentials()` falls back to `admin@worklens.ai` / **`Admin@2025`** when `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD` env vars are unset. If deployment omits env config, a known credential pair is active.

---

## HIGH Findings

| # | Finding | Evidence |
|---|---|---|
| H1 | **IDOR on `self/*`** — 6 routes take `employeeId` from query/body with no session binding and no auth. Any caller reads/mutates any employee's dashboard, activities, anomalies, consents, devices. | `src/app/api/self/dashboard/route.ts`, `self/activities/route.ts`, `self/anomalies/route.ts`, `self/consents/route.ts`, `self/consents/[id]/route.ts`, `self/devices/route.ts` |
| H2 | **SSRF + API-key exfiltration** — `ai-provider/test-connection` is unauthenticated, accepts client-supplied `apiKey`/`baseUrl`, and the server fetches `baseUrl` (line ~30). Point baseUrl at an attacker server to capture the key; or probe internal network. | `src/app/api/ai-provider/test-connection/route.ts` |
| H3 | **Arbitrary settings mutation** — unauthenticated `PUT /api/settings` upserts any key/value; can pivot to AI provider config, agent policy, etc. | `src/app/api/settings/route.ts` |
| H4 | **Mass PII export** — `reports/pdf/*` (5 files), `reports/[id]/export`, `[id]/csv`, `[id]/pdf`, `reports/generate`, `reports/daily`, `daily/ai-summary`, `audit-logs/export`, `employees/export` all unauthenticated and emit full-org data (200-row caps only). | e.g. `src/app/api/reports/pdf/employee/route.ts:19-47` |
| H5 | **`export/[type]` authenticated but no RBAC** — any logged-in user (even `viewer`) downloads every employee/activity/time-entry row. | `src/app/api/export/[type]/route.ts:304-319` (auth OK), no role check |
| H6 | **Screenshot exfiltration + AI-cost abuse** — all 6 screenshot routes unauthenticated; `[id]/analyze` and `batch-analyze` fire AI provider calls per request (billing abuse). | `src/app/api/screenshots/[id]/analyze/route.ts`, `screenshots/batch-analyze/route.ts` |
| H7 | **Avatar upload: IDOR + path traversal** — any authenticated user can overwrite any employee/user avatar (`type`+`id` from query, no ownership check); `id` is interpolated into the filename (`${id}.png`) and `path.join`-ed → `../` in `id` writes a PNG outside `public/uploads/avatars` (write happens at line 74 *before* the failing DB update, so the file persists). | `src/app/api/upload/avatar/route.ts:27-28,72-74` |
| H8 | **Plaintext agent passwords + no rate limit on public auth endpoints** — `agent/authenticate` and `agent/register` are public and compare plaintext → online brute-force; also `auth/login` (see M3). | `agent/authenticate/route.ts:28`, `agent/register/route.ts` |
| H9 | **GET with state mutation** — `GET /api/notifications?markAllRead=true` mutates DB (HTTP semantics violation, cache pollution, CSRF-able). | `src/app/api/notifications/route.ts` |

---

## MEDIUM Findings

| # | Finding | Evidence |
|---|---|---|
| M1 | **Single-org assumption** — `db.organization.findFirst()` in 30+ routes; zero org isolation; if a second org is ever created, all data bleeds. | e.g. `departments/route.ts:27`, `import/[type]/route.ts:409`, `reports/pdf/dashboard/route.ts:16` |
| M2 | **In-memory user scan at login** — fetches all users then filters in JS for case-insensitive match; O(n) per login, no rate limit, timing oracle. | `src/app/api/auth/login/route.ts` |
| M3 | **No rate limiting anywhere** — login, agent register/authenticate, OCR search, AI analysis, sentiment analyze all callable in unbounded loops. | global |
| M4 | **No input validation library** — zero `zod`/`yup` in routes; many PUTs write body fields directly (unknown fields → Prisma 500s); enums often unvalidated (e.g. `reports/generate` accepts any `type`; `alerts` PUT accepts arbitrary `status`/`severity`). | `reports/generate/route.ts`, `alerts/route.ts` |
| M5 | **Raw SQL** — `db.$queryRawUnsafe` in OCR search; parameterized (escaped `%`/`_`) so low injection risk, but raw SQL with user input in a monitoring app warrants review. | `src/app/api/screenshots/ocr-search/route.ts` |
| M6 | **Heavy compute on GET** — `insights/ai-analysis` and `anomalies/detect` run full-org aggregation (N+1 aggregates over all employees/devices) on unauthenticated GET; trivial DoS. | `insights/ai-analysis/route.ts:14`, `anomalies/detect/route.ts` |
| M7 | **Agent token hygiene** — `lastUsedAt` updated on every authenticated agent request (write amplification); `generateToken` uses modulo-biased mapping with `Math.random()` fallback (not CSPRNG). | `src/lib/agent/auth.ts:59-62,82-93` |
| M8 | **Stray directive** — `'server';` (not `'use server'`) in audit-logs route; harmless but signals copy-paste drift. | `src/app/api/audit-logs/route.ts:1` |
| M9 | **Type hack on Prisma where** — `employeeId` assigned `{ in: [...] }` cast `as unknown as string`; works, but would break schema changes silently. | `src/app/api/reports/pdf/activity/route.ts:41-43` |
| M10 | **JWT lacks revocation/rotation** — logout is client-side only (`auth/logout` returns success without server-side invalidation); token survives until 7d expiry. | `src/app/api/auth/logout/route.ts` |
| M11 | **Unbounded reads** — `export/[type]` fetches **all** activities/time-entries into memory then filters in JS; `sentiment/summary`, `insights/ai-analysis`, `departments/performance` also load entire tables. | `export/[type]/route.ts:138-144`, `sentiment/summary/route.ts:7-22` |
| M12 | **Inconsistent error/response shapes** — `{error}`, `{message}`, `{data}`, `{employees}`, `{user}`, raw arrays, `{success:true}` all coexist; 404s sometimes empty arrays, sometimes error objects. | global |

---

## LOW Findings

| # | Finding |
|---|---|
| L1 | Missing audit logs on most mutating routes (only auth/users, import, upload, agent auth log). |
| L2 | Root route returns `"Hello, world!"` (trivial info/version probe surface). |
| L3 | `employees/import` CSV parser splits on raw commas — quoted CSV fields break imports (correctness). |
| L4 | Filename in `Content-Disposition` derived from user data (`reports/pdf/project/route.ts:100`) — header-injection surface if project names contain quotes (low, NextResponse escapes). |
| L5 | `hasRolePermission` hierarchy is string-typed and open to typos (`hierarchy[role] || 0` silently grants nothing — safe direction, but no strict typing). |

---

## What IS protected (the 21 auth'd/agent files)

- **JWT (9):** `auth/me` *(broken await — C3)*, `auth/refresh-token`, `auth/logout`, `auth/change-password`, `auth/users`, `auth/users/[id]` *(RBAC: admin/super_admin — the only RBAC in the app)*, `export/[type]` *(no RBAC)*, `import/[type]` *(no RBAC)*, `upload/avatar` *(IDOR/traversal — H7)*
- **Agent token via `validateAgentToken` (6):** `agent/heartbeat`, `agent/screenshot`, `agent/activity`, `agent/config`, `agent/break`, `agent/tamper`
- **Agent token hand-rolled (2):** `agent/consent`, `agent/anomaly` — bypass `agentApproved`/`status` checks (`validateAgentToken` enforces them; these do not)
- **Public by design (4):** `auth/login`, `agent/register`, `agent/authenticate`, root route

---

## Full Route Table (108)

`A` = auth, `R` = RBAC, `V` = validation, `P` = pagination. `Y`/`N`/`Part`/`AG` (agent-token).

| Route | A | R | V | P |
|---|---|---|---|---|
| `GET /api` (root) | N | N | N | N |
| **activities** | | | | |
| `GET/POST /api/activities` | N | N | N | N |
| `GET /api/activities/daily` | N | N | N | N |
| **agent** | | | | |
| `POST /api/agent/authenticate` | public | N | Part | N |
| `POST /api/agent/register` | public | N | Part | N |
| `POST /api/agent/heartbeat` | AG | N | Part | N |
| `POST /api/agent/screenshot` | AG | N | Part | N |
| `POST /api/agent/activity` | AG | N | Part | N |
| `GET /api/agent/config` | AG | N | N | N |
| `POST /api/agent/break` | AG | N | Part | N |
| `POST /api/agent/tamper` | AG | N | Part | N |
| `POST /api/agent/consent` | AG* | N | Part | N |
| `POST /api/agent/anomaly` | AG* | N | Part | N |
| **agent-registrations** | | | | |
| `GET/POST /api/agent-registrations` | N | N | Part | N |
| `POST /api/agent-registrations/[id]/approve` | N | N | N | N |
| `POST /api/agent-registrations/[id]/reject` | N | N | N | N |
| **ai-provider** | | | | |
| `POST /api/ai-provider/test-connection` | N | N | N | N |
| **alerts** | | | | |
| `GET/POST /api/alerts` | N | N | N | N |
| **analytics** | | | | |
| `GET /api/analytics` | N | N | N | N |
| `GET /api/analytics/compare` | N | N | N | N |
| **anomalies** | | | | |
| `GET/POST /api/anomalies` | N | N | N | N |
| `GET/PUT/DELETE /api/anomalies/[id]` | N | N | N | N |
| `POST /api/anomalies/batch` | N | N | N | N |
| `POST /api/anomalies/detect` | N | N | N | N |
| **app-list** | | | | |
| `GET /api/app-list` | N | N | N | N |
| **audit-logs** | | | | |
| `GET /api/audit-logs` | N | N | N | N |
| `GET /api/audit-logs/export` | N | N | N | N |
| **auth** | | | | |
| `POST /api/auth/login` | public | N | Part | N |
| `GET /api/auth/me` | Y (broken) | N | N | N |
| `POST /api/auth/refresh-token` | Y | N | N | N |
| `POST /api/auth/logout` | Y | N | N | N |
| `POST /api/auth/change-password` | Y | N | Part | N |
| `GET/POST /api/auth/users` | Y | Y | Part | N |
| `GET/PUT/DELETE /api/auth/users/[id]` | Y | Y | Part | N |
| **break-status** | | | | |
| `GET /api/break-status` | N | N | N | N |
| `GET /api/break-status/summary` | N | N | N | N |
| `POST /api/break-status/[id]/toggle` | N | N | N | N |
| **consent** | | | | |
| `GET/POST /api/consent` | N | N | N | N |
| `PUT/DELETE /api/consent/[id]` | N | N | N | N |
| `POST /api/consent/bulk` | N | N | N | N |
| `GET /api/consent/logs` | N | N | N | N |
| `GET /api/consent/summary` | N | N | N | N |
| **dashboard** | | | | |
| `GET /api/dashboard` | N | N | N | N |
| **departments** | | | | |
| `GET/POST /api/departments` | N | N | Part | N |
| `GET/PUT/DELETE /api/departments/[id]` | N | N | N | N |
| `GET /api/departments/performance` | N | N | N | N |
| **devices** | | | | |
| `GET/POST /api/devices` | N | N | Part | Y |
| `GET/PUT/DELETE /api/devices/[id]` | N | N | N | N |
| `GET /api/devices/summary` | N | N | N | N |
| `GET /api/devices/chart-data` | N | N | N | N |
| **employees** | | | | |
| `GET/POST /api/employees` | N | N | Part | Y |
| `GET/PUT/DELETE /api/employees/[id]` | N | N | N | N |
| `GET /api/employees/[id]/detail` | N | N | N | N |
| `GET /api/employees/[id]/performance` | N | N | N | N |
| `GET /api/employees/list` | N | N | Part | Y |
| `GET /api/employees/statistics` | N | N | N | N |
| `POST /api/employees/bulk` | N | N | Part | N |
| `GET /api/employees/export` | N | N | N | N |
| `POST /api/employees/import` | N | N | Part | N |
| **export** | | | | |
| `GET /api/export/[type]` | Y | N | Y | N |
| **import** | | | | |
| `POST /api/import/[type]` | Y | N | Y | N |
| **insights** | | | | |
| `GET/POST/PUT /api/insights` | N | N | Part | N |
| `GET/PUT /api/insights/[id]` | N | N | Y | N |
| `GET /api/insights/ai-analysis` | N | N | N | N |
| **notifications** | | | | |
| `GET/PUT /api/notifications` | N | N | N | N |
| `GET /api/notifications/count` | N | N | N | N |
| `POST /api/notifications/batch` | N | N | N | N |
| `GET /api/notifications/types` | N | N | N | N |
| **organization** | | | | |
| `GET/PUT /api/organization` | N | N | N | N |
| `GET /api/organization/team-data` | N | N | N | N |
| **projects** | | | | |
| `GET/POST /api/projects` | N | N | Part | N |
| `GET/PUT/DELETE /api/projects/[id]` | N | N | Part | N |
| `GET/POST /api/projects/[id]/members` | N | N | N | N |
| `PUT/DELETE /api/projects/[id]/members/[memberId]` | N | N | N | N |
| `GET/POST /api/projects/[id]/time-entries` | N | N | N | N |
| `GET /api/projects/stats` | N | N | N | N |
| **reports** | | | | |
| `GET/POST /api/reports` | N | N | Part | N |
| `POST /api/reports/generate` | N | N | N | N |
| `GET /api/reports/daily` | N | N | N | N |
| `GET /api/reports/daily/ai-summary` | N | N | N | N |
| `GET /api/reports/[id]/export` | N | N | N | N |
| `GET /api/reports/[id]/csv` | N | N | N | N |
| `GET /api/reports/[id]/pdf` | N | N | N | N |
| `POST /api/reports/pdf/project` | N | N | Part | N |
| `POST /api/reports/pdf/employee` | N | N | Part | N |
| `POST /api/reports/pdf/dashboard` | N | N | Part | N |
| `POST /api/reports/pdf/activity` | N | N | Part | N |
| `POST /api/reports/pdf/audit` | N | N | Part | N |
| **screenshots** | | | | |
| `GET/POST /api/screenshots` | N | N | Part | Y |
| `GET/DELETE /api/screenshots/[id]` | N | N | N | N |
| `GET /api/screenshots/stats` | N | N | N | N |
| `GET /api/screenshots/ocr-search` | N | N | N | N |
| `POST /api/screenshots/[id]/analyze` | N | N | N | N |
| `POST /api/screenshots/batch-analyze` | N | N | N | N |
| **search** | | | | |
| `GET /api/search` | N | N | N | N |
| **self** | | | | |
| `GET /api/self/dashboard` | N | N | N | N |
| `GET /api/self/activities` | N | N | N | Y |
| `GET /api/self/anomalies` | N | N | N | N |
| `GET /api/self/devices` | N | N | N | N |
| `GET/POST /api/self/consents` | N | N | Part | N |
| `PUT /api/self/consents/[id]` | N | N | Part | N |
| **sentiment** | | | | |
| `GET /api/sentiment` | N | N | Part | Y |
| `GET/DELETE /api/sentiment/[id]` | N | N | N | N |
| `POST /api/sentiment/analyze` | N | N | Part | N |
| `GET /api/sentiment/summary` | N | N | N | N |
| **settings** | | | | |
| `GET/PUT /api/settings` | N | N | N | N |
| **upload** | | | | |
| `POST /api/upload/avatar` | Y | N | Y | N |
| **usb-events** | | | | |
| `GET/POST /api/usb-events` | N | N | N | N |

Totals: **Auth: 21/108** (9 JWT + 6 agent + 2 hand-rolled agent + 4 public) | **RBAC: 2/108** | **Rate limiting: 0/108**

---

## Recommended Remediation Order

1. **Stop the bleeding (P0):** add `middleware.ts` enforcing JWT auth on everything except `auth/login`, `agent/register`, `agent/authenticate`, `agent/*` (agent-token); add `select` whitelist to `employees/[id]` (C2); fix `auth/me` await (C3).
2. **P0:** enforce RBAC on export/import/avatar/reports; fix avatar IDOR+traversal (H7); remove client-supplied `baseUrl` from `ai-provider/test-connection` (H2).
3. **P1:** rate-limit login/register/agent-auth; hash `agentPassword` (bcrypt) + migrate existing; replace hand-rolled agent checks with `validateAgentToken`.
4. **P1:** add zod schemas to all mutating routes; enforce org scoping via `auth.organizationId` (drop `findFirst()` pattern).
5. **P2:** standardize response envelope (`{ data, meta }`), unify error shape, add pagination, add audit logging, move compute off GET.
