# Database & Prisma Audit — WorkLensAI

**Date:** 2026-08-07
**Scope:** `prisma/schema.prisma` (570 lines, 25 models), `src/lib/db.ts`, `src/lib/seed.ts`, all `src/app/api/**/route.ts` files, client components.
**Mode:** Read-only. No code was modified.

---

## Scores

| Area | Score | Rationale |
|---|---|---|
| **Database Score** | **32 / 100** | Zero indexes on any FK or time-filter column; no cascades; string-typed enums; JSON-as-string columns; redundant unique index; missing uniqueness on email/department-name. Model shape itself is reasonable and CUID-keyed. |
| **Prisma Score** | **45 / 100** | Correct singleton + `Promise.all` in several routes, but zero `$transaction` usage, N+1 loops, multiple unbounded full-table fetches, mock/randomized data persisted by production endpoints, weak token generation. |

---

## Findings

### CRITICAL

#### C1. No indexes anywhere in the schema
**Files:** `prisma/schema.prisma` (entire file, lines 1–570)
**Problem:** There is not a single `@@index` in the schema. Only `@unique`/`@@unique` exist (`Organization.slug` :18, `Employee.employeeId` :76, `AppUser.email` :286, `SystemSetting.key` :305, `AgentToken.token` :340, `ProjectMember [projectId, employeeId]` :524).
**Root cause:** Schema was designed without query-pattern awareness.
**Impact:** Every time-range query on `Activity` (the hottest table — the agent writes per-app/per-site rows and every dashboard/analytics/anomaly route filters by `employeeId + timestamp`) is a full table scan. Seed data alone produces ~30 days × 5–12 activities/day × 48 employees (thousands of rows). Performance degrades linearly; `anomalies/detect` and `insights/ai-analysis` will become unusable with real scale.
**Recommended fix:** Add at minimum:
- `@@index([employeeId, timestamp])` on `Activity` (and `@@index([organizationId, timestamp])`)
- `@@index([organizationId])` on every model with an `organizationId` FK
- `@@index([employeeId])` on `Device`, `Screenshot`, `Anomaly`, `Consent`, `SentimentRecord`, `TimeEntry`, `ProjectMember`
- `@@index([consentId])` on `ConsentLog`, `@@index([timestamp])` on `UsbEvent`, `AuditLog`, `Notification`, `Alert`

#### C2. Production endpoints fabricate and persist analysis data
**Files:**
- `src/app/api/screenshots/[id]/analyze/route.ts:82–117` (`generateSmartMock`)
- `src/app/api/screenshots/batch-analyze/route.ts:101–109, 156–192` (same fallback), `:124` (`blurScore: 0.85` hardcoded)
- `src/app/api/anomalies/detect/route.ts:71, 93, 123, 151`
**Problem:** When the image file is missing/unreadable or the VLM call fails, the route silently generates a fake `ocrText` + `aiAnalysis` (category = "Productive"/"Unproductive"/"Neutral" guessed from a hardcoded app-name list). This fabricated analysis is then **written back to the DB** (`db.screenshot.update`, batch route :117–126) and drives `flagged`/`flagReason`. `anomalies/detect` persists `confidence: 0.82 + Math.random() * 0.15` and similar randomized values.
**Root cause:** Failure handling designed to "never fail" instead of surfacing errors.
**Impact:** Employee monitoring/flagging decisions (potentially disciplinary) are based on made-up data. Anomaly confidence scores are random, so severity ordering is meaningless. This is data integrity corruption in a privacy-sensitive product.
**Recommended fix:** Remove the mock fallbacks. On VLM failure, return a `502`/explicit `analysis_failed` state and do NOT write `flagged=true`. Confidence must come from the model; if unavailable, omit/`null` it.

---

### HIGH

#### H1. N+1 query loops
**Files:**
- `src/app/api/anomalies/detect/route.ts:39–157` — `for (const emp of employees)` runs **5–6 queries per employee** (recent/baseline/today/off-hours/week activities + duplicate check per anomaly at :164). With N employees → 6N+ queries per detect run.
- `src/app/api/analytics/route.ts:97` — `db.employee.findMany` inside a `departments` loop.
- `src/app/api/self/devices/route.ts:43` — `findFirst` per device in a loop.
**Recommended fix:** Replace per-employee loops with batched `groupBy`/`aggregate` (`where: { employeeId: { in: [...] } }`).

#### H2. Unbounded full-table reads (no pagination or date cap)
**Files & evidence:**
| Route | Location | Problem |
|---|---|---|
| `src/app/api/alerts/route.ts` | :15–18 | `findMany` — no take/skip |
| `src/app/api/insights/route.ts` | :7–9 | `findMany` — no take/skip |
| `src/app/api/analytics/route.ts` | :32 | all activities in period, no take |
| `src/app/api/analytics/compare/route.ts` | :10, :65 | all activities for period, no take |
| `src/app/api/reports/daily/route.ts` | :22 | all day activities, no take |
| `src/app/api/reports/[id]/pdf/route.ts` | :26, :64, :103, :140 | full-period unbounded fetches |
| `src/app/api/departments/performance/route.ts` | :8–17 | all employees + all productive activities in memory |
| `src/app/api/consent/summary/route.ts` | :10–14 | all consents + employee includes |
| `src/app/api/reports/pdf/activity/route.ts` | :30 | `db.department.findMany({})` unfiltered |
| `src/app/api/insights/ai-analysis/route.ts` | ~:20–50 | all employees with **all** activities; departments with nested employees+activities; 500 recent activities — mega-fetch into memory |
| `src/app/api/audit-logs/route.ts` | :26–29 | paginated list but a **third unbounded** `findMany` for stats |
| `src/app/api/organization/team-data/route.ts` | :25, :76 | all employees + all activities in memory |

**Impact:** Memory/CPU blow-up and slow responses as data grows; SQLite single-file locking contention on long scans.
**Recommended fix:** Paginate or push aggregations to SQL (`groupBy`, `aggregate`, `count`). For stats queries use `groupBy` instead of fetching all rows and reducing in JS.

#### H3. Login does a full-table scan of users
**File:** `src/app/api/auth/login/route.ts:18`
**Problem:** `db.appUser.findMany({ where: { isActive: true } })` loads **every user** on every login to case-insensitively match email in JS (:19–21). Also leaks user existence timing.
**Root cause:** SQLite has no `mode: 'insensitive'` (workaround already commented in `search/route.ts:14`), so email match was moved to JS wholesale instead of normalizing stored emails.
**Recommended fix:** Store emails lowercased and use `findFirst({ where: { email, isActive: true } })`.

---

### MEDIUM

#### M1. Multi-step writes without `$transaction` (zero transactions found in the entire codebase)
**Files:**
- `src/app/api/agent-registrations/[id]/approve/route.ts` — registration update + employee update + device create + audit log + notification
- `src/app/api/devices/route.ts` POST — org lookup + device create + employee update
- `src/app/api/break-status/[id]/toggle/route.ts` — findFirst + create toggle sequence (double-toggle race)
- `src/app/api/import/[type]/route.ts:96–140+` — per-row department/employee creates in a loop; a failed row leaves a half-imported dataset
**Recommended fix:** Wrap approval/device/toggle/import mutations in `db.$transaction([...])` or `$transaction(async (tx) => ...)`.

#### M2. Missing cascade/delete behavior and redundant unique index
**Files:** `prisma/schema.prisma`
- Only one `onDelete: Cascade` exists (ProjectMember.project, :520). Deleting an `Organization`/`Employee`/`Department` will fail (default `Restrict`) or orphan rows; optional FKs (`Employee.departmentId` :87, `Device.employeeId` :127, `Project.departmentId` :501, `Screenshot.deviceId` :358) have no `onDelete: SetNull`.
- `Employee` :76 + :108 — `@unique(employeeId)` AND `@@unique([employeeId, organizationId])`: the composite is redundant (employeeId is already globally unique) and costs an extra index.

#### M3. Weak agent-token generation
**File:** `src/lib/agent/auth.ts:82–93`
**Problem:** `generateToken()` falls back to `Math.random()` when `crypto.getRandomValues` is unavailable (Node has it, so the fallback is dead code — but it exists), and uses `chars[byte % chars.length]` which has **modulo bias** (62 ∤ 256).
**Recommended fix:** Always use `crypto.randomBytes(n).toString('base64url')`.

#### M4. Plaintext agent passwords
**Files:**
- `src/app/api/agent/authenticate/route.ts:28` — `employee.agentPassword !== password` (string compare)
- `src/app/api/agent/register/route.ts:42` — same
- Schema comment `prisma/schema.prisma:88` confirms intended plaintext
**Impact:** Agent credentials stored insecurely; also no brute-force throttling on the agent auth path.
**Recommended fix:** Hash with bcrypt/argon2 like `AppUser.password` (which correctly uses `hashPasswordSync`/`verifyPassword`).

#### M5. `db.organization.findFirst()` without filter — multi-tenant ambiguity
**Files:** ~12 routes including `src/app/api/agent/anomaly/route.ts:43`, `app-list/route.ts:64,109`, `anomalies/route.ts:101`, `devices/route.ts:44`, `consent/route.ts:85`, `consent/bulk/route.ts:18`, `auth/login/route.ts:65`, `auth/me/route.ts:33`, `agent/consent/route.ts:84`, `sentiment/analyze/route.ts:323`, `organization/route.ts:7`, `organization/team-data/route.ts:9`
**Impact:** With more than one organization, `findFirst()` returns an arbitrary org → cross-tenant data mixing. Schema is multi-tenant capable (`organizationId` on ~20 models) but the app assumes one org.
**Recommended fix:** Resolve org from auth/session and use `findUnique({ where: { id } })`.

#### M6. String-typed enums and JSON-as-string columns
**Files:** `prisma/schema.prisma` — all `status`/`type`/`severity`/`category`/`mood` fields are raw `String` (no Prisma `enum`); `metadata`, `data`, `signals`, `riskFactors`, `tags` are unvalidated JSON strings (Alert :214, AuditLog :233, Report :251, AiInsight :273, Anomaly :425, Consent signals :555/:557, Project.tags :490).
**Impact:** Typos silently create invalid states; no DB-level constraint; JSON parsed ad hoc in routes.
**Recommended fix:** Prisma `enum`s for the ~15 enumerated fields; SQLite JSON columns or typed serialization helpers for metadata.

#### M7. Import race conditions
**File:** `src/app/api/import/[type]/route.ts:78–94, 137–140`
**Problem:** Duplicate check is a cached in-memory email `Set` (:82–86) but `Employee.email` has **no unique constraint**; department name lookups are cached (`deptMap` :89–94) yet new departments are created per row (:137) — concurrent imports create duplicate emails/departments.
**Recommended fix:** `@@unique([email, organizationId])` on Employee; `@@unique([organizationId, name])` on Department; upsert departments.

#### M8. `seed.ts` executes on module load with no guard
**File:** `src/lib/seed.ts:1240` — `seed().catch(...)` runs at import time and begins by `deleteMany`-ing **every table** (:8–32). Verified: nothing imports it (0 references), so it's manual dev-only — but any accidental import wipes the DB. Add `if (process.env.NODE_ENV === 'production' || !process.env.SEED_ALLOWED) return;`.

---

### LOW

| # | File:Line | Issue |
|---|---|---|
| L1 | `src/components/auth/login-page.tsx:200–203` | Hardcoded "Demo Credentials" hint in UI (admin@worklens.ai / Admin@2025) — shipped to production UI |
| L2 | `src/lib/seed.ts:53–54` | `SUPER_ADMIN_PASSWORD` fallback `'Admin@2025'` |
| L3 | `src/components/ui/sidebar.tsx:611` | `Math.random()` skeleton width (benign UI shimmer) |
| L4 | `src/components/providers/websocket-provider.tsx:125` | `Math.random()` client-side event-log IDs (benign, cosmetic) |
| L5 | `src/app/api/route.ts:4` | `/api` returns static `"Hello, world!"` (dead endpoint) |
| L6 | `src/lib/agent/auth.ts:89` | `Math.random()` fallback token path (see M3) |

---

## Exhaustive inventory: static / mock / hardcoded values

**Production code paths (must fix):**
1. `src/app/api/screenshots/[id]/analyze/route.ts:82–117` — `generateSmartMock` fabricates OCR + AI analysis and persists it (C2)
2. `src/app/api/screenshots/batch-analyze/route.ts:101–109, 124, 156–192` — same fallback + hardcoded `blurScore: 0.85` (C2)
3. `src/app/api/anomalies/detect/route.ts:71, 93, 123, 151` — `Math.random()`-based confidence scores persisted to `Anomaly` (C2)
4. `src/components/auth/login-page.tsx:200–203` — demo credentials in UI (L1)
5. `src/lib/agent/auth.ts:89` — `Math.random()` token fallback (M3)
6. `src/app/api/route.ts:4` — static hello response (L5)

**Development-only (acceptable, but guarded where noted):**
7. `src/lib/seed.ts` — ~40 `Math.random()` sites generating the entire demo dataset: activities :223, 273–318; screenshots :843–847; anomaly confidence/blurScore :871, 875; anomalies :922–950; consents :984–1012; projects/members/time-entries :1058–1120; sentiment :1171–1213. Runs unguarded at import time (M8). Hardcoded fixture org `TechVision Global` :37.
8. `src/components/ui/sidebar.tsx:611` — random skeleton width (UI shimmer, benign).
9. `src/components/providers/websocket-provider.tsx:125` — random client log IDs (benign). WebSocket client itself is real (socket.io), no simulated events.

---

## Verified healthy patterns (for balance)
- `src/lib/db.ts` — correct PrismaClient singleton with global caching.
- Pagination correctly implemented in: `activities`, `employees`, `devices`, `screenshots`, `notifications`, `usb-events`, `anomalies`, `consent`, `consent/logs`, `audit-logs` (list).
- `Promise.all` used for parallel queries in `dashboard`, `activities`, `devices`, `usb-events`, `notifications`, `audit-logs`.
- `groupBy`/`aggregate` used where appropriate: `dashboard/route.ts:38` (device status), `notifications/route.ts:65,72` (type/priority agg), `self/dashboard/route.ts:91` (category breakdown).
- `createMany` used for bulk activity ingestion (`agent/activity/route.ts`).
- AppUser passwords are properly hashed and verified (`auth/login/route.ts:31`).
- No direct `db` usage in server components (`src/app/**/*.tsx` — zero matches).
