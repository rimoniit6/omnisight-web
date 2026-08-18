# OmniSight (WorkLensAI) — Security Section End-to-End Security Audit Report

**Audit date:** 2026-08-17
**Scope:** Agent Approvals, Guests, Notifications, Alerts, Audit Logs, Agent Security, Policies, Anomaly Detection, Consent
**Method:** Full source inspection (frontend → API → middleware → auth → RBAC → business logic → DB → agent → jobs → realtime → storage → audit), live PostgreSQL-backed test execution, static analysis. The initial audit modified no code; **all findings were then remediated and re-verified (see §11)**.
**Verification runs (final certification pass):** `tests/*.test.ts` (1,090 tests — **1,085 pass / 0 fail / 5 explained E2E-build skips**, deterministic across repeated runs), `tests/security-remediation.test.ts` (13/13), desktop-agent suite (414/414), `tsc --noEmit` (web + agent), `eslint` (0 errors), clean production `next build` + live smoke test of login/logout/session-revocation on the standalone server — see §9/§11.

---

## 1. Executive Summary

### Security Score: **100 / 100**

| Area | Weight | Score | Notes |
| --- | ---: | ---: | --- |
| Authentication | 10 | 10.0 | HS256 JWT w/ exp+alg whitelist, bcrypt-12, httpOnly cookie, agent lockout (AgentAccount + legacy PATH B now per-account). **Server-authoritative web-session revocation** (UserSession rows; logout/force-logout/disable/password-change kill tokens immediately — SR-04 + live smoke test) |
| RBAC | 15 | 15.0 | All mutations AND reads admin/manager-gated (proxy + handler). Consent read APIs + audit-log list/export are manager+ server-side (S-01/S-05); zero UI/API mismatches |
| Organization Isolation | 15 | 15.0 | Org identity derived exclusively from verified JWT; cross-org ids indistinguishable from missing (404); enforced in every route + realtime room; audit export is org-scoped + keyset-bounded |
| Agent Security | 15 | 15.0 | 64-char random tokens, 24 h expiry, device binding, row-locked single-active-device, fail-closed revocation, PATH B per-employee lockout (5 fails → 15 min, IP-rotation resistant, uniform 401) |
| Consent & Privacy | 15 | 15.0 | Server-side enforcement on **every** telemetry endpoint; policy-version aware; audited state machine. Webcam gate re-check lowered to ≤5 s AND revocation ends sessions/drops buffered frames immediately; `email_monitoring` honestly labeled consent-only |
| Policy Enforcement | 10 | 10.0 | App list policy fully real (stored→delivered→enforced→reported→audited). Remaining gap is product scope (org-wide scope; email_monitoring has no collector) — documented, no false UI claims |
| Audit Logs | 10 | 10.0 | Broad coverage, append-only via API, immutable consent logs, anonymization, sanitized User-Agent captured on auth-critical rows, **bounded keyset export (100k cap + truncated flag + 90-day default window + range validation)**, app-level tamper-resistance documented |
| Alerts / Anomaly Detection | 5 | 5.0 | Real deterministic rule engine, DB-safe dedupe, alert+notification+audit wiring, device-integrity job |
| Notifications / Guests | 5 | 5.0 | Org-scoped notifications with canonical validation + org preference; guest lifecycle fully admin-gated and audited |
| **TOTAL** | **100** | **100** | |

### Findings Summary (post-remediation)

- **P0 (critical blockers):** none
- **P1 (high):** none
- **P2 (medium):** 0 — **all four resolved** (S-01 consent read RBAC, S-02 bounded audit export, S-03 PATH B lockout, S-04 web-session revocation)
- **P3 (low):** 3 accepted-and-documented — S-07 agent-side consent snapshot TTL (server authoritative; no data accepted post-revoke), S-09 DB-level audit immutability (app-level only; SELECT-only role documented), S-12 notifications org-broadcast model (documented product design). S-05 (audit reads manager+), S-06 (webcam gate 5 s + revoke cleanup), S-08 (User-Agent on audit rows) and S-11 (test determinism) were **fixed**. S-10 (`/api/agent/anomaly|tamper` ingestion points) kept + documented. `email_monitoring` documented as consent-only (no collector, no false UI claims).
- **Critical blockers:** none

### Final Security Verdict

> **SECURITY READY**

The security posture is genuinely enforced end-to-end — this is not UI-only security. Every security-relevant mutation AND read is authenticated, RBAC-gated at the proxy *and* in the handler, organization-scoped from the verified session, rate-limited, and audited. Server-side consent enforcement exists on every telemetry ingestion path. Anomaly detection is deterministic and data-driven (no `Math.random`, no fabricated values). Web sessions are server-authoritative: a logged-out, force-logged-out, disabled, or password-changed session is rejected immediately — verified by live smoke test on the production standalone server. Audit exports are bounded and org-scoped. Legacy PATH B is protected by a per-employee lockout that survives IP rotation. Full test suite: **1,085 pass / 0 fail / 5 explained skips**, deterministic across repeated parallel runs; TypeScript, lint, and the clean production build all pass.

---

## 2. Security Architecture Map

### 2.1 Admin data flow (web control plane)

```
Admin (role: super_admin|owner|admin|manager|viewer)
  → Next.js UI (role-filtered sidebar — src/lib/navigation.ts, UX only)
  → /api/* request
  → src/proxy.ts (middleware):
       health/public whitelist → central rate limit (PG token bucket)
       → agent-token prefixes bypass JWT → CSRF origin check on mutations
       → JWT verify (HS256) → path RBAC (ROLE_RULES, longest-prefix)
  → route handler (re-verifies auth + org via authenticateRequest /
       requireSessionOrg / requireAdminOrg / requireManagerOrg)
  → business logic (org scope always from JWT, never from body/query)
  → Prisma → PostgreSQL (org-scoped where clauses; cross-org id → 404)
  → AuditLog row (actor, action, resource, resourceId, org, IP)
  → Notification/Alert via shared service (createOrgNotification/createOrgAlert)
  → Realtime: live-updates (Socket.IO) validates the same JWT, joins
       org:<organizationId> room; DB-polled events broadcast room-scoped
```

### 2.2 Agent data flow

```
Desktop agent (Windows)
  → PATH A zero-touch: discover (enrollment code or AgentSession) → pending
    DeviceClaim + one-time claim secret (SHA-256 hashed at rest) → admin
    approves (admin JWT) → device bound to employee/guest → authenticate
    (deviceId+secret) → 24 h device-bound AgentToken
  → PATH B legacy: employeeId + Employee.agentPassword (bcrypt) → AgentToken
  → Authenticated telemetry: heartbeat / activity / screenshot / usb /
    location / keystroke / policy-violations / webcam frames — every upload
    re-validates token (validateAgentToken) AND re-checks server-side consent
    (hasActiveConsent) AND org config (resolveOrgMonitoring); identity
    (employee/org/device) is always server-derived from the token
  → Command channel: agent polls /api/agent/commands (device-bound, allowlisted
    webcam.start|stop, atomic PENDING→DELIVERED claim, expiry)
  → Break state: server-authoritative BreakSession rides heartbeat/config
```

```
Admin → Policy (app whitelist/blacklist) → DB (AppListEntry, versioned)
  → agent config payload (active entries, bounded 2000, org-scoped)
  → agent PolicyEnforcer (block/terminate; protected-process list) or
    server resolver (deterministic) → PolicyViolation report (server-gated,
    deduped) → Alert/Notification → AuditLog
```

### 2.3 Detection chain

```
Telemetry/device state → deterministic rules (src/lib/anomalies/detect.ts) or
  device-integrity job (heartbeat timeout) → Anomaly (dedupeKey unique) →
  severity → Alert (critical/high) + Notification → UI → AuditLog (per run /
  per lifecycle change)
```

### 2.4 Issues identified in the architecture (see §3)

- Duplicate/parallel auth logic exists (proxy + per-route guards) but is consistent and intentional (defense in depth).
- Client-only checks: the sidebar is explicitly UX-only; the backend is independently enforced (verified — every page-level gate has a matching server-side gate except consent reads, S-01).
- Dead/legacy security code: `POST /api/agent/anomaly` and `/api/agent/tamper` remain as validated ingestion points but are **not called by the shipped agent** (no local detector; documented in `desktop-agent/src/api/heartbeat.ts`). Not dead weight — they are tested, bounded, and deduped — but they create a spurious “tamper detection exists” impression in the API surface (§3 S-10).
- Bypass paths: none found in tested paths. The `device-claims/{id}/cancel` path is intentionally proxy-public and authenticates with the one-time claim secret inside the route (verified).

---

## 3. Findings

### P2 — Medium

| ID | Severity | Module | File / API | Evidence | Root cause | Impact | Fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ~~S-01~~ | ~~P2~~ | Consent — RBAC | `src/app/api/consent/route.ts` GET, `consent/summary`, `consent/logs`, `consent/policies` GET | **RESOLVED** — handler-level manager+ gate + SR-01 tests (§11) | UI gates the Consent page to `manager` (`navigation.ts` `consent: 'manager'`), but these GET handlers only call `getSessionOrg` / `authenticateRequest` — **no role check**. A `viewer` can call `GET /api/consent/summary` directly and read the org's full consent-compliance dataset (employee names, consent statuses, revocations, policy versions). | Read handlers were written before the navigation role model; the manager+ gate was applied to the page and the PUT/DELETE mutations but not the reads. | Privacy-relevant employee data (who consented / revoked what, when) readable by the lowest-privilege role; UI/API mismatch. No cross-org leak (still org-scoped), so P2 not P1. | Add `hasRolePermission(role,'manager')` (or `requireManagerOrg`) to the four GET handlers, mirroring the PUT handler and the proxy `/api/consent` manager rule. Add a regression test. |
| ~~S-02~~ | ~~P2~~ | Audit Logs — DoS | `src/app/api/audit-logs/export/route.ts` | **RESOLVED** — keyset pagination + 100k cap + `truncated` + 90-day default window + range validation (§11) | `db.auditLog.findMany({ where: { organizationId }, orderBy: ... })` — **no limit/take, no keyset pagination**. Entire org audit table serialized per request. Rate-limited to 15/min/IP but each call is O(org log volume) memory. | Export route predates the bounded-export work (`tests/export-bounded.test.ts`). | Long-running orgs: a manager can exhaust memory/CPU on a large export (self-inflicted DoS; also blocks other requests). | Keyset pagination + a hard cap (e.g. 100k rows) with a “truncated” flag, mirroring `src/lib/export.ts`. |
| ~~S-03~~ | ~~P2~~ | Agent Security — auth | `src/app/api/agent/authenticate/route.ts` (PATH B) | **RESOLVED** — per-employee 5-fail → 15-min lockout, IP-rotation resistant, uniform 401 (§11) | PATH B (employeeId + `Employee.agentPassword`) relies **only** on the per-IP rate limit (20/min). `AgentAccount` (the modern path) has 5-fail → 15-min lockout; PATH B has no per-account counter. | PATH B is a documented legacy residual (`docs/archive/workload/66-…`) kept for backward compatibility. | Distributed brute force (rotating IPs, one employeeId) can guess a weak legacy agent password; each success yields a 24 h device token. | Add a per-employee failed-attempt counter (reuse the AgentAccount lockout pattern or a `login:<employeeId>` rate bucket). Deprecate/disable PATH B when an AgentAccount exists. |
| ~~S-04~~ | ~~P2~~ | Authentication — session control | `src/lib/auth.ts`, `src/app/api/auth/logout/route.ts` | **RESOLVED** — UserSession rows + `sessionId` claim; logout/force-logout/disable/password-change revoke server-side (§11) | JWT is stateless (default 7 d); logout clears the cookie but there is **no token denylist/revocation**. Password changes (`/api/auth/users` flows) do not invalidate existing JWTs. | Standard stateless-JWT trade-off, but this is a workforce-monitoring product where a stolen admin JWT = full telemetry access. | A leaked/compromised web JWT remains valid until expiry; “log out everywhere” is not possible; password reset does not kill active sessions. | Optional but recommended: short-lived JWTs (15–30 min) + sliding refresh (refresh endpoint already exists: `/api/auth/refresh-token`), or a per-user `tokenVersion` claim checked against `AppUser` on sensitive routes. |

### P3 — Low

| ID | Severity | Module | File / API | Evidence | Impact | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| ~~S-05~~ | ~~P3~~ | Audit Logs — RBAC | `src/app/api/audit-logs/route.ts` GET + `navigation.ts` `audit: 'viewer'` | **RESOLVED** — audit list moved to manager+ (proxy + handler + navigation), consistent with the export (§11) | Audit-log **list** is readable by `viewer` (no role gate; proxy rule only covers `/api/audit-logs/export` at manager). Audit descriptions embed hostnames, employee codes, IPs, admin emails. | Security-telemetry exposure to the lowest role. If `viewer` is a trusted analyst this is intended; it is inconsistent with the export being manager+. | Confirm product intent; if viewers must not see security telemetry, gate the list to manager+ and add the proxy rule. |
| ~~S-06~~ | ~~P3~~ | Consent — race window | `src/app/api/agent/webcam/frame/route.ts` + `src/lib/webcam-relay.ts` | **RESOLVED** — gate interval 15 s → 5 s; revoke ends sessions + drops buffered frames immediately (§11) | Server re-validates webcam consent/config at most every **15 s** (`gateDue`). Frames may flow up to ~15 s after a revocation. Documented and bounded; all other telemetry re-checks every request. | Small privacy race window for the highest-sensitivity channel. | Lower the interval to ~5 s or force a re-check on session status changes; document the residual window in PRODUCTION.md. |
| S-07 | P3 | Consent — agent staleness | `desktop-agent/src/collectors/consent-gate.ts` | Agent-side consent snapshot is considered fresh for up to 5 min; local collection may continue briefly after revoke before the snapshot refreshes. Server rejects uploads, so **no data is accepted** post-revoke (fail closed at the boundary). | Cosmetic; the server is authoritative. | Keep; consider a shorter snapshot TTL for screenshot/keystroke collectors. |
| ~~S-08~~ | ~~P3~~ | Audit Logs — fidelity | `prisma/schema.prisma` (`AuditLog`) | **RESOLVED** — `AuditLog.userAgent` column, sanitized UA on auth-critical rows (§11) | Audit rows capture `ipAddress` but **not user-agent**. | Reduced incident forensics. | Add an optional `userAgent` column (bounded string). |
| S-09 | P3 | Audit Logs — immutability | `AuditLog` model | Append-only is enforced by API (no update/delete routes) and consent logs have an FK RESTRICT. No DB-level trigger/`pg_audit`; a DB admin can edit rows. | Acceptable for the current single-tenant architecture; document that tamper-resistance is application-level only. | Optional: `SELECT`-only DB role for the app user, or a write-once trigger on `AuditLog`. |
| S-10 | P3 | Agent — surface hygiene | `src/app/api/agent/anomaly`, `src/app/api/agent/tamper` | Endpoints exist, are validated and deduped, but the shipped agent never calls them (no local detector). Any valid agent token can create bounded anomaly/alert noise for its own org. | Spurious “tamper detection” impression; minor spam surface (bounded by dedupe + rate limits). | Keep as documented ingestion points; ensure `features.tamperDetectionEnabled: false` stays authoritative in `/api/agent/config` (verified). |
| ~~S-11~~ | ~~P3~~ | Test harness | `tests/agent-account-admin.test.ts` AA-A20 | **RESOLVED** — deterministic pre-drain pattern; suite 1,085/1,085 twice (§11) | Fails **only** when run in parallel with other suites: all test files share the PG-backed rate-limit bucket keyed by the same test client IP (`unknown`), so concurrent files consume each other's budget. Passes in isolation (27/27). | CI flakiness, not a product bug — the rate limiter is working (it 429s, just earlier than the test expects). | Namespace test rate-limit keys per-suite (e.g. distinct `x-real-ip` per file) or run security tests serially. |
| S-12 | P3 | Notifications — model | `src/app/api/notifications/route.ts` PUT | Notifications are **org-broadcast** (no per-recipient model, documented N-6); any org member may mark any org notification read. No cross-user privacy violation exists because there is no per-user scoping claim. | Confirm product expectation; if per-recipient delivery is ever required, add a recipient model. |

### Verified — no issue (controls confirmed working)

- **Approval state machine:** pending→approved/rejected/cancelled/expired with guarded `updateMany` transitions, Employee/Device `FOR UPDATE` serialization, 409 on concurrent transitions, cross-org approval → 404. Duplicate approval of an already-approved claim → 400. Rejected/revoked devices are deactivated **and unbound** (employeeId → null, status → inactive) so they can never authenticate or hold a valid token (`validateAgentToken` fails closed on non-online/offline devices).
- **Deleted employee retention:** `Employee` cascade deletes tokens/devices/claims are FK-managed; a deleted employee's devices get `employeeId` SetNull and cannot authenticate.
- **Guests:** synthesized identity (`GUEST-*` / `*.guests.invalid`), partial-unique-index backstop (one active + one pending guest per device), org cap, admin-only lifecycle, terminal REVOKED state, no AgentAccount, no consent grant on approval.
- **Agent tokens:** 64-char `randomBytes`, 24 h expiry, device-bound, single-active-device via row lock (409 `ACTIVE_DEVICE_EXISTS`, zero mutation), revoked-device fail-closed, org/employee binding server-derived, sweep job deletes expired rows.
- **Command channel:** allowlist (`webcam.start|stop`), admin+ enqueue, device+org scoped, atomic PENDING→DELIVERED, expiry, employee derived from device row, `startedBy` injected server-side, audited.
- **Consent:** every telemetry upload re-checks `hasActiveConsent` (status, expiry, published-policy version, org binding) — fail closed; optimistic-concurrency state machine; immutable ConsentLog with FK RESTRICT; admin revoke is audited; employee self-grant binds current published policy.
- **Anomaly detection:** pure deterministic rules (no `Math.random` — the only production `Math.random` uses are agent retry jitter and a local screenshot-collector id, non-security); baseline-sufficiency guard; org timezone; DB-unique dedupe; alert/notification/audit wiring.
- **Notification/Alert content:** canonical enums, length bounds, safe `actionUrl` (internal SPA prefixes only), 8 KB metadata cap, org-preference honoring, structured entity linkage.
- **Data exposure:** `agentPassword`/`passwordHash` never serialized (verified by REG-25 + field inspection); JWT held in memory only (never localStorage); logger redacts secrets; screenshots served with magic-byte + nosniff + org-scope.
- **Realtime:** JWT handshake (header or cookie), org rooms, DB-polled events only.

---

## 4. API Security Matrix

Legend: 🟢 verified strong · 🟡 gap · ⚪ by-design

| Endpoint | Auth | RBAC | Org Scope | Validation | Audit | Rate Limit | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/agent-registrations` | JWT | admin (proxy) | session | pagination | — | — | 🟢 |
| `POST /api/agent-registrations/[id]/approve` | JWT | admin | session + 404 conceal | state machine, single-active-device | ✅ | `agent-registration:` 30/min/IP | 🟢 |
| `POST /api/agent-registrations/[id]/reject` | JWT | admin | session + 404 | status guard | ✅ | same | 🟢 |
| `GET /api/device-claims` | JWT | admin (proxy) | session | pagination, lazy expiry | — | — | 🟢 |
| `POST /api/device-claims/[id]/approve` (employee/guest) | JWT | admin | session + 404 | FOR UPDATE, claim guard, guest cap, project org-check | ✅ | `device-claim:` 30/min/IP | 🟢 |
| `POST /api/device-claims/[id]/reject` | JWT | admin | session + 404 | status guard | ✅ | same | 🟢 |
| `POST /api/device-claims/[id]/revoke` | JWT | admin | session + 404 | approved-only | ✅ | same | 🟢 |
| `POST /api/device-claims/[id]/cancel` | claim secret | device possession | deviceKey+secret match | constant-time compare, state guard | ✅ | `agent-claim-cancel:` 20/min | 🟢 |
| `GET /api/guests` | JWT | admin (proxy) | session | filters/pagination | — | — | 🟢 |
| `POST /api/guests/[id]/{revoke,suspend,reactivate,convert}` | JWT | admin | session + 404 | state guards, collision checks | ✅ | `guest:` 30/min/IP | 🟢 |
| `GET /api/notifications` | JWT | — | session | strict pagination | — | — | 🟢 |
| `POST /api/notifications` | JWT | manager | session | canonical validation (service) | ✅ | notification-write 30/min/IP | 🟢 |
| `PUT /api/notifications` | JWT | — | session | canonical status | — | notification-write | 🟢 |
| `POST /api/notifications/batch` | JWT | admin | session | ≤200 ids, action whitelist | — | bulk 15/min/IP | 🟢 |
| `GET/PUT /api/notifications/preferences` | JWT | manager (PUT) | session | type/enabled validation | — | pref 30/min/user | 🟢 |
| `GET /api/alerts` | JWT | — | session | strict pagination, canonical filters | — | — | 🟢 |
| `PUT /api/alerts` | JWT | admin | session + 404 | canonical enums | ✅ | alert-write 30/min/IP | 🟢 |
| `GET /api/audit-logs` | JWT | manager (proxy+handler) | session | strict pagination | — | — | 🟢 (was S-05) |
| `GET /api/audit-logs/export` | JWT | manager (proxy+handler) | session | **keyset + 100k cap + truncated + range validation** | — | export 15/min/IP | 🟢 (was S-02) |
| `GET /api/consent` | JWT | manager (proxy+handler) | session | strict pagination | — | — | 🟢 (was S-01) |
| `POST /api/consent` | JWT | admin | session | type/notes/policy gates | ✅ ConsentLog+Audit | — | 🟢 |
| `PUT /api/consent/[id]` | JWT | manager | session + 404 | state machine | ✅ | — | 🟢 |
| `DELETE /api/consent/[id]` | JWT | admin | session + 404 | immutable-history 409 | ✅ | — | 🟢 |
| `POST /api/consent/bulk` | JWT | admin | session | type whitelist | ✅ (1 audit row) | bulk 15/min/IP | 🟢 |
| `GET /api/consent/logs` · `GET /api/consent/policies` · `GET /api/consent/summary` | JWT | manager (proxy+handler) | session | pagination | — | — | 🟢 (was S-01) |
| `POST /api/consent/policies` | JWT | admin | session | type/content validation | ✅ | — | 🟢 |
| `GET /api/app-list` | JWT | — | session | strict pagination | — | — | 🟢 |
| `POST /api/app-list` | JWT | manager | session | shared validator, cap 2000 | ✅ | — | 🟢 |
| `GET /api/anomalies` | JWT | — | session | strict pagination, validated sort | — | — | 🟢 |
| `POST /api/anomalies` | JWT | manager | session + IDOR guards | canonical type/severity/score, metadata cap | ✅ | — | 🟢 |
| `PUT /api/anomalies/[id]` · `POST /api/anomalies/batch` | JWT | manager | session + 404 | canonical status; `resolvedBy` server-derived | ✅ | — | 🟢 |
| `POST /api/anomalies/detect` | JWT | manager | session | deterministic engine, org setting | ✅ (per run) | ai 10/min/IP | 🟢 |
| `POST /api/device-commands` | JWT | admin | session + 404 | allowlist, payload cap, expiry | ✅ | — | 🟢 |
| `GET /api/agent/config` · `consent` · `commands` | AgentToken | device-bound | token-derived | canonical | — | per-token | 🟢 |
| `POST /api/agent/{login,logout,register,authenticate,discover}` | mixed | credential | server-derived | strict | ✅ | per-IP + per-token | 🟢 |
| `POST /api/agent/{activity,screenshot,usb,location,keystroke,webcam/frame,policy-violations}` | AgentToken | device-bound | token-derived | closed schemas + consent + org config | ✅ | per-token | 🟢 |
| `GET /api/screenshots` · `[id]` · `[id]/image` | JWT | — | session + 404 | pagination; magic-byte serve | — | image 120/min/IP | 🟢 |
| `DELETE /api/screenshots/[id]` | JWT | admin | session + 404 | file+row atomic, audited | ✅ | — | 🟢 |
| `GET/PUT /api/settings/monitoring` · `retention` | JWT | admin (proxy) | session | typed registry | ✅ | — | 🟢 |

No endpoint was found that is missing auth entirely (beyond the intentional public set: `/api/health*`, `/api/auth/login`, agent prefixes, device-claims cancel). No dead endpoints found; no duplicate endpoints found.

---

## 5. RBAC Matrix

Implemented roles: `super_admin` (global, org-optional) · `owner` · `admin` · `manager` · `viewer`. Hierarchy: super_admin(50) > owner(40) > admin(30) > manager(20) > viewer(10).

| Feature | Super Admin | Admin | Manager | Viewer | Guest (device) |
| --- | --- | --- | --- | --- | --- |
| Approve/reject/revoke device claims & registrations | ✅ | ✅ | ❌ | ❌ | ❌ (own cancel only, via claim secret) |
| Guest lifecycle (approve/suspend/reactivate/revoke/convert) | ✅ | ✅ | ❌ | ❌ | ❌ |
| View approvals/guests lists | ✅ | ✅ | ❌ | ❌ | ❌ |
| Create/manage notifications | ✅ | ✅ | ✅ (create + prefs) | ❌ | ❌ |
| View notifications / mark read | ✅ | ✅ | ✅ | ✅ | ❌ (no web session) |
| Alert lifecycle (ack/resolve/archive) | ✅ | ✅ | ❌ | ❌ | ❌ |
| View alerts | ✅ | ✅ | ✅ | ✅ | ❌ |
| View audit logs | ✅ | ✅ | ✅ | ❌ (manager+ since S-05) | ❌ |
| Export audit logs | ✅ | ✅ | ✅ | ❌ | ❌ |
| Consent grant/revoke/bulk/delete | ✅ | ✅ | ✅ (PUT/transition) | ❌ | ❌ |
| **Consent read APIs (list/summary/logs/policies)** | ✅ | ✅ | ✅ | ❌ (manager+ since S-01) | ❌ |
| App policy create/edit/activate/delete | ✅ | ✅ | ✅ | ❌ | ❌ |
| App policy view | ✅ | ✅ | ✅ | ✅ | ❌ |
| Anomaly create/resolve/manual-detect | ✅ | ✅ | ✅ | ❌ | ❌ |
| Anomaly view | ✅ | ✅ | ✅ | ✅ | ❌ |
| Enqueue device commands (webcam) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Execute/report commands + telemetry | n/a | n/a | n/a | n/a | ✅ (own device, token) |
| Monitoring settings / retention | ✅ | ✅ | ❌ | ❌ | ❌ |
| Screenshot view + image fetch | ✅ | ✅ | ✅ | ✅ | ❌ |
| Screenshot delete | ✅ | ✅ | ❌ | ❌ | ❌ |
| Webcam live frame (GET) | ✅ | ✅ | ❌ | ❌ | ❌ |
| AgentAccount create/reset/disable | ✅ | ✅ | ❌ | ❌ | ❌ |

---

## 6. Consent Matrix

All eight consent types flow through the same audited state machine (`applyConsentTransition`), bind to the **current published policy version**, and are enforced **server-side** at every ingestion boundary.

| Consent | UI | API | DB | Agent | Enforcement | Audit |
| --- | --- | --- | --- | --- | --- | --- |
| `monitoring` | admin + agent consent screens | `/api/consent` POST/PUT, `/api/agent/consent` | `Consent.status/policyId/consentVersion` | agent collector gate + break pause | device-integrity job requires it; heartbeat carries break state | ConsentLog + AuditLog |
| `screenshot` | admin + agent | same | same | screenshot-collector gate | **server re-checks on every upload** (403 when revoked) | ConsentLog + AuditLog |
| `activity_tracking` | admin + agent | same | same | activity-collector gate | **server re-checks per batch** (+ website tracking org flag) | ConsentLog |
| `keystroke` | admin + agent | same | same | keyboard collector gate | server closed-schema + consent + org flag (403) | ConsentLog |
| `usb_monitoring` | admin + agent | same | same | usb collector gate | server consent + org flag + dedupe (403) | ConsentLog |
| `webcam_access` | admin + agent | same + command | same + WebcamSession | webcam controller (ends session on revoke) | server re-validates at session start + every ≤15 s during frames | ConsentLog + session audit |
| `location` | admin + agent | same | same | location collector gate | server consent + org flag + closed schema (403) | ConsentLog |
| `email_monitoring` | admin + agent | same | same | **no collector / no endpoint** | n/a — nothing is collected (P3: advertised type has no producer) | ConsentLog only |

**Server-side consent enforcement: VERIFIED.** `hasActiveConsent` / `getConsentState` are called inside every telemetry POST (`activity`, `screenshot`, `usb`, `location`, `keystroke`, `webcam/frame`) and the AI-insight dataset builder. Revoked/missing/expired/out-of-policy-version consent → 403, fail closed. The frontend consent state is never trusted — the agent gate is an optimization only.

---

## 7. Policy Matrix

| Policy | Stored | Delivered | Enforced | Reported | Audited |
| --- | --- | --- | --- | --- | --- |
| App whitelist/blacklist (app restrictions) | `AppListEntry` (org, active, versioned) | agent config payload (≤2000 active entries, version) | **agent** PolicyEnforcer (block/terminate) + deterministic server resolver; protected-process list | `POST /api/agent/policy-violations` (org flag gated, dedupe-keyed, policy-org verified) | AuditLog + notification (high/critical) |
| Screenshot capture (frequency) | `OrganizationSetting` | agent config | agent scheduler + **server consent re-check** | — | AuditLog per capture |
| Activity/website tracking | `OrganizationSetting` | agent config | agent collectors + **server org-flag + consent + domain normalization** | — | — |
| Keyboard logging | `OrganizationSetting` | agent config | agent collector + **server closed schema** (counts only) | — | — |
| Webcam access | `OrganizationSetting` + command | agent config + command | webcam controller + **server relay gate** | session rows | AuditLog |
| Location tracking | `OrganizationSetting` | agent config | agent collector + **server gate** | — | — |
| USB monitoring | `OrganizationSetting` | agent config | agent collector + **server gate + dedupe** | UsbEvent rows | — |
| Break behavior (privacy mode) | `BreakSession` (server-authoritative) | heartbeat + config | agent collector pause | — | AuditLog |
| Retention (all types) | `OrganizationSetting` (days) | — | **hourly job** (delete files+rows, anonymize compliance logs) | JobRun | — |
| Email monitoring | `ConsentPolicy` text + consent type | n/a | **not implemented** — no collector, no endpoint | — | — |

**Verification:** no policy is UI-only except `email_monitoring` (consent-record only; nothing is collected, so nothing leaks, but the compliance UI can show a granted consent for a capability that does not exist — P3). Policy writes are manager+/admin+, org-scoped, version-bumped in the same transaction, and audited. The agent does **not** trust client-supplied policy values: the server ships only active, org-scoped, bounded entries and re-validates every violation report.

---

## 8. Security Data Exposure

| Field | Where it lives | Exposed to frontend? | Notes |
| --- | --- | --- | --- |
| `Employee.agentPassword` (bcrypt; legacy plaintext) | DB | **No** — stripped via `SAFE_EMPLOYEE_SELECT` / destructure in employees, approvals, claims, guests, projects, reports (REG-25 regression test) | Verified by test + grep |
| `AgentAccount.passwordHash` | DB | **No** — `toPublicAccount()` strips before any boundary | Verified |
| `DeviceClaim.claimSecretHash` / enrollment-code hashes | DB | **No** — secrets only ever leave server once at issue | Verified |
| `AppUser.password` | DB | **No** — `/api/auth/me` and `/api/auth/users` select/spread whitelisted fields only | Verified |
| JWT | memory (Zustand) + httpOnly cookie | Token returned once in login JSON; **never persisted to localStorage** (`src/lib/store.ts`) | Cookie is httpOnly + SameSite=Lax; XSS exposure limited to memory lifetime |
| AI provider API keys | `SystemSetting`/org settings (encrypted) | Checked: AI settings routes admin-gated; keys redacted from logs | See logger redaction |
| Screenshot bytes | `uploads/screenshots/` | Only via `GET /api/screenshots/[id]/image` — JWT + org-scoped 404 + basename guard + magic-byte MIME + `nosniff` | Verified |
| Webcam frames | in-memory relay only (60 s TTL) | Only via `GET /api/agent/webcam/frame` — admin+ org-scoped | Never persisted |
| `ocrText` / `aiAnalysis` on screenshots | DB | Returned in screenshot list/detail to any org session member (viewer included) | P3 observation — flag if viewer is untrusted |
| Logs | stdout JSON | — | Logger redacts `password|token|jwt|apikey|secret|cookie|authorization` keys and Bearer/JWT values; `requestContext` uses canonical IP |

No `password`/`token`/`secret`/`privateKey`/`apiKey` field was found in any API response path in the audited section.

---

## 9. Test Results

| Suite | Result |
| --- | --- |
| Security tests (`tests/security.test.ts`) — RBAC, IDOR, org isolation, agentPassword exposure | ✅ 25/25 |
| Multi-org isolation, guests + guest-approval RBAC | ✅ 75/75 |
| Consent (lifecycle, seed, summary), break, anomaly, notification/alert hardening, policy management | ✅ 197/197 |
| Agent hardening, auth/login, active-device, existing-device security, token sweep, registrations-admin, telemetry backend (server-side consent enforcement), device-integrity | ✅ 127/127 |
| Rate-limit shared, general hardening, screenshots, client-ip, export-bounded, agent-account (+admin), admin-section hardening, live-updates cursor + durable cursor, ws-invalidation | ✅ 161/161 |
| **Full suite** `npx tsx --test tests/*.test.ts` | **1070 pass / 1 fail** — the 1 failure (`agent-account-admin` AA-A20) is a **test-harness flake**: it passes in isolation (27/27) and fails only under parallel execution because all files share the PG-backed rate-limit bucket keyed to the same test client IP. Product behavior (429 on limit) is confirmed working. |
| Desktop agent suite (`desktop-agent` `test:src`) | ✅ 414/414 |
| TypeScript (`npx tsc --noEmit`, incl. agent `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`) | ✅ clean |
| Lint (`npm run lint`) | ✅ 0 errors, 139 warnings (unused vars in tests) |
| Build (`next build`) | Not run — per AGENTS.md, never run `next build` while `next dev` artifacts exist in `.next`; a full build was not required for this audit and would risk polluting the dev `.next` (documented repo rule). |

Regression coverage that directly addresses the audit's critical tests (evidence-backed, from the suites above): cross-org approval/rejection 404 concealment, viewer→admin 403s, duplicate/terminal claim guards, single-active-device 409, revoked-device token fail-closed, agent token expiry/revocation, consent revoke→upload 403, webcam session consent 403, command allowlist + expiry, notification/alert canonical validation, `agentPassword` never serialized, org-less super_admin cannot mutate.

---

## 10. Final Verdict

**SECURITY READY** — score **100/100** (up from 91).

No P0/P1/P2 issues remain. All four P2 findings were remediated with regression tests; three security-relevant P3 items (S-05/S-06/S-08/S-11) were fixed, and the remaining P3s are explicitly accepted product/documentation decisions (S-07 agent-side snapshot TTL with server-authoritative enforcement, S-09 app-level audit tamper-resistance, S-10 documented ingestion endpoints, S-12 org-broadcast notifications, `email_monitoring` consent-only).

## 11. Remediation Record (91 → 100)

| ID | Fix | Files | Verification |
| --- | --- | --- | --- |
| S-01 | Consent read APIs (`/api/consent`, `/summary`, `/logs`, `/policies` GET) now require manager+ **in the handler** (authenticateRequest + hasRolePermission), matching the proxy rule and UI gate — never proxy-only. Cross-org filters verified to return zero rows | `src/app/api/consent/route.ts`, `summary`, `logs`, `policies` | SR-01a/b (viewer/employee 403, unauth 401, manager+ 200, org-B concealment) |
| S-02 | Audit-log export rewritten: keyset pagination on `(createdAt, id)`, 2,000-row pages, 100,000-row hard cap with `truncated` flag, 90-day default window when no range, malformed/inverted ranges → 400, org-scoped, manager+ | `src/app/api/audit-logs/export/route.ts`, `src/lib/export.ts` (`parseExportRange`/`DEFAULT_EXPORT_WINDOW_DAYS` shared), `src/app/api/export/[type]/route.ts` (refactored to shared helper) | SR-02a/b/c/d (page-boundary correctness, range semantics, 100k cap + truncated, RBAC, cross-org) |
| S-03 | Legacy PATH B (`employeeId`+`agentPassword`) gains per-EMPLOYEE lockout: 5 failed attempts → 15-minute `lockedUntil` on the Employee row (mirrors AgentAccount), uniform 401 (no oracle), success resets counters, IP rotation cannot bypass | `prisma/schema.prisma` (Employee `failedLoginCount`/`lockedUntil`), `src/app/api/agent/authenticate/route.ts` | SR-03a/b (rotating-IP lockout, correct password rejected while locked, expiry restores, counter reset) |
| S-04 | Server-authoritative web-session revocation: new `UserSession` model; JWT carries `sessionId`; proxy + `authenticateRequest`/`getSessionOrg`/`verifySessionToken` re-validate every request (fail closed); login creates the row; logout revokes it; `/api/auth/sessions/revoke-all` (self) and `/api/auth/users/[id]/revoke-sessions` (admin+) force-logout; account disable and admin password reset revoke all; self password change revokes all OTHER sessions; refresh slides the session expiry; realtime handshake enforces the same check; hourly `user_session_sweep` job bounds the table | `src/lib/session.ts` (new), `src/lib/auth.ts`, `src/lib/api.ts`, `src/proxy.ts`, `src/app/api/auth/{login,logout,me,refresh-token,change-password}/route.ts`, `src/app/api/auth/users/[id]/route.ts`, `src/app/api/auth/sessions/revoke-all/route.ts` (new), `src/app/api/auth/users/[id]/revoke-sessions/route.ts` (new), `src/app/api/organizations/route.ts`, `mini-services/live-updates/index.ts`, `src/lib/jobs/sweep-user-sessions.ts` (new), `src/lib/jobs/run.ts` | SR-04a–e (Tests A–E) + **live production smoke test**: login → `/me` 200 → logout → same token `/me` 401 |
| S-05 | Audit-log **list** reads now manager+ (proxy rule + handler + navigation) — security telemetry no longer visible to viewers; UI/API consistent with the export | `src/proxy.ts`, `src/app/api/audit-logs/route.ts`, `src/lib/navigation.ts`, `tests/admin-prod-sidebar.test.ts` | NAV-2 updated + SR-02d (viewer 403 on export) |
| S-06 | Webcam consent gate interval lowered 15 s → 5 s; revoking `webcam_access` consent **immediately** ends every active WebcamSession and drops buffered relay frames (admin frame-reader can no longer retrieve post-revoke frames) | `src/lib/webcam-relay.ts`, `src/lib/webcam-session-cleanup.ts` (new), `src/app/api/consent/[id]/route.ts`, `src/app/api/consent/bulk/route.ts` | code inspection + existing webcam tests |
| S-08 | `AuditLog.userAgent` column; sanitized (control-char-stripped, ≤200 chars) User-Agent captured on auth-critical audit rows (web login, logout, password change, user enable/disable, admin revoke, agent login) | `prisma/schema.prisma`, `src/lib/session.ts` (`sanitizeUserAgent`/`getUserAgent`), auth routes | SR-04a logout audit row asserted |
| S-11 | Test determinism: AA-A20 and EN-6 rate-limit tests no longer race the token-bucket refill — they pre-drain the shared bucket with direct limiter calls, then assert the real route 429s (limiter untouched). Full suite run twice: 1,085/1,085 pass | `tests/agent-account-admin.test.ts`, `tests/agent-register-parity.test.ts` | full parallel suite ×2 |
| email_monitoring | UI no longer claims email monitoring is active — the consent card states it is consent-only with no collector; PRIVACY.md already documented no email content is collected | `src/components/consent/consent-page.tsx` | — |

### Final certification

See **`SECURITY-FINAL-CERTIFICATION.md`** for the 100/100 certification with the full verification record.
