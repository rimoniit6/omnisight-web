# OmniSight — Feature Inventory

> Previously branded as **WorkLensAI** — technical identifiers from that era (cookie names, environment variables, native module names) are intentionally preserved for compatibility.

This document is the source-of-truth feature inventory for the OmniSight repository. Every feature is classified by its actual implementation state, verified against source code, the Prisma schema, API routes, tests, and certification reports in `docs/audits/`.

**Status categories**

| Status | Meaning |
|---|---|
| **Implemented** | Functionality exists in code and is verified by tests and/or certification reports |
| **Partial** | Functionality exists but has known gaps, inactive wiring, or best-effort behavior |
| **Experimental** | Exists but not considered production-ready |
| **Planned** | Referenced in plans/audits/registries but not implemented |
| **Not available** | Expected/important functionality that is absent |

---

## 1. Feature matrix (summary)

| Feature | Status | Notes |
|---|---|---|
| Web login (JWT + cookie) | Implemented | Custom HS256 JWT, `worklens_token` cookie |
| Role-based access control | Implemented | `super_admin`, `owner`, `admin`, `manager`, `viewer` |
| Multi-organization isolation | Implemented | Tenant identity from verified JWT only |
| Organization creation | Implemented | Org-less Super Admin bootstrap flow |
| Departments | Implemented | CRUD, manager, performance view |
| Employees (CRUD, bulk, import/export) | Implemented | Bulk archive, CSV/Excel import & export |
| Guests (zero-touch enrollment) | Implemented | PENDING/ACTIVE/SUSPENDED/REVOKED lifecycle, convert to employee |
| Devices | Implemented | Heartbeat-based status, lifecycle statuses |
| Device claims (zero-touch) | Implemented | Discover → approve/reject/cancel/revoke |
| Agent registrations (legacy path) | Implemented | Register → admin approve/reject |
| Agent accounts (agent login) | Implemented | `agentId`/password, lockout, admin-managed |
| Agent software build | Implemented | `POST /api/agent-software/build` (NSIS installer, server URL baked) |
| Enrollment code | Implemented | Org-scoped, SHA-256 hashed, returned once |
| Activity tracking (app/website/idle) | Implemented | Domain-only website URLs |
| Website tracking (browser extension) | Partial | Best-effort (`websiteNativeTracking` opt-in) |
| Keyboard telemetry | Implemented | Aggregate counts only; raw keys never stored |
| Location telemetry | Implemented | Coordinates only; no addresses |
| Webcam (on-demand) | Implemented | Live relay, frames never persisted |
| USB event monitoring | Implemented | Insert/remove events, dedupe |
| Screenshot capture | Implemented | PNG/JPEG/WebP, magic-byte validation |
| Screenshot OCR search | Implemented | Search over stored OCR text |
| Screenshot AI analysis | Implemented | Vision model, batch <= 10 |
| Screenshot flagging | Implemented | `flagged` + `flagReason` |
| Break / privacy mode | Implemented | Agent, admin, portal sources; canonical `BreakSession` |
| Consent management | Implemented | 8 types, granted/denied/revoked/expired |
| Consent policies (versioned) | Implemented | draft/published/archived, versioned re-consent |
| Consent expiry job | Implemented | Hourly `expire_consents` |
| Monitoring configuration | Implemented | Per-org `OrganizationSetting`, fail-closed defaults |
| App whitelist/blacklist | Implemented | `AppListEntry`, policy version, agent enforcement |
| Policy violations | Implemented | Agent-reported, dedupe, optional process termination |
| Anomaly detection | Implemented | 4 auto rules + manual/agent-reported types |
| Alerts | Implemented | Severity, status, escalation, realtime |
| Notifications | Implemented | 4 active producers; 12 registered types |
| Notification preferences | Implemented | Org-level enable/disable per type |
| Audit logs | Implemented | login/logout/create/update/delete/export/configure |
| AI provider configuration | Implemented | 6 providers, BYOK, encrypted keys |
| AI insights | Implemented | AI analysis with honest data-summary fallback |
| Sentiment analysis | Implemented | Rules fallback, project-scoped |
| Daily report + AI summary | Implemented | On-demand |
| Reports (generate/export) | Implemented | productivity/attendance/activity/department/device/employee |
| PDF reports | Implemented | dashboard/activity/audit/employee/project |
| Dashboard | Implemented | KPIs, charts, live activity ticker |
| Analytics + comparison | Implemented | Period & department comparison |
| Live monitor | Implemented | Realtime event stream, sounds, filters |
| Realtime (WebSocket) | Implemented | Socket.IO mini-service, org rooms |
| Presence | Implemented | Heartbeat-derived, realtime + snapshot |
| Projects | Implemented | Members, time entries, sentiment, restore |
| Project auto time sync | Implemented | Activity → `TimeEntry` (source `ACTIVITY_AUTO`) |
| Employee detail panels | Implemented | Overview/Activity/Websites/Timeline/Keyboard/Location/Webcam/Devices/Alerts |
| Employee Portal (manager view) | Implemented | Self-portal pages are manager/admin views |
| Data retention jobs | Implemented | Per-org retention, anonymization |
| Import (bulk) | Implemented | Employees, projects, time-entries (.csv/.xlsx/.xls) |
| Export | Implemented | CSV + Excel for 4 types |
| Search | Implemented | Employees/departments/devices (command palette) |
| Avatar upload | Implemented | sharp-resized, employee/user |
| Onboarding tour | Implemented | 6-step, localStorage flag |
| Agent anomaly/tamper reporting | Partial | Server routes exist; agent-side wiring dormant |
| Agent auto-update | Partial | Update service exists; disabled without `WL_UPDATE_URL` |
| Agent native website tracking | Partial | Opt-in, best-effort; no exact active-tab guarantee |
| Employee self-service login | Not available | Employees have no login; portal is manager-view |
| Teams model | Not available | Departments only; no Team entity |
| Task/todo tracking | Not available | Projects + time entries only |
| Billing/seats | Not available | Seat limits were removed from schema |
| 2FA / MFA | Not available | Dead settings removed; not implemented |
| Email/SMS/push notifications | Not available | In-app only |
| Scheduled (automatic) AI analysis | Not available | AI is on-demand only |
| Non-Windows agents | Not available | Windows-only desktop agent |
| Full-URL website tracking | Not available | Domain-only by design |
| Raw keystroke capture | Not available | Aggregate-only by design |
| Webcam recording/storage | Not available | Live relay only; frames never persisted |
| Microphone capture | Not available | No implementation anywhere |

---

## 2. Detailed feature inventory

### 2.1 Authentication

**Web login / JWT sessions — Implemented**

- Custom JWT implementation (HS256 via Web Crypto), no external JWT library (`src/lib/auth.ts`).
- Cookie: `worklens_token` (env `SESSION_COOKIE_NAME`), `httpOnly`, `SameSite=Lax`, `secure` in production, 7-day maxAge (`JWT_EXPIRES_IN`, default `7d`).
- Login: `POST /api/auth/login` — rate-limited (10/5 min per IP+email), bcryptjs (cost 12) verification, audit log entry, uniform `401 Invalid email or password`.
- Sliding refresh: `POST /api/auth/refresh-token` (role/org re-read from DB). Logout: `POST /api/auth/logout` (idempotent, clears cookie).
- Change password: `POST /api/auth/change-password` (policy: ≥ 8 chars + upper + lower + digit + special).
- Roles (`AppUser.role`): `super_admin | owner | admin | manager | viewer` (default `admin`).
- Verified by: `tests/security.test.ts`, `tests/super-admin.test.ts`, `tests/multi-org-isolation.test.ts`.

**Super Admin bootstrap — Implemented**

- `npm run bootstrap:super-admin` (`scripts/bootstrap-super-admin.ts`), driven by `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` (policy: ≥ 12 chars + upper + lower + digit).
- Idempotent — never overwrites an existing account; creates no demo data; org-less until an organization is created.

**Agent login (AgentAccount) — Implemented**

- `POST /api/agent/login` with `{agentId, password}` → opaque 64-char `AgentSession` (24 h TTL). Lockout: 5 failures → 15 min.
- AgentAccounts are **admin-created only** (never employee self-registration); default `agentId` = employee's `employeeId`.
- Password policy: ≥ 12 chars + upper + lower + digit. Legacy plaintext hashes auto-upgraded to bcrypt on first successful verify.
- Verified by: `tests/agent-auth-login.test.ts`, `tests/agent-account.test.ts`, `tests/agent-account-admin.test.ts`.

**Agent device authentication — Implemented**

- `POST /api/agent/authenticate` — Path A: `{deviceId, deviceSecret}` from an approved DeviceClaim; Path B (legacy): `{employeeId, password}` against `Employee.agentPassword`.
- Issues device-bound `AgentToken` (64-char random, 24 h expiry, stored raw, unique).
- Single-active-device-per-employee rule enforced with `SELECT ... FOR UPDATE`; conflict → `409 ACTIVE_DEVICE_EXISTS`, zero mutation.
- Verified by: `tests/agent-hardening.test.ts`, `tests/agent-active-device-backend.test.ts`, `tests/agent-existing-device-security.test.ts`.

### 2.2 RBAC

- **Implemented.** Hierarchy: `super_admin` (50) > `owner` (40) > `admin` (30) > `manager` (20) > `viewer` (10); unknown roles = level 0 (denied everywhere).
- Enforcement: `src/proxy.ts` (auth + role-prefix rules + central rate limiting + CSRF origin check) plus per-route helpers in `src/lib/api.ts` (`requireAdminOrg`, `requireManagerOrg`, `requireSessionOrg`, `requireSuperAdmin`).
- Cross-org resources → **404** (concealment); cross-org references on writes → **422**; client-supplied `organizationId` is always ignored.
- Org-less Super Admin: global reads on opted-in routes; empty dashboard/analytics/search; cannot mutate org rows; the only role that can create an organization.
- UI navigation filtering is UX-only; the API is authoritative.

### 2.3 Admin console pages

| Page | Route key | Min role (UI) | Status |
|---|---|---|---|
| Dashboard | `dashboard` | viewer | Implemented |
| Employees | `employees` | viewer | Implemented |
| Employee Details | `employee-details` | viewer | Implemented |
| Departments | `departments` | viewer | Implemented |
| Devices | `devices` | viewer | Implemented |
| Activities | `activities` | viewer | Implemented |
| Screenshots | `screenshots` | viewer | Implemented |
| Break Monitor | `break-status` | viewer | Implemented |
| Live Monitor | `live-monitor` | viewer | Implemented |
| Analytics | `analytics` | viewer | Implemented |
| AI Insights | `insights` | viewer | Implemented |
| Sentiment | `sentiment` | viewer | Implemented |
| AI Provider | `ai-provider` | admin | Implemented |
| Agent Approvals | `agent-approvals` | admin | Implemented |
| Guests | `guests` | admin | Implemented |
| Notifications | `notifications` | viewer | Implemented |
| Alerts | `alerts` | viewer | Implemented |
| Audit Logs | `audit` | viewer | Implemented |
| Agent Security | `security` | admin | Implemented |
| Policies | `policies` | viewer (read) | Implemented |
| Anomaly Detection | `anomalies` | viewer | Implemented |
| Consent | `consent` | manager | Implemented |
| Projects | `projects` | viewer | Implemented |
| Employee Portal | `self-portal` | manager | Implemented |
| Organization | `organization` | admin | Implemented |
| Reports | `reports` | manager | Implemented |
| Daily Report | `daily-report` | manager | Implemented |
| Settings | `settings` | admin | Implemented |

Navigation labels and sidebar groups: `src/lib/navigation.ts`, `src/components/layout/app-sidebar.tsx`.

### 2.4 Employee management

- Implemented: CRUD via `/api/employees` + `/api/employees/[id]`; fields firstName, lastName, email (unique per org), phone, designation, employeeId (unique), department, join/leave dates, status (`active|inactive|archived`), type (`employee|guest`), avatar.
- Implemented: bulk archive `POST /api/employees/bulk` (`action: 'archive'`).
- Implemented: employee detail endpoints `/api/employees/[id]/detail`, `/performance`, `/activities`, `/websites`, `/keyboard`, `/location`, `/webcam`, `/projects`, `/active-project`, `/agent-account` (+ `/agent-account/reset-password`).
- Implemented: `/api/employees/statistics`, `/api/employees/presence`, `/api/employees/search`, avatar upload (`/api/upload/avatar?type=employee&id=...`).
- Implemented: Agent Account card (create / reset / "Set up Agent Account" — the latter activates only migrated placeholder accounts, never a deliberately disabled one).

### 2.5 Devices

- Implemented: `/api/devices` (list, filters, status), `/api/devices/[id]`, `/api/devices/summary`, `/api/devices/chart-data`.
- Status model: stored lifecycle statuses `online|offline|inactive|maintenance|retired`; effective `online/offline` derived from heartbeat freshness (3 missed beats or 90 s) — `src/lib/device-status.ts`.
- Implemented: `/api/device-claims` + approve/reject/cancel/revoke. Revoke → device `inactive` → all bound agent tokens fail closed at `validateAgentToken`.
- Implemented (legacy path): `/api/agent-registrations` + approve/reject, `POST /api/agent/register`.

### 2.6 Zero-touch enrollment and guests

- Implemented: `POST /api/agent/discover` (Bearer AgentSession) creates a `Device` (status `inactive`) + pending `DeviceClaim` with a one-time secret (32 random bytes, only SHA-256 hash stored, 30-day expiry). Optional enrollment code binds an anonymous device to an org (`OrganizationSetting.agent_enrollment_code`, hashed).
- Implemented: `/api/device-claims/[id]/approve` — mode `employee` (binds an existing employee, device → online, `agentApproved=true`) or mode `guest` (creates a synthesized Employee with `type='guest'`, email `@guests.invalid`; **no AgentAccount**; standard monitoring consent (`monitoring` + `activity_tracking`) auto-granted at approval via the audited state machine, bound to the org's current published policies — types without a published policy are skipped fail-closed).
- Implemented: `/api/guests` + suspend/reactivate/revoke/convert. Statuses `PENDING → ACTIVE → REJECTED | REVOKED | SUSPENDED`. Convert preserves telemetry and flips `type` to `employee`.
- Verified by: `tests/zero-touch.test.ts`, `tests/guests.test.ts`, `tests/guest-approval-rbac.test.ts`.

### 2.7 Agent software build

- Implemented: `POST /api/agent-software/build` (admin, rate-limited 5/h, audited) → runs `omnisight-agent/scripts/build-prod.mjs` producing an NSIS installer with `AGENT_SERVER_URL` baked (validated: https always; http only loopback) and optionally `AGENT_ENROLLMENT_CODE`.
- Implemented: `GET /api/agent-software` (config + last/recent builds), `GET /api/agent-software/builds/[id]`, `GET /api/agent-software/builds/[id]/download` (artifact + SHA-256).
- Model: `AgentBuild` (`pending|building|completed|failed`); artifacts under `uploads/agent-builds/<org>/<buildId>.exe`.

### 2.8 Activity monitoring

- Implemented: `POST /api/agent/activity` — types `application|website|idle|work_session|screenshot`, categories `productive|neutral|unproductive|idle`, batch ≤ 100, duration ≤ 86400 s, future skew ≤ 5 min.
- Implemented: website privacy — bare registrable domains only (`normalizeWebsiteDomain`, `src/lib/domain.ts`); internal schemes rejected; titles sanitized; no full URLs stored, broadcast, or exported.
- Implemented: internal agent processes excluded from all analytics (`excludeInternalAgentActivities`, `src/lib/agent-process.ts`).
- Implemented: admin views `/api/activities`, `/api/activities/daily`, employee activities, analytics, reports.
- Verified by: `tests/website-tracking.test.ts`, `tests/website-100.test.ts`, `tests/activities-hardening.test.ts`.

### 2.9 Keyboard telemetry

- Implemented, aggregate-only: `POST /api/agent/keystroke` accepts only `intervalStart, intervalEnd, keystrokeCount, activeTypingSeconds, application`. Raw-key fields (`key`, `keyCode`, `character`, `char`, `text`, `typedText`, `clipboard`, `formData`, `ime`, `scanCode`, `virtualKey`) are rejected with 422; the `KeyboardActivity` model has no raw-data columns.
- Implemented: admin view `/api/employees/[id]/keyboard` — 1-minute buckets, per-application breakdown.
- Default **disabled** (`keystroke_logging_enabled=false`); requires `keystroke` consent.
- Verified by: `tests/telemetry-backend.test.ts`, `tests/admin-telemetry-backend.test.ts`.

### 2.10 Location telemetry

- Implemented: `POST /api/agent/location` — `latitude, longitude, accuracy, timestamp` only; address/reverse-geocoding fields rejected (422); accuracy ≤ 1,000,000 m.
- Implemented: admin view `/api/employees/[id]/location` (latest fix + history).
- Default **disabled** (`location_tracking=false`); requires `location` consent.

### 2.11 Webcam (on-demand)

- Implemented: admin sends `webcam.start` / `webcam.stop` via `/api/device-commands` (allowlist-only command types; default expiry 120 s, max 600 s, max payload 2048 B).
- Implemented: agent polls `/api/agent/commands` (atomic PENDING → DELIVERED), acks via `/api/agent/commands/[id]/ack`, streams JPEG frames (~10 fps) to `/api/agent/webcam/frame`.
- Implemented: frames relayed in-memory only (TTL 60 s, ≤ 16 sessions, `src/lib/webcam-relay.ts`) — **never persisted, logged, or analyzed**.
- Implemented: `WebcamSession` metadata rows with start/end reasons (`command|timeout|disconnect|consent_revoked|config_disabled|error|shutdown`); audit + notification on relevant endings.
- Requires `webcam_capture_enabled` config AND `webcam_access` consent; the server re-validates both at session start and at least every 5 s during streaming (the frame-relay gate interval).
- Verified by: `tests/webcam-request.test.ts`, `tests/webcam-ui-e2e.mjs`.

### 2.12 Screenshots

- Implemented: `POST /api/agent/screenshot` (FormData) — PNG/JPEG/WebP with magic-byte verification, ≤ 5 MB, UUID filenames; stored under `uploads/screenshots/`.
- Implemented: `/api/screenshots/[id]/image` — `nosniff`, private cache, org-scoped 404 concealment, path-traversal-safe.
- Implemented: `/api/screenshots` (filters, flagged), `/api/screenshots/stats`, `/api/screenshots/ocr-search`.
- Implemented: `/api/screenshots/[id]/analyze` (admin+), `/api/screenshots/batch-analyze` (≤ 10) — real vision-provider calls; honest 502 on failure; **no mock analysis**.
- Implemented: flagging (`flagged` + `flagReason`), delete (row + file together, audited).
- Implemented: retention (`screenshot_retention_days`, default 30) with physical-file-first deletion and orphan sweep.
- Verified by: `tests/screenshots.test.ts`, `tests/png-dimensions.test.ts`, `docs/audits/feature/...` certification reports.

### 2.13 Break / privacy mode

- Implemented: canonical open `BreakSession` (partial unique index — one open break per employee).
- Implemented sources: `agent` (`POST /api/agent/break`), `admin` (`/api/break-status/[id]/toggle`), `self_service` (via self/break-status route).
- Implemented: `GET /api/break-status` (list + `currentlyOnBreak`), `/api/break-status/summary` (org-timezone "today"), `/api/break-status/history` (paginated).
- Implemented: every mutation writes `BreakSession` + legacy `Activity` mirror row + `AuditLog` in one transaction.
- Verified by: `tests/break-hardening.test.ts`, `docs/audits/feature/break-monitor` certification.

### 2.14 Consent and consent policies

- Implemented: 8 consent types — exact strings: `monitoring`, `screenshot`, `activity_tracking`, `keystroke`, `usb_monitoring`, `webcam_access`, `location`, `email_monitoring`.
- Implemented: statuses `pending|granted|denied|revoked|expired`; transition machine with idempotent same-state repeats; every transition audited in `ConsentLog` (immutable, FK RESTRICT).
- Implemented: enforcement `hasActiveConsent` — fail closed when: no row, status ≠ granted, `expiresAt` lapsed, linked policy missing/archived/not published, or policy version ≠ `consentVersion`.
- Implemented: versioned `ConsentPolicy` (`draft|published|archived`, versions `v1`, `v2`, ...); granting binds to the current published policy; publishing v2 auto-archives v1 (existing consent becomes inert until re-consent).
- Implemented: admin bulk grant/revoke (`/api/consent/bulk`), logs (`/api/consent/logs`), summary (`/api/consent/summary`).
- Implemented: hourly `expire_consents` job flips expired grants (bounded 500 rows/run).
- Verified by: `tests/consent.test.ts`, `tests/consent-seed.test.ts`, `tests/consent-summary.test.ts`.

### 2.15 Monitoring configuration

- Implemented: per-org settings in `OrganizationSetting` only (no global fallback — `src/lib/jobs/settings.ts` registry):
  - `heartbeat_interval` (60 s default, clamp 10–600), `screenshot_enabled` (true), `screenshot_frequency` (10 min, 1–180), `app_tracking` (true), `website_tracking` (true), `idle_detection` (true), `idle_timeout` (5 min), `working_hours_only` (true), `work_start_time` 09:00 / `work_end_time` 18:00 (org timezone), `ai_anomaly_detection` (true, server-side only).
  - Fail-closed defaults: `location_tracking` false, `keystroke_logging_enabled` false, `webcam_capture_enabled` false, `website_native_tracking` false, `usb_monitoring` false, `app_policy_enforcement` false, `app_policy_terminate` false.
- Implemented: feature equation `enabled = config AND consent AND agent capability`.

### 2.16 App whitelist/blacklist and policy violations

- Implemented: `AppListEntry` (`whitelist|blacklist`, `isActive`, optional executableName/publisher/sha256/path identity); admin API `/api/app-list` + `[id]`; unique constraint per (org, app, listType, isActive).
- Implemented: deterministic resolver — blacklist match blocks (explicit deny wins), whitelist allows, else none; identity strength sha256 > exact path > publisher+name > executable name.
- Implemented: versioned policy payload (`app_policy_version` in `OrganizationSetting`, bumped in the same transaction as every policy write) shipped to agents via `GET /api/agent/config`.
- Implemented: agent enforcement + reporting (`POST /api/agent/policy-violations`); server accepts only `action: 'blocked'`; dedupe 5-min bucket; optional process termination only with `app_policy_terminate`; protected processes never terminable.
- Implemented: admin views `/api/policy-violations`, `/api/usb-events`.
- Verified by: `tests/policy-management-hardening.test.ts`, `tests/agent-process-exclusion.test.ts`.

### 2.17 Anomalies and alerts

- Implemented: auto-detected types (rule engine, org-timezone aware, `src/lib/anomalies/detect.ts`):
  - `productivity_drop` (7-day vs baseline ratio drop > 30%; skipped for new hires with < 5 baseline days)
  - `excessive_idle` (> 120 min idle today)
  - `unusual_login` (off-hours activity: > 5 off-window app activities AND > 50% ratio)
  - `low_activity_spike` (today < 30% of daily average and < 10 activities)
  - Other type values (`rapid_app_switch`, `overtime_work`, `policy_breach`, `unusual_screenshot`) exist for manual/agent-reported/legacy rows only.
- Implemented: `POST /api/anomalies/detect` (manager+), list/detail/update (statuses `detected|investigating|resolved|false_positive`), batch update, hourly `anomaly_detection` job; per-day dedupe keys.
- Implemented: high/critical detections create a `security` Alert + `anomaly_detected` notification with `/anomalies` deep link.
- Implemented: `/api/alerts` GET/PUT (severities `info|warning|error|critical`, statuses `pending|acknowledged|resolved|archived`).
- Verified by: `tests/anomaly-hardening.test.ts`, `tests/notification-alerting-hardening.test.ts`.

### 2.18 Notifications

- Implemented: 12 registered types (`src/lib/notifications/constants.ts`): `security`, `anomaly_detected`, `policy_violation`, `device_offline`, `new_employee`, `high_inactivity`, `license_expiration`, `ai_recommendation`, `consent_update`, `project_deadline`, `overtime_alert`, `system`.
- Implemented: **active producers**: `security` (agent register/discover/tamper, claim/registration approval, alerts), `anomaly_detected` (anomaly service + agent), `policy_violation` (agent), `new_employee` (employee creation). The remaining types are registered for UI consistency but have no producers.
- Implemented: org-scoped `NotificationPreference` (absent row = enabled; checked inside `createOrgNotification`), admin batch actions, mark-all-read, preferences API (manager+).
- Implemented: paginated list with unread count, stats by type/priority, 24 h recent count.
- Verified by: `tests/notification-alerting-hardening.test.ts`, `tests/live-ticker.test.ts`.

### 2.19 Audit logs

- Implemented: `/api/audit-logs` (filters action/resource, pagination) + `/api/audit-logs/export` (CSV, manager+).
- Implemented: actions `login|logout|create|update|delete|export|configure`; resources `employee|device|department|policy|settings|report|notification|alert`; immutable rows; `AuditLog.organizationId` nullable (org-less super admin actions still audited).
- Implemented: audit entries written by consent transitions, policy writes, command enqueues, break lifecycle, screenshot deletes, anomalies, alerts, user management, agent auth.

### 2.20 AI features

- Implemented: provider configuration (`/api/ai-provider/*`), 6 providers: `openai`, `anthropic`, `google`, `mistral`, `ollama`, `custom` (BYOK base URL). Keys entered by admin, encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`), never returned (GET redacts to `REDACTED`).
- Implemented: test-connection probe that persists config only on success; compatibility validation of provider/model/baseUrl; rate limit 10/min.
- Implemented: AI Insights (`/api/insights`, `/api/insights/ai-analysis`) — structured, schema-validated AI analysis; when the provider is unavailable/disabled/failing, a **deterministic Data Summary** from the same measured dataset is persisted and labeled honestly (`mode: DATA_SUMMARY`, no AI badge in UI).
- Implemented: Sentiment analysis (`/api/sentiment/*`, project-scoped variant) with rules-based fallback (`aiProviderUsed: 'rules'`), NULL score + `no-data` mood when no activity data exists.
- Implemented: daily report AI summary (`/api/reports/daily/ai-summary`) with per-error-code fallback copy and deterministic rating.
- Implemented: screenshot vision analysis (`analyze`, `batch-analyze`).
- Implemented: usage statistics (`/api/ai-provider/usage`) counting only rows that used a real provider (excludes `rules`/`none`).
- **Not available**: scheduled/automatic AI analysis (on-demand only).
- Verified by: `tests/ai-insights-ai.test.ts`, `tests/sentiment-fixes.test.ts`, `tests/project-sentiment.test.ts`.

### 2.21 Dashboard, analytics, comparison

- Implemented: `GET /api/dashboard` — KPIs (totalEmployees, totalDevices, onlineDevices via heartbeat freshness, avgProductivity, activeAlerts), recentActivities (10), topEmployees (5), departmentBreakdown, deviceStatusBreakdown, dailyProductivity (org-local days).
- Implemented: `/api/analytics?period=week|month|day` + date range (≤ 90 days) — productivityTrends, departmentProductivity, topApps (10), summary (workloadDistribution sums to 100).
- Implemented: `/api/analytics/compare` — periods mode (4 dates) and departments mode (2 departments, trailing-90-day fallback).
- Implemented: `/api/departments/performance` (avg/total productive hours, top performer, "Unassigned" bucket).

### 2.22 Projects and time tracking

- Implemented: `/api/projects` CRUD (status `active|on_hold|completed|cancelled`, priority, budget fields), search, stats, restore (`/api/projects/[id]/restore`).
- Implemented: members (`/api/projects/[id]/members`, roles `lead|member|reviewer|stakeholder`, hoursPerWeek), time entries (`/api/projects/[id]/time-entries`, categories `development|design|meeting|research|testing|review|admin`, billable, source `MANUAL|ACTIVITY_AUTO`).
- Implemented: **project time auto-sync** — background sync converts real `application`/`website` Activity into `TimeEntry` rows (`source: ACTIVITY_AUTO`) when an employee has exactly one active project membership (or an admin-selected `activeTrackingProjectId`); requires `activity_tracking` consent; idempotent via `ProjectTimeSync` unique keys + global cursor; runs every 60 s (`PROJECT_TIME_SYNC_INTERVAL_SECONDS`) + hourly job.
- Implemented: project sentiment (`/api/projects/[id]/sentiment`), project analytics (employee detail / analytics).
- Verified by: `tests/projects.test.ts`, `tests/projects-tracking.test.ts`, `tests/project-time-sync.test.ts`.

### 2.23 Realtime (WebSocket)

- Implemented: `mini-services/live-updates` — Socket.IO on `LIVE_UPDATES_PORT` (default 3010), run with Bun; JWT handshake (HS256, same `JWT_SECRET`); org-scoped rooms; 5 s cursor-based polling of 15 tables; transition-only emissions for device/registration/claim/guest/build status.
- Implemented: events `connected`, `device-status`, `employee-presence`, `activity-ping`, `notification`, `alert-event`, `break-status`, `break-started`, `break-ended`, `new-screenshot`, `agent-registration`, `device-claim`, `usb-event`, `project-time-update`, `anomaly`, `app-policy`, `policy-violation`, `guest`, `agent-build`, `device-summary`, `latency-pong`.
- Implemented: client provider (`websocket-provider.tsx`) with endpoint candidates (`NEXT_PUBLIC_LIVE_UPDATES_URL`, `/?XTransformPort=3010`, direct `:3010`), event log (80 entries), centralized React Query invalidation (`src/lib/ws-invalidation.ts`), latency probe.
- Implemented: Live Monitor page, live activity ticker, presence provider.
- Verified by: `tests/live-updates-cursor.test.ts`, `tests/live-monitor-event-stats.test.ts`, `tests/ws-invalidation.test.ts`.

### 2.24 Reports, exports, imports

- Implemented: report generation `POST /api/reports/generate` (types `productivity|attendance|activity|department|device|employee`; formats `pdf|csv|json|excel`), list `/api/reports`, per-report CSV/JSON export and PDF, stored `Report` rows.
- Implemented: pre-configured PDFs — `/api/reports/pdf/dashboard`, `/api/reports/pdf/activity`, `/api/reports/pdf/audit`, `/api/reports/pdf/employee`, `/api/reports/pdf/project`.
- Implemented: daily report `/api/reports/daily` + AI summary `/api/reports/daily/ai-summary` (rate-limited 10/min).
- Implemented: export `/api/export/[type]` — types `employees|activities|time-entries|projects`, CSV + Excel (xlsx), selectable columns.
- Implemented: import `/api/import/[type]` — same types, .csv/.xlsx/.xls, row-level error reporting, template download.
- Verified by: `tests/admin-prod-reports-rbac.test.ts`, `docs/audits/feature/daily-summary` certification.

### 2.25 Background jobs

- Implemented (`src/lib/jobs/`, scheduled hourly by default via `JOBS_INTERVAL_SECONDS`, also `npm run jobs`):
  - `expire_consents` — expire granted consents past `expiresAt` (bounded 500/run).
  - `retention_cleanup` — per-org retention purge: screenshots (file-first deletion), activities (90 d default), reports, AI insights, sentiment records, USB events, policy violations, notifications (read/archived only), alerts (resolved/archived only), break sessions (ended only); audit + consent logs **anonymized, never deleted**; orphan screenshot sweep.
  - `project_time_sync` — activity → time entry sync (also on a 60 s loop).
  - `anomaly_detection` — rule engine for all active orgs (honors `ai_anomaly_detection`).
- Lease-based `JobRun` rows (5-min crash-safe lease) prevent duplicate concurrent runs.

### 2.26 Desktop agent

- Implemented (Windows-only, Electron 33, `omnisight-agent/`, see [omnisight-agent.md](./omnisight-agent.md)):
  - Collectors: activity (10 s), screenshot (config minutes, ≥ 30 s), keyboard (aggregate 1-min buckets), location (5 min poll), webcam (command-driven relay), website (bridge + best-effort monitor), USB (15 s diff), policy enforcer (10 s sweep).
  - Native addon `worklens_capture.node` (N-API v8, C++17, MSVC v143, SDK 10.0.26100): foreground window, capture, keyboard count, process list/terminate, USB, location, camera.
  - Services: orchestrator (lifecycle phases), heartbeat (config interval, default 60 s), consent refresh (60 s), config refresh (10 min), queue drain (20 s), screenshot spool (encrypted at rest, 50 files/250 MB bound), command poll (10 s), webcam guard (5 s), update service (4 h, HTTPS feed only), website bridge (loopback + token).
  - Enrollment paths: employee AgentAccount login → discover → admin approval (claims) OR legacy register → approve OR zero-touch enrollment code.
  - Fail-closed gates: `config flag AND consent AND native capability`; server re-enforces with 403.
  - Packaging: `electron-builder` NSIS; `npm run package:agent`; server-side builds via `/api/agent-software/build`.
- Partial: agent-side anomaly/tamper/break reporting classes exist (`src/api/heartbeat.ts`) but are not instantiated by the agent runtime (dormant wiring).
- Partial: auto-update — update service implemented but disabled unless `WL_UPDATE_URL` (HTTPS) is configured; `publish: null` in electron-builder config.

### 2.27 Employee self-service

- **Not available as a login flow.** Employees have no web login. The **Employee Portal** page (`self-portal`) is a manager+/admin view of a *selected employee's* data (dashboard, consents, anomalies, projects, telemetry summary, break status). See [EMPLOYEE-GUIDE.md](./EMPLOYEE-GUIDE.md).

### 2.28 Search, tour, avatars

- Implemented: `/api/search` (employees/departments/devices, org-scoped, ILIKE), command palette (Ctrl+K) with 24 navigation items.
- Implemented: onboarding tour (6 steps, `localStorage 'worklens-tour-completed'`).
- Implemented: avatar upload (sharp, 128 px, employee/user, IDOR-guarded).

---

## 3. Verification status

- Tests: ~60 suites in `tests/` run with `npx tsx --test tests/*.test.ts` (Node test runner). Key suites listed per feature above.
- Certification trail: `docs/audits/` — latest sections certified production-ready (admin section 96/100, notifications 93/100, website tracking 92/100, break monitor 86/100, live monitor 94/100, agent approvals 83/100); earlier audits document issues that were subsequently fixed (e.g., original 36/100 repository audit with mock data and unauthenticated routes).
- Ongoing gaps (open from audits): server-side re-enforcement of `website_tracking=false` for agent-uploaded rows, agent local data-at-rest encryption (plaintext fallback when DPAPI unavailable), server-side activity field validation depth, zero-touch first-org binding semantics, agent-approvals realtime visibility.



