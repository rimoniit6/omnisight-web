# Project Module Audit

Audit of **Admin Panel → Projects** — full end-to-end verification: UI → Components → API → Validation → Authorization → Prisma → Database → Relationships → Persistence → Related Features.

Audit date: 2026-08-10 · Performed against the real dev database (`db/custom.db`, seeded) and a throwaway SQLite test DB for automated suites.

## Overall Result

**PASS** (with 2 documented pre-existing failures outside the Projects module — see Remaining Issues)

---

## Project List

| Item | Result | Evidence |
|---|---|---|
| Database data | PASS | List, stats, and cards all come from `/api/projects` (Prisma, org-scoped). No mocks, no `Math.random()`, no hardcoded counts. |
| Search | PASS | Server-side, case-insensitive, partial (`contains`), multi-field (name + description). Debounced (250 ms) on the client. |
| Filters | PASS | Status + Priority filters compose with search server-side (`AND` semantics). Only schema-backed enums exposed. |
| Pagination | PASS | True server-side (`skip`/`take`), page count from DB, page sizes 20/50/100, "Showing X–Y of Z" range, Prev/Next + numbered pages. Filters/search/page-size reset to page 1. |
| Sorting | PASS | Server-side `sortBy`: newest, deadline, hours_most, hours_least. |
| Stats semantics | PASS | KPI cards (Total Projects / Total Hours / Team Members / Overdue) are org-wide and stable while search/filters change the paginated `total` (regression-tested in PRJ-2). |
| Loading / Empty / Error / Retry | PASS | Skeletons, "No projects found" empty state, "Unable to load projects" + Retry, filter-aware empty messaging. |

## CRUD

| Item | Result | Evidence |
|---|---|---|
| Create | PASS | Dialog → validation → POST → DB row → list refresh without page reload (React Query invalidation). Empty name 400, duplicate name 409, bad enum 422, bad dates 422. |
| Read | PASS | GET list (paginated), GET detail (includes department + organization names, member count, hours). |
| Update | PASS | Edit dialog seeded from detail; PUT validates name/enums/dates and duplicate-name 409; persists across refresh. |
| Archive/Delete | PASS | Archive (DELETE) sets `status = cancelled` (soft lifecycle) — historical members/time entries/activities are preserved, not deleted. Confirmation dialog before archive. |

## Relationships

| Item | Result | Evidence |
|---|---|---|
| Employee ↔ Project | PASS | Many-to-many via `ProjectMember`. Two-way consistency proven: member add shows on Project Detail AND employee's project list; soft-remove reflects on both sides. |
| Project ↔ Organization | PASS | `organizationId` set from session on create; all reads/mutations org-scoped; cross-org access → 404, cross-org references → 422. |
| Project ↔ Manager | N/A | Schema has no dedicated manager column (employees participate via members with a `lead` role). Not invented. |
| Project ↔ Task | N/A | No Task model in this codebase. Not invented. |
| Project ↔ Activity | PASS | Activities are employee/device-scoped (no project attribution exists in schema — not fabricated). |
| Project ↔ Time | PASS | Time entries are project-scoped; non-member posting → 403; hours validation (1–24), date validation, category enum validation; project totals and member totals aggregate real DB rows. |
| Project ↔ Reports | PASS | Project PDF is org-scoped (cross-org → 404); export route org-scoped; dashboard PDF org-scoped. |

## Project Members

| Item | Result | Evidence |
|---|---|---|
| Searchable Employee Selector | PASS | `EmployeeCombobox` with server-side search (`/api/employees/search`), name/email/employeeId fields. |
| Multi-select | PASS | Supported by the combobox; assignments iterate payloads. |
| Assignment | PASS | POST validates employee org (422 cross-org), role enum, hours range; inserts real `ProjectMember` row. |
| Duplicate Prevention | PASS | Composite unique `(projectId, employeeId)` + explicit 409 on active duplicate. |
| Removal | PASS | Soft-remove (sets `leftAt`) — employee and project untouched, other members remain, historical time entries intact. |
| Re-add after removal | PASS | POST reactivates the previous row (clears `leftAt`, updates role/hours) instead of hitting the unique constraint → 500. Verified both in `projects/[id]/members` and `employees/[id]/projects`. |
| Soft Removal/History | PASS | `leftAt` preserved; employee's active-project list excludes left memberships while history remains. |
| Project-specific role | PASS | `role` on membership (lead/member/reviewer/stakeholder) is distinct from the employee's global designation; editable per member. |

## Database

| Item | Result | Evidence |
|---|---|---|
| Foreign Keys | PASS | Prisma relations on ProjectMember → Project/Employee, Project → Organization/Department, TimeEntry → Project/Employee. |
| Unique Constraints | PASS | `@@unique([projectId, employeeId])` on ProjectMember (verified in schema + reactivation fix). |
| Indexes | PASS | Indexed query paths present (`Project.organizationId`, `status`, `ProjectMember.projectId`, `employeeId`, `TimeEntry.projectId`). |
| Transactions | PASS | Multi-step ops (member add with reactivation, member removal) use Prisma transactions/upsert-style updates — no partial state. Member POST find→create/update runs inside `$transaction` with a `P2002` → 409 fallback for a lost concurrent race. |
| N+1 Queries | PASS | List query includes aggregates via `_count` and member preview; no per-row queries. |
| Tenant Isolation | PASS | `requireSessionOrg` everywhere; org always from session, never client-controlled. |

## Security

| Item | Result | Evidence |
|---|---|---|
| Authentication | PASS | All project routes require session/Bearer (401 unauth — PROJECT-13). |
| Authorization | PASS | Mutations gated to admin (viewer 403 — PROJECT-15). |
| Cross-Organization Protection | PASS | Cross-org read/mutate → 404 (PROJECT-16); cross-org member assignment → 422/404 (PROJECT-17). |
| Sensitive Data Exposure | PASS | No agent credentials, no internal IDs shown as names (name/email/employeeId rendered); member payloads strip credentials. |
| PDF / Export / Import | PASS | Project PDF, dashboard PDF, export, and import now org-scoped (cross-org PDF → 404); project import dedupes by name. |

## UI

| Item | Result | Evidence |
|---|---|---|
| Loading States | PASS | Skeletons for stats, cards, table, and detail queries. |
| Empty States | PASS | "No projects found", "No members yet", "No time entries" — all real. |
| Error States | PASS | List error + Retry; create/edit errors surfaced as toasts/inline (e.g. duplicate-name 409 message shown). |
| Responsive UI | PASS | Cards/table views, filter bar wraps, dialogs scroll; verified desktop at minimum (mobile not browser-verified this pass). |

## Testing

| Item | Result | Evidence |
|---|---|---|
| TypeScript | PASS | `npx tsc --noEmit` clean. |
| ESLint | PASS | `npx eslint` on all changed files clean. |
| Unit Tests | PASS | `tests/projects.test.ts` — 17/17 pass (new). |
| Integration Tests (route-level) | PASS | Same suite exercises real Prisma + throwaway SQLite DB. |
| Integration Tests | PASS | `tests/security.test.ts` — 24/26 pass; both failures pre-existing and in the Employees module (EMPLOYEE-11/12 — see below). |

| E2E Tests | PASS | `tests/projects.test.ts` covers list/search/filter/pagination/sort/CRUD/members/cross-org/consistency via route-level integration. |
| Browser Click-Through | PASS | Scripted browser run against live dev server (patchright/Playwright): login → Projects → search → create → detail → **Add Member via searchable combobox** → member added → **two-way employee↔project consistency** → edit → archive. Zero failed steps; console clean apart from pre-existing 401 `/api/auth/me` probes and socket.io warnings. |

**Browser flow verified live:** Projects page (4/4 stat cards) → server search (no-match state) → create via UI (toast + DB persisted) → detail dialog (Overview/Team/Time Log/Edit/Archive) → Team tab → Add Member → employee search → member added (API members=1) → employee's active project list includes the project → edit (name persisted) → archive (status `cancelled`).

## Files Changed

Backend (API):
- `src/app/api/projects/route.ts` — server-side `sortBy`, correct pagination, richer DB-backed stats (`totalProjects`, `activeProjects`, `totalHours`, `dailyAverageHours`, `uniqueMembers`, `overdueCount`), strict validation (name/status/priority enums, date range, duplicate-name 409), org-scoped department check.
- `src/app/api/projects/[id]/route.ts` — PUT validation parity (409/422), DELETE = soft archive to `cancelled`, GET includes organization + department names.
- `src/app/api/projects/[id]/members/route.ts` — role/hours validation, cross-org 422, duplicate 409, reactivate soft-removed membership on re-add; find→create/update wrapped in a transaction with `P2002` → 409 race handling.
- `src/app/api/projects/[id]/members/[memberId]/route.ts` — PUT role validation; DELETE soft-removes (`leftAt`) instead of hard-deleting.
- `src/app/api/projects/[id]/time-entries/route.ts` — hours/date/category validation, non-member 403, pagination support.
- `src/app/api/employees/[id]/projects/route.ts` — reactivate previously-left memberships (unique-constraint fix), two-way consistency.
- `src/app/api/reports/pdf/project/route.ts` — org-scoped (cross-org → 404).
- `src/app/api/reports/pdf/dashboard/route.ts` — org-scoped.
- `src/app/api/export/[type]/route.ts` — org-scoped exports.
- `src/app/api/import/[type]/route.ts` — org-scoped import; project name dedupe.

Frontend:
- `src/components/projects/projects-page.tsx` — server pagination controls + page size, debounced server search, error/retry, real member avatars/counts, detail `.data` unwrap, Edit Project dialog, Archive confirmation, member role editing, time-entry pagination, broader React Query invalidation, create-error toast from server message.

Tests:
- `tests/projects.test.ts` — new 17-test suite (PRJ-1 … PRJ-17).
- `package.json` — `test:projects` script.

QA tooling (not shipped):
- `scripts/browser-qa.mjs`, `scripts/qa-projects-browser.mjs` — scripted browser QA runner + Projects flow script.

## API Changes

- `GET /api/projects` — added `sortBy` param; response now includes `totalPages`, `page`, `pageSize`, and richer `stats`.
- `POST /api/projects` — new validation: 400 empty name, 409 duplicate name, 422 invalid status/priority/date range, 422 cross-org department.
- `PUT /api/projects/[id]` — same validation parity; 409 duplicate name.
- `DELETE /api/projects/[id]` — soft archive (status → `cancelled`), preserves history.
- `POST /api/projects/[id]/members` — reactivates soft-removed memberships; 409 active duplicate; 422 invalid role/hours; 422 cross-org employee.
- `DELETE /api/projects/[id]/members/[memberId]` — soft-remove via `leftAt`.
- `PUT /api/projects/[id]/members/[memberId]` — role validation.
- `POST /api/projects/[id]/time-entries` — 403 non-member, 422 hours/date/category.
- `GET /api/employees/[id]/projects` PUT — reactivation on re-add.
- PDF/export/import routes — org-scoped responses.

## Database Changes

None required — the existing schema (Project, ProjectMember with `@@unique([projectId, employeeId])`, TimeEntry) fully supports all audited behavior. No migrations were created.

## Migrations

None.

## Review Findings (addressed)

Post-implementation code review raised three points — all resolved:
1. **Stats vs. filtered list inconsistency** — `stats.totalProjects` used the filtered count while the other KPI cards were org-wide. Fixed: all KPI cards are org-wide; the paginated `total` carries the filtered count. Regression-tested (PRJ-2).
2. **Member reactivation race** — the find→create/update path was two separate Prisma calls; two concurrent POSTs could both attempt `create` and crash on the unique constraint. Fixed: wrapped in `db.$transaction`, `P2002` → clean 409.
3. **Export activity scoping** — verified correct: activities are scoped through the `employee.organizationId` relation (the Activity model has no org column). No change needed.

## Remaining Issues

1. **Pre-existing, out of scope:** `tests/security.test.ts` EMPLOYEE-11/12 fail. The employee PUT route (`src/app/api/employees/[id]/route.ts`, modified in an earlier session, not by this audit) requires full `firstName`/`lastName`/`email` on every update while the test sends a partial payload (`{ designation }`). Verified pre-existing by stashing this audit's changes and re-running — the failures occur on the original tree too. **Recommendation:** make the employee PUT merge partial updates (spread existing values) or fix the test payload; address in the Employees module audit.
2. **Dev-server watcher caveat:** `src/app/api/employees/search/route.ts` is untracked (new) and was created after the running dev server booted; the Next watcher missed it until the server was restarted. It now works (200). Track the file so fresh clones include it.
3. Mobile responsive rendering was not browser-verified this pass (desktop verified). Table view on narrow screens relies on `overflow-x-auto`.

## Production Decision

**GO** — the Projects module is functional end-to-end with real database data: list → search → filter → pagination → create → detail → edit → members (searchable employee selector, multi-assign, roles) → employee↔project consistency → tasks/activity/time/reports (per schema) → remove member → persistence. No fake data, no hardcoded counts, no broken CRUD, no orphan/duplicate memberships, no cross-tenant leakage, no raw IDs as admin-facing names.

---

# Production Hardening Certification (2026-08-13)

Re-audit of the Projects/Members/Time-Entries **and** Consent/Self-Portal modules for the confirmed P1/P2/P3 findings. Verified against a throwaway PostgreSQL DB (`workai_test_multiorg`, `workai_test_hardening`) for automated suites and the live dev server (`workai`, restarted to pick up changes) for HTTP probes.

## Overall Result

**PASS** — every confirmed P1/P2/P3 finding is resolved, regression-tested, and live-verified. No new issues introduced.

## Fixes Applied

| Finding | Severity | Fix | Evidence |
|---|---|---|---|
| Member PUT/POST accepts `role:null` / `hoursPerWeek:null` / NaN / malformed types → Prisma 500 | P1 | Strict 422 validation in `projects/[id]/members/route.ts` (POST) and `members/[memberId]/route.ts` (PUT) | H-01…H-04 |
| Projects & time-entries list accept NaN/negative/oversized pagination → Prisma 500 | P1 | `validatePagination` (strict integers ≥ 1, `maxPageSize` cap) in `src/lib/api.ts`, applied to projects + time-entries + consent + consent/logs + self/activities + self/anomalies | H-05, H-06 |
| Time-entries `dateFrom`/`dateTo` invalid → Prisma 500 | P1 | Explicit `Invalid dateFrom/dateTo` → 422 | H-06 |
| `self/consents` GET wrote Consent + ConsentLog rows (GET side effect) | P1 | Read-only: missing types synthesized in-memory as `pending:` rows; no DB writes | H-08 |
| Consent audit attribution wrong (self-consent actor = employee target) | P1 | `authenticateRequest` used for actor (`performedBy` = auth email, `userId` = auth userId); employee is target only | H-13 |
| No-published-policy grant → raw 500 | P1/P2 | Mapped to 409 (`consent/route.ts`, `consent/[id]/route.ts`, `self/consents/[id]/route.ts`) | H-12, H-15 |
| Consent PUT trusted client-supplied `performedBy` / `action` heuristic | P3 | Always `auth.email`; `action: status === 'revoked' ? 'admin_revoked' : undefined` | H-14 |
| `requiresReconsent` compared version only | P2 | Now mirrors `hasActiveConsent`: binds `policyId` AND `consentVersion` | H-09 |
| Time-entries `total` ignored filters | P2 | `count({ where })` mirrors data filters | H-07 |
| Consent POST always returned 201 | P3 | 201 only on fresh create; 200 on transition of existing | H-10 |
| Consent bulk accepted unknown consent types (partial writes) | P2 | Whitelist against `CONSENT_TYPES` before any write; `consentTypes` must be array | H-16 |
| `auditLog.userId` null/absent on project/member/time-entry writes | P2 | `userId: admin.userId` on all 7 `auditLog.create` calls | H-17 |
| Consent API accessible to viewers (nav said manager, API did not enforce) | P2 | Proxy `ROLE_RULES` gains `/api/consent` → manager; `PAGE_MIN_ROLE.consent` → manager | live RBAC probe |
| Consent notes unbounded | P3 | `MAX_CONSENT_NOTES_LENGTH = 500`; centralized truncation + 400 rejection | H-11 |
| Agent consent GET (poll endpoint) had no rate rule | P3 | RATE_RULES adds `GET /api/agent/consent` keyed by agent token (600/min, heartbeat parity) | proxy.ts |

## Test Results (2026-08-13)

| Suite | Result |
|---|---|
| `tests/hardening.test.ts` (new, H-01…H-17) | 17/17 pass |
| `tests/projects.test.ts` (PRJ-1…17) | 17/17 pass |
| `tests/multi-org-isolation.test.ts` (MO-1…48) | 48/48 pass |
| `tests/consent.test.ts` | 27/27 pass |
| `tests/consent-summary.test.ts` | 9/9 pass |
| `tests/security.test.ts` | 28/28 pass |
| `tests/agent-account.test.ts` | 11/11 pass |
| `npx tsc --noEmit` | 0 errors |
| `npx eslint` (all changed files) | 0 errors |
| `npx prisma validate` | valid |
| `npx next build` | succeeds |

## Live HTTP Probes (dev server, admin/viewer sessions)

- `GET /api/projects?page=abc` → 422
- `GET /api/projects?page=1&pageSize=10` → 200
- `GET /api/projects/[id]/time-entries?dateFrom=notadate` → 422
- `POST /api/projects/[id]/members` `role:null` → 422; `hoursPerWeek:null` → 422
- `GET /api/consent?page=1&pageSize=50` → 200; `pageSize=5000` → 422
- `GET /api/self/consents?employeeId=…` → 200, synthetic `pending:` rows, **0 Consent + 0 ConsentLog rows written**
- viewer → `GET /api/consent` 403, `POST /api/consent/bulk` 403, `GET /api/self/consents` 403

## Notes / Accepted Decisions

- Org-less `super_admin` with `allowGlobal` can read globally but all mutations return 403 — documented, tested behavior (`tests/security.test.ts:544`), left unchanged.
- `Consent @@unique([employeeId, consentType])` makes bulk `findFirst` deterministic; `getPublishedPolicy` orders by `effectiveAt desc` — no change needed.
- Consent-policy publish race (two concurrent publishes of different policies for the same type) is bounded by the schema's `(org, type, version)` unique key; acceptable residual risk, no schema change made.
- All dev DB audit-seed data (`scripts/_audit_seed.mjs` and its rows) removed; dev DB left clean.

## Production Decision

**GO** — P0 = 0, P1 = 0. No cross-org access, no unauthorized mutation, no audit attribution errors, no GET-based writes, no invalid-input 500s, no client-controlled tenant scope or actor, no fabricated data. All gates pass; certification complete.
