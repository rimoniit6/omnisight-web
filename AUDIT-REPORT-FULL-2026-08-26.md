# OmniSight Web Admin Panel — Production-Readiness Audit Report

**Audit date:** 2026-08-26
**Method:** Static deep audit (all 145 components, ~100 API routes, 42-model Prisma schema read/traced) + live functional probing (running server, real HTTP requests) + build/typecheck/lint execution.

**Testing limitation (declared up front):** The configured database (Supabase, port 6543) was **unreachable** from this environment. Login fails closed (`429`) when the rate-limiter store can't reach the DB. Therefore **full authenticated end-to-end CRUD flows are UNVERIFIED — BLOCKED BY DEPENDENCY**. What *was* verified live: server boot, `/api/health`, unauthenticated access to all 19 sensitive route families, JWT forgery resistance, DB-outage behavior, production build, typecheck, lint. Everything else is code-traced with exact file:line evidence — nothing is assumed.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Score Breakdown](#2-score-breakdown)
3. [Critical Findings](#3-critical-findings)
4. [High Findings](#4-high-findings)
5. [Medium Findings](#5-medium-findings)
6. [Low Findings](#6-low-findings)
7. [Dead Button / Non-Functional UI Report](#7-dead-button--non-functional-ui-report)
8. [Mock / Fake Data Report](#8-mock--fake-data-report)
9. [Dead Code Report](#9-dead-code-report)
10. [API ↔ UI Mismatch Report](#10-api--ui-mismatch-report)
11. [Database / Persistence Report](#11-database--persistence-report)
12. [Auth/RBAC Report](#12-authrbac-report)
13. [Service App / Device Management Report](#13-service-app--device-management-report)
14. [Responsive / UI Report](#14-responsive--ui-report)
15. [Build / Runtime Errors](#15-build--runtime-errors)
16. [Complete Feature Matrix](#16-complete-feature-matrix)
17. [Priority Fix Plan](#17-priority-fix-plan)
18. [Final Verdict](#18-final-verdict)
19. [The Most Important Question](#19-the-most-important-question)

---

## 1. Executive Summary

| Metric | Value |
|---|---|
| **Overall score** | **70 / 100** |
| Production readiness | NOT PRODUCTION READY (2 critical authorization flaws + systematic false-success UI feedback) |
| Total findings | 68 |
| Critical | 3 |
| High | 6 |
| Medium | 22 |
| Low | 17 |
| INFO / dead-code items | 20 |
| Dead/fake/non-functional UI actions | **9** |
| False-success handlers (toast "Success" without checking result) | **~18** |
| Mock/demo data in production UI paths | **0** ✅ |
| UI→API route mismatches found | **0** ✅ |

The engineering quality underneath is genuinely high — real WebSocket infrastructure, transactional device approval with row locks, honest AI-status labeling, zero fabricated metrics, parameterized SQL everywhere, hardened uploads. But the panel **fails its core multi-tenant promise**: any org admin can take over accounts in *any other tenant*, and can escalate themselves to Owner. Combined with ~18 places where the UI says "Success" without checking whether the server agreed, the panel cannot be certified production ready.

### Project Inventory

| Aspect | Value |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack dev, `proxy.ts` = middleware) |
| React / TypeScript | React 19 / TypeScript 5 |
| Database / ORM | PostgreSQL (Supabase, PgBouncer :6543) / Prisma 6 — 42 models, 26 migrations |
| Authentication | Custom HS256 JWT (in-memory token) + httpOnly session cookie + server-authoritative `UserSession` revocation |
| Authorization | Proxy-level prefix RBAC (`super_admin(50) > owner(40) > admin(30) > manager(20) > viewer(10)`) + per-handler `requireAdminOrg` family |
| API architecture | ~100 REST route handlers under `src/app/api/**`; SPA-style client pages switched via Zustand |
| State management | Zustand (auth/app stores) + TanStack React Query (data cache) |
| Real-time | Socket.io client ↔ `mini-services/live-updates` Bun service; WS events drive React Query invalidation |
| Validation | Zod-style whitelists per-route; react-hook-form on forms |
| UI system | shadcn/radix + Tailwind 4 + sonner toasts + recharts |
| Storage | Pluggable driver (local / Supabase), sharp re-encode for avatars, magic-byte checks for screenshots |
| Tests | `tsx --test` suites (~14) + Playwright e2e fixtures + ~60 verify scripts |

---

## 2. Score Breakdown

| Dimension | /10 | Basis |
|---|--:|---|
| Functional correctness | 7 | Most flows traced real; false-success pattern pervasive |
| UI action reliability | 6 | 9 dead/fake actions; ~18 unchecked-result handlers; no double-submit guards on lists |
| Backend integration | 9 | Zero UI↔API mismatches across all pages; shapes match |
| Database correctness | 7 | Strong indexing on hot paths; missing org+time composites; Float money; cascade trap |
| Authentication | 8 | Server-authoritative sessions, revocation, forgery-resistant (verified live); no account lockout; placeholder-secret validation gap |
| Authorization/RBAC | **4** | Proxy RBAC good, but cross-tenant user admin + privilege escalation defeat tenancy |
| Security | 7 | CSRF origin check, SSRF guards, upload hardening, fail-closed rate limiting; two critical authz holes |
| API quality | 8 | Consistent wrappers, validation whitelists, correct status codes |
| Error handling | 5 | Systematic silent failures; several queries render misleading zeros instead of errors |
| Data integrity | 7 | Transactions + locks where it matters; dangling FK-less IDs; unique-constraint flaw on AppListEntry |
| Responsive UI | 6 | `useIsMobile` + mobile sheet + overflow-x tables present; **live viewport testing blocked by DB** |
| Accessibility | 7 | Skip-link, aria-wired login error, labeled dialogs; full screen-reader pass not possible live |
| Code quality | 8 | Clean structure, heavy documentation comments, ~900+ lines dead weight |
| Build/test health | 8 | `next build` ✅, `tsc --noEmit` ✅, eslint src-clean (6 errors = test-fixture false positives); test suites DB-blocked |

**Weighted overall: 70/100.**

---

## 3. CRITICAL FINDINGS

### C-1 · Cross-tenant user administration — full IDOR over all tenants

- **Files:**
  - `src/app/api/auth/users/[id]/route.ts:92` — `db.appUser.findUnique({ where: { id } })` — no `organizationId` scoping.
  - `src/app/api/auth/users/route.ts:41` — GET lists **all users across all orgs** (`findMany({ where })`, no org filter).
  - `src/app/api/auth/users/route.ts:162` — POST accepts a client-supplied `organizationId`: `organizationId: organizationId || payload.organizationId || null`.
- **Verified:** Handler read directly; proxy grants only `minRole: 'admin'` (`src/proxy.ts:170`), never tenancy. The sibling `revoke-sessions/route.ts:29–38` implements tenant isolation correctly — proving intent and that this surface was missed.
- **Attack:** Org A admin → `PUT /api/auth/users/<OrgB-admin-id>` with `{"password":"Evil12345!"}` → password reset + session revocation of a foreign tenant's admin (lines 118–133 perform exactly this). Cross-tenant user enumeration via GET list.
- **Recommended fix:** Scope every query by the session's organizationId (except super_admin); reject client-supplied `organizationId` for non-super-admins.

### C-2 · Privilege escalation: admin can mint an owner

- **Files:** `src/app/api/auth/users/route.ts:128–136`; `[id]/route.ts:107–116`.
- **Detail:** Only assignment of `super_admin` is gated. An `admin` (level 30) may create or promote to `owner` (level 40).
- **Attack:** Compromised plain admin creates an Owner account, or self-promotes a colluding viewer — escalating above their own authority.
- **Recommended fix:** Require `level(assigner) ≥ level(assignee)` unless super_admin.

### C-3 · Placeholder secrets pass production validation

- **Files:** working `.env` contains literal `REPLACE_WITH_*` values for `JWT_SECRET` (43 chars) and `ENCRYPTION_KEY` (28 chars); validators only check length ≥ 16 (`src/lib/auth.ts:27–33`, `src/lib/crypto.ts:25–35`). Verified programmatically (values not reproduced here).
- **Impact:** A copy-paste deployment ships with a publicly-known JWT signing secret → arbitrary admin token forgery. (`SUPER_ADMIN_PASSWORD` placeholder happens to fail the bootstrap strength regex.)
- **Recommended fix:** Reject values matching `REPLACE_WITH*` / known placeholders; add startup entropy checks; rotate current values.

---

## 4. HIGH FINDINGS

### H-1 · Fake persistence claims in Insights

- `src/components/insights/insight-card.tsx:243–253` — "Create Alert" toasts success but only marks the insight acknowledged; **no alert row is ever created** (no POST to `/api/alerts`).
- `src/components/insights/insights-page.tsx:848–855` — "Take Action" fires only a toast ("Action noted"), persists nothing.

### H-2 · Destructive actions without confirmation dialogs

| Action | Location |
|---|---|
| Delete Device | `device-table.tsx:124` |
| Delete Department | `department-table.tsx:77` |
| Archive Employee (row menu) | `employee-table.tsx:148` |
| Bulk Archive Employees | `employees-page.tsx` bulk bar |
| Archive Employee (details page) | `employee-details-page.tsx:545` |
| Delete app-list policy entry | `policies-page.tsx:349–352` |
| **Publish consent policy** (forces org-wide re-consent!) | `consent-page.tsx:697–699` |
| Delete consent policy draft | `consent-page.tsx:700–702` |
| Remove project member | `projects-page.tsx:1919–1927` |
| Reject guest claim / approve-as-guest | `guests-page.tsx:402–407` |
| Suspend guest | `guests-page.tsx:442–444` |

Several combined with H-3 → a misclick permanently archives/deletes with zero friction *and* a lying success toast.

### H-3 · ~18 false-success mutations (missing `res.ok` checks)

Representative sites:

- `employees-page.tsx:135–144` (row archive), `:167–182` (bulk archive — prints `"undefined employee(s) archived"` on API error)
- `employee-details-page.tsx:361–391` (export loop false-success on page-1 failure), `:393–402` (archive)
- `departments-page.tsx:67–76` (delete)
- `devices-page.tsx:109–119` (delete)
- `notifications-page.tsx:220–228` (markAllRead), `230–237` (markRead), `239–247` (archive), click-to-read
- `alerts-page.tsx:147–151` (status), `212–250` (bulk uses raw fetch — HTTP errors don't reject)
- `screenshots-page.tsx:287–301` (analyze), `303–320` (flag), `345–364` (batch — renders `"Analyzed undefined of NaN screenshots"`)
- `ai-provider-page.tsx:288–296` (shows BOTH "Failed to update setting" AND "Configuration saved")
- `use-pdf-download.ts:44–48` + consumers — PDF download failures completely silent

### H-4 · Web login brute-force posture

- `src/app/api/auth/login/route.ts:25–34` — bucket key `login:${clientIp}:${email}` → IP rotation defeats it; no account lockout for AppUser (agent accounts have 5-strikes/15-min lockout). Uniform error messages ✅ prevent enumeration.

### H-5 · Broken npm scripts referencing nonexistent package

- `package.json:33–37`: `dev:agent`, `build:agent`, `package:agent`, `test:agent`, `typecheck:agent` all point at `omnisight-agent/` which does not exist. `DESKTOP-AGENT.md` and `ARCHITECTURE.md` still document it.

### H-6 · Revoked-session enforcement skipped on sensitive routes

- `verifyJWT` used instead of `verifySessionToken` in:
  - `auth/users/route.ts:16,102`
  - `upload/avatar/route.ts:21`
  - `import/[type]/route.ts:364`
  - `self-guard.ts:21` (entire `/api/self/*` family)
- Logout/disable doesn't reliably kill these sessions; legacy stateless tokens remain valid there.

---

## 5. MEDIUM FINDINGS

| # | Finding | Location |
|---|---|---|
| M-1 | Self-portal anomaly filter uses wrong enums (`open/dismissed` vs canonical `detected/investigating/resolved/false_positive`) → always 0 rows | `self-portal-page.tsx:878–883` vs `self/anomalies/route.ts:24,35` |
| M-2 | UTC-shift date bug: `toISOString().split('T')[0]` picks yesterday's report in UTC+ zones before 06:00 — same bug class already fixed elsewhere in the codebase | `daily-report.tsx:533,543`, `reports-page.tsx:237–238` |
| M-3 | Query-key mismatches defeat realtime invalidation: drawer uses `['employee-detail',id]`, WS invalidates `['employee-details',id]`; avatar upload invalidates nonexistent `['employee',id]` | `employee-detail-drawer.tsx:157,242` vs `ws-invalidation.ts:36,50,61` |
| M-4 | Live Monitor swallows 2 event types (`alert-event`, `project-time-update` logged but excluded from filter set — invisible, no chip exists) | `websocket-provider.tsx:166,531–575` vs `live-monitor-page.tsx:46–56` |
| M-5 | Security page stat cards computed from first 50 alerts only; no pagination exists to reach more | `security-page.tsx:217,231–233` |
| M-6 | Policies whitelist/blacklist counts under-report beyond 100 entries (single fixed page) | `policies-page.tsx:194,204–205` |
| M-7 | AI-provider settings PUT fired on every keystroke/slider tick — request storm + last-write-wins races | `ai-provider-page.tsx:685,837` |
| M-8 | Missing error states → misleading zeros/empty states on failure: analytics main+compare, audit log, devices fleet overview, activities stats, employee statistics, settings sections, daily report history | group-audit §5 references |
| M-9 | `/api/import/[type]` mutation has no handler-level role check (proxy-only protection) | `import/[type]/route.ts:358–367` |
| M-10 | Schema issues: `Project.hourlyRate Float` (money-in-float); missing composite indexes `Screenshot(org,capturedAt)`, `Device(org,updatedAt/status)`, `Employee(org,status/createdAt)`, `Report/AiInsight/SentimentRecord(org,createdAt)`; `AppListEntry` unique includes Boolean `isActive` → re-adding a deactivated app throws P2002; `AppUser.email @unique` global blocks multi-tenant emails; Org→Consent(Cascade)→ConsentLog(Restrict) deadlock latent | `schema.prisma:1059, 771–804, 195–233, 97–165, 576–595, 599–617, 1236–1263, 828, 623, 977/1001` |
| M-11 | Dangling references without FKs: `AgentToken.deviceId`, `UsbEvent.*`, `PolicyViolation.*`, `Notification.employee/deviceId` → orphaned rows on device delete; `Employee.guestId` FK added then dropped in migrations (stale comment at `guests.ts:128`) | schema audit §2 |
| M-12 | Sidebar shows hardcoded "All systems operational" (never queries `/api/health`) | `app-sidebar.tsx:298–319` |
| M-13 | Welcome banner labels total headcount as "**active** employees" | `welcome-banner.tsx:68,102` |
| M-14 | Notifications quick-action "View" button no-op for non-employee entity types | `notifications-page.tsx:736–745` |
| M-15 | Employee export loop: no pending guard (concurrent loops on double-click); page-1 failure still exports 0 rows with success toast | `employee-details-page.tsx:361–402` |
| M-16 | Enrollment-code management backend-complete but has **zero frontend callers** (no display/copy/regenerate UI anywhere) | `organization/enrollment-code/route.ts` unused by UI |
| M-17 | Consent logs export absent on both sides despite feature framing | `consent-page.tsx:1199–1252`, `export/[type]/route.ts:486–496` |
| M-18 | Agent-approvals surfaces raw machine error `ACTIVE_DEVICE_EXISTS` to users | `agent-approvals-page.tsx:996` vs `approve/route.ts:166` |
| M-19 | Sidebar unread badge fetched once on mount; bell polls every 30s → counts diverge | `app-sidebar.tsx:169–182` |
| M-20 | Guest rejected/revoked tab merges statuses client-side within one 20-row page → incomplete totals | `guests-page.tsx:163–167` |
| M-21 | No per-row pending/disabled guard on guest-tab mutations and agent-account toggle (double-fire risk) | `guests-page.tsx:442`, `agent-account-card.tsx:100–115` |
| M-22 | Details-page archive doesn't invalidate `['employees']` → list shows archived employee up to 30s staleTime | `employee-details-page.tsx:393–402` |

---

## 6. LOW FINDINGS

| # | Finding | Location |
|---|---|---|
| L-1 | Agent bearer tokens/sessions stored plaintext (DB leak yields live credentials) | `agent/auth.ts:108` |
| L-2 | CSP `'unsafe-inline'` scripts; `connect-src ws:` permits plaintext WebSocket to any host | `next.config.ts:16–26` |
| L-3 | Token generator modulo bias (~negligible at 64-char length) | `agent/auth.ts:199–203` |
| L-4 | `seed-demo.ts` fallback password `admin1234` (triple-gated dev-only; absent from committed env files) | `seed-demo.ts:233` |
| L-5 | `/api/notifications/types` GET unauthenticated at handler level (static registry, proxy-only) | `notifications/types/route.ts:5–9` |
| L-6 | Dead helper `getOrgId()` prefers client-supplied org id — IDOR trap if ever used | `lib/api.ts:172–175` |
| L-7 | Invalid model IDs hardcoded in AI catalog (`gemini-3.5-flash` etc.) — persisting them breaks test-connection | `ai-provider-page.tsx:97–100` |
| L-8 | Duplicate CSV serializers ×4 | `csv-export.ts`, `export.ts`, `reports/[id]/csv`, `bulk-import-dialog.tsx:198` |
| L-9 | Duplicate date formatters ×7 despite central `timezone.ts` | various |
| L-10 | Departments search client-side only over full list | `departments-page.tsx:78–83` |
| L-11 | `AgentRegistration.employeeId @unique` lifetime — rejected registrations can never be replaced by new rows | schema |
| L-12 | Zero Postgres enums; string statuses with mixed casing (Guest/AgentCommand uppercase vs lowercase elsewhere) | schema-wide |
| L-13 | Dashboard trend deltas deliberately empty (honest but reduces usefulness) | `kpi-cards.tsx:106–114` |
| L-14 | Root HTML doc artifacts clutter repo root | `OMNISIGHT-*.html` ×5 |
| L-15 | `xlsx@0.18.5` dependency lineage known-vulnerable — worth upgrading/pinning | `package.json:107` |
| L-16 | Activity table lacks denormalized `organizationId` → every org-scoped query pays an Employee join | `schema.prisma:321–349` |
| L-17 | Employee inline status change lacks pending guard (minor) | `employee-table.tsx:101–114` |

---

## 7. DEAD BUTTON / NON-FUNCTIONAL UI REPORT

| Page | Button/Action | Location | Expected | Actual | Root Cause | Severity |
|---|---|---|---|---|---|---|
| Insights | "Create Alert" | `insight-card.tsx:243–253` | Creates alert | Toast lies; nothing persisted | No POST to `/api/alerts` | HIGH |
| Insights | "Take Action" | `insights-page.tsx:848–855` | Records action | Toast only | Placeholder handler | MEDIUM |
| Live Monitor | Event stat tiles ("Click to hide/show") | `live-monitor-page.tsx:344–363` | Toggle visibility | Nothing (no onClick) | Cursor affordance without handler | MEDIUM |
| Employees | ⌘N shortcut hint | `employees-page.tsx:258–263` | Opens Add dialog | Shortcut doesn't exist | No dispatcher anywhere in app | LOW |
| Notifications | Quick "View" (device/anomaly/project entities) | `notifications-page.tsx:736–745` | Navigate to entity | No-op | Only `employee` branch implemented | MEDIUM |
| Sidebar | System-health indicator | `app-sidebar.tsx:298–319` | Reflects real health | Always green | Hardcoded text | MEDIUM |
| Employees | `worklens:add/edit-employee` event listeners | `employees-page.tsx:44–73` | React to dispatched events | Never fire | No dispatchers exist anywhere | LOW |
| Employee drawer | Avatar-upload data refresh | `employee-detail-drawer.tsx:242` | Refresh drawer/list data | Invalidates nonexistent key | Wrong query key `['employee',id]` | MEDIUM |
| Agent acct dialog | `employeeName` prop | `agent-account-dialog.tsx:11–22` | Display context | Unused | Dead prop | LOW |

---

## 8. MOCK / FAKE DATA REPORT

| Feature | File | Fake Data Source | Production Impact |
|---|---|---|---|
| **None found** | — | — | — |

Verification notes:

- All charts/dashboards/analytics traced to Prisma aggregations (`/api/dashboard`, `/api/analytics` groupBy/raw SQL, `/api/devices/chart-data`, `/api/live-monitor/event-stats`).
- Seed scripts (`seed.ts`, `seed-demo.ts`) are CLI-only, triple-gated (`argv` match + `NODE_ENV !== 'production'` refusal + `SEED_ALLOWED=1`, which appears in **no** committed env file).
- Dashboard trend deltas deliberately empty strings rather than invented percentages (`kpi-cards.tsx:106–114`).
- Sentiment/AI features explicitly label "Rule-based" vs "AI-generated", refuse to fabricate scores when there is no data (`sentiment/analyze/route.ts:514–533`, `ai-insights/data-summary.ts:110`).
- Live Monitor latency renders `—` rather than a fabricated number until a real ping responds.
- The only `Math.random()` producers are dev-gated seed scripts and verify-* probe scripts (never bundled).

**This is the cleanest mock-data profile auditable — a dashboard defect from fake data was NOT found.**

---

## 9. DEAD CODE REPORT

### Genuinely dead (zero references anywhere — verified by full-corpus scan)

| File | Symbol | Type | Recommendation |
|---|---|---|---|
| `src/lib/api.ts:172` | `getOrgId` | function | Delete (IDOR trap if ever used) |
| `src/lib/api.ts:164` | `getSearchQuery` | function | Delete |
| `src/lib/api.ts:48` | `apiCreated` | function | Delete |
| `src/lib/api.ts:52` | `apiNoContent` | function | Delete |
| `src/lib/api.ts:90` | `withAuth` (HOF) | legacy auth wrapper | Delete — superseded by `require*Org` family |
| `src/lib/api.ts:106` | `withAuthAndRole` (HOF) | legacy auth wrapper | Delete |
| `src/lib/navigation.ts:69` | `filterPagesByRole` | function | Delete |
| `src/lib/agent-account.ts:137` | `getAgentAccountByAgentId` | async function | Delete |
| `src/lib/auth.ts:263` | `getSuperAdminCredentials` | function | Delete (env read directly elsewhere) |
| `src/lib/csv-export.ts:47` | `exportReportToCSV` (+ private helper) | function | Delete |

### Test-only (alive in tests, unreachable from app build)

| File | Symbol/Module | Lines | Classification |
|---|---|---|---|
| `src/lib/policies/resolver.ts` | whole module | 137 | Imported only by `tests/policy-management-hardening.test.ts` |
| `src/lib/policies/normalize.ts` | whole module | 77 | Transitively test-only via resolver |
| `src/lib/brand.ts` | whole module | 17 | Test-only branding constants |

### Obsolete / superseded

| File | Type | Note |
|---|---|---|
| `src/hooks/use-toast.ts` (165 ln) + `src/components/ui/toaster.tsx` (32 ln) | shadcn toast stack | Production mounts sonner directly (`app/layout.tsx:5`); 40+ components import sonner |
| `src/components/ui/sonner.tsx` (21 ln) | wrapper | Nothing imports it |
| `src/components/ui/{accordion, carousel, context-menu, hover-card, input-otp, menubar, navigation-menu, resizable}.tsx` | shadcn primitives | Unused boilerplate scaffolding (~900 lines total with toast trio) |

### Planned / incomplete

| File | Symbol | Note |
|---|---|---|
| `src/components/employees/employee-identity.tsx` (58 ln) | `EmployeeIdentity` | Built ahead of adoption ("future surfaces should render through this") — adopt or delete |

### Infrastructure / stale references

| Item | Finding |
|---|---|
| `package.json:33–37` agent scripts | All 5 broken — directory doesn't exist; tsconfig excludes phantom path; docs describe it |
| Root HTML files (`OMNISIGHT-ALL-IN-ONE.html` etc., ×5) | Mermaid doc visuals — never imported; move to `docs/` |
| TODO/FIXME/HACK comments | **Zero genuine hits** in src/ |
| Commented-out code blocks >5 lines | **None found** |

**Dead code total: ~1,100 lines across ~20 items.**

---

## 10. API ↔ UI MISMATCH REPORT

**Result: ZERO mismatches found.**

Every referenced endpoint across all 27 admin pages was cross-checked against actual route files under `src/app/api/**` with HTTP methods and request/response shapes. Highlights verified:

- Employees: full param set (`page/pageSize/search/status/role/deviceStatus/date-range/sort whitelist`) honored server-side.
- Activities summary shape (`summary.total/totalDuration/productiveTime/unproductiveTime`) matches UI consumption exactly.
- Export dialog `/api/export/[type]?format=csv|xlsx&columns&from&to` validates everything server-side.
- PDF endpoints are POST-only and the hook uses POST correctly.
- Notifications PUT body keys, batch actions, preferences override/revert semantics all match.
- Reports CSV/JSON/PDF/HTML flows return consumed shapes precisely.
- Device commands allowlist (`webcam.start/stop`) matches webcam panel usage.
- Live-monitor `range=today|24h|7d` matches UI options identically.

Feature-absence findings (not mismatches): enrollment-code UI absent (M-16), consent logs export absent (M-17).

---

## 11. DATABASE / PERSISTENCE REPORT

Every traced mutation writes real rows. Persistence architecture highlights:

- Approval flows use transactions + `SELECT FOR UPDATE` row locks (`lib/agent/activation.ts:114`, `discover/route.ts:270`, claim-approve routes).
- All 14 `.upsert()` call sites target models with backing unique constraints — no upsert race risk.
- Partial unique indexes (hand-written SQL) protect break-session and guest lifecycles.
- Retention jobs distinguish operational deletes from compliance anonymization (AuditLog/ConsentLog anonymize-only).
- Settings upserts write SystemSetting/OrganizationSetting rows with audit entries.

Structural risks (see M-10/M-11):

1. Missing org+time composite indexes on the busiest list endpoints (Screenshot, Device, Employee, Report, AiInsight, SentimentRecord).
2. Money stored as Float (`Project.hourlyRate`).
3. `AppListEntry` unique-with-Boolean flaw → P2002 on re-add after deactivate.
4. Global `AppUser.email @unique` blocks multi-tenant email reuse.
5. Latent Org→Consent→ConsentLog cascade-vs-Restrict deadlock (only triggers on org hard-delete, which production code currently never performs).
6. FK-less reference columns accumulate orphaned IDs after device deletion (AgentToken, UsbEvent, PolicyViolation, Notification, Alert).
7. `Employee.guestId` FK added then dropped across migrations — bare TEXT pointer with a stale explanatory comment.

**Live restart-persistence test: UNVERIFIED — BLOCKED BY DEPENDENCY (database unreachable from audit environment).**

---

## 12. AUTH/RBAC REPORT

### Strong (verified in code and live where possible)

- httpOnly SameSite=Lax cookie + memory-only JWT (token never touches localStorage) — `store.ts:74–83`.
- Server-authoritative `UserSession` rows revalidated in proxy; logout/disable/password-change revoke live sessions — `session.ts`.
- CSRF Origin-vs-Host check on all mutating requests — `proxy.ts:270–284`.
- Central fail-closed PG-backed rate limiting — `proxy.ts:33–88` (verified live: DB-down ⇒ 429, not open access).
- Uniform anti-enumeration login errors; bcrypt cost 12; alg-conflict & future-iat rejection in `verifyJWT`.

### Live verification results (this environment)

| Probe | Result |
|---|---|
| 19 protected route families, no auth | **all 401** ✅ |
| Forged JWT `alg:none` (Bearer) | 401 ✅ |
| Forged JWT bad signature (Bearer) | 401 ✅ |
| Forged cookie `worklens_token=<alg:none token>` | 401 ✅ |
| `/api/health` during DB outage | 200 JSON ✅ (per AGENTS.md expectation) |
| `/api/auth/login` during DB outage | 429 JSON (fail-closed) ✅ secure / ❌ unavailable |

### Broken

- C-1 cross-tenant user administration (critical).
- C-2 admin→owner escalation (critical).
- H-4 IP-rotatable login rate limit + no AppUser lockout.
- H-6 `verifyJWT`-instead-of-`verifySessionToken` call sites bypass revocation checks.

Viewer→manager→admin escalation otherwise correctly blocked (proxy RBAC + per-handler role wrappers verified per route); only `/api/import` relies solely on the proxy (M-9).

---

## 13. SERVICE APP / DEVICE MANAGEMENT REPORT

End-to-end enrollment trace **verified in code as genuinely transactional**:

1. Agent discovers itself → `POST /api/agent/discover` creates DeviceClaim (+Device) using enrollment-code hash.
2. Admin queue lists claims (`?summary=true` counts) — `agent-approvals-page.tsx:210–251`.
3. **Approve as employee**: transaction with row-locked employee, guarded pending→approved transition, one-active-device enforcement, device binding online, `agentApproved=true`, ProjectMember upserts, audit log, notification (`[id]/approve/route.ts:149–257`).
4. **Approve as guest**: locks Device+Organization rows, enforces guest cap, creates Guest + synthesized guest-backed Employee, auto-grants monitoring consents through the audited state machine, fails closed without a published policy (`:262–402`).
5. Reject/Revoke write rejectionReason/revokedAt + deactivation; cancel is device-initiated (claim-secret constant-time verified).
6. Legacy registration path also creates a real Device row.

Agent authentication posture:

- Hashed claim secrets w/ constant-time compare; 64-char opaque 24h AgentTokens bound to employee+device; revalidated (expiry, approval, status, liveness) on EVERY request; command polling device-bound + allowlist-only (webcam start/stop) + atomically claimed (no replay); webcam sessions re-check command ownership and consent/config. Spoofing another device is not possible via token-bound filtering.

Gaps: enrollment-code UI absent (M-16); plaintext agent tokens (L-1); raw machine error surfaced (M-18).

**Live agent-flow testing: UNVERIFIED — BLOCKED BY DEPENDENCY.** (A local monitoring agent was observed hitting the running server during the audit and receiving correct fail-closed 429/401 responses during the DB outage.)

---

## 14. RESPONSIVE / UI REPORT

Static review findings:

- Mobile sidebar sheet + hamburger (`page.tsx:123–127`), `useIsMobile` breakpoint hook used across sidebar/table/header.
- Tables wrapped in `overflow-x-auto` (verified `employee-table.tsx:305` pattern).
- Skip-to-content link with visible focus state (`page.tsx:87–92`).
- Footer links collapse on mobile (`hidden md:flex`).
- Touch targets generally ≥ standard sizes via shadcn primitives.

**Live viewport matrix testing (360×800 → 1920×1080): PARTIAL — BLOCKED BY DEPENDENCY** (cannot authenticate without reachable DB). Repo contains prior coverage tooling (`scripts/mobile-matrix.mjs`).

---

## 15. BUILD / RUNTIME ERRORS

| Check | Result |
|---|---|
| `npm run build` (production) | ✅ EXIT 0 — all ~140 routes compiled; Proxy(Middleware) registered |
| `npx tsc --noEmit` | ✅ EXIT 0 |
| `eslint .` | 6 errors — **all** in `tests/e2e/fixtures.ts` (Playwright `request.use()` misread as React hook); src/ clean; 335 warnings (unused test vars) |
| Runtime console (dev boot) | No hydration/build errors observed; graceful DB-down handling (fail-closed 429, JSON errors, no HTML 404 pages — matches AGENTS.md expectations) |
| Test suites (`tsx --test`, Playwright) | UNVERIFIED — require live Postgres |
| Dependency notes | 5 broken agent scripts (H-5); `xlsx@0.18.5` worth upgrading (L-15) |

---

## 16. COMPLETE FEATURE MATRIX

| Feature | UI | Handler | API | Backend Logic | DB | End-to-End | Status |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Login/logout/session | ✅ | ✅ | ✅ | ✅ | ✅ | LIVE✓ (unauth probes) / rest blocked | PASS |
| Dashboard KPIs/charts/feed | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PASS |
| Employees CRUD/search/filter/paginate/export | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (archive toasts lie — H-3) |
| Departments CRUD | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (delete unconfirmed + lying toast) |
| Devices CRUD + fleet charts | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (delete unconfirmed + lying toast) |
| Device enrollment/approve/reject/revoke | ✅ | ✅ | ✅ | ✅ tx+locks | ✅ | code-verified | PASS |
| Guests lifecycle | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (reject/suspend unconfirmed) |
| Activities timeline/stats | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (silent errors, no empty state) |
| Analytics/comparison | ✅ | ✅ | ✅ | ✅ SQL | ✅ | code-verified | PARTIAL (silent errors) |
| AI Insights + provider config | ✅ | ✅ | ✅ | ✅ honest fallback | ✅ | code-verified | PARTIAL (fake Create-Alert/Take-Action) |
| Notifications (+prefs/batch) | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (false successes; View dead for some types) |
| Alerts triage/bulk/severity | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (false successes) |
| Audit logs + CSV export | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (silent errors) |
| Settings (global/monitoring/retention) | ✅ | ✅ | ✅ | ✅ upsert+audit | ✅ | code-verified | PASS |
| Reports generate/CSV/JSON/PDF/HTML/daily | ✅ | ✅ | ✅ | ✅ pdfkit | ✅ | code-verified | PARTIAL (UTC-shift bug; silent PDF failures) |
| Export/import (csv/xlsx) | ✅ | ✅ | ✅ | ✅ validated | ✅ | code-verified | PASS |
| Screenshots gallery/OCR/flag/analyze/delete | ✅ | ✅ | ✅ | ✅ consent-gated | ✅ | code-verified | PARTIAL (false-success analyze/flag/batch) |
| Break status + admin toggle | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PASS |
| Policies app-list/USB/violations | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (unconfirmed delete; counts under-report) |
| Anomalies detect/triage | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PASS |
| Consent policies/lifecycle/bulk | ✅ | ✅ | ✅ | ✅ state machine | ✅ | code-verified | PARTIAL (publish/delete unconfirmed) |
| Projects/members/time-entries/sentiment | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (member removal unconfirmed) |
| Live monitor (WebSocket) | ✅ | ✅ | ✅ socket.io | ✅ | ✅ | transport verified in code | PARTIAL (2 event types swallowed) |
| Security page | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (>50 alerts unreachable) |
| Self portal (breaks/consents/projects) | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PARTIAL (anomaly filter broken enums) |
| Organization mgmt + first-run bootstrap | ✅ | ✅ | ✅ | ✅ | ✅ | code-verified | PASS |
| User management | ✅ | ✅ | ✅ | ❌ no tenancy | ✅ | code-verified | **FAIL (C-1/C-2)** |

---

## 17. PRIORITY FIX PLAN

### P0 — Fix immediately

1. **C-1:** Org-scope every query in `/api/auth/users/**` by session organizationId (super_admin exempt); reject client-supplied `organizationId` for non-super-admins.
2. **C-2:** Enforce `level(assigner) ≥ level(assignee)` unless super_admin.
3. **C-3:** Reject `REPLACE_WITH*`/placeholder secrets at startup; rotate current `.env` values.
4. Add `res.ok` checks + truthful error toasts to the ~18 handlers listed in H-3 (mechanical fix).

### P1 — Fix before production

1. Confirmation dialogs for all destructive actions (H-2 table) — especially consent-policy publish (org-wide impact) and device/department deletes.
2. Account lockout for web login (mirror the agent-auth 5-strikes pattern) + non-IP component in the rate-limit bucket key.
3. Switch remaining `verifyJWT` call sites to `verifySessionToken` (H-6 list).
4. Add handler-level role check inside `/api/import` (M-9).
5. Fix M-1 anomaly filter enums, M-2 UTC date handling, M-3 query keys, M-4 live-monitor event-type filters.
6. Fix or remove the fake Insight buttons (H-1).

### P2 — Fix before public release

1. Schema migration batch: composite indexes, `Decimal` hourlyRate, AppListEntry unique fix, FK/orphan policy decision, Postgres enum conversion.
2. Pagination for Security alerts / Policies lists / Guest tabs so stats can't under-report.
3. Debounce AI-provider settings saves (M-7).
4. Humanize machine error codes surfaced to users (M-18).
5. Enrollment-code management UI or explicit env-only documentation (M-16).
6. Consent logs export (M-17).
7. Wire sidebar health indicator to `/api/health` (M-12); fix "active employees" label (M-13).

### P3 — Cleanup / improvement

1. Delete ~1,100 dead lines per §9 tables.
2. Remove or restore the 5 phantom `omnisight-agent:*` npm scripts and stale docs references.
3. Consolidate CSV serializers and duplicate date helpers onto central modules.
4. Remove obsolete toast stack and unused shadcn primitives.
5. Move root HTML doc artifacts into `docs/`.
6. Upgrade `xlsx` dependency.

---

## 18. FINAL VERDICT

# **NOT PRODUCTION READY**

Primary blockers: cross-tenant administrative takeover (C-1), privilege escalation (C-2), deployable placeholder secrets (C-3), and a systemic truthfulness gap where the UI reports success for operations whose results were never checked (H-3). Everything else — architecture, integration discipline, anti-mock hygiene, security depth — is strong and worth preserving.

---

## 19. The Most Important Question

> *"If I click every visible button in the OmniSight Admin Panel, which buttons/actions will actually perform their promised operation, which will partially work, and which are dead/fake/broken?"*

### Actually work (traced UI → handler → API → DB)

Login/logout; employee create/edit/search/filter/sort/paginate/export; department & device create/edit; the entire device-enrollment approval pipeline (approve-as-employee, approve-as-guest, reject, revoke — transactional with row locks); guest suspend/reactivate/revoke/convert (revoke confirmed); projects/members/time-entries/archive/restore; consent policy lifecycle + bulk operations; break monitoring + admin force-toggle; anomaly triage; notification preferences/batch; alert severity/status changes; settings persistence (all three surfaces); report generation + CSV/JSON/HTML/PDF exports; bulk import with honest per-row errors; screenshot delete plumbing; global search/command palette; avatar upload; WebSocket live feeds; theme switching; guided tour.

### Partially work

Anything whose toast you're relying on — archiving employees (row/bulk/details), deleting departments/devices, marking notifications read/archived, resolving alerts (incl. bulk), analyzing/flagging screenshots, AI-provider saves, pre-set PDF downloads — these **mutate correctly when the API succeeds but show "Success" even when it fails**, so feedback cannot be trusted (and bulk variants print `undefined`/`NaN` messages on error). Analytics/audit/settings/devices views silently render zeros instead of errors on API failure. Live Monitor hides 2 of its 14 event types with no way to enable them. Self-portal anomaly filter returns nothing (wrong enum values). Security/Policies/Guest stat cards under-count past their first fixed page.

### Dead / fake / broken

Insights "Create Alert" (claims persistence, persists nothing); Insights "Take Action" (toast only); Notifications "View" for device/anomaly/project entities; Live-Monitor stat tiles ("Click to hide/show" — no handler); the advertised ⌘N shortcut; two orphaned custom-event listeners that nothing dispatches; the always-green "All systems operational" indicator; enrollment-code management (backend exists, no UI anywhere); consent-logs export (absent both sides).

And the most dangerous click of all: any button in **User Management** works exactly as promised — just against *any tenant in the system*, executable by any admin of any organization.

---

*End of report.*
