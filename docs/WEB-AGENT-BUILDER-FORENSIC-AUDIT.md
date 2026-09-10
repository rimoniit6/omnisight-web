# ================================================================
# OMNISIGHT MASTER PRD-ALIGNED
# WEB ↔ AGENT ↔ AGENT BUILDER FULL FORENSIC AUDIT
# ================================================================

**Audit Date:** September 8, 2026
**Mode:** READ-ONLY — No files modified

---

## 1. Audit Metadata

| Field | Value |
|-------|-------|
| Web Repository | `E:\Live project\omnisight\omnisight-web` |
| Agent Repository | `E:\Live project\omnisight\omnisight-agent` (NOT present in working tree) |
| Agent Builder | Part of Agent repository — NOT auditable |
| Master PRD | `master.PRD` (2360 lines, 80 sections) |
| Web Version | 0.2.1 |
| TypeScript | Clean (tsc --noEmit passes) |
| Tests | 100+ files, 43,754 lines, key suites passing |

---

## 2. Repository Availability

| Repository | Available | Auditable | Notes |
|------------|-----------|-----------|-------|
| omnisight-web | ✅ YES | ✅ FULL | Complete codebase inspected |
| omnisight-agent | ❌ NO | ❌ CONTRACT-LEVEL ONLY | Separate checkout not in this tree |
| Agent Builder | ❌ NO | ❌ NOT AUDITABLE | Part of Agent repo |

---

## 3. Master PRD Summary

The Master PRD (`master.PRD`) defines OmniSight as a **multi-organization workforce monitoring platform** with:

- **3 Service Models:** MANAGED, CUSTOMER_DB, PRIVATE
- **4 User Roles:** Super Admin, Organization Admin, Manager, Viewer
- **Subscription lifecycle:** PENDING → ACTIVE → PAUSED → ACTIVE → EXPIRED
- **Manual payment** for V1
- **Server-authoritative Agent** capabilities
- **Strict tenant isolation**
- **Agent Builder** as Super Admin tool

---

## 4. Executive Summary

The Web repository has a **substantial, production-grade implementation** with strong foundations in multi-tenancy, RBAC, Agent authentication, and database design. However, the audit reveals **critical gaps** in subscription lifecycle (PAUSED state missing), terminology alignment (SUSPENDED vs PAUSED), and Agent-level subscription enforcement. The Agent repository is not available for direct audit, creating significant verification gaps.

**Overall Master PRD Alignment Score: 62/100**

**Final Verdict: NOT READY — PRODUCT DECISIONS REQUIRED**

---

## 5. Overall Alignment Score

| Area | Score | Notes |
|------|-------|-------|
| Master PRD Alignment | 62/100 | Core architecture compatible; subscription lifecycle gaps |
| Web Alignment | 80/100 | Strong implementation; needs subscription and terminology fixes |
| Agent Alignment | 55/100 | Contract-level only; cannot verify runtime behavior |
| Agent Builder Alignment | 30/100 | Not auditable from this repository |
| Web ↔ Agent Contract | 65/100 | Core endpoints defined; subscription enforcement gaps |
| Service Model Alignment | 60/100 | Enum exists; PRIVATE lacks differentiated behavior |
| Subscription Alignment | 45/100 | PAUSED state missing; lifecycle incomplete |
| RBAC Alignment | 78/100 | Strong definitions; Viewer/Manager enforcement needs verification |
| Tenant Isolation | 82/100 | Strong foundations; some routes need verification |
| Security | 75/100 | Good auth; rate limiting present; needs hardening |
| Data Integrity | 78/100 | Well-structured; Employee identity scope unclear |
| Testing | 65/100 | Good unit/integration; gaps in contract and E2E |
| Production Readiness | 60/100 | Functional; needs subscription and deployment hardening |

---

## 6. Architecture Assessment

### Tech Stack
- **Framework:** Next.js (App Router)
- **Database:** PostgreSQL via Prisma ORM
- **Auth:** Custom JWT (HS256) + bcrypt + session cookies
- **Agent Auth:** Bearer tokens (24h expiry) + AgentSession (short-lived)
- **Storage:** S3-compatible (Supabase Storage or local)
- **Testing:** Node.js test runner + tsx

### Architecture Strengths
- Clean multi-tenant data model with `organizationId` on every tenant-scoped table
- Strong RBAC with centralized permission definitions (`src/lib/permissions.ts`)
- Agent authentication with organization binding enforced server-side
- Single-active-device rule with row-level locking (`src/lib/agent/activation.ts`)
- Tenant scope helpers (`src/lib/tenant-scope.ts`) with fail-closed assertions
- Deployment mode resolver (`src/lib/deployment-mode.ts`) with validation

### Architecture Concerns
- **Subscription lacks PAUSED status** — PRD requires ACTIVE ↔ PAUSED transitions
- **Organization status uses 'suspended'** instead of PRD-defined 'PAUSED'
- **Employee.employeeId is globally unique** — PRD says evaluate scope carefully
- **Agent Builder not in this repository** — cannot verify build-time enforcement
- **PRIVATE service model has no differentiated behavior** — label only

---

## 7. Product Model Reconstruction

### Actual Product Model

| Concept | Implementation | PRD Requirement | Status |
|---------|---------------|-----------------|--------|
| Organization | `Organization` model with `status` field | Tenant boundary | ✅ ALIGNED |
| Super Admin | `AppUser.role = 'super_admin'` | Platform authority | ✅ ALIGNED |
| Org Admin | `OrganizationMembership.role = 'org_admin'` | Organization admin | ✅ ALIGNED |
| Manager | `OrganizationMembership.role = 'manager'` | Operational role | ✅ ALIGNED |
| Viewer | `OrganizationMembership.role = 'viewer'` | Read-only role | ✅ ALIGNED |
| Employee | `Employee` model, org-scoped | Monitored employee | ⚠️ IDENTITY SCOPE UNCLEAR |
| Agent | `AgentToken` + `Device` + `AgentAccount` | Server-authorized | ✅ ALIGNED |
| Device | `Device` model with `agentKey` | Machine identity | ✅ ALIGNED |
| Package | `Plan` model (NOT "Package") | Commercial entitlement | ⚠️ NAMING DRIFT |
| Subscription | `Subscription` model | Subscription lifecycle | ❌ PAUSED MISSING |
| Invoice | `Invoice` model | Manual payment | ✅ ALIGNED |
| DeploymentMode | `DeploymentMode` enum | Service model | ⚠️ PARTIAL |
| Capability | Plan.features JSON + org monitoring settings | Entitlement-aware | ⚠️ BROKEN CHAIN |

### Terminology Inconsistencies

| PRD Term | Implementation Term | Conflict? |
|----------|-------------------|-----------|
| Package/Plan | `Plan` model | ⚠️ Minor — Plan is acceptable |
| Pause (Organization) | `suspended` status | ❌ CONFLICT |
| PAUSED (Subscription) | Not implemented | ❌ MISSING |
| Service Model | `deploymentMode` | ✅ Compatible |
| Capability | `Plan.features` + `OrganizationSetting` | ⚠️ Not unified |

---

## 8. Service Model Audit

### 8.1 MANAGED

| Dimension | Implementation | PRD Requirement | Status |
|-----------|---------------|-----------------|--------|
| Database | Single shared PostgreSQL | OmniSight owns DB | ✅ PASS |
| Application | Next.js hosted | OmniSight owns app | ✅ PASS |
| Storage | S3-compatible | OmniSight owns storage | ✅ PASS |
| Agent Behavior | Standard | Standard | ✅ PASS |
| Super Admin Access | Full operational dashboard | Full access | ✅ PASS |
| Deployment Mode | `DeploymentMode.MANAGED` | MANAGED | ✅ PASS |

### 8.2 CUSTOMER_DB

| Dimension | Implementation | PRD Requirement | Status |
|-----------|---------------|-----------------|--------|
| Database | Blocked in provisioning | Customer owns DB | ⚠️ CORRECTLY BLOCKED |
| Application | OmniSight hosts | OmniSight hosts app/API | ✅ PASS |
| External DB Config | `OrganizationSettings.useOwnDb` exists | Explicit config needed | ⚠️ PARTIAL |
| Agent Behavior | Same as MANAGED | Needs differentiation | ❌ MISSING |
| Provisioning | Blocked with error message | Cannot provision yet | ✅ CORRECT |

**Evidence:** `src/app/api/admin/organizations/create/route.ts` blocks CUSTOMER_DB selection.

### 8.3 PRIVATE

| Dimension | Implementation | PRD Requirement | Status |
|-----------|---------------|-----------------|--------|
| Database | Label only | Customer owns DB | ❌ LABEL ONLY |
| Application | Label only | Customer owns app | ❌ LABEL ONLY |
| Storage | Label only | Customer owns storage | ❌ LABEL ONLY |
| Agent Behavior | Same as MANAGED | Customer-managed | ❌ NO DIFFERENTIATION |
| Deployment | No packaging | Customer installs | ❌ NOT IMPLEMENTED |
| License | `LicenseKey` model exists | License validation | ⚠️ PARTIAL |

**Evidence:** `DeploymentMode.PRIVATE` exists in enum but no code path treats it differently from MANAGED.

---

## 9. Package / Subscription / Capability Audit

### The Chain (PRD Required)

```
Organization
    ↓
Subscription
    ↓
Package (Plan)
    ↓
Services/Capabilities
    ↓
Agent Configuration
    ↓
Agent Runtime Enforcement
```

### Actual Implementation

```
Organization → Subscription → Plan → features (JSON array)
                                        ↓
                              Agent Config endpoint
                                        ↓
                              Agent receives config
                                        ↓
                              Agent gates on config + consent
```

### Chain Analysis

| Link | Implemented? | Evidence | Gap |
|------|-------------|----------|-----|
| Organization → Subscription | ✅ Yes | `Organization.subscriptionId` FK | None |
| Subscription → Plan | ✅ Yes | `Subscription.planId` FK | None |
| Plan → Capabilities | ⚠️ Partial | `Plan.features` JSON array | Features are string labels, not structured capabilities |
| Capabilities → Agent Config | ⚠️ Partial | `/api/agent/config` reads plan features | Screenshot frequency override exists; other capabilities unclear |
| Agent Config → Runtime | ❌ UNVERIFIED | Agent repo not available | Cannot verify runtime enforcement |
| Server Authority | ⚠️ Partial | Config endpoint enforces screenshot policy | Other capabilities may not be enforced |

### Critical Gap: Subscription PAUSED Not Implemented

**SubscriptionStatus enum:**
```prisma
enum SubscriptionStatus {
  PENDING   // Payment pending verification
  ACTIVE    // Fully active
  EXPIRED   // Passed endDate
  CANCELLED // Manually cancelled by admin/user
}
```

**PRD requires:**
```
PENDING → ACTIVE → PAUSED → ACTIVE → EXPIRED → CANCELLED
```

**Missing:** `PAUSED` status. No code path for subscription pause/resume.

---

## 10. Organization Lifecycle

### PRD Required
```
PROVISIONING → ACTIVE → PAUSED → ACTIVE → EXPIRED → RENEWED/ACTIVE
```

### Actual Implementation
```
pending → active → suspended → archived
```

### Status Mapping

| PRD Status | Implementation Status | Conflict? |
|------------|----------------------|-----------|
| PROVISIONING | `pending` | ⚠️ Acceptable |
| ACTIVE | `active` | ✅ Aligned |
| PAUSED | `suspended` | ❌ CONFLICT — terminology mismatch |
| EXPIRED | Not implemented | ❌ MISSING |
| DELETED | `archived` | ⚠️ Different concept |

**Evidence:** `src/app/api/super-admin/organizations/[id]/route.ts` line 146: `['pending', 'active', 'suspended', 'archived']`

**Impact:** Agent auth checks `org.status !== 'active'` which works for suspended orgs, but the PRD requires "PAUSED" terminology and explicit PAUSED behavior (data preserved, Agent stopped).

---

## 11. Subscription Lifecycle

### PRD States

| State | Implemented? | Evidence | Agent Impact |
|-------|-------------|----------|-------------|
| PENDING | ✅ Yes | `SubscriptionStatus.PENDING` | N/A |
| ACTIVE | ✅ Yes | `SubscriptionStatus.ACTIVE` | Agent operates normally |
| PAUSED | ❌ NO | Not in enum | Cannot pause subscription |
| EXPIRED | ✅ Yes | `SubscriptionStatus.EXPIRED` | UNVERIFIED — Agent not checked |
| CANCELLED | ✅ Yes | `SubscriptionStatus.CANCELLED` | UNVERIFIED — Agent not checked |

### Agent Subscription Enforcement

**Agent auth checks (from `src/lib/agent/auth.ts`):**
1. ✅ Employee status = 'active'
2. ✅ Employee.agentApproved = true
3. ✅ AgentAccount status = 'active' (if exists)
4. ✅ Organization status = 'active'
5. ✅ Device status = 'online' or 'offline'
6. ❌ **Subscription status NOT checked**

**Agent config endpoint (from `/api/agent/config`):**
1. ✅ Fetches subscription and plan
2. ✅ Screenshot frequency overridden by plan features
3. ❌ **No general subscription status enforcement**
4. ❌ **No PAUSED subscription handling**

**Critical Finding:** The Agent can continue operating even when the subscription is EXPIRED or CANCELLED, because `validateAgentToken()` does not check subscription status. Only organization status (`active`) is checked.

---

## 12. Super Admin Audit

### Authentication
- ✅ Email/password login with bcrypt
- ✅ JWT (HS256) with session cookies
- ✅ Rate limiting on login
- ✅ `requireSuperAdmin()` middleware
- **Evidence:** `src/app/api/auth/login/route.ts`, `src/lib/auth.ts`

### Dashboard
- ✅ Metrics API returns real database counts
- ✅ Organization count, active devices, revenue
- **Evidence:** `src/app/api/super-admin/metrics/route.ts`

### Organization Management
- ✅ CRUD with deployment mode validation
- ✅ Status transitions: pending/active/suspended/archived
- ⚠️ No PAUSED status (uses 'suspended')
- ✅ Deployment mode changes validated
- ✅ Audit logging on mutations
- **Evidence:** `src/app/api/super-admin/organizations/[id]/route.ts`

### Subscription Management
- ✅ Create subscription with plan
- ✅ List/filter subscriptions
- ⚠️ No PAUSED status available
- ⚠️ No pause/resume workflow
- **Evidence:** `src/app/api/super-admin/subscriptions/route.ts`

### Invoice Management
- ✅ Create invoice with payment details
- ✅ Payment method, transaction ID, amount
- ✅ Status tracking (PENDING/PAID/OVERDUE/CANCELLED)
- **Evidence:** `src/app/api/admin/invoices/`

---

## 13. Organization Admin Audit

### Permissions
- ✅ Organization-scoped via `OrganizationMembership`
- ✅ Can manage members, employees, devices
- ✅ Can read subscription/service model info
- ❌ Cannot modify commercial fields (service model, pricing) — enforced server-side

### Evidence
- `src/lib/permissions.ts` — `ORG_ADMIN_PERMISSIONS` array
- `src/lib/api.ts` — `requireOrgAdmin()` middleware

---

## 14. Manager Audit

### Permissions Defined
- ✅ Read: organization, settings, employees, devices, projects, reports, agents, audio, consent, policies, alerts, anomalies, notifications, dashboard, analytics, insights, sentiment
- ✅ Create/Update: employees, projects
- ❌ No delete permissions
- ❌ No member management
- ❌ No device management

### Enforcement
- ✅ Permission checks via `hasPermission()` in `src/lib/permissions.ts`
- ⚠️ Server-side enforcement needs verification on all mutation endpoints

---

## 15. Viewer Audit

### Permissions Defined
- ✅ Read-only across all organization resources
- ❌ No create/update/delete permissions
- ❌ No member management
- ❌ No device management

### Enforcement
- ✅ Permission checks via `hasPermission()` in `src/lib/permissions.ts`
- ⚠️ API-level write prevention needs verification on all mutation endpoints

---

## 16. Employee Audit

### Identity Model
- ✅ `Employee.employeeId` — globally unique (`@unique`)
- ✅ `Employee.organizationId` — org-scoped
- ✅ `@@unique([email, organizationId])` — email unique per org
- ⚠️ **PRD Question:** Should employeeId be globally unique or org-scoped?

### Lifecycle
- ✅ Create → Active → Inactive/Archived
- ✅ `agentApproved` flag for admin approval
- ✅ `agentPassword` for agent authentication
- ✅ `AgentAccount` 1:1 relationship

### Evidence
- `prisma/schema.prisma` — Employee model
- `src/app/api/employees/` — CRUD endpoints

---

## 17. Agent Authentication

### Two-Path Authentication

**PATH A — Device Credential (Primary):**
```
Agent → POST /api/agent/authenticate (deviceId + deviceSecret)
  → Verify claim (approved only)
  → Verify claim secret (SHA-256)
  → Verify employee active + approved
  → Verify AgentAccount active (if exists)
  → Verify org active
  → Verify device eligible
  → AcquireActiveSlot (FOR UPDATE lock)
  → Issue 24h AgentToken
  → Audit log
```

**PATH B — Agent Login (Discovery):**
```
Agent → POST /api/agent/login (agentId + password)
  → Verify AgentAccount credentials (bcrypt)
  → Verify employee active
  → Verify org active
  → Issue short-lived AgentSession
  → Audit log

Agent → POST /api/agent/discover (with AgentSession)
  → Validate session
  → Resolve org from session (server-derived)
  → Create/reuse Device + DeviceClaim
  → Issue claim secret
```

### Token Validation (`validateAgentToken`)
- ✅ Token exists and not expired
- ✅ Employee active and approved
- ✅ AgentAccount active (if exists)
- ✅ Device active (online/offline)
- ✅ Organization active
- ✅ Token org matches employee org
- ❌ **Subscription status NOT checked**

### Evidence
- `src/app/api/agent/authenticate/route.ts`
- `src/app/api/agent/login/route.ts`
- `src/app/api/agent/discover/route.ts`
- `src/lib/agent/auth.ts`
- `src/lib/agent/activation.ts`

---

## 18. Agent Organization Binding

### Enforcement
- ✅ `AgentToken.organizationId` — set from `Employee.organizationId` at token issuance
- ✅ Cross-org integrity check in `validateAgentToken()`: `agentToken.organizationId !== agentToken.employee.organizationId` → fail
- ✅ DeviceClaim organization matches session org
- ✅ Device organization verified on every request

### IDOR Protection
- ✅ Organization derived from authenticated token, not client input
- ✅ DeviceClaim verification prevents cross-org device binding
- ✅ Employee binding verified against session organization

---

## 19. Agent Capability Enforcement

### Server-Side Enforcement

| Capability | Server Enforced? | Evidence |
|------------|-----------------|----------|
| Screenshot | ✅ YES | Consent check + org policy + interval check in `/api/agent/screenshot` |
| Activity | ⚠️ PARTIAL | Consent check exists; org policy enforcement unclear |
| Location | ✅ YES | Consent check + org policy in `/api/agent/location` |
| Keystroke | ⚠️ PARTIAL | Consent check exists; org policy unclear |
| Webcam | ⚠️ PARTIAL | Command-based; consent unclear |
| USB | ⚠️ PARTIAL | Org policy flag exists; consent unclear |
| Break Mode | ✅ YES | Server-authoritative via config endpoint |
| App Policy | ✅ YES | Server-authoritative via config + violations endpoint |

### Critical Gap: Subscription Not Enforced at Agent Level

The Agent config endpoint (`/api/agent/config`) returns subscription-aware screenshot frequency, but:
- ❌ No subscription status check in `validateAgentToken()`
- ❌ No subscription status check in config endpoint
- ❌ Agent can continue operating with EXPIRED/CANCELLED subscription

---

## 20. Agent Runtime Audit

### Config Endpoint (`/api/agent/config`)
Returns:
- ✅ Monitoring settings (org-scoped via `OrganizationSetting`)
- ✅ Screenshot frequency (subscription-aware)
- ✅ Break state (server-authoritative)
- ✅ Feature flags (tamper detection, USB, app policy)
- ✅ Policy (whitelist/blacklist)
- ✅ Assignment data (employee, department, projects)
- ✅ Deployment context (mode, organization name)
- ❌ **No subscription status in config response**
- ❌ **No subscription status enforcement**

### Heartbeat (`/api/agent/heartbeat`)
- ✅ Validates agent token
- ✅ Updates device heartbeat
- ✅ Returns break state
- ❌ **No subscription status check**

---

## 21. Agent Offline Behavior

### PRD Requirement
PRD does not explicitly define offline behavior → `PRD-AMBIGUITY`

### Actual Implementation
- Agent token has 24h expiry
- Device status set to 'offline' when no heartbeat
- Agent continues operating until token expires
- No explicit offline queue or data sync mechanism documented

---

## 22. Agent Builder Audit

### Status
**NOT AUDITABLE** — Agent Builder is part of the Agent repository, which is not available in this working tree.

### What We Know (from Web side)
- Agent Builder is a Super Admin tool
- Organization selection
- Package validation
- Service model validation
- Capability selection
- Configuration generation
- Build artifacts

### What We Cannot Verify
- Build-time capability enforcement
- Organization binding in build artifacts
- Token/secret handling in builds
- Output artifact integrity
- Tamper resistance

---

## 23. Builder → Agent Trace

**UNVERIFIED** — Agent repository not available.

---

## 24. Web ↔ Agent API Contract

### Endpoint Inventory

| Endpoint | Method | Auth | Org Binding | Subscription Check | Status |
|----------|--------|------|-------------|-------------------|--------|
| `/api/agent/authenticate` | POST | Device credentials | ✅ From claim | ❌ No | IMPLEMENTED |
| `/api/agent/login` | POST | AgentAccount | ✅ Server-derived | ❌ No | IMPLEMENTED |
| `/api/agent/discover` | POST | AgentSession | ✅ Server-derived | ❌ No | IMPLEMENTED |
| `/api/agent/heartbeat` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/config` | GET | AgentToken | ✅ Token org | ⚠️ Partial (screenshot) | IMPLEMENTED |
| `/api/agent/screenshot` | POST | AgentToken | ✅ Token org | ⚠️ Consent + policy | IMPLEMENTED |
| `/api/agent/activity` | POST | AgentToken | ✅ Token org | ⚠️ Consent | IMPLEMENTED |
| `/api/agent/location` | POST | AgentToken | ✅ Token org | ⚠️ Consent + policy | IMPLEMENTED |
| `/api/agent/keystroke` | POST | AgentToken | ✅ Token org | ⚠️ Consent | IMPLEMENTED |
| `/api/agent/commands` | GET | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/commands/[id]/ack` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/break` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/usb` | POST | AgentToken | ✅ Token org | ⚠️ Consent + policy | IMPLEMENTED |
| `/api/agent/consent` | POST | AgentToken | ✅ Token org | ✅ Yes | IMPLEMENTED |
| `/api/agent/policy-violations` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/tamper` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/webcam/session` | POST | AgentToken | ✅ Token org | ⚠️ Command-based | IMPLEMENTED |
| `/api/agent/webcam/frame` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/webcam/session/end` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |
| `/api/agent/logout` | POST | AgentSession | ✅ Server-derived | ❌ No | IMPLEMENTED |
| `/api/agent/compat` | GET | None | ❌ No | ❌ No | IMPLEMENTED |
| `/api/agent/anomaly` | POST | AgentToken | ✅ Token org | ❌ No | IMPLEMENTED |

### Contract Gaps

1. ❌ **No subscription status check** on any Agent endpoint
2. ❌ **No subscription pause/resume handling** in Agent contract
3. ⚠️ **Consent enforcement varies** by capability
4. ❌ **Agent Builder contract unknown** (repo not available)

---

## 25. Policy Synchronization

### How Web Changes Reach Agent
```
Super Admin changes setting
  → Database (OrganizationSetting)
  → Agent calls GET /api/agent/config
  → Agent receives updated config
  → Agent applies on next sync
```

### Evidence
- Config endpoint reads from `OrganizationSetting` table
- Agent polls config periodically
- Break state delivered on every heartbeat and config call

### Gaps
- ⚠️ No push mechanism — agent must poll
- ⚠️ Stale config possible between polls
- ❌ No subscription status in config response

---

## 26. Screenshot Pipeline

### Full Trace
```
Agent captures screenshot
  → POST /api/agent/screenshot
  → validateAgentToken() ✅
  → hasActiveConsent('screenshot') ✅
  → resolveOrgMonitoring() → screenshot_enabled check ✅
  → screenshotInterval > 0 check ✅
  → File validation (PNG/JPEG/WebP, magic bytes) ✅
  → putScreenshot() to storage ✅
  → DB transaction (Screenshot + AuditLog) ✅
  → Background thumbnail processing
```

### Enforcement
- ✅ Token validation
- ✅ Consent check
- ✅ Org policy check (screenshot_enabled)
- ✅ Interval check (> 0)
- ✅ File type validation (magic bytes)
- ✅ File size limit (5MB)
- ✅ Org-scoped storage path
- ❌ **No subscription status check**

---

## 27. Activity Pipeline

### Full Trace
```
Agent collects activity
  → POST /api/agent/activity
  → validateAgentToken() ✅
  → hasActiveConsent('activity_tracking') ✅
  → resolveOrgMonitoring() → app_tracking/website_tracking check ✅
  → Activity records created ✅
  → OrganizationId set from token ✅
```

### Enforcement
- ✅ Token validation
- ✅ Consent check
- ✅ Org policy check
- ✅ Org-scoped storage
- ❌ **No subscription status check**

---

## 28. Location Pipeline

### Full Trace
```
Agent collects location
  → POST /api/agent/location
  → validateAgentToken() ✅
  → hasActiveConsent('location') ✅
  → resolveOrgMonitoring() → location_tracking check ✅
  → Coordinate validation ✅
  → 5km movement filter (server-authoritative) ✅
  → LocationEvent created ✅
```

### Enforcement
- ✅ Token validation
- ✅ Consent check
- ✅ Org policy check
- ✅ Coordinate validation
- ✅ Movement threshold (5km)
- ✅ Closed schema (no address fields)
- ❌ **No subscription status check**

---

## 29. Live Activity / Real-time

### Implementation
- Live-updates poll via `createdAt` cursor indexes
- Multiple models have `@@index([createdAt])` for live polling
- No WebSocket/Socket.IO implementation found

### Gaps
- ⚠️ Polling-based, not true real-time
- ❌ No WebSocket implementation

---

## 30. Storage

### Implementation
- S3-compatible storage via `src/lib/storage/index.ts`
- Org-scoped paths: `/uploads/screenshots/<orgId>/`
- Signed URL support
- Thumbnail processing pipeline

### Evidence
- `src/lib/storage/index.ts`
- `putScreenshot()`, `deleteScreenshot()`, `isNotFound()`

---

## 31. Retention

### PRD Requirement
PRD says retention must be configurable per data category.

### Actual Implementation
- `Plan.retentionDays` field exists
- `resolveRetentionDays()` function exists
- Used in config endpoint for screenshot retention

### Gaps
- ⚠️ Retention enforcement not verified
- ❌ No automated cleanup job verified

---

## 32. Manual Payment → Activation Flow

### PRD Flow
```
Customer → Contact → Select Package + Service Model → Manual Payment
  → Super Admin verifies → Creates Organization → Sets Subscription
  → Records Payment → Creates Org Admin → Activates Org → Builds Agent
```

### Actual Implementation
```
Super Admin creates Organization via provision flow
  → Selects Service Model + Package
  → Creates subscription
  → Creates invoice
  → Creates Org Admin membership
  → Organization becomes active
  → Agent can be built (Agent Builder — not in this repo)
```

### Gaps
- ⚠️ Provision flow exists but verification of all steps incomplete
- ❌ Agent Builder not in this repository
- ❌ Agent delivery mechanism not verified

---

## 33. RBAC

### Permission Matrix

| Capability | Super Admin | Org Admin | Manager | Viewer | Enforcement |
|------------|-------------|-----------|---------|--------|-------------|
| Create Organization | ✅ | ❌ | ❌ | ❌ | Server ✅ |
| Manage Subscriptions | ✅ | ❌ | ❌ | ❌ | Server ✅ |
| Manage Payments | ✅ | ❌ | ❌ | ❌ | Server ✅ |
| Manage Org Settings | ✅ | ✅ | ❌ | ❌ | Server ✅ |
| Manage Members | ✅ | ✅ | ❌ | ❌ | Server ✅ |
| Manage Employees | ✅ | ✅ | ✅ | ❌ | Server ✅ |
| Manage Devices | ✅ | ✅ | ❌ | ❌ | Server ✅ |
| View Dashboard | ✅ | ✅ | ✅ | ✅ | Server ✅ |
| View Activity | ✅ | ✅ | ✅ | ✅ | Server ✅ |
| View Screenshots | ✅ | ✅ | ✅ | ✅ | Server ✅ |
| Pause/Resume Org | ✅ | ❌ | ❌ | ❌ | ⚠️ PARTIAL |

---

## 34. Tenant Isolation

### Enforcement
- ✅ `organizationId` on every tenant-scoped table
- ✅ `withTenantScope()` helper injects org predicate
- ✅ `assertTenantScope()` fail-closed assertion
- ✅ Agent token bound to organization
- ✅ Cross-org integrity check in `validateAgentToken()`
- ✅ DeviceClaim organization verification
- ✅ Cross-tenant API test passing (`multi-org-ga.test.ts`)

### Evidence
- `src/lib/tenant-scope.ts`
- `src/lib/agent/auth.ts` — cross-org check
- `tests/multi-org-ga.test.ts` — test G: Org A cannot read Org B employees

---

## 35. Security

### Authentication Security
- ✅ bcrypt password hashing (cost 12)
- ✅ JWT HS256 with HMAC-SHA256
- ✅ Session cookies (httpOnly, secure, sameSite)
- ✅ Rate limiting on login/agent auth
- ✅ Brute-force lockout on AgentAccount
- ✅ Uniform error responses (no account enumeration)

### Token Security
- ✅ 24h AgentToken expiry
- ✅ Short-lived AgentSession
- ✅ Token deleted on expiry
- ✅ Constant-time claim secret comparison

### Input Validation
- ✅ File type validation (magic bytes)
- ✅ File size limits
- ✅ Coordinate validation
- ✅ Closed schema for location
- ✅ JSON body validation

### Findings
- ⚠️ No CSRF protection verification
- ⚠️ Rate limiting coverage needs verification
- ⚠️ Password complexity requirements not verified

---

## 36. Database

### Schema Strengths
- ✅ Clean multi-tenant model with `organizationId` FK
- ✅ Proper indexes on hot paths
- ✅ Cascade delete rules
- ✅ Audit log survives org deletion (SetNull)
- ✅ RateLimitCounter for token bucket

### Schema Concerns
- ❌ `SubscriptionStatus` lacks PAUSED
- ⚠️ `Employee.employeeId` globally unique — may be wrong scope
- ⚠️ `Device.agentKey` globally unique — may need org scoping
- ⚠️ Some cascade rules need review

---

## 37. Seed Data

### Implementation
- ✅ Production guard: `NODE_ENV !== 'production' && SEED_ALLOWED=1`
- ✅ Only bootstraps Super Admin + Plan catalog
- ✅ No demo organizations, users, or agents
- ✅ Plans are reference data, not demo data

### Evidence
- `src/lib/seed.ts`
- Production bootstrap: `scripts/bootstrap-super-admin.ts`

---

## 38. Testing

### Test Coverage

| Category | Coverage | Notes |
|----------|----------|-------|
| RBAC | ✅ Strong | 20 tests passing |
| Multi-org isolation | ✅ Strong | 12 tests passing |
| Tenant isolation | ✅ Strong | Cross-tenant tests |
| Subscription lifecycle | ❌ Gaps | PAUSED not tested (doesn't exist) |
| Agent contract | ❌ Gaps | Agent repo not available |
| Agent Builder | ❌ None | Not in this repo |
| Viewer enforcement | ⚠️ Partial | Needs more API-level tests |
| Manager enforcement | ⚠️ Partial | Needs more API-level tests |
| Subscription pause/resume | ❌ None | Not implemented |
| Offline behavior | ❌ None | Not defined in PRD |

---

## 39. Build / Deployment

### Build Verification
- ✅ `tsc --noEmit` passes (exit code 0)
- ⚠️ Vitest has native binding issue (environment-specific)
- ✅ Tests run via `tsx --test`

### Deployment Readiness
- ⚠️ Subscription lifecycle incomplete
- ⚠️ PRIVATE service model not differentiated
- ⚠️ Agent Builder not verified

---

## 40. Master PRD Compliance Matrix

| ID | Requirement | Web | Agent | Builder | Contract | DB | Status | Severity | Evidence | Required Change |
|----|------------|-----|-------|---------|----------|-----|--------|----------|----------|----------------|
| PRD-01 | Organization as tenant boundary | ✅ | ✅ | ❓ | ✅ | ✅ | PASS | — | schema.prisma | None |
| PRD-02 | 3 Service Models | ⚠️ | ❓ | ❓ | ⚠️ | ✅ | PARTIAL | HIGH | deployment-mode.ts | PRIVATE needs behavior |
| PRD-03 | Service Model immutability | ✅ | ❓ | ❓ | — | ✅ | PASS | — | deployment-mode.ts | None |
| PRD-04 | Package ≠ Service Model | ✅ | ❓ | ❓ | — | ✅ | PASS | — | schema.prisma | None |
| PRD-05 | Subscription PAUSED state | ❌ | ❌ | ❓ | ❌ | ❌ | MISSING | CRITICAL | schema.prisma | Add PAUSED to enum |
| PRD-06 | Subscription pause/resume | ❌ | ❌ | ❓ | ❌ | ❌ | MISSING | CRITICAL | N/A | Implement workflow |
| PRD-07 | Organization PAUSED status | ❌ | ⚠️ | ❓ | — | ❌ | CONFLICT | HIGH | org [id]/route.ts | Rename suspended→paused |
| PRD-08 | Agent subscription enforcement | ❌ | ❌ | ❓ | ❌ | — | MISSING | CRITICAL | agent/auth.ts | Add subscription check |
| PRD-09 | Agent org binding | ✅ | ❓ | ❓ | ✅ | ✅ | PASS | — | agent/auth.ts | None |
| PRD-10 | Tenant isolation | ✅ | ✅ | ❓ | ✅ | ✅ | PASS | — | tenant-scope.ts | None |
| PRD-11 | RBAC enforcement | ✅ | ❓ | ❓ | — | ✅ | PARTIAL | MEDIUM | permissions.ts | Verify all endpoints |
| PRD-12 | Manual payment | ✅ | — | — | — | ✅ | PASS | — | invoices/ | None |
| PRD-13 | Audit logging | ✅ | ✅ | ❓ | — | ✅ | PARTIAL | MEDIUM | Multiple routes | Verify coverage |
| PRD-14 | Screenshot consent | ✅ | ❓ | ❓ | ✅ | ✅ | PASS | — | screenshot/route.ts | None |
| PRD-15 | Screenshot retention | ⚠️ | ❓ | ❓ | — | ⚠️ | PARTIAL | MEDIUM | config/route.ts | Verify enforcement |
| PRD-16 | Agent offline behavior | ⚠️ | ❓ | ❓ | — | — | PRD-AMBIGUITY | MEDIUM | N/A | Define behavior |
| PRD-17 | Agent Builder | — | — | ❓ | — | — | UNVERIFIED | HIGH | Agent repo | Audit Agent repo |
| PRD-18 | Employee identity scope | ⚠️ | ❓ | ❓ | — | ✅ | PRD-AMBIGUITY | MEDIUM | schema.prisma | Clarify scope |

---

## 41. Service Model Matrix

| Dimension | MANAGED | CUSTOMER_DB | PRIVATE |
|-----------|---------|-------------|---------|
| Application Host | OmniSight | OmniSight | Customer |
| API Host | OmniSight | OmniSight | Customer |
| Primary DB Owner | OmniSight | Customer | Customer |
| Storage Owner | OmniSight | Customer | Customer |
| Backup Owner | OmniSight | Customer | Customer |
| Update Owner | OmniSight | OmniSight | Customer |
| Agent Behavior | Standard | Same as MANAGED | Same as MANAGED |
| Subscription Validation | Server | Server | Server |
| Agent Config | Standard | Standard | Standard |
| Builder Behavior | Standard | Blocked | Standard |
| Super Admin Control | Full | Control-plane only | Control-plane only |
| Org Admin Control | Standard | Standard | Standard |
| Current Implementation | ✅ Implemented | ⚠️ Blocked (correct) | ❌ Label only |
| Gap | None | External DB config | Full differentiation |

---

## 42. Agent Capability Matrix

| Capability | PRD | Package | Web API | Agent | Builder | Runtime Enforcement | Subscription Enforcement | Status |
|------------|-----|---------|---------|-------|---------|--------------------|-----------------------|--------|
| Screenshot | ✅ | Plan.features | ✅ | ❓ | ❓ | ✅ Server | ❌ MISSING | PARTIAL |
| Activity | ✅ | Plan.features | ✅ | ❓ | ❓ | ⚠️ Consent only | ❌ MISSING | PARTIAL |
| Location | ✅ | Plan.features | ✅ | ❓ | ❓ | ✅ Server | ❌ MISSING | PARTIAL |
| Keystroke | ✅ | Plan.features | ✅ | ❓ | ❓ | ⚠️ Consent only | ❌ MISSING | PARTIAL |
| Webcam | ✅ | Plan.features | ✅ | ❓ | ❓ | ⚠️ Command-based | ❌ MISSING | PARTIAL |
| USB | ✅ | Plan.features | ✅ | ❓ | ❓ | ⚠️ Consent + policy | ❌ MISSING | PARTIAL |
| App Inventory | ✅ | Plan.features | ✅ | ❓ | ❓ | ⚠️ Policy | ❌ MISSING | PARTIAL |
| Break Mode | ✅ | — | ✅ | ❓ | ❓ | ✅ Server | — | PASS |
| App Policy | ✅ | — | ✅ | ❓ | ❓ | ✅ Server | — | PASS |

---

## 43. Role Matrix

| Capability | Super Admin | Org Admin | Manager | Viewer | Agent | Server Enforcement | UI Enforcement |
|------------|-------------|-----------|---------|--------|-------|-------------------|----------------|
| Create Organization | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ requireSuperAdmin | ✅ |
| Manage Subscriptions | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ requireSuperAdmin | ✅ |
| Manage Payments | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ requireSuperAdmin | ✅ |
| Manage Org Settings | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ requireOrgAdmin | ✅ |
| Manage Members | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ requireOrgAdmin | ✅ |
| Manage Employees | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ hasPermission | ✅ |
| Manage Devices | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ hasPermission | ✅ |
| View Dashboard | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ hasPermission | ✅ |
| Pause/Resume Org | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ PARTIAL | ⚠️ PARTIAL |
| Modify Service Model | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ requireSuperAdmin | ✅ |

---

## 44. Agent State Matrix

| Organization | Subscription | Agent Expected State | Actual State | Status |
|-------------|-------------|---------------------|-------------|--------|
| ACTIVE | ACTIVE | Full operation | ✅ Full operation | PASS |
| ACTIVE | PAUSED | Restricted/paused | ⚠️ Full operation (no check) | FAIL |
| ACTIVE | EXPIRED | Restricted/expired | ⚠️ Full operation (no check) | FAIL |
| ACTIVE | CANCELLED | Restricted/cancelled | ⚠️ Full operation (no check) | FAIL |
| PAUSED (suspended) | ACTIVE | No operation | ✅ Blocked (org check) | PASS |
| PAUSED (suspended) | PAUSED | No operation | ✅ Blocked (org check) | PASS |
| PAUSED (suspended) | EXPIRED | No operation | ✅ Blocked (org check) | PASS |

---

## 45. Web ↔ Agent Contract Matrix

| Endpoint | Web | Agent | Request Match | Response Match | Auth | Org Binding | Entitlement | Policy | Error Contract | Tests | Status |
|----------|-----|-------|---------------|----------------|------|-------------|-------------|--------|---------------|-------|--------|
| `/api/agent/authenticate` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ❌ No sub check | — | ✅ | ⚠️ | PARTIAL |
| `/api/agent/login` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ❌ No sub check | — | ✅ | ⚠️ | PARTIAL |
| `/api/agent/discover` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ❌ No sub check | — | ✅ | ⚠️ | PARTIAL |
| `/api/agent/heartbeat` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ❌ No sub check | — | ✅ | ⚠️ | PARTIAL |
| `/api/agent/config` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ⚠️ Partial | ✅ | ✅ | ⚠️ | PARTIAL |
| `/api/agent/screenshot` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ⚠️ Consent only | ✅ | ✅ | ⚠️ | PARTIAL |
| `/api/agent/activity` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ⚠️ Consent only | ⚠️ | ✅ | ⚠️ | PARTIAL |
| `/api/agent/location` | ✅ | ❓ | UNVERIFIED | UNVERIFIED | ✅ | ✅ | ⚠️ Consent only | ✅ | ✅ | ⚠️ | PARTIAL |

---

## 46. MUST PRESERVE

| Feature | Evidence | Why Correct | Dependencies | Risk if Changed |
|---------|----------|-------------|-------------|----------------|
| Multi-tenant data model | schema.prisma — organizationId on every table | Core architecture — correct tenant boundary | All org-scoped features | CRITICAL — security breach |
| Agent token authentication | src/lib/agent/auth.ts | Server-authoritative — org binding enforced | All Agent operations | CRITICAL — security breach |
| Single-active-device rule | src/lib/agent/activation.ts | Prevents token abuse — serialized via FOR UPDATE | Device management | HIGH — token conflicts |
| Tenant scope helpers | src/lib/tenant-scope.ts | Fail-closed assertions prevent cross-tenant queries | All data access | CRITICAL — security breach |
| RBAC permission system | src/lib/permissions.ts | Centralized, single source of truth | All authorization | HIGH — permission bypass |
| Screenshot consent enforcement | src/app/api/agent/screenshot/route.ts | Privacy-first — consent required | Screenshot pipeline | HIGH — privacy violation |
| Location consent enforcement | src/app/api/agent/location/route.ts | Privacy-first — consent required + 5km filter | Location pipeline | HIGH — privacy violation |
| Deployment mode validation | src/lib/deployment-mode.ts | Prevents invalid mode changes | Service model | MEDIUM — incorrect deployment |
| Audit logging | Multiple API routes | Compliance trail | Security | MEDIUM — audit gaps |
| Seed data production guard | src/lib/seed.ts | Prevents demo data in production | Data integrity | MEDIUM — data pollution |
| Organization provision flow | src/components/super-admin/organization-provision-flow.tsx | Multi-step, transactional | Onboarding | MEDIUM — provisioning failure |
| Rate limiting | src/lib/rate-limit.ts | Brute-force protection | Auth security | MEDIUM — auth bypass |

---

## 47. MUST MODIFY

| Current Behavior | Required PRD Behavior | Files | APIs | DB | Agent | Builder | Dependency | Risk | Priority |
|-----------------|----------------------|-------|------|-----|-------|---------|------------|------|----------|
| SubscriptionStatus lacks PAUSED | Add PAUSED status | schema.prisma | subscription APIs | SubscriptionStatus enum | Config endpoint | — | None | CRITICAL | P0 |
| Organization uses 'suspended' | Use 'paused' per PRD | Multiple files | Org update APIs | Organization.status | validateAgentToken | — | Subscription PAUSED | HIGH | P0 |
| No subscription pause/resume workflow | Implement pause/resume | Subscription management | subscription APIs | Subscription | Config + heartbeat | — | PAUSED status | HIGH | P0 |
| Agent does not check subscription | Add subscription status check | agent/auth.ts | All agent endpoints | — | validateAgentToken | — | PAUSED status | CRITICAL | P0 |
| PRIVATE service model has no behavior | Implement differentiated PRIVATE | deployment-mode.ts | Org provisioning | — | Agent config | — | Service model definition | HIGH | P1 |
| Viewer/Manager API enforcement unverified | Verify all mutation endpoints | All mutation APIs | POST/PUT/DELETE | — | — | — | None | MEDIUM | P1 |
| Employee.employeeId globally unique | Clarify scope requirement | schema.prisma | Employee APIs | Employee.employeeId | — | — | PRD decision | MEDIUM | P1 |
| Agent Builder not auditable | Audit Agent repository | Agent repo | Agent Builder | — | — | Agent repo | Agent repo access | HIGH | P1 |

---

## 48. MUST NOT CHANGE

| Behavior | Evidence | Why Preserved |
|----------|----------|--------------|
| Tenant isolation via organizationId | schema.prisma, tenant-scope.ts | Security foundation |
| Agent token org binding | agent/auth.ts | Prevents cross-tenant Agent access |
| Single-active-device rule | activation.ts | Prevents token abuse |
| Consent enforcement for screenshots | screenshot/route.ts | Privacy requirement |
| Consent enforcement for location | location/route.ts | Privacy requirement |
| Screenshot file validation (magic bytes) | screenshots/storage.ts | Security requirement |
| Uniform error responses (no enumeration) | agent/login/route.ts | Security requirement |
| Deployment mode change validation | deployment-mode.ts | Prevents invalid transitions |
| Audit log survival on org deletion | AuditLog.onDelete: SetNull | Compliance requirement |
| Production seed guard | seed.ts | Data integrity |

---

## 49. RETIRE / REPLACE

| Feature | Current Behavior | PRD Conflict | Severity |
|---------|-----------------|-------------|----------|
| 'suspended' terminology | Organization status = 'suspended' | PRD requires 'paused' | HIGH |
| No subscription PAUSED state | SubscriptionStatus enum lacks PAUSED | PRD requires PAUSED | CRITICAL |

---

## 50. PRODUCT DECISIONS REQUIRED

| Decision | Why Needed | Current Behavior | PRD Requirement | Options | Affected Systems | Recommendation |
|----------|-----------|-----------------|-----------------|---------|-----------------|----------------|
| Manager exact permissions | API enforcement gaps | Permission list defined | "Permission-driven, not hard-coded" | Keep current / Restrict more | Manager endpoints | Verify current is correct |
| Viewer exact scope | API enforcement gaps | Read-only permissions | "Read-only operational role" | Keep current / Restrict more | Viewer endpoints | Verify current is correct |
| Customer DB storage responsibility | Not defined in PRD | OrganizationSettings.useOwnDb exists | "Storage responsibility must be explicitly configured" | OmniSight / Customer / Hybrid | Deployment mode | PRD must define |
| Private deployment update model | Not defined in PRD | Label only | "Customer hosts everything" | OTA / Manual / Hybrid | Agent updates | PRD must define |
| Package capability mapping | Partial | Plan.features JSON array | "Included capabilities" | String array / Structured / Enum | Agent config | Clarify mapping |
| Agent behavior during subscription pause | Not defined | No pause exists | "Access to protected services must follow policy" | Stop all / Allow read / Custom | Agent runtime | PRD must define |
| Agent behavior after subscription expiry | Not defined | No enforcement | "Must handle explicitly" | Stop all / Grace period / Custom | Agent runtime | PRD must define |
| Offline behavior | Not defined | Token-based timeout | PRD-AMBIGUITY | Queue / Stop / Continue | Agent runtime | PRD must define |
| Retention policy values | Not defined | Plan.retentionDays exists | "Must be documented and implemented" | Per-plan / Per-org / Global | Storage, DB | PRD must define |
| Employee identity scope | Globally unique employeeId | Employee.employeeId @unique | "Must be evaluated carefully" | Global / Org-scoped / Device-scoped | Employee, Agent | PRD must define |
| Subscription renewal process | Not defined | Manual only | "Super Admin must be able to renew" | Manual / Automated / Hybrid | Subscription | PRD must define |

---

## 51. CONFLICT MATRIX

| Existing Behavior | PRD Requirement | Conflict | Severity | Web Impact | Agent Impact | Builder Impact | DB Impact | Resolution |
|-------------------|----------------|---------|----------|------------|--------------|----------------|-----------|------------|
| Org status = 'suspended' | PRD requires 'paused' | Terminology mismatch | HIGH | Status enum, all status checks | validateAgentToken org check | — | Organization.status | Rename enum value |
| SubscriptionStatus lacks PAUSED | PRD requires PAUSED | Missing lifecycle state | CRITICAL | Subscription management | No subscription check | — | SubscriptionStatus enum | Add PAUSED |
| Agent does not check subscription | PRD requires subscription enforcement | Missing enforcement | CRITICAL | — | validateAgentToken, config | — | — | Add subscription check |
| PRIVATE has no behavior | PRD defines PRIVATE as customer-hosted | Incomplete implementation | MEDIUM | Deployment mode | Config response | — | DeploymentMode | Implement differentiation |
| Employee.employeeId globally unique | PRD says evaluate scope | Potential wrong scope | MEDIUM | Employee APIs | — | — | Employee.employeeId | Clarify requirement |

---

## 52. SECURITY FINDINGS

### CRITICAL
| ID | Finding | Evidence | Impact | Component | Direction |
|----|---------|----------|--------|-----------|-----------|
| SEC-001 | Agent does not check subscription status | src/lib/agent/auth.ts — validateAgentToken() | Agent operates without subscription authorization | Agent auth | Add subscription check |
| SEC-002 | Subscription PAUSED state not implemented | schema.prisma SubscriptionStatus | Cannot pause subscription — no lifecycle control | Subscription | Add PAUSED status |

### HIGH
| ID | Finding | Evidence | Impact | Component | Direction |
|----|---------|----------|--------|-----------|-----------|
| SEC-003 | Agent Builder not auditable | Agent repo not available | Cannot verify build-time security | Agent Builder | Audit Agent repo |
| SEC-004 | Organization uses 'suspended' not 'paused' | org [id]/route.ts line 146 | Terminology confusion — possible enforcement gaps | Org lifecycle | Rename to 'paused' |
| SEC-005 | PRIVATE service model has no differentiated behavior | deployment-mode.ts | All models behave identically — no isolation | Service models | Implement differentiation |

### MEDIUM
| ID | Finding | Evidence | Impact | Component | Direction |
|----|---------|----------|--------|-----------|-----------|
| SEC-006 | Viewer/Manager API enforcement not fully verified | permissions.ts | Potential write bypass | RBAC | Verify all endpoints |
| SEC-007 | Password complexity requirements not verified | auth.ts | Weak passwords possible | Authentication | Verify policy |
| SEC-008 | CSRF protection not verified | Multiple routes | Potential CSRF attacks | Web security | Verify implementation |

### LOW
| ID | Finding | Evidence | Impact | Component | Direction |
|----|---------|----------|--------|-----------|-----------|
| SEC-009 | Rate limiting coverage needs review | rate-limit.ts | Potential brute force on some endpoints | API security | Verify coverage |
| SEC-010 | Session expiry configuration unverified | auth.ts | Session persistence issues | Authentication | Verify config |

---

## 53. DATA INTEGRITY FINDINGS

| ID | Finding | Evidence | Impact | Migration Required? | Direction |
|----|---------|----------|--------|-------------------|-----------|
| DI-001 | SubscriptionStatus lacks PAUSED | schema.prisma | Cannot pause subscriptions | YES | Add PAUSED to enum |
| DI-002 | Organization status uses 'suspended' not 'paused' | schema.prisma Organization.status | Terminology inconsistency | YES | Rename value |
| DI-003 | Employee.employeeId globally unique | schema.prisma @@unique | May be wrong scope | POSSIBLY | Clarify requirement |
| DI-004 | Device.agentKey globally unique | schema.prisma @@unique | May need org scoping | POSSIBLY | Evaluate scope |

---

## 54. BUSINESS LOGIC FINDINGS

| ID | Business Rule | Current Behavior | Expected Behavior | Evidence | Impact | Priority |
|----|--------------|-----------------|-------------------|----------|--------|----------|
| BL-001 | Subscription pause/resume | Not implemented | ACTIVE ↔ PAUSED transitions | schema.prisma | Cannot pause org operations | CRITICAL |
| BL-002 | Agent subscription enforcement | No check in validateAgentToken | Server must enforce subscription | agent/auth.ts | Agent operates without authorization | CRITICAL |
| BL-003 | Organization PAUSED behavior | 'suspended' blocks agent | PAUSED must stop agent operations | agent/auth.ts org check | Terminology mismatch | HIGH |
| BL-004 | PRIVATE deployment differentiation | Same as MANAGED | Customer-hosted behavior | deployment-mode.ts | No isolation between models | HIGH |
| BL-005 | Subscription expiry Agent behavior | No enforcement | Agent must respect expiry | agent/auth.ts | Agent operates after expiry | HIGH |

---

## 55. TEST GAPS

| Area | Current Coverage | Gap | Priority |
|------|-----------------|-----|----------|
| Subscription PAUSED lifecycle | None | Not implemented | CRITICAL |
| Agent subscription enforcement | None | Not implemented | CRITICAL |
| Organization PAUSED terminology | Tests use 'suspended' | Need rename | HIGH |
| Agent Builder | None | Repo not available | HIGH |
| Viewer API write prevention | Partial | Need more endpoint tests | MEDIUM |
| Manager API enforcement | Partial | Need more endpoint tests | MEDIUM |
| Subscription expiry Agent behavior | None | Not defined in PRD | MEDIUM |
| Offline behavior | None | Not defined in PRD | MEDIUM |
| Service model differentiation | Partial | PRIVATE not tested | MEDIUM |

---

## 56. IMPLEMENTATION DEPENDENCY ORDER

```
Phase 0 — Product Decisions
  → Manager/Viewer exact permissions
  → Customer DB storage responsibility
  → Private deployment update model
  → Agent behavior during pause/expiry
  → Offline behavior definition
  → Retention policy values
  → Employee identity scope

Phase 1 — Database Alignment
  → Add PAUSED to SubscriptionStatus enum
  → Rename Organization status 'suspended' → 'paused'
  → Migration for status value rename

Phase 2 — Subscription Lifecycle
  → Implement subscription pause/resume API
  → Implement pause/resume UI for Super Admin
  → Add subscription status to Agent config response

Phase 3 — Agent Subscription Enforcement
  → Add subscription status check to validateAgentToken()
  → Add subscription status check to Agent config endpoint
  → Define Agent behavior for PAUSED/EXPIRED/CANCELLED

Phase 4 — Organization Lifecycle Alignment
  → Rename all 'suspended' references to 'paused'
  → Update Agent auth org check to use 'paused'
  → Update UI to use 'paused' terminology

Phase 5 — Service Model Differentiation
  → Implement PRIVATE deployment behavior
  → Implement Customer DB external database config
  → Verify service model immutability

Phase 6 — RBAC Verification
  → Verify Viewer write prevention on all endpoints
  → Verify Manager enforcement on all endpoints
  → Add tests for enforcement

Phase 7 — Agent Contract Alignment
  → Audit Agent repository (when available)
  → Verify Agent handles subscription status changes
  → Verify Agent offline behavior

Phase 8 — Agent Builder Audit
  → Audit Agent Builder (when available)
  → Verify build-time capability enforcement
  → Verify organization binding in builds

Phase 9 — Storage/Retention
  → Verify retention enforcement
  → Verify automated cleanup
  → Verify storage quotas

Phase 10 — Testing
  → Add subscription lifecycle tests
  → Add Agent contract tests
  → Add tenant isolation tests
  → Add E2E tests

Phase 11 — Production Verification
  → Verify deployment configuration
  → Verify monitoring and alerting
  → Verify backup and recovery
```

---

## 57. FINAL VERDICT

### **NOT READY — PRODUCT DECISIONS REQUIRED**

**Why:**

1. **Subscription PAUSED state is missing** — This is a CRITICAL gap. The PRD requires ACTIVE ↔ PAUSED transitions, but the SubscriptionStatus enum only has PENDING/ACTIVE/EXPIRED/CANCELLED. Without PAUSED, the entire subscription lifecycle is incomplete.

2. **Agent does not enforce subscription status** — `validateAgentToken()` in `src/lib/agent/auth.ts` checks employee status, AgentAccount status, device status, and organization status, but does NOT check subscription status. An Agent with an EXPIRED or CANCELLED subscription continues operating.

3. **Agent Builder is not auditable** — The Agent repository is not available in this working tree. We cannot verify build-time capability enforcement, organization binding, or token handling.

4. **Product decisions are required** before implementation can proceed — Manager/Viewer exact permissions, Customer DB storage responsibility, Private deployment updates, Agent pause/expiry behavior, and retention policy values are not defined.

**The core architecture is compatible with the Master PRD.** The multi-tenant model, RBAC system, Agent authentication, and database design are well-implemented. Targeted changes in the recommended phases will bring the system to compliance.

---

## 58. COMPLETE EVIDENCE INDEX

| Finding | Evidence Location |
|---------|------------------|
| SubscriptionStatus enum | `prisma/schema.prisma` — SubscriptionStatus: PENDING, ACTIVE, EXPIRED, CANCELLED |
| Organization status uses 'suspended' | `src/app/api/super-admin/organizations/[id]/route.ts` line 146 |
| Agent auth does not check subscription | `src/lib/agent/auth.ts` — validateAgentToken() |
| Agent config has subscription-aware screenshots | `src/app/api/agent/config/route.ts` — effectiveScreenshotFrequency |
| Deployment mode validation | `src/lib/deployment-mode.ts` — validateDeploymentModeChange() |
| Tenant scope helpers | `src/lib/tenant-scope.ts` — withTenantScope(), assertTenantScope() |
| RBAC permissions | `src/lib/permissions.ts` — ROLE_PERMISSIONS |
| Agent activation (single-active-device) | `src/lib/agent/activation.ts` — acquireActiveSlot() |
| Agent authenticate endpoint | `src/app/api/agent/authenticate/route.ts` |
| Agent login endpoint | `src/app/api/agent/login/route.ts` |
| Agent discover endpoint | `src/app/api/agent/discover/route.ts` |
| Agent heartbeat endpoint | `src/app/api/agent/heartbeat/route.ts` |
| Agent config endpoint | `src/app/api/agent/config/route.ts` |
| Agent screenshot endpoint | `src/app/api/agent/screenshot/route.ts` |
| Agent location endpoint | `src/app/api/agent/location/route.ts` |
| Subscription utilities | `src/lib/subscription.ts` — getActiveSubscription() |
| Super Admin org update | `src/app/api/super-admin/organizations/[id]/route.ts` |
| Super Admin subscription create | `src/app/api/super-admin/subscriptions/route.ts` |
| Seed data production guard | `src/lib/seed.ts` — seedAllowed() |
| Multi-org isolation tests | `tests/multi-org-ga.test.ts` — 12 tests passing |
| RBAC tests | `tests/role-rbac-nav-fix.test.ts` — 20 tests passing |
| Master PRD | `master.PRD` — 2360 lines, 80 sections |

---

```
NO FILES WERE MODIFIED
NO DATABASE WAS MODIFIED
NO MIGRATIONS WERE CREATED
NO SEED DATA WAS MODIFIED
NO CONFIGURATION WAS MODIFIED
NO TESTS WERE MODIFIED
```

---

*Audit completed September 8, 2026*
*Next step: Product decisions → Implementation prompt based on this audit*
