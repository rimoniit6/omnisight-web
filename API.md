# OmniSight — API Reference

> Previously branded as **WorkLensAI** — technical identifiers from that era are intentionally preserved.

Every route listed here exists in `src/app/api/**` (Next.js App Router). Routes not listed do not exist. All endpoints are JSON unless noted; errors use `{ error: string }` (sometimes `{ success: false, error }`).

Related docs: [ARCHITECTURE.md](./ARCHITECTURE.md) · [SECURITY.md](./SECURITY.md)

---

## 0. Conventions

**Authentication**

- Web/admin endpoints: JWT (HS256) via `Authorization: Bearer <token>` **or** the `worklens_token` httpOnly cookie. The proxy (`src/proxy.ts`) rejects requests without a valid token (401).
- Agent endpoints (`/api/agent/*`, `/api/device-claims/[id]/cancel`): agent bearer token (`AgentToken` / `AgentSession`), self-validated in-route.
- Role levels: `super_admin` > `owner` > `admin` > `manager` > `viewer` (≥ required role passes).

**Tenant isolation**

- `organizationId` is always derived from the verified JWT. Client-supplied `organizationId` is ignored everywhere.
- Cross-organization resource IDs → **404**; cross-org references in create/update → **422**.

**Common errors**

| Code | Meaning |
|---|---|
| 401 | Missing/invalid token ("Unauthorized. Please sign in."), or agent auth failure |
| 403 | Insufficient permissions ("Insufficient permissions") / consent or config gate denied |
| 404 | Resource not found in your org (concealment) |
| 409 | Conflict (duplicate, state conflict, active device exists) |
| 422 | Validation error (closed schemas reject unknown/forbidden fields) |
| 429 | Rate limited (headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`) |

**Rate limiting** (in-memory, per-process): `login` 10/5min (IP+email), `agentLogin` 20/min (IP), `agentAuthenticate` 20/min, `agentRegister` 10/min, `agentDiscover` 20/min (IP+deviceKey), `deviceClaimWrite` 30/min, `agentRegistrationWrite` 30/min, `orgCreate` 10/min, `aiTestConnection` 10/min, `agentAccountWrite` 20/min, `exportCsv`/`exportPdf`/`bulkWrite` 15/min, `importWrite` 5/min, `employeeWrite`/`deviceWrite` 30/min, `aiWrite` 10/min, `analyticsRead` 60/min, `uploadAvatar` 20/min, `screenshotImage` 120/min, `agentHeartbeat` 600/min (per token), `agentWrite` 120/min (per token), webcam frame 900/min (per token).

---

## 1. Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | Public | `{status:"ok", uptime, timestamp, version}` — no secrets |
| GET | `/api/health/database` | Public | Database connectivity check |

## 2. Authentication (web)

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | Public (rate-limited) | `{email, password}` → `{token, user, organization}` + sets cookie. Uniform 401 on failure |
| POST | `/api/auth/logout` | Any | Revokes session, clears cookie, audits `logout` |
| GET | `/api/auth/me` | Any | `{user, organization}` — never returns hashes |
| POST | `/api/auth/refresh-token` | Any (valid token) | Sliding expiry; re-issues with current role/org |
| POST | `/api/auth/change-password` | Any | `{currentPassword, newPassword}` (≥ 8 chars + upper + lower + digit + special) |
| GET | `/api/auth/users` | admin+ | List users (password never included) |
| POST | `/api/auth/users` | admin+ | Create user (only `super_admin` may create `super_admin`) |
| PUT | `/api/auth/users/[id]` | admin+ | Update user (role/status/name/email) |
| DELETE | `/api/auth/users/[id]` | admin+ | Deactivate user |

## 3. Organization

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/organizations` | super_admin (org-less only) | Create first organization; binds creator, returns fresh token. 409 on duplicate name |
| GET | `/api/organization` | Any (org) | Org profile + counts (employees, devices), departments, recent audit logs, alerts |
| PATCH | `/api/organization` | admin+ | Update org (timezone IANA-validated, audited) |
| GET | `/api/organization/team-data` | Any (org) | Team chart data |
| GET | `/api/organization/enrollment-code` | admin+ | Enrollment-code state (enabled?) — never the code |
| POST | `/api/organization/enrollment-code` | admin+ | Generate/rotate enrollment code (returned exactly once, SHA-256 stored) |
| DELETE | `/api/organization/enrollment-code` | admin+ | Disable zero-touch enrollment |

## 4. Users & settings

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/settings` | admin+ | All system settings; `ai_api_key` redacted as `REDACTED` |
| PUT | `/api/settings` | super_admin (system) / admin (org) | Update settings; `REDACTED` preserves stored secret; validates AI provider compatibility |
| GET | `/api/settings/monitoring` | admin+ | Org monitoring settings (resolved, typed) |
| PUT | `/api/settings/monitoring` | admin+ | Update org monitoring settings |
| GET | `/api/settings/retention` | admin+ | Org retention settings |
| PUT | `/api/settings/retention` | admin+ | Update retention settings (0–3650 days) |
| POST | `/api/upload/avatar` | Any (own) / admin+ (others) | `?type=employee\|user&id=` avatar upload (JPEG/PNG/WebP/GIF ≤ 5 MB, resized 128 px) |

## 5. Departments

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/departments` | Any (org) | List departments |
| POST | `/api/departments` | admin+ | Create department (unique name per org) |
| PUT | `/api/departments/[id]` | admin+ | Update department |
| DELETE | `/api/departments/[id]` | admin+ | Delete department |
| GET | `/api/departments/performance` | Any (org) | Per-department productive hours, top performer, "Unassigned" bucket |

## 6. Employees

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/employees` | Any (org) | Paginated list with filters, stats |
| POST | `/api/employees` | admin+ | Create employee (creates `new_employee` notification) |
| POST | `/api/employees/bulk` | admin+ | Bulk archive `{ids, action:'archive'}` |
| GET | `/api/employees/statistics` | Any (org) | Aggregate stats |
| GET | `/api/employees/presence` | Any (org) | `{employeeId: {online, lastSeenAt}}` (heartbeat-based) |
| GET | `/api/employees/search` | Any (org) | Search |
| GET | `/api/employees/[id]` | Any (org) | Employee record |
| PUT | `/api/employees/[id]` | admin+ | Update employee |
| DELETE | `/api/employees/[id]` | admin+ | Archive/delete employee |
| GET | `/api/employees/[id]/detail` | Any (org) | Stats + last-10 activities |
| GET | `/api/employees/[id]/performance` | Any (org) | Performance profile for period |
| GET | `/api/employees/[id]/activities` | Any (org) | Paginated activities |
| GET | `/api/employees/[id]/websites` | Any (org) | Aggregated bare-domain website stats |
| GET | `/api/employees/[id]/keyboard` | Any (org) | Keyboard aggregates (1-min buckets) — consent+config gated |
| GET | `/api/employees/[id]/location` | Any (org) | Location history + latest fix — consent+config gated |
| GET | `/api/employees/[id]/webcam` | Any (org) | Webcam status (consent/config/device), sessions — never frames |
| GET | `/api/employees/[id]/projects` | Any (org) | Project memberships |
| GET | `/api/employees/[id]/active-project` | Any (org) | Active tracking project |
| GET/POST | `/api/employees/[id]/agent-account` | admin+ | Get/create Agent Account |
| POST | `/api/employees/[id]/agent-account/reset-password` | admin+ | Reset agent password (≥ 12 chars, upper+lower+digit) |
| GET | `/api/employees/[id]/alerts` | Any (org) | Employee alerts |

## 7. Devices & claims & registrations

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/devices` | Any (org) | List (effective online/offline via heartbeat) |
| POST | `/api/devices` | admin+ | Create device |
| GET | `/api/devices/summary` | Any (org) | Summary counts |
| GET | `/api/devices/chart-data` | Any (org) | Chart data |
| GET | `/api/devices/[id]` | Any (org) | Detail + last 10 activities |
| PUT | `/api/devices/[id]` | admin+ | Update device |
| DELETE | `/api/devices/[id]` | admin+ | Delete device |
| GET | `/api/device-claims` | Any (org) | Claims list (+ `?summary=true`, `?q=`) |
| POST | `/api/device-claims/[id]/approve` | admin+ | Approve claim — mode `employee` (bind employee) or `guest` (create guest; never consent) |
| POST | `/api/device-claims/[id]/reject` | admin+ | Reject pending claim |
| POST | `/api/device-claims/[id]/cancel` | Claim secret + deviceKey | Employee-initiated cancel (PENDING → CANCELLED, idempotent) |
| POST | `/api/device-claims/[id]/revoke` | admin+ | Revoke approved claim → device `inactive` → tokens fail closed |
| GET | `/api/agent-registrations` | admin+ | Legacy registrations list |
| POST | `/api/agent-registrations/[id]/approve` | admin+ | Approve legacy registration (creates Device, sets agentApproved) |
| POST | `/api/agent-registrations/[id]/reject` | admin+ | Reject with reason |

## 8. Agent endpoints (device-bound `AgentToken` unless noted)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/agent/login` | none (rate 20/min/IP) | `{agentId, password}` → `AgentSession` (24 h). Lockout 5 fails → 15 min |
| POST | `/api/agent/logout` | AgentSession or AgentToken | Revoke session/token (idempotent) |
| POST | `/api/agent/discover` | AgentSession | Create Device + pending DeviceClaim; returns `{deviceId, claimId, secret, status}` |
| POST | `/api/agent/authenticate` | none (rate 20/min/IP) | Path A `{deviceId, deviceSecret}` / Path B `{employeeId, password}` → `AgentToken`; 409 on active-device conflict |
| POST | `/api/agent/register` | none (rate 10/min/IP) | Legacy registration (pending) |
| POST | `/api/agent/heartbeat` | AgentToken | Device online + lastHeartbeat; returns canonical break state |
| POST | `/api/agent/activity` | AgentToken | Batch ≤ 100 activities (consent + config gated; 403 otherwise) |
| POST | `/api/agent/screenshot` | AgentToken | FormData PNG/JPEG/WebP ≤ 5 MB (magic-byte validated) |
| POST | `/api/agent/keystroke` | AgentToken | Aggregate intervals ≤ 50 (raw-key fields rejected 422) |
| POST | `/api/agent/location` | AgentToken | Single fix (coordinates only) |
| POST | `/api/agent/consent` (GET/POST) | AgentToken | Query/update own consent state |
| GET | `/api/agent/config` | AgentToken | Full monitoring config + policy payload + assignment + break state |
| POST | `/api/agent/commands` | AgentToken | Poll pending commands (atomic PENDING → DELIVERED) |
| POST | `/api/agent/commands/[id]/ack` | AgentToken | Acknowledge command (idempotent) |
| POST | `/api/agent/webcam/session` | AgentToken | Start session (requires valid `webcam.start` command + consent + config) |
| POST | `/api/agent/webcam/session/end` | AgentToken | End session (reason allowlist, idempotent) |
| POST | `/api/agent/webcam/frame` | AgentToken | Upload JPEG frame (≤ 1 MB, in-memory relay only) |
| POST | `/api/agent/usb` | AgentToken | USB insert/remove events (dedupe 5-min) |
| POST | `/api/agent/policy-violations` | AgentToken | Report violation (`action:'blocked'` only, dedupe) |
| POST | `/api/agent/anomaly` | AgentToken | Report anomaly (dormant client wiring) |
| POST | `/api/agent/tamper` | AgentToken | Report tamper events (dormant client wiring) |
| POST | `/api/agent/break` | AgentToken | `{breakMode: true\|false}` — start/end break |
| POST | `/api/agent/discover` (w/ code) | AgentSession | Zero-touch: `{enrollmentCode, ...}` binds org |

## 9. Device commands (admin → agent)

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/device-commands` | admin+ | Enqueue command — allowlist `webcam.start\|webcam.stop`; expiry 120 s default (max 600 s); audited |
| GET | `/api/device-commands` | admin+ | List commands for device |

## 10. Screenshots

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/screenshots` | Any (org) | List + filters (flagged, employee, device, date) |
| GET | `/api/screenshots/stats` | Any (org) | Stats |
| GET | `/api/screenshots/ocr-search` | Any (org) | `?q=` search over stored OCR text (LIKE, escaped) |
| POST | `/api/screenshots/batch-analyze` | admin+ | AI vision analysis of ≤ 10 screenshots (rate-limited) |
| GET | `/api/screenshots/[id]` | Any (org) | Metadata |
| GET | `/api/screenshots/[id]/image` | Any (org) | Image bytes (`nosniff`, private cache; cross-org → 404) |
| POST | `/api/screenshots/[id]/analyze` | admin+ | AI vision analysis (honest 502 on failure) |
| DELETE | `/api/screenshots/[id]` | admin+ | Delete row + file (audited) |

## 11. Activities & analytics

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/activities` | Any (org) | List (filters, pagination) |
| GET | `/api/activities/daily` | Any (org) | Daily aggregation |
| GET | `/api/dashboard` | Any (org) | KPIs + charts (empty for org-less super admin) |
| GET | `/api/analytics` | Any (org) | `?period=week\|month\|day&startDate&endDate` (≤ 90 days) |
| GET | `/api/analytics/compare` | Any (org) | `?mode=periods\|departments` |
| GET | `/api/live-monitor/event-stats` | Any (org) | `?range=today\|24h\|7d` counts |

## 12. Break status

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/break-status` | Any (org) | List + `currentlyOnBreak` |
| GET | `/api/break-status/summary` | Any (org) | Org-timezone today summary |
| GET | `/api/break-status/history` | Any (org) | Paginated history |
| POST | `/api/break-status/[id]/toggle` | admin+ | Start/end break (viewer/manager → 403) |

## 13. Consent

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/consent` | manager+ | Consent records + stats |
| POST | `/api/consent/bulk` | manager+ | Bulk grant/revoke |
| GET | `/api/consent/summary` | manager+ | Summary |
| GET | `/api/consent/logs` | manager+ | Immutable consent log |
| GET/POST | `/api/consent/policies` | manager+ (write) | Policy list / create (draft) |
| PUT/DELETE | `/api/consent/policies/[id]` | manager+ (write) | Update / archive policy |
| PUT | `/api/consent/[id]` | manager+ | Transition consent (granted/denied/revoked) — binds current published policy |

## 14. AI

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/insights` | Any (org) | Insight list |
| POST | `/api/insights` | manager+ | Run analysis (AI or deterministic Data Summary fallback) |
| GET | `/api/insights/ai-analysis` | Any (org) | Run analysis without persisting (rate-limited) |
| PUT | `/api/insights/[id]` | manager+ | Update status (active/actioned/dismissed) |
| GET | `/api/ai-provider/usage` | admin+ | Usage stats (real provider calls only) |
| POST | `/api/ai-provider/test-connection` | admin+ | Probe provider; persists config only on success (rate 10/min) |
| GET | `/api/sentiment` | Any (org) | Sentiment records |
| POST | `/api/sentiment/analyze` | manager+ | Run sentiment analysis (rules fallback, rate-limited) |
| GET | `/api/sentiment/summary` | Any (org) | Summary |
| GET | `/api/projects/[id]/sentiment` | Any (org) | Project sentiment |
| POST | `/api/projects/[id]/sentiment/analyze` | manager+ | Project-scoped sentiment (data never leaks across projects) |

## 15. Projects & time entries

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/projects` | Any (org) | List (+ `?claim-assign`, search, stats) |
| POST | `/api/projects` | admin+ | Create |
| GET | `/api/projects/stats` | Any (org) | Stats |
| GET | `/api/projects/search` | Any (org) | Search |
| GET | `/api/projects/[id]` | Any (org) | Detail |
| PUT | `/api/projects/[id]` | admin+ | Update |
| DELETE | `/api/projects/[id]` | admin+ | Delete (soft) |
| POST | `/api/projects/[id]/restore` | admin+ | Restore deleted project |
| GET/POST | `/api/projects/[id]/members` | admin+ (write) | Members |
| PUT/DELETE | `/api/projects/[id]/members/[memberId]` | admin+ | Update/remove member |
| GET/POST | `/api/projects/[id]/time-entries` | Any (org) / admin+ | Time entries (manual) |
| PUT/DELETE | `/api/projects/[id]/time-entries/[entryId]` | admin+ | Update/delete time entry |

## 16. Notifications & alerts

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/notifications` | Any (org) | Paginated + unreadCount + stats |
| POST | `/api/notifications` | manager+ | Create (audited; skipped if org preference disables type) |
| PUT | `/api/notifications` | Any (org) | Mark read/archive/mark-all-read |
| POST | `/api/notifications/batch` | admin+ | Batch mark_read/archive/delete (≤ 200 ids) |
| GET | `/api/notifications/count` | Any (org) | `{unread, total}` |
| GET | `/api/notifications/types` | Any | Registry (public) |
| GET/PUT | `/api/notifications/preferences` | manager+ (write) | Org notification preferences |
| GET | `/api/alerts` | Any (org) | List + byStatus/bySeverity |
| PUT | `/api/alerts` | admin+ | Update status/severity (audited with diffs) |

## 17. Anomalies & policies

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/anomalies` | Any (org) | List + filters + stats |
| POST | `/api/anomalies` | manager+ | Create manual anomaly |
| GET | `/api/anomalies/[id]` | Any (org) | Detail |
| PUT | `/api/anomalies/[id]` | manager+ | Update status (resolvedBy = actor) |
| POST | `/api/anomalies/detect` | manager+ | Run rule engine (org or single employee) |
| POST | `/api/anomalies/batch` | manager+ | Batch status update |
| GET/POST | `/api/app-list` | Any (org) read / manager+ write | Whitelist/blacklist entries |
| DELETE | `/api/app-list/[id]` | admin+ | Soft delete (+ policy version bump) |
| GET | `/api/policy-violations` | Any (org) | Violations list + summary |
| GET | `/api/usb-events` | Any (org) | USB events + summary |

## 18. Reports & exports & imports

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/reports` | manager+ | Report list |
| POST | `/api/reports/generate` | manager+ | Generate (types productivity/attendance/activity/department/device/employee; formats pdf/csv/json/excel) |
| GET | `/api/reports/[id]/csv` | manager+ | CSV download |
| GET | `/api/reports/[id]/export` | manager+ | Export |
| GET | `/api/reports/[id]/pdf` | manager+ | PDF download |
| POST | `/api/reports/daily` | manager+ | Daily report (rate 10/min) |
| POST | `/api/reports/daily/ai-summary` | manager+ | AI summary (rate 10/min; fallback copy per error code) |
| POST | `/api/reports/pdf/dashboard` | manager+ | Dashboard PDF |
| POST | `/api/reports/pdf/activity` | manager+ | Activity log PDF |
| POST | `/api/reports/pdf/audit` | manager+ | Audit log PDF |
| POST | `/api/reports/pdf/employee` | manager+ | Employee PDF |
| POST | `/api/reports/pdf/project` | manager+ | Project PDF |
| GET | `/api/export/[type]` | manager+ (proxy rule) | Export CSV/Excel — types `employees\|activities\|time-entries\|projects` |
| POST | `/api/import/[type]` | admin+ (proxy rule) | Import .csv/.xlsx/.xls — same types; row-level errors |

## 19. Audit & search & misc

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/audit-logs` | Any (org) | Paginated, filtered by action/resource |
| GET | `/api/audit-logs/export` | manager+ (proxy rule) | CSV export |
| GET | `/api/search` | Any (org) | `?q=` employees/departments/devices (empty for org-less super admin) |
| GET | `/api/guests` | admin+ | Guest list by status |
| POST | `/api/guests/[id]/suspend` / `reactivate` / `revoke` / `convert` | admin+ | Guest lifecycle (convert requires name/email; telemetry preserved) |
| GET | `/api/agent-software` | admin+ | Agent software config + builds |
| POST | `/api/agent-software/build` | admin+ | Trigger build (rate 5/h; fixed command; enrollment code never stored) |
| GET | `/api/agent-software/builds/[id]` | admin+ | Build status |
| GET | `/api/agent-software/builds/[id]/download` | admin+ | Installer download (+ SHA-256) |
| GET | `/api/app-list` | Any (org) | (see §17) |
| POST | `/api/usb-events` | AgentToken | (see §8 agent/usb) |
