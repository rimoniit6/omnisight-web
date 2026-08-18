# M008 Stage-3 Implementation Report

## Overview

M008 Stage-3 (AI-powered analytics consumption layer) is the final stage of the M008 analytics milestone. It turns persisted analytics (UserDailySummary, DeviceHealthSnapshot, ApplicationUsage, Alert, etc. — never raw ActivityEvent) into executive-ready value: AI-generated insights, trend analysis, risk scoring, recommendations, generated/scheduled reports, and an executive dashboard. All surfaced through a Super-Admin-only REST surface backed by a new AISummary/ReportSchedule/AuditLog schema and the existing Report model.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Admin API surface                             │
│  (all secured by requireSuperAdmin → 403 for non-admins)          │
│  /api/admin/reports[...]  /api/admin/report-schedules[...]        │
│  /api/admin/ai/{insights,regenerate,health}                       │
│  /api/admin/executive/dashboard                                   │
│  /api/admin/trends   /api/admin/recommendations                   │
└──────────────────────────────────────────────────────────────────┘
            │                          │
            ▼                          ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│    AI Engine             │  │     Reports Engine           │
│  (src/lib/ai/)           │  │  (src/lib/reports/)          │
│  insights.ts   →         │  │  types.ts  → report types    │
│    collectMetrics +      │  │  generator.ts → build JSON/  │
│    buildPrompt +         │  │    CSV/Excel/PDF text        │
│    callAI + fallback     │  │  scheduler.ts → cron-ish     │
│  trends.ts     → trends  │  │    daily/weekly/monthly run  │
│  risk.ts       → org/    │  └──────────────────────────────┘
│                   emp/    │
│                   device  │
│  recommendations.ts      │
└──────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────┐
│  Persistence (additive-only migration 20260804000000)        │
│  AISummary    → cached insights (TTL cache, audit, force)    │
│  ReportSchedule → scheduling config + last-run state         │
│  AuditLog     → report/insight/schedule audit trail          │
│  Report       → generated report artifacts (pre-existing)    │
└──────────────────────────────────────────────────────────────┘
```

Data flow: every engine reads **persisted analytics only** (UserDailySummary, DeviceHealthSnapshot, ApplicationUsage, Alert, User/Device join rows). `resolveAnalyticsScope` maps admin scope requests to the correct org/department/user/device; `RANGE_DAYS`/`parseRange` normalize `24h|7d|30d|90d` windows.

## AI Insight Engine

10 insight types × 4 scopes (`organization`, `department`, `user`, `device`) = 40 distinct insight combinations.

| Type | Focus | Type | Focus |
|------|-------|------|-------|
| productivity | scores, trend vs. target | anomaly | unusual metrics vs. baseline |
| behavior | app/work-hour patterns | health | device health snapshots |
| application | top apps + usage | organization | org-level aggregation |
| focus | focus time & sessions | department | dept-level aggregation |
| idle | idle streaks/ratio | executive | executive dashboard summary |

`generateInsight()`:
1. `collectMetrics(type, scope)` → persisted numeric metrics only
2. Cache check on `AISummary` by `(scope, scopeId, insightType, modelVersion)` with `expiresAt > now` — return cached row on hit
3. `buildPrompt()` + `systemPrompt` → `callAI()`
4. **No-AI-backend fallback** (`buildFallbackInsight`): on any provider error, returns a deterministic, data-driven markdown summary built purely from the persisted metrics, explicitly labelled as a deterministic fallback. This keeps the executive dashboard and insights surface functional with zero AI configuration.
5. Upsert into `AISummary` (atomic on the unique key), refresh `expiresAt` (5-minute TTL).

## Trend Engine (`src/lib/ai/trends.ts`)

- `computeTrend(metrics, period='7d')` — slope, direction, moving average, streak, volatility
- Scope variants: organization, department, user, device
- `GET /api/admin/trends` returns `{ trends, range, generatedAt }` including `organizationScore` (org risk score 0-100) and `organizationLevel`

## Risk Engine (`src/lib/ai/risk.ts`)

- `computeEmployeeRisk` → per-user `{ score, level, factors[] }` from productivity/idle/health metrics
- `computeDeviceRisk` → per-device risk from health snapshots + offline state
- `computeOrganizationRisk` → weighted org risk `(avgEmp × 0.4 + avgDevice × 0.4 + alertRisk × 0.2)`, `levelFromScore` → Low/Medium/High/Critical
- Consumed by executive dashboard and trends `organizationScore`

## Recommendations (`src/lib/ai/recommendations.ts`)

Deterministic, rule-driven recommendations from persisted metrics (not LLM). Shape: `{ id: 'rec-<kebab>-<ts>', title, priority: Low|Medium|High|Critical, ... }`. Endpoint returns `{ recommendations, range, generatedAt }`, default max 10, hard cap 50.

## Reports Engine (`src/lib/reports/`)

- **types.ts** — 8 report types (Productivity, Executive, Trend, Risk, Alerts, Devices, Department, User), 4 periods (Daily/Weekly/Monthly/Custom), 4 formats (PDF/CSV/Excel/JSON)
- **generator.ts** — `generateReport()` builds content + `fileSize` (content byte length) from persisted analytics; `createdBy` = admin userId
- **scheduler.ts** — report scheduler worker (60s poll) runs enabled `ReportSchedule`s on their frequency (daily/weekly/monthly with day-of-week/day-of-month/hour/minute/timezone); writes `lastRunStatus/lastRunAt/lastReportId` and a `schedule_run` audit row

## Admin API Endpoints

All Super-Admin only (`requireSuperAdmin` → 403 for Employee/RBAC checks):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/admin/reports` | List (filter/limit) / generate report |
| GET/DELETE | `/api/admin/reports/{id}` | Fetch / delete report (audit `report_deleted`) |
| GET/POST | `/api/admin/report-schedules` | List / create schedule (audit `schedule_created`) |
| PATCH/DELETE | `/api/admin/report-schedules/{id}` | Update / delete schedule (audit `schedule_updated`/`schedule_deleted`) |
| POST | `/api/admin/report-schedules/{id}` | Run scheduled report now (audit `schedule_run`) |
| GET | `/api/admin/ai/insights?type&scope` | On-demand insight (cached; `force=true` regenerates) |
| POST | `/api/admin/ai/regenerate` | Force regenerate (audit `ai_regenerated`) |
| GET | `/api/admin/ai/health` | AI provider health probe |
| GET | `/api/admin/executive/dashboard` | Executive KPIs + insight + risk |
| GET | `/api/admin/trends` | Trend lines + org risk score/level |
| GET | `/api/admin/recommendations` | Rule-driven recommendations |

Invalid schedule frequency / missing title → 400. Missing resources → 404.

## Database Migration

`prisma/migrations/20260804000000_m008_stage3_ai_insights/migration.sql` — additive-only, 3 new tables:

- **AISummary** — `scope`, `scopeId?`, `insightType`, `modelVersion`, `prompt`, `content`, `metrics?`, `expiresAt`; unique index `(scope, scopeId, insightType, modelVersion)` + 3 secondary indexes
- **ReportSchedule** — `title`, `type`, `scope`, `scopeId?`, `period`, `frequency`, `dayOfWeek?`, `dayOfMonth?`, `hour`, `minute`, `timezone`, `range?`, `format`, `enabled`, `lastRunAt/lastRunStatus/lastRunDurationMs/lastRunError/lastReportId`; indexes on `(enabled, period)` and `lastRunAt`
- **AuditLog** — `actor`, `action`, `entityType`, `entityId?`, `detail?`, `ip?`; actions: `report_generated`, `report_deleted`, `ai_regenerated`, `schedule_created`, `schedule_updated`, `schedule_run`, `schedule_deleted`; indexes on actor/action/entity/createdAt

## Verification

- `npx tsc --noEmit` — clean on all new Stage-3 files (trends/risk/recommendations/routes)
- `scripts/verify-m008-stage3.mjs` — **165 passed, 0 failed** (bun), 10 sections: schema asserts; reports CRUD+audit; AI insights (on-demand/cached/forced/all-40); regenerate+audit; AI health; executive dashboard; trends (incl. dept scope); recommendations; report-schedules CRUD+run+audit; RBAC (Employee blocked from all 10 admin endpoints)
- `scripts/verify-m008-stage2.mjs` — still green (76/76), no regressions

### Issues found & fixed during verification

1. **Trends `organizationScore` shape** — route returned `orgRisk.risk` (a `{score, level, factors}` object) instead of the numeric score. Fixed to `orgRisk.risk.score` (`src/app/api/admin/trends/route.ts`).
2. **Schedule run endpoint path** — code comment documented `POST .../{id}/run` but the handler was mounted at `POST .../{id}`. Aligned the comment to the implemented contract; verify script updated to hit the real path.
3. **Test-scoped DB query** — `AISummary` check picked the executive-dashboard row (scopeId=orgId, stale TTL) instead of the row the run refreshed; scoped to `scopeId IS NULL`.

## Key Design Decisions

1. **Persisted-analytics-only reads** — insights/trends/risk/recommendations/reports read UserDailySummary, DeviceHealthSnapshot, ApplicationUsage, Alert — never raw ActivityEvent. Schema compliance is test-enforced by the suite.
2. **Deterministic degradation** — with no AI provider configured (no `.z-ai-config`, no keys), `generateInsight` returns a clearly-labelled deterministic fallback built from persisted metrics instead of erroring. The full admin surface stays functional.
3. **Cached insights** — `AISummary` upserts on the unique `(scope, scopeId, insightType, modelVersion)` key with a 5-minute `expiresAt` TTL; `force=true` bypasses the cache. `metrics` JSON column makes every insight reproducible.
4. **Rule-driven recommendations** — recommendations are deterministic rules (id, title, priority), not LLM output, so priority values are stable and testable.
5. **Full audit trail** — every report generation/deletion, AI regeneration, and schedule create/update/run/delete writes an AuditLog row with actor, entity, and detail.
6. **RBAC** — all 12 admin endpoint paths gate on `requireSuperAdmin()`; the suite asserts Employee gets 403 on all of them.
7. **Additive schema** — no existing tables modified; 3 new tables + the pre-existing `Report` model carry all Stage-3 state.
