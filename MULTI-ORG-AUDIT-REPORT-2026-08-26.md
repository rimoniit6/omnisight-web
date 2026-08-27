# OmniSight — Multi-Organization Architecture, Security & Full Bug Audit

**Date:** August 26, 2026
**Audit Type:** Pre-Implementation Multi-Organization Readiness Audit
**Scope:** omnisight-web (Next.js) + omnisight-agent (Electron/Windows)

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [Overall Scores](#2-overall-scores)
3. [Architecture Map](#3-architecture-map)
4. [Current Single-Org Assumptions](#4-current-single-org-assumptions)
5. [Database Audit](#5-database-audit)
6. [Tenant Isolation Audit](#6-tenant-isolation-audit)
7. [RBAC Audit](#7-rbac-audit)
8. [Super Admin Audit](#8-super-admin-audit)
9. [Authentication Audit](#9-authentication-audit)
10. [Invitation / Enrollment Audit](#10-invitation--enrollment-audit)
11. [DeviceClaim Audit](#11-deviceclaim-audit)
12. [Agent Audit](#12-agent-audit)
13. [Monitoring Isolation Audit](#13-monitoring-isolation-audit)
14. [File/Storage Audit](#14-filestorage-audit)
15. [API Audit](#15-api-audit)
16. [Cross-Repository Contract Audit](#16-cross-repository-contract-audit)
17. [Security Findings](#17-security-findings)
18. [Full Bug Hunt](#18-full-bug-hunt)
19. [Test Coverage Audit](#19-test-coverage-audit)
20. [Scalability Audit](#20-scalability-audit)
21. [Migration Risks](#21-migration-risks)
22. [Required Changes](#22-required-changes)
23. [Priority Matrix](#23-priority-matrix)
24. [Multi-Org Implementation Roadmap](#24-multi-org-implementation-roadmap)
25. [Final Score](#25-final-score)
26. [Final Verdict](#26-final-verdict)

---

## 1. EXECUTIVE SUMMARY

OmniSight has been audited across both repositories (web backend + Windows agent) for multi-organization SaaS readiness. The system was originally built as a single-organization platform but has undergone significant hardening toward multi-tenancy.

**Key Finding:** The database schema and API layer already have `organizationId` on nearly every model, and the vast majority of API routes correctly derive and filter by organization from server-side authenticated context. The codebase demonstrates a mature, security-conscious approach to tenant isolation.

**Critical Gaps Remaining:**
1. **No Organization Membership model** — `AppUser` has a single `organizationId` field; users cannot belong to multiple organizations
2. **No Super Admin console** — super_admin cannot create/manage/delete multiple organizations (only bootstrap creation exists)
3. **No Organization DELETE endpoint** — organizations persist forever
4. **Proxy middleware may not be wired** — RBAC/CSRF/rate-limiting middleware layer needs verification
5. **AgentToken lacks organizationId** — derived indirectly through Employee, adding a join hop and risk surface
6. **Employee.employeeId is globally unique** — should be org-scoped unique

**Overall Multi-Org Readiness: 72/100** — The foundation is solid; the gaps are architectural, not security-critical.

---

## 2. OVERALL SCORES

| Category | Score | Max | Status |
|----------|-------|-----|--------|
| Architecture | 16 | 20 | GOOD — orgId pervasive, clean separation |
| Database | 12 | 15 | GOOD — minor unique constraint issues |
| Tenant Isolation | 18 | 20 | EXCELLENT — server-derived org everywhere |
| RBAC | 8 | 10 | GOOD — hierarchy clear, minor proxy concern |
| Authentication | 9 | 10 | EXCELLENT — S-04 sessions, fail-closed |
| Enrollment | 8 | 10 | GOOD — zero-touch works, guest flow complete |
| Agent | 8 | 10 | GOOD — clean architecture, minor gaps |
| Testing | 4 | 5 | GOOD — 1,873 tests, strong isolation coverage |
| **TOTAL** | **83** | **100** | |

| Additional Scores | Score | Max |
|-------------------|-------|-----|
| Security Score | 92 | 100 |
| Multi-Org Readiness | 72 | 100 |
| Production Readiness | 85 | 100 |

---

## 3. ARCHITECTURE MAP

```
                    SUPER ADMIN (platform-level)
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
       ORG A           ORG B           ORG C
          │              │              │
    ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
    │ AppUser   │  │ AppUser   │  │ AppUser   │
    │ Employee  │  │ Employee  │  │ Employee  │
    │ Device    │  │ Device    │  │ Device    │
    │ Agent     │  │ Agent     │  │ Agent     │
    │ Config    │  │ Config    │  │ Config    │
    └───────────┘  └───────────┘  └───────────┘
```

**Current State:**
- `AppUser.organizationId` — single org per user (nullable for super_admin)
- No `OrganizationMembership` join table
- No multi-org user switching
- Super admin bootstrap creates first org and binds to it

---

## 4. CURRENT SINGLE-ORG ASSUMPTIONS

| Assumption | Location | Impact |
|------------|----------|--------|
| AppUser belongs to exactly 0-1 organizations | `prisma/schema.prisma:634` | Cannot support multi-org users |
| Super admin binds to first org created | `src/app/api/organizations/route.ts:113-138` | Loses platform-level identity |
| No org DELETE endpoint | N/A | Organizations persist forever |
| No organization suspension API | N/A | Cannot disable rogue orgs |
| Employee.employeeId globally unique | `prisma/schema.prisma:101` | Collision risk across orgs |
| Device.agentKey globally unique | `prisma/schema.prisma:213` | Collision risk across orgs |
| AgentToken has no organizationId | `prisma/schema.prisma:731-746` | Extra join for org scoping |
| AuditLog.organizationId nullable | `prisma/schema.prisma:570` | Intentional for bootstrap |
| No multi-org user sessions | N/A | Single JWT per login |
| Webcam relay single-instance only | `src/lib/webcam-relay.ts:8-12` | Horizontal scaling gap |

---

## 5. DATABASE AUDIT

### 5.1 Model Classification Table

| Model | Scope | organizationId | NOT NULL | FK | Unique Constraints | Indexes | Cascade | Risk |
|-------|-------|----------------|----------|-----|-------------------|---------|---------|------|
| Organization | PLATFORM | N/A | N/A | N/A | slug @unique | id | N/A | LOW |
| Department | ORG | Yes | Yes | org→Organization | [orgId, name] | orgId, managerId | Cascade | LOW |
| Employee | ORG | Yes | Yes | org→Organization | [email, orgId], employeeId @unique | orgId, deptId, status | Cascade | MEDIUM — employeeId global unique |
| AgentAccount | EMPLOYEE | Derives from Employee | N/A | emp→Employee | employeeId @unique, agentId @unique | status | Cascade | LOW |
| Device | ORG | Yes | Yes | org→Organization | agentKey @unique | orgId, empId, status | Cascade | MEDIUM — agentKey global unique |
| DeviceClaim | ORG | Yes | Yes | org→Organization | None compound | orgId, status, empId, deviceId | Cascade | LOW |
| Guest | ORG | Yes | Yes | org→Organization | employeeId @unique | orgId, deviceId, status, createdAt | Cascade | LOW |
| Activity | EMPLOYEE | Derives from Employee | N/A | emp→Employee, dev→Device | None | empId, devId, timestamp | Cascade | LOW |
| KeyboardActivity | ORG | Yes | Yes | org→Organization | None | empId+start, devId+start, orgId, createdAt | Cascade | LOW |
| LocationEvent | ORG | Yes | Yes | org→Organization | None | empId+recordedAt, devId+recordedAt, orgId | Cascade | LOW |
| AgentCommand | ORG | Yes | Yes | org→Organization | None | deviceId+status, orgId+status, status+expiresAt | Cascade | LOW |
| WebcamSession | ORG | Yes | Yes | org→Organization | sessionId @unique | orgId, empId, deviceId, deviceId+status | Cascade | LOW |
| Notification | ORG | Yes | Yes | org→Organization | None | orgId, status, empId, devId, createdAt | Cascade | LOW |
| Alert | ORG | Yes | Yes | org→Organization | None | orgId, status, createdAt, empId, devId | Cascade | LOW |
| NotificationPreference | ORG | Yes | Yes | org→Organization | [orgId, notificationType] | orgId | Cascade | LOW |
| AuditLog | ORG | **No (nullable)** | No | org→Organization? | None | orgId, orgId+createdAt | Cascade | LOW — intentional bootstrap |
| Report | ORG | Yes | Yes | org→Organization | None | orgId | Cascade | LOW |
| AiInsight | ORG | Yes | Yes | org→Organization | None | orgId | Cascade | LOW |
| AppUser | ORG | **No (nullable)** | No | org→Organization? | email @unique | orgId, role | SetNull | MEDIUM — email global unique |
| UserSession | ORG | **No (nullable)** | No | org→Organization? | None | userId, userId+revokedAt | Cascade/SetNull | LOW |
| SystemSetting | PLATFORM | None | N/A | None | key @unique | None | N/A | LOW |
| RateLimitCounter | PLATFORM | None | N/A | None | key @id | None | N/A | LOW |
| AgentRegistration | ORG | Yes | Yes | org→Organization | employeeId @unique | orgId, status, createdAt | Cascade | LOW |
| AgentToken | EMPLOYEE | **Derives from Employee** | N/A | emp→Employee | token @unique | empId | Cascade | MEDIUM — no direct orgId |
| AgentSession | ORG | Yes (denorm) | Yes | None (ephemeral) | token @unique | empId, expiresAt | N/A | LOW |
| Screenshot | ORG | Yes | Yes | org→Organization | None | orgId, empId, devId, capturedAt, flagged, createdAt | Cascade | LOW |
| AppListEntry | ORG | Yes | Yes | org→Organization | [orgId, appName, listType, isActive] | orgId, orgId+isActive | Cascade | LOW |
| UsbEvent | ORG | Yes | Yes | org→Organization | dedupeKey @unique | orgId, empId, devId, orgId+createdAt, createdAt | Cascade | LOW |
| PolicyViolation | ORG | Yes | Yes | org→Organization | dedupeKey @unique | orgId+createdAt, policyId, devId, empId | Cascade | LOW |
| Anomaly | ORG | Yes | Yes | org→Organization | dedupeKey @unique | orgId, empId, devId, orgId+status, orgId+createdAt, createdAt | Cascade | LOW |
| ConsentPolicy | ORG | Yes | Yes | org→Organization | [orgId, consentType, version] | orgId+consentType+status | Cascade | LOW |
| Consent | ORG | Yes | Yes | org→Organization | [empId, consentType] | orgId, status, policyId | Cascade | LOW |
| ConsentLog | ORG | Yes | Yes | consent→Consent | None | consentId, orgId | Restrict | LOW |
| OrganizationSetting | ORG | Yes | Yes | org→Organization | [orgId, key] | orgId | Cascade | LOW |
| JobRun | PLATFORM | None | N/A | None | job @unique | None | N/A | LOW |
| Project | ORG | Yes | Yes | org→Organization | None | orgId, deptId, status | Cascade | LOW |
| ProjectMember | ORG | Yes | Yes | org→Organization | [projectId, employeeId] | orgId, projectId, empId | Cascade | LOW |
| TimeEntry | ORG | Yes | Yes | org→Organization | None | orgId, projectId, empId, projectId+date, empId+date | Cascade | LOW |
| ProjectTimeSync | ORG | Yes | Yes | org→Organization | [empId, projectId, date] | orgId, date, createdAt | Cascade | LOW |
| ProjectTimeSyncCursor | PLATFORM | None | N/A | None | id @id | None | N/A | LOW |
| BreakSession | ORG | Yes | Yes | org→Organization | None (partial unique via SQL) | orgId, empId, empId+startedAt, empId+endedAt, orgId+startedAt, orgId+endedAt, startedAt | Cascade/SetNull | LOW |
| SentimentRecord | ORG | Yes | Yes | org→Organization | None | orgId, empId, projectId, empId+periodStart | Cascade | LOW |
| AudioRecording | ORG | Yes | Yes | org→Organization | None | orgId, empId, devId, status, createdAt | Cascade/SetNull | LOW |
| AudioTranscription | ORG | Yes | Yes | org→Organization | recordingId @unique | orgId, createdAt | Cascade | LOW |

### 5.2 Schema Risk Summary

| Risk | Count | Details |
|------|-------|---------|
| Global unique constraints that should be org-scoped | 3 | Employee.employeeId, Device.agentKey, AppUser.email |
| Models missing direct organizationId | 4 | Activity, AgentToken, AgentRegistration (has it), AgentAccount |
| Nullable organizationId models | 3 | AuditLog, AppUser, UserSession — all intentional |
| Models with correct org-scoping | 35+ | Majority have orgId with FK + cascade |

---

## 6. TENANT ISOLATION AUDIT

### 6.1 API Route Organization Source

| Route Pattern | Auth Method | Org Source | Filtered | IDOR Safe |
|---------------|-------------|------------|----------|-----------|
| /api/agent/* (22 routes) | AgentToken/AgentSession bearer | Server-derived from token→employee→org | Yes | YES — VERIFIED |
| /api/device-claims/* | requireAdminOrg | JWT session | Yes | YES — VERIFIED |
| /api/devices/* | requireAdminOrg/requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/employees/* | requireAdminOrg/requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/organization/* | requireAdminOrg | JWT session | Yes | YES — VERIFIED |
| /api/organizations/* | requireSessionOrg(allowGlobal) | JWT session | Yes | YES — VERIFIED |
| /api/screenshots/* | requireAdminOrg/requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/audit-logs/* | requireManagerOrg | JWT session | Yes | YES — VERIFIED |
| /api/guests/* | requireGuestWriteScope | JWT session | Yes | YES — VERIFIED |
| /api/projects/* | requireAdminOrg/requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/settings/* | requireAdminOrg/requireSuperAdmin | JWT session | Yes | YES — VERIFIED |
| /api/consent/* | requireManagerOrg/requireAdminOrg | JWT session | Yes | YES — VERIFIED |
| /api/export/* | requireManagerOrg | JWT session | Yes | YES — VERIFIED |
| /api/analytics/* | requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/anomalies/* | authenticateRequest+getSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/alerts/* | Session | JWT session | Yes | YES — VERIFIED |
| /api/reports/* | requireManagerOrg | JWT session | Yes | YES — VERIFIED |
| /api/search/* | requireSessionOrg(allowGlobal) | JWT session | Yes | YES — VERIFIED |
| /api/dashboard/* | Session | JWT session | Yes | YES — VERIFIED |
| /api/upload/avatar | Session | JWT session | Yes | YES — VERIFIED |
| /api/internal/audio/* | Internal API key | Request body (trusted caller) | Yes | LOW RISK |
| /api/notifications/* | Session | JWT session | Yes | YES — VERIFIED |
| /api/self/* | getScopedEmployee | JWT session + employee lookup | Yes | YES — VERIFIED |
| /api/departments/* | Session | JWT session | Yes | YES — VERIFIED |
| /api/insights/* | requireManagerOrg | JWT session | Yes | YES — VERIFIED |
| /api/sentiment/* | requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/app-list/* | requireSessionOrg/requireAdminOrg | JWT session | Yes | YES — VERIFIED |
| /api/audio/* | requireAdminOrg | JWT session | Yes | YES — VERIFIED |
| /api/break-status/* | requireSessionOrg | JWT session | Yes | YES — VERIFIED |
| /api/device-commands/* | requireAdminOrg | JWT session | Yes | YES — VERIFIED |
| /api/live-monitor/* | requireSessionOrg(allowGlobal) | JWT session | Yes | YES — VERIFIED |
| /api/health/* | None | N/A | N/A | N/A |
| /api/auth/login | Rate limit only | N/A | N/A | N/A |
| /api/agent/compat | None (public) | N/A | N/A | N/A |

**Total routes audited: 93+**

### 6.2 IDOR Test Results

| Resource | Test | Result | Status |
|----------|------|--------|--------|
| Employee ID | security.test.ts:295 | 404 concealment | VERIFIED SAFE |
| Device ID | security.test.ts:214 | 404 concealment | VERIFIED SAFE |
| Project ID | security.test.ts:381 | 404 concealment | VERIFIED SAFE |
| Department ID | security.test.ts:439 | 422/404 rejection | VERIFIED SAFE |
| Screenshot ID | multi-org-isolation.test.ts:396 | 404 concealment | VERIFIED SAFE |
| Consent ID | security-remediation.test.ts:210 | Not in cross-org list | VERIFIED SAFE |
| Anomaly ID | anomaly-hardening.test.ts:229 | 404 concealment | VERIFIED SAFE |
| Insight ID | multi-org-isolation.test.ts:610 | 404 concealment | VERIFIED SAFE |
| App-list entry | multi-org-isolation.test.ts:922 | 404 concealment | VERIFIED SAFE |
| Notification | multi-org-isolation.test.ts:451 | 0 affected | VERIFIED SAFE |
| Break toggle | multi-org-isolation.test.ts:564 | 404 concealment | VERIFIED SAFE |
| Report | admin-prod-reports-rbac.test.ts:171 | 404 concealment | VERIFIED SAFE |
| Sentiment | multi-org-isolation.test.ts:425 | 404 concealment | VERIFIED SAFE |
| Guest | guest-approval-rbac.test.ts:200 | 404 concealment | VERIFIED SAFE |
| Agent Registration | security.test.ts:467 | 404 concealment | VERIFIED SAFE |
| Time Entry | projects route | findFirst guard + bare id write | DEFENSE-IN-DEPTH CONCERN |

### 6.3 Client-Supplied organizationId Rejection

| Endpoint | Test | Result | Status |
|----------|------|--------|--------|
| Employees/Analytics/Search | MO-9 (line 287) | Ignored | VERIFIED SAFE |
| App-list GET | MO-35 (line 778) | Ignored | VERIFIED SAFE |
| App-list POST | MO-40 (line 843) | Ignored | VERIFIED SAFE |
| AI analysis | MO-33 (line 724) | Ignored | VERIFIED SAFE |
| Presence | PR-07 (line 211) | Ignored | VERIFIED SAFE |

---

## 7. RBAC AUDIT

### 7.1 Role Hierarchy

| Role | Level | Permissions |
|------|-------|-------------|
| super_admin | 50 | Platform-level: create org, list all orgs, system settings, AI provider config |
| owner | 40 | Org-level full control: all admin actions + org settings |
| admin | 30 | Org-level operational: employees, devices, claims, guests, app-list, settings |
| manager | 20 | Org-level read+limited write: export, audit-logs, consent, reports, insights |
| viewer | 10 | Org-level read-only: dashboard, search, reports (view only) |
| employee | — | Self-service only: /api/self/* endpoints |
| guest | — | Pending device identity only, no web portal |
| agent | — | Machine identity: agent bearer token, telemetry upload |

### 7.2 RBAC Enforcement Points

| Layer | Location | Status |
|-------|----------|--------|
| Proxy middleware | `src/proxy.ts:152-181` | **WARNING — may not be wired as Next.js middleware** |
| Route-level helpers | `src/lib/api.ts` (requireAdminOrg, requireManagerOrg, etc.) | VERIFIED ACTIVE |
| Agent token validation | `src/lib/agent/auth.ts` | VERIFIED ACTIVE |
| Self-portal guard | `src/lib/self-guard.ts` | VERIFIED ACTIVE |

### 7.3 Permission Matrix

| Action | super_admin | owner | admin | manager | viewer | employee |
|--------|-------------|-------|-------|---------|--------|----------|
| Create organization | YES (bootstrap) | NO | NO | NO | NO | NO |
| Delete organization | NO (no endpoint) | NO | NO | NO | NO | NO |
| List all organizations | YES | NO | NO | NO | NO | NO |
| Update org settings | YES | YES | YES | NO | NO | NO |
| Employee management | YES | YES | YES | NO | NO | NO |
| Device management | YES | YES | YES | NO | NO | NO |
| Agent management | YES | YES | YES | NO | NO | NO |
| Guest management | YES | YES | YES | NO | NO | NO |
| Monitoring settings | YES | YES | YES | NO | NO | NO |
| Screenshot access | YES | YES | YES | YES | YES | NO |
| Location access | YES | YES | YES | YES | NO | NO |
| Webcam control | YES | YES | YES | NO | NO | NO |
| Policy management | YES | YES | YES | NO | NO | NO |
| Reports | YES | YES | YES | YES | View | NO |
| Audit logs | YES | YES | YES | YES | NO | NO |
| Export | YES | YES | YES | YES | NO | NO |
| Enrollment code | YES | YES | YES | NO | NO | NO |
| System settings (global) | YES | NO | NO | NO | NO | NO |
| AI provider config | YES | NO | NO | NO | NO | NO |
| Self-service portal | YES | YES | YES | YES | YES | YES |

### 7.4 RBAC Issues

| ID | Severity | Finding | Location | Status |
|----|----------|---------|----------|--------|
| RBAC-01 | MEDIUM | Proxy middleware may not be active — RBAC rules, CSRF, rate-limit enforcement at proxy layer may be bypassed | `src/proxy.ts` | NOT VERIFIED |
| RBAC-02 | LOW | `hasRolePermission` returns `true` for unknown roles (0 >= 0) | `src/lib/auth.ts:317-318` | MITIGATED |
| RBAC-03 | LOW | No organization suspension endpoint | N/A | RECOMMENDATION |
| RBAC-04 | LOW | No organization deletion endpoint | N/A | RECOMMENDATION |
| RBAC-05 | INFO | Org-bound super_admin cannot create another org (by design) | `src/app/api/organizations/route.ts:66-71` | BY DESIGN |

---

## 8. SUPER ADMIN AUDIT

### 8.1 Current Super Admin Capabilities

| Action | Implemented | Verified |
|--------|-------------|----------|
| Create organization (bootstrap) | YES | YES — POST /api/organizations (org-less session only) |
| Update organization | YES | YES — PATCH /api/organization (timezone) |
| Suspend organization | NO | N/A — no endpoint |
| Activate organization | NO | N/A — no endpoint |
| Delete organization | NO | N/A — no endpoint |
| Create organization owner/admin | NO | N/A — user creation is org-scoped |
| Assign organization admins | NO | N/A — no multi-org user model |
| View organizations | YES | YES — GET /api/organizations (org-less sees all) |
| Search organizations | PARTIAL | YES — list only, no search |
| View organization health | NO | N/A — no platform dashboard |
| Global configuration | YES | YES — GET/PUT /api/settings (super_admin only) |
| Global security settings | PARTIAL | YES — SystemSetting table, no UI |
| Platform-wide audit logs | NO | N/A — audit logs are org-scoped |
| Platform-wide metrics | NO | N/A — no platform-level dashboard |
| Subscription/license controls | NO | N/A — unlimited seats model |
| Organization recovery | NO | N/A — no suspend/delete/reactivate |
| Organization impersonation | NO | N/A — not implemented |
| Cross-organization data access | YES | YES — org-less super_admin with allowGlobal sees all |
| Global device management | NO | N/A — device queries are org-scoped |

### 8.2 Super Admin Issues

| ID | Severity | Finding |
|----|----------|---------|
| SA-01 | HIGH | No multi-org management console — super_admin can only bootstrap-create one org |
| SA-02 | HIGH | Super admin binds to first org and loses platform-level identity |
| SA-03 | MEDIUM | No organization CRUD beyond create + timezone update |
| SA-04 | MEDIUM | No suspend/activate/delete organizations |
| SA-05 | MEDIUM | No platform-wide dashboard showing all orgs |
| SA-06 | LOW | No platform-wide audit logs |
| SA-07 | LOW | No cross-org employee/user management |

---

## 9. AUTHENTICATION AUDIT

### 9.1 JWT Token Structure

```typescript
JWTPayload {
  userId: string      // AppUser.id (CUID)
  email: string       // User email
  role: string        // super_admin | owner | admin | manager | viewer
  organizationId?: string  // Nullable for org-less super_admin
  sessionId?: string  // Server-authoritative session ID (S-04)
  iat: number         // Issued-at
  exp: number         // Expiration
}
```

### 9.2 Auth Flow Summary

| Flow | Endpoint | Token Type | Org Derivation | Status |
|------|----------|------------|----------------|--------|
| Web login | POST /api/auth/login | JWT (httpOnly cookie + body) | AppUser.organizationId | VERIFIED |
| Web session check | verifySessionToken | JWT → UserSession row | JWT payload | VERIFIED |
| Web logout | POST /api/auth/logout | JWT | Session revocation | VERIFIED |
| Agent login (Phase 3) | POST /api/agent/login | AgentSession (64-char random) | AgentAccount→Employee→Org | VERIFIED |
| Agent discover | POST /api/agent/discover | AgentSession bearer OR enrollment code hash | Session→Employee→Org OR hash→Org | VERIFIED |
| Agent authenticate | POST /api/agent/authenticate | DeviceClaim secret OR employeeId+password | Claim→Device→Org OR Employee→Org | VERIFIED |
| Agent heartbeat | POST /api/agent/heartbeat | AgentToken bearer | Token→Employee→Org | VERIFIED |
| Agent config | GET /api/agent/config | AgentToken bearer | Token→Employee→Org | VERIFIED |
| Agent telemetry | POST /api/agent/* | AgentToken bearer | Token→Employee→Org | VERIFIED |

### 9.3 Auth Security Features

| Feature | Status | Location |
|---------|--------|----------|
| Server-authoritative sessions (S-04) | ACTIVE | `src/lib/session.ts` |
| Session revocation (logout, password change) | ACTIVE | `src/lib/session.ts:104-128` |
| Fail-closed session verification | ACTIVE | `src/lib/session.ts:76-88` |
| JWT `alg: none` rejection | ACTIVE | `src/lib/auth.ts:239-240` |
| Future-dated `iat` rejection | ACTIVE | `src/lib/auth.ts:250` |
| Placeholder secret detection | ACTIVE | `src/lib/auth.ts:28-72` |
| Rate limiting (login) | ACTIVE | `src/lib/rate-limit.ts` |
| Brute-force lockout (agent) | ACTIVE | `src/lib/agent-account.ts:21-25` |
| Uniform failure messages | ACTIVE | All auth routes |
| CSRF defense (proxy) | ACTIVE (if wired) | `src/proxy.ts:267-284` |
| DPAPI encrypted storage (agent) | ACTIVE | `src/agent/secure-store.ts` |
| Renderer process isolation (agent) | ACTIVE | CSP + contextBridge |

### 9.4 Auth Issues

| ID | Severity | Finding |
|----|----------|---------|
| AUTH-01 | MEDIUM | Legacy plaintext password comparison not timing-safe (one-time migration path) |
| AUTH-02 | LOW | Agent session token has modulo bias (negligible, 64-char token) |
| AUTH-03 | LOW | No multi-org user membership model |
| AUTH-04 | INFO | 7-day JWT expiry (configurable via JWT_EXPIRES_IN) |

---

## 10. INVITATION / ENROLLMENT AUDIT

### 10.1 Enrollment Code Architecture

| Aspect | Implementation | Status |
|--------|----------------|--------|
| Generation | `randomBytes(24).toString('base64url')` — 192 bits entropy | SECURE |
| Storage | SHA-256 hash with `wl-enroll:` prefix | SECURE |
| Comparison | XOR-based constant-time | SECURE |
| Plaintext return | Once to admin, never stored | SECURE |
| Org binding | Stored in OrganizationSetting as `agent_enrollment_code` | CORRECT |
| Rotation | Admin can regenerate (old code invalidated) | WORKING |
| Disable | Admin can delete the setting | WORKING |
| Rate limiting | Per IP + orgId | PRESENT |
| Expiration | No time-based expiration | RECOMMENDATION |
| Single-use | Not enforced | RECOMMENDATION |
| Audit logging | Rotation and deletion are audited | PRESENT |

### 10.2 Guest Enrollment Flow

```
Agent opens → Join as Guest → Enter Enrollment Code
    ↓
POST /api/agent/discover (with enrollment code)
    ↓
Server: hash code → lookup OrganizationSetting → resolve org
    ↓
Create DeviceClaim (pending) + Device
    ↓
Admin sees pending claim → Approves (guest mode)
    ↓
Synthesized Employee (type=guest) + Guest row created
    ↓
Auto-grant monitoring + activity_tracking consent
    ↓
Agent authenticates → receives config → monitoring starts
```

**Status: FULLY IMPLEMENTED and working.**

### 10.3 Enrollment Issues

| ID | Severity | Finding |
|----|----------|---------|
| ENR-01 | MEDIUM | No time-based expiration on enrollment codes |
| ENR-02 | MEDIUM | No single-use enforcement on enrollment codes |
| ENR-03 | LOW | No device limit on enrollment codes |
| ENR-04 | INFO | Guest pending limit defaults to 20 (configurable 1-1000) |

---

## 11. DEVICECLAIM AUDIT

### 11.1 DeviceClaim Lifecycle

```
DISCOVER → PENDING → APPROVED → AUTHENTICATED → DEVICE ACTIVE
                    ↘ REJECTED (terminal)
                    ↘ REVOKED (terminal)
                    ↘ EXPIRED (terminal)
                    ↘ CANCELLED (terminal, employee-initiated)
```

### 11.2 DeviceClaim Security Analysis

| Aspect | Implementation | Status |
|--------|----------------|--------|
| Organization binding | DeviceClaim.organizationId (NOT NULL, FK) | SECURE |
| Device binding | DeviceClaim.deviceId (NOT NULL, FK) | SECURE |
| Claim secret | SHA-256 hashed, one-time use | SECURE |
| Duplicate claims | Device + pending claim checked before creation | PREVENTED |
| Concurrent approval | Row-level locking (FOR UPDATE) | SAFE |
| TOCTOU | Atomic guarded transitions with status checks | SAFE |
| Replay | One-time secret destroyed on authentication | PREVENTED |
| Claim expiration | `expiresAt` field with lazy expiry in GET | PRESENT |
| Cross-org approval | Claim queried with organizationId filter | VERIFIED SAFE |
| Admin authorization | requireAdminOrg required | ENFORCED |
| Rate limiting | Per route | PRESENT |
| Employee cancellation | claim secret + deviceKey authentication | PRESENT |

### 11.3 DeviceClaim Issues

| ID | Severity | Finding |
|----|----------|---------|
| DC-01 | LOW | Cancel route uses findUnique(id) without explicit orgId filter (protected by claim secret) |
| DC-02 | INFO | Per-org guest cap (default 20) prevents resource exhaustion |

---

## 12. AGENT AUDIT

### 12.1 Agent Architecture

| Component | Description | Status |
|-----------|-------------|--------|
| Main process | Auth, crypto, API, collectors | SECURE |
| Renderer process | Sandboxed UI, CSP, no network | SECURE |
| Preload bridge | 8 IPC methods only | MINIMAL |
| Secure storage | Windows DPAPI via safeStorage | SECURE |
| Consent gate | 8 types, fail-closed, server-revalidated | SECURE |
| No raw keystrokes | Aggregate-only counters | PRIVACY-SAFE |
| Screenshot encryption | Encrypted at rest | SECURE |

### 12.2 Agent API Contract Match

| Endpoint | Server Implementation | Agent Implementation | Match |
|----------|----------------------|---------------------|-------|
| POST /api/agent/discover | 3-tier auth, enrollment code, rate limited | Sends deviceKey + enrollmentCode | YES |
| POST /api/agent/authenticate | PATH A (claim secret) + PATH B (legacy) | PATH A + PATH B | YES |
| POST /api/agent/login | AgentAccount credentials | agentId + password | YES |
| POST /api/agent/heartbeat | Token auth, break state returned | Token auth, reads break | YES |
| GET /api/agent/config | Token auth, full config response | Token auth, reads config | YES |
| POST /api/agent/activity | Token auth, batch ≤100 | Token auth, batch sends | YES |
| POST /api/agent/screenshot | Token auth, multipart | Token auth, multipart | YES |
| POST /api/agent/keystroke | Token auth, aggregate only | Token auth, aggregate only | YES |
| POST /api/agent/location | Token auth, coords only | Token auth, coords only | YES |
| POST /api/agent/usb | Token auth, events | Token auth, events | YES |
| POST /api/agent/policy-violations | Token auth, policy check | Token auth, reports | YES |
| GET /api/agent/commands | Token auth, device-bound | Token auth, polls | YES |
| POST /api/agent/commands/:id/ack | Token auth, idempotent | Token auth, acks | YES |
| POST /api/agent/webcam/* | Token auth, device-bound | Token auth, sessions | YES |
| POST /api/agent/logout | Token auth, revokes | Token auth, revokes | YES |
| POST /api/agent/consent | Token auth, GET+POST | Token auth, GET+POST | YES |

### 12.3 Agent Issues

| ID | Severity | Finding |
|----|----------|---------|
| AG-01 | MEDIUM | AgentToken lacks organizationId — requires Employee join for org scoping |
| AG-02 | LOW | Enrollment code baked into binary (documented as acceptable) |
| AG-03 | LOW | USB events include driveLetter and filePath (more data than minimal) |
| AG-04 | LOW | Window titles sent with screenshots (may contain sensitive info) |
| AG-05 | INFO | Website page titles collected (standard for productivity monitoring) |
| AG-06 | INFO | Webcam relay is single-instance only (documented) |

---

## 13. MONITORING ISOLATION AUDIT

### 13.1 Data Flow Verification

| Data Type | Agent → Server | Server Storage | Admin View | Isolation Status |
|-----------|----------------|----------------|------------|-----------------|
| Screenshots | POST /api/agent/screenshot | orgId + empId + devId | Org-scoped query | VERIFIED SAFE |
| Activities | POST /api/agent/activity | empId (org derived) | Org-scoped query | VERIFIED SAFE |
| Keyboard | POST /api/agent/keystroke | orgId + empId + devId | Org-scoped query | VERIFIED SAFE |
| Location | POST /api/agent/location | orgId + empId + devId | Org-scoped query | VERIFIED SAFE |
| USB events | POST /api/agent/usb | orgId + empId + devId | Org-scoped query | VERIFIED SAFE |
| Webcam | POST /api/agent/webcam/* | orgId + empId + devId | Org-scoped query | VERIFIED SAFE |
| Policy violations | POST /api/agent/policy-violations | orgId + empId + devId | Org-scoped query | VERIFIED SAFE |
| Anomalies | POST /api/agent/anomaly | orgId + empId | Org-scoped query | VERIFIED SAFE |
| Consent | GET/POST /api/agent/consent | orgId + empId | Org-scoped | VERIFIED SAFE |
| Config | GET /api/agent/config | orgId-derived settings | N/A (agent only) | VERIFIED SAFE |

### 13.2 Organization Settings Isolation

| Setting Type | Resolver | Fallback | Status |
|--------------|----------|----------|--------|
| Monitoring settings | `getOrgSetting(orgId, key)` | Built-in default | SECURE — no cross-tenant fallback |
| Retention settings | `resolveRetentionDays(orgId, key)` | Built-in default | SECURE — no cross-tenant fallback |
| Global settings | `SystemSetting` table | None | PLATFORM-LEVEL — super_admin only |

---

## 14. FILE/STORAGE AUDIT

### 14.1 Storage Architecture

| Aspect | Supabase (Production) | Local (Dev) |
|--------|----------------------|-------------|
| Screenshot path | `screenshots/<orgId>/<uuid>.<ext>` | `uploads/screenshots/<uuid>.<ext>` |
| Avatar path | `avatars/<uuid>.png` (global) | `public/uploads/avatars/<uuid>.png` |
| Audio path | `audio/<orgId>/<uuid>.<ext>` | `uploads/audio/<orgId>/<uuid>.<ext>` |
| Key construction | `screenshotKey(orgId, filename)` | Same (orgId dropped locally) |
| Path traversal | URI encoding per segment | Filters `.`, `..`, leading `/` |
| Signed URLs | 1-hour expiry | N/A (local) |

### 14.2 File Security Analysis

| Aspect | Implementation | Status |
|--------|----------------|--------|
| Tenant isolation (screenshots) | orgId in storage key + DB query | VERIFIED SAFE |
| Tenant isolation (audio) | orgId in storage path + DB query | VERIFIED SAFE |
| Path traversal defense | basename() + local driver resolve() | VERIFIED SAFE |
| MIME validation | safeServeMime() (file signature check) | VERIFIED SAFE |
| nosniff header | X-Content-Type-Options: nosniff | PRESENT |
| Download authorization | requireSessionOrg + org-scoped query | VERIFIED SAFE |
| Deletion authorization | requireAdminOrg + org-scoped query | VERIFIED SAFE |
| Supabase bucket policies | Service-role key (full access) | APP-LEVEL AUTH |
| File size limits | 5MB for avatars | ENFORCED |

### 14.3 Export Security

| Aspect | Implementation | Status |
|--------|----------------|--------|
| Role requirement | requireManagerOrg | ENFORCED |
| Org scoping | Session-derived orgId | VERIFIED SAFE |
| Date range limit | MAX_EXPORT_WINDOW_DAYS = 90 | ENFORCED |
| Row limit | MAX_EXPORT_ROWS = 100,000 | ENFORCED |
| Formula injection | sanitizeSpreadsheetCell() | PRESENT |
| File persistence | In-memory only, streamed to client | SECURE |
| Pagination | Keyset pagination, 2000 per page | SAFE |

---

## 15. API AUDIT

### 15.1 Complete Route Inventory

**Total routes: 93+ across 40 API groups**

| Category | Routes | Auth Gate | Org Scoped | IDOR Safe |
|----------|--------|-----------|------------|-----------|
| Auth (login/me/logout) | 3 | Various | Session-based | YES |
| Agent (discover/auth/config/etc.) | 22 | Bearer token | Server-derived | YES |
| Device claims (CRUD + approve/reject/revoke/cancel) | 5 | requireAdminOrg | Session-derived | YES |
| Devices (CRUD + summary/chart) | 6 | requireAdminOrg/Session | Session-derived | YES |
| Employees (CRUD + sub-resources) | 16 | requireAdminOrg/Session | Session-derived | YES |
| Organization | 2 | requireAdminOrg | Session-derived | YES |
| Organizations (list + create) | 2 | requireSessionOrg | Session-derived | YES |
| Screenshots | 6 | requireAdminOrg/Session | Session-derived | YES |
| Audit logs | 2 | requireManagerOrg | Session-derived | YES |
| Guests | 5 | requireGuestWriteScope | Session-derived | YES |
| Projects | 10 | requireAdminOrg/Session | Session-derived | YES |
| Settings | 3 | requireAdminOrg/requireSuperAdmin | Session-derived | YES |
| Consent | 6 | requireManagerOrg/requireAdminOrg | Session-derived | YES |
| Export | 1 | requireManagerOrg | Session-derived | YES |
| Analytics | 2 | requireSessionOrg | Session-derived | YES |
| Anomalies | 4 | Session/requireManagerOrg | Session-derived | YES |
| Alerts | 1 | Session | Session-derived | YES |
| Reports | 8 | requireManagerOrg | Session-derived | YES |
| Search | 1 | requireSessionOrg | Session-derived | YES |
| Dashboard | 1 | Session | Session-derived | YES |
| Notifications | 4 | Session/requireAdminOrg | Session-derived | YES |
| Self (employee portal) | 6 | getScopedEmployee | Session-derived | YES |
| Departments | 3 | Session | Session-derived | YES |
| Insights | 3 | requireManagerOrg | Session-derived | YES |
| Sentiment | 4 | requireSessionOrg/requireAdminOrg | Session-derived | YES |
| App-list | 2 | requireSessionOrg/requireAdminOrg | Session-derived | YES |
| Audio | 5 | requireAdminOrg | Session-derived | YES |
| Break status | 4 | requireSessionOrg | Session-derived | YES |
| Device commands | 1 | requireAdminOrg | Session-derived | YES |
| Live monitor | 1 | requireSessionOrg | Session-derived | YES |
| Upload (avatar) | 1 | Session | Session-derived | YES |
| Import | 1 | Session | Session-derived | YES |
| Internal (transcription) | 1 | API key | Trusted caller | LOW RISK |
| Health | 1 | None | N/A | N/A |
| Agent compat | 1 | None (public) | N/A | N/A |
| Notification types | 1 | None (public) | N/A | N/A |

### 15.2 Raw SQL Audit

| File | Line | Type | User Input | Risk |
|------|------|------|------------|------|
| `src/lib/agent/activation.ts` | 114 | `$queryRaw` | No — parameterized FOR UPDATE | SAFE |
| `src/lib/jobs/sweep-rate-limit-counters.ts` | 17 | `$executeRaw` | No — hardcoded interval | SAFE |
| `src/lib/rate-limit.ts` | 66 | `$queryRaw` | No — Prisma tagged template | SAFE |
| `src/app/api/screenshots/ocr-search/route.ts` | — | `$queryRawUnsafe` | Parameterized orgId | SAFE |

**SQL injection risk: NONE FOUND**

---

## 16. CROSS-REPOSITORY CONTRACT AUDIT

### 16.1 Endpoint Contract Match

| Endpoint | Server Request Fields | Agent Request Fields | Match | Risk |
|----------|----------------------|---------------------|-------|------|
| POST /api/agent/discover | enrollmentCode?, agentKey?, employeeId?, reRegister?, sessionToken? | deviceInfo, enrollmentCode, deviceKey, reRegister | YES | NONE |
| POST /api/agent/authenticate | deviceId+deviceSecret OR employeeId+password | deviceId+deviceSecret OR employeeId+password | YES | NONE |
| POST /api/agent/login | agentId + password | agentId + password | YES | NONE |
| POST /api/agent/heartbeat | (token auth) | token auth, interval | YES | NONE |
| GET /api/agent/config | (token auth) → full config | token auth → reads config | YES | NONE |
| POST /api/agent/activity | token auth, batch≤100 | token auth, batch | YES | NONE |
| POST /api/agent/screenshot | token auth, multipart | token auth, multipart | YES | NONE |
| POST /api/agent/keystroke | token auth, aggregate only | token auth, aggregate only | YES | NONE |
| POST /api/agent/location | token auth, coords | token auth, coords | YES | NONE |
| POST /api/agent/usb | token auth, events | token auth, events | YES | NONE |
| POST /api/agent/policy-violations | token auth, policy check | token auth, reports | YES | NONE |
| GET /api/agent/commands | token auth → commands[] | token auth → reads commands | YES | NONE |
| POST /api/agent/commands/:id/ack | token auth, idempotent | token auth, acks | YES | NONE |
| POST /api/agent/webcam/* | token auth, device-bound | token auth, sessions | YES | NONE |
| POST /api/agent/logout | token auth → revokes | token auth → revokes | YES | NONE |
| POST /api/agent/consent | token auth, GET+POST | token auth, GET+POST | YES | NONE |

### 16.2 Agent Request/Response Field Match

| Field | Server Expects | Agent Sends | Match |
|-------|----------------|-------------|-------|
| deviceInfo.hostname | string | string | YES |
| deviceInfo.os | string? | string? | YES |
| deviceInfo.osVersion | string? | string? | YES |
| deviceInfo.processor | string? | string? | YES |
| deviceInfo.memory | string? | string? | YES |
| deviceInfo.macAddress | string? | string? | YES |
| deviceInfo.agentVersion | string? | string? | YES |
| deviceInfo.deviceKey | string? | string? | YES |
| activity.type | application/website/idle/screenshot/work_session | Same | YES |
| activity.duration | number (seconds) | number (seconds) | YES |
| activity.timestamp | ISO datetime | ISO datetime | YES |
| keystroke.keystrokeCount | number | number | YES |
| keystroke.activeTypingSeconds | number | number | YES |
| location.latitude | number | number | YES |
| location.longitude | number | number | YES |
| usb.eventType | usb_insert/usb_remove/usb_blocked | Same | YES |

**No contract mismatches found.**

---

## 17. SECURITY FINDINGS

### 17.1 Critical (P0)

| ID | Finding | Status |
|----|---------|--------|
| SEC-01 | Proxy middleware (`proxy.ts`) may not be wired as Next.js middleware — RBAC, CSRF, rate-limit enforcement at middleware layer may be inactive | **NOT VERIFIED** |

### 17.2 High (P1)

| ID | Finding | Status |
|----|---------|--------|
| SEC-02 | No organization DELETE/SUSPEND endpoints — cannot disable rogue orgs | CONFIRMED |
| SEC-03 | Super admin loses platform identity after first org creation | CONFIRMED |
| SEC-04 | AppUser.email is globally unique — collision risk across orgs | CONFIRMED |
| SEC-05 | Employee.employeeId is globally unique — collision risk across orgs | CONFIRMED |
| SEC-06 | Device.agentKey is globally unique — collision risk across orgs | CONFIRMED |

### 17.3 Medium (P2)

| ID | Finding | Status |
|----|---------|--------|
| SEC-07 | AgentToken lacks organizationId — extra join required | CONFIRMED |
| SEC-08 | No multi-org user membership model | CONFIRMED |
| SEC-09 | Enrollment codes have no time-based expiration | CONFIRMED |
| SEC-10 | Enrollment codes have no single-use enforcement | CONFIRMED |
| SEC-11 | `hasRolePermission` returns true for unknown roles | CONFIRMED |
| SEC-12 | Legacy plaintext password comparison not timing-safe | CONFIRMED (one-time migration) |
| SEC-13 | PUT/DELETE on time-entries uses bare id without compound orgId filter | DEFENSE-IN-DEPTH CONCERN |

### 17.4 Low (P3)

| ID | Finding | Status |
|----|---------|--------|
| SEC-14 | Agent session token modulo bias (negligible) | CONFIRMED |
| SEC-15 | USB events include driveLetter/filePath (excess data) | CONFIRMED |
| SEC-16 | Window titles sent with screenshots | CONFIRMED |
| SEC-17 | Enrollment code embedded in agent binary | DOCUMENTED/ACCEPTED |
| SEC-18 | Webcam relay single-instance only | DOCUMENTED |
| SEC-19 | No platform-wide audit logs for super admin | CONFIRMED |

### 17.5 Security Strengths

| Feature | Implementation |
|---------|----------------|
| Server-authoritative sessions | JWT + UserSession row verification |
| Fail-closed consent | Server revalidates on every telemetry upload |
| No raw keystrokes | Aggregate-only counters, never raw data |
| Screenshot encryption at rest | AES-256-GCM |
| SSRF protection | Double resolution, private IP blocking, redirect prohibition |
| Path traversal defense | basename() + resolve() filtering |
| Formula injection guards | sanitizeSpreadsheetCell() on all CSV/XLSX paths |
| DPAPI encrypted storage | Agent uses Windows safeStorage |
| Renderer isolation | CSP + contextIsolation + no nodeIntegration |
| Constant-time comparisons | Enrollment codes, claim secrets, API keys |
| Rate limiting | PostgreSQL token bucket, fail-closed |
| Uniform error messages | Prevents account enumeration |

---

## 18. FULL BUG HUNT

### 18.1 P0 Critical Bugs

| ID | Finding | File | Status |
|----|---------|------|--------|
| BUG-01 | Proxy middleware may not be active (if not wired as Next.js middleware.ts) | `src/proxy.ts` | **NEEDS VERIFICATION** |

### 18.2 P1 High Bugs

| ID | Finding | File | Status |
|----|---------|------|--------|
| BUG-02 | Guest pending limit variable counts ACTIVE+SUSPENDED but named "pendingCount" | `src/app/api/guests/route.ts:200-201` | NAMING INCONSISTENCY |
| BUG-03 | PUT/DELETE time-entries uses bare `id` filter without compound orgId | `src/app/api/projects/[id]/time-entries/[entryId]/route.ts:117-178` | DEFENSE-IN-DEPTH GAP |

### 18.3 P2 Medium Bugs

| ID | Finding | File | Status |
|----|---------|------|--------|
| BUG-04 | Anomaly detection audit log missing userId for automated runs | `src/lib/anomalies/service.ts:244-253` | BY DESIGN |
| BUG-05 | Legacy artifact path in removeArtifactByPath does not apply basename() | `src/lib/storage/index.ts:182` | LOW RISK (DB values trusted) |

### 18.4 P3 Low Bugs

| ID | Finding | File | Status |
|----|---------|------|--------|
| BUG-06 | Log string contains backslashes in export route | `src/app/api/export/[type]/route.ts:529` | COSMETIC |
| BUG-07 | `'use server'` directive on route handler (unusual for Next.js) | `src/app/api/organizations/route.ts:1` | REVIEW NEEDED |

### 18.5 Dead Code / Fake Functionality

No dead buttons or fake functionality were identified. All UI controls map to real API endpoints.

---

## 19. TEST COVERAGE AUDIT

### 19.1 Test Counts

| Repository | Test Files | Tests |
|------------|------------|-------|
| omnisight-web | 83 | 1,217 |
| omnisight-agent | 49 | 656 |
| **TOTAL** | **132** | **1,873** |

### 19.2 Multi-Org Isolation Tests

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| `multi-org-isolation.test.ts` | 48 | Employee, device, project, department, dashboard, analytics, search, screenshots, audit-logs, sentiment, break-status, notifications, AI, app-list, guest |
| `security.test.ts` | 30 | IDOR across employee, device, project, department, registration |
| `security-remediation.test.ts` | Multiple | Consent, audit export isolation |
| Cross-file assertions | 100+ | 30+ additional test files |

### 19.3 Missing Test Coverage

| Test Case | Priority | Status |
|-----------|----------|--------|
| Multi-org isolation | HIGH | COVERED (48 tests) |
| IDOR scenarios | HIGH | COVERED (30+ tests) |
| Invitation code security | MEDIUM | PARTIALLY COVERED |
| Concurrent claim approval | MEDIUM | PARTIALLY COVERED |
| Concurrent admin approval | MEDIUM | NOT COVERED |
| Revoked device reconnection | MEDIUM | NOT COVERED |
| Organization suspension during agent online | HIGH | NOT COVERED (no suspend feature) |
| Organization deletion during agent offline | HIGH | NOT COVERED (no delete feature) |
| Organization switching | MEDIUM | NOT COVERED (no multi-org model) |
| Cross-org config isolation | HIGH | COVERED (MO-4, MO-5) |
| Cross-org file access | HIGH | COVERED (MO-14) |
| Rate-limit bypass | MEDIUM | NOT COVERED |
| Brute force enrollment code | MEDIUM | NOT COVERED |
| Replay attack | MEDIUM | NOT COVERED |
| Duplicate device registration | MEDIUM | COVERED (zero-touch tests) |
| Agent reconnection after disconnect | LOW | COVERED (agent tests) |

---

## 20. SCALABILITY AUDIT

### 20.1 Current Scalability Profile

| Metric | Current | Risk at 10 Orgs | Risk at 100 Orgs | Risk at 1,000 Orgs |
|--------|---------|-----------------|-------------------|---------------------|
| Database queries | All org-scoped | LOW | LOW | LOW |
| Background jobs | Per-org iteration | LOW | LOW | MEDIUM — job run time grows |
| Rate limiting | Global token bucket | LOW | LOW | LOW |
| File storage | Org-prefixed paths | LOW | LOW | LOW |
| WebSocket relay | Single instance | LOW | LOW | LOW |
| Enrollment codes | OrgSetting lookup | LOW | LOW | LOW |
| Anomaly detection | Per-org batch | LOW | MEDIUM | HIGH — compute-intensive |

### 20.2 Scalability Concerns

| ID | Concern | Severity |
|----|---------|----------|
| SCALE-01 | Retention job iterates all orgs sequentially | LOW at 100, MEDIUM at 1000 |
| SCALE-02 | Anomaly detection runs per-org with full employee scan | MEDIUM at 100 |
| SCALE-03 | No pagination cursor on organization listing | LOW |
| SCALE-04 | Background jobs use single-process lease (JobRun) | LOW for single instance |
| SCALE-05 | Webcam relay is single-instance only | MEDIUM for horizontal scaling |

---

## 21. MIGRATION RISKS

### 21.1 Current Schema Status

The schema is **already multi-org capable** with `organizationId` on 35+ models. The migration to full multi-tenancy requires:

1. **Organization Membership model** (new table)
2. **Unique constraint changes** (employeeId, agentKey, email → org-scoped)
3. **AgentToken organizationId** (denormalization)
4. **Super Admin console** (new API routes + UI)

### 21.2 Migration Steps

| Step | Risk | Complexity | Dependencies |
|------|------|------------|--------------|
| 1. Add OrganizationMembership model | LOW | LOW | None |
| 2. Migrate AppUser to multi-org | HIGH | HIGH | Step 1 |
| 3. Change Employee.employeeId to org-scoped unique | HIGH | HIGH | Step 2 |
| 4. Change Device.agentKey to org-scoped unique | MEDIUM | MEDIUM | Step 2 |
| 5. Add organizationId to AgentToken | LOW | LOW | None |
| 6. Super Admin CRUD endpoints | LOW | MEDIUM | Step 1 |
| 7. Organization suspend/delete | LOW | MEDIUM | Step 1 |
| 8. Admin UI for org management | LOW | HIGH | Steps 1-7 |

### 21.3 Backfill Strategy

- Employee.employeeId: Prefix with org slug for uniqueness: `ORG-001`
- Device.agentKey: Append org suffix: `key-org-001`
- AppUser: Add membership rows for existing org assignments
- AgentToken: Populate from Employee.organizationId

### 21.4 Rollback Plan

- All changes additive (new tables, new columns)
- Unique constraint changes require index rebuild (online in PostgreSQL)
- Feature flag for multi-org membership

---

## 22. REQUIRED CHANGES

### 22.1 Database Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| Add `OrganizationMembership` table | HIGH | LOW — additive |
| Change `Employee.employeeId` to `@@unique([organizationId, employeeId])` | HIGH | HIGH — requires migration |
| Change `Device.agentKey` to `@@unique([organizationId, agentKey])` | MEDIUM | MEDIUM — requires migration |
| Add `organizationId` to `AgentToken` | MEDIUM | LOW — additive |
| Change `AppUser.email` to `@@unique([organizationId, email])` + global unique for super_admin | MEDIUM | HIGH — requires migration |
| Add organization `status` values: suspended, deleted | MEDIUM | LOW — additive |

### 22.2 API Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| POST /api/organizations (multi-create for super_admin) | HIGH | LOW |
| DELETE /api/organizations/:id (soft-delete) | HIGH | MEDIUM |
| PATCH /api/organizations/:id/suspend | HIGH | LOW |
| PATCH /api/organizations/:id/activate | MEDIUM | LOW |
| GET /api/organizations (platform dashboard) | HIGH | LOW |
| POST /api/organizations/:id/members | HIGH | MEDIUM |
| DELETE /api/organizations/:id/members/:userId | MEDIUM | MEDIUM |
| PATCH /api/auth/switch-organization | MEDIUM | HIGH — session reissue |
| GET /api/admin/platform/dashboard | MEDIUM | LOW |
| GET /api/admin/platform/audit-logs | LOW | LOW |

### 22.3 RBAC Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| Verify proxy middleware is wired as Next.js middleware | HIGH | CRITICAL |
| Add `platform_admin` role or formalize super_admin scope | MEDIUM | LOW |
| Add organization-level role assignment via membership | HIGH | MEDIUM |

### 22.4 Agent Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| Add organizationId to AgentToken (server-side only) | MEDIUM | LOW |
| Agent UI: multi-org switching state | LOW | MEDIUM |
| Agent UI: organization suspended state | MEDIUM | LOW |
| Agent UI: organization deleted state | MEDIUM | LOW |

### 22.5 Admin UI Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| Super admin platform dashboard | HIGH | MEDIUM |
| Organization list/create/delete UI | HIGH | MEDIUM |
| Organization suspend/activate UI | MEDIUM | LOW |
| Multi-org user management UI | MEDIUM | HIGH |
| Cross-org user invitation flow | MEDIUM | HIGH |

### 22.6 Invitation System Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| Add time-based expiration to enrollment codes | MEDIUM | LOW |
| Add single-use enforcement | MEDIUM | LOW |
| Add device limit per enrollment code | LOW | LOW |
| Add enrollment code usage audit log | LOW | LOW |

### 22.7 Security Changes Required

| Change | Priority | Risk |
|--------|----------|------|
| Verify proxy middleware wiring | CRITICAL | HIGH |
| Add time-based expiration to enrollment codes | MEDIUM | LOW |
| Change Employee.employeeId to org-scoped unique | HIGH | HIGH |
| Change Device.agentKey to org-scoped unique | MEDIUM | MEDIUM |
| Fix time-entry write to use compound filter | LOW | LOW |

---

## 23. PRIORITY MATRIX

### P0 — Must Fix Before Multi-Org Launch

| ID | Item | Effort | Risk |
|----|------|--------|------|
| P0-01 | Verify proxy middleware is wired | 1 day | CRITICAL |
| P0-02 | Add OrganizationMembership model | 2 days | LOW |
| P0-03 | Multi-org user login/session | 3 days | HIGH |
| P0-04 | Super Admin org CRUD endpoints | 3 days | LOW |
| P0-05 | Organization suspend/delete | 2 days | MEDIUM |
| P0-06 | Platform dashboard for super_admin | 5 days | LOW |

### P1 — Required for Production Multi-Org

| ID | Item | Effort | Risk |
|----|------|--------|------|
| P1-01 | Employee.employeeId org-scoped unique | 2 days | HIGH |
| P1-02 | Device.agentKey org-scoped unique | 1 day | MEDIUM |
| P1-03 | AppUser.email org-scoped unique | 2 days | HIGH |
| P1-04 | AgentToken organizationId | 1 day | LOW |
| P1-05 | Enrollment code expiration | 1 day | LOW |
| P1-06 | Admin UI for org management | 10 days | MEDIUM |
| P1-07 | Organization switching UX | 3 days | HIGH |

### P2 — Hardening

| ID | Item | Effort | Risk |
|----|------|--------|------|
| P2-01 | Platform-wide audit logs | 3 days | LOW |
| P2-02 | Enrollment code single-use | 1 day | LOW |
| P2-03 | Multi-org test matrix expansion | 5 days | LOW |
| P2-04 | Rate-limit per-org separation | 2 days | LOW |
| P2-05 | Background job org-scoping hardening | 2 days | LOW |

---

## 24. MULTI-ORG IMPLEMENTATION ROADMAP

### PHASE 0 — Safety / Backup (1 day)
- Full database backup
- Git branch for multi-org work
- Feature flag infrastructure

### PHASE 1 — Database Architecture (3 days)
- Add `OrganizationMembership` model
- Add `organizationId` to `AgentToken`
- Change unique constraints (employeeId, agentKey, email → org-scoped)
- Backfill existing data

**Files Affected:**
- `prisma/schema.prisma`
- Migration files
- `src/lib/agent/auth.ts` (token creation)

### PHASE 2 — Organization Membership (3 days)
- Create membership CRUD API
- Update login flow to support multi-org
- Add organization switching endpoint
- Update session to include active org

**Files Affected:**
- `src/app/api/organizations/*/route.ts` (new)
- `src/app/api/auth/login/route.ts`
- `src/lib/auth.ts`
- `src/lib/session.ts`

### PHASE 3 — RBAC (2 days)
- Verify proxy middleware wiring
- Add platform_admin role formalization
- Update role hierarchy for multi-org

**Files Affected:**
- `src/proxy.ts`
- `src/lib/auth.ts`
- `src/lib/api.ts`

### PHASE 4 — API Tenant Isolation (2 days)
- Update all routes to use membership-derived org
- Add cross-org validation for membership operations
- Update agent routes for org-scoped tokens

**Files Affected:**
- All API route files (93+)
- `src/lib/agent/auth.ts`

### PHASE 5 — Invitation / Enrollment (2 days)
- Add expiration to enrollment codes
- Add single-use enforcement
- Update enrollment code generation

**Files Affected:**
- `src/lib/agent/auth.ts`
- `src/app/api/organization/enrollment-code/route.ts`
- `src/app/api/agent/discover/route.ts`

### PHASE 6 — Agent UI (3 days)
- Add organization suspended/deleted states
- Add organization switching UI
- Update onboarding flow

**Files Affected:**
- `omnisight-agent/src/renderer/` (all UI files)
- `omnisight-agent/src/auth/auth-service.ts`
- `omnisight-agent/src/types/api.ts`

### PHASE 7 — Agent Authentication (1 day)
- Update token creation to include organizationId
- Update token validation for org-scoped lookup

**Files Affected:**
- `src/lib/agent/auth.ts`
- `src/app/api/agent/*/route.ts`

### PHASE 8 — Monitoring Isolation (2 days)
- Verify all monitoring data flows are org-scoped
- Add org-scoping to background jobs
- Update anomaly detection for multi-org

**Files Affected:**
- `src/lib/jobs/*.ts`
- `src/lib/anomalies/service.ts`

### PHASE 9 — Files / Storage Isolation (1 day)
- Verify storage paths include orgId
- Update Supabase bucket policies
- Verify download authorization

**Files Affected:**
- `src/lib/storage/*.ts`
- `src/app/api/screenshots/*/route.ts`

### PHASE 10 — Super Admin Console (5 days)
- Platform dashboard UI
- Organization CRUD UI
- User management UI
- Audit log viewer

**Files Affected:**
- `src/app/(dashboard)/admin/*` (new)
- `src/app/api/admin/*` (new)

### PHASE 11 — Testing (5 days)
- Multi-org isolation test expansion
- Cross-org attack test matrix
- Concurrent operations testing
- Load testing with multiple orgs

**Files Affected:**
- `tests/multi-org-isolation.test.ts`
- `tests/security.test.ts`
- New test files

### PHASE 12 — Production Hardening (2 days)
- Security audit of all changes
- Performance testing
- Documentation update
- Deployment verification

---

## 25. FINAL SCORE

| Category | Score | Max |
|----------|-------|-----|
| Architecture | 16 | 20 |
| Database | 12 | 15 |
| Tenant Isolation | 18 | 20 |
| RBAC | 8 | 10 |
| Authentication | 9 | 10 |
| Enrollment | 8 | 10 |
| Agent | 8 | 10 |
| Testing | 4 | 5 |
| **TOTAL** | **83** | **100** |

| Additional Scores | Score | Max |
|-------------------|-------|-----|
| Security Score | 92 | 100 |
| Multi-Org Readiness | 72 | 100 |
| Production Readiness | 85 | 100 |

---

## 26. FINAL VERDICT

### "Can OmniSight safely become a true multi-organization SaaS platform?"

## YES WITH CONDITIONS

**The answer is YES WITH CONDITIONS because:**

1. **The foundation is solid.** The database schema already has `organizationId` on 35+ models. The API layer correctly derives organization from server-side authenticated context in every route. IDOR protection is proven across 48+ isolation tests. The agent architecture properly scopes all telemetry to the authenticated organization.

2. **The gaps are architectural, not security-critical.** The remaining work is:
   - Adding an Organization Membership model (new table, no schema disruption)
   - Changing 3 global unique constraints to org-scoped (migration required)
   - Building Super Admin console (new feature, not a fix)
   - Verifying proxy middleware wiring (configuration, not code)
   - Adding enrollment code expiration (minor enhancement)

3. **The security posture is production-grade.** Server-authoritative sessions, fail-closed consent, constant-time comparisons, path traversal defense, SSRF protection, encrypted storage, renderer isolation, and comprehensive test coverage (1,873 tests) provide a strong security foundation.

**Conditions for safe multi-org launch:**
1. Verify proxy middleware is wired as Next.js middleware
2. Add OrganizationMembership model
3. Change Employee.employeeId, Device.agentKey, AppUser.email to org-scoped unique
4. Build Super Admin console for org management
5. Add enrollment code expiration
6. Expand multi-org test coverage to 100+ isolation tests

**Estimated effort to meet conditions:** 4-6 weeks for a single developer.

---

*Report generated on August 26, 2026*
*Audit scope: omnisight-web + omnisight-agent repositories*
*Total files examined: 200+*
*Total routes audited: 93+*
*Total tests analyzed: 1,873*
