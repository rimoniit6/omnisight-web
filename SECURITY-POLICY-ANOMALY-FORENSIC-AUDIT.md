# OMNISIGHT — AGENT SECURITY / POLICIES / ANOMALY DETECTION FORENSIC AUDIT

**Date:** 2026-09-02
**Scope:** End-to-end forensic audit of Agent Security, Policies, and Anomaly Detection features
**Codebases:** `omnisight-web` (admin panel), `omnisight-agent` (desktop agent)
**Methodology:** Source-code reading, API tracing, database schema analysis, Agent integration verification, build/test verification

---

## Table of Contents

1. [Feature Map Overview](#1-feature-map-overview)
2. [Feature A — Agent Security](#2-feature-a--agent-security)
3. [Feature B — Policies](#3-feature-b--policies)
4. [Feature C — Anomaly Detection](#4-feature-c--anomaly-detection)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Feature Scorecard](#6-feature-scorecard)
7. [What Does It Actually Do?](#7-what-does-it-actually-do)
8. [Who Can Use It?](#8-who-can-use-it)
9. [File Report](#9-file-report)
10. [Validation](#10-validation)
11. [Final Forensic Verdict](#11-final-forensic-verdict)

---

## 1. Feature Map Overview

### Conceptual Distinction

The audit confirmed three distinct concepts exist in the codebase:

| Concept | Purpose | Scope |
|---------|---------|-------|
| **Agent Security** | Security alerts, tamper events, device integrity monitoring | Read-only dashboard for security-relevant alerts (tamper, offline, policy violations, inactivity) |
| **Policies** | Application whitelist/blacklist management + enforcement | CRUD for `AppListEntry` records; Agent-side process monitoring; violation reporting |
| **Anomaly Detection** | Statistical behavior analysis | Server-side rule engine comparing 7-day activity against 30-day baselines |

These are NOT conflated in the implementation. Each has separate models, APIs, pages, and processing pipelines.

### Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ADMIN PANEL (omnisight-web)                  │
│                                                                     │
│  Settings ──→ OrganizationSetting ──→ /api/agent/config ──→ Agent   │
│  App Lists ──→ AppListEntry ──→ policy.version bump ──→ Agent      │
│  Anomalies ──→ Anomaly model ←── detection engine (hourly)         │
│  Alerts ──→ Alert model ←── tamper / violation / anomaly           │
│  Security ──→ Alert (filtered by type)                             │
└─────────────┬───────────────────────────────────────┬───────────────┘
              │                                       │
              │ GET /api/agent/config                 │
              │ POST /api/agent/policy-violations     │
              │ POST /api/agent/tamper                │
              │                                       │
              ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     DESKTOP AGENT (omnisight-agent)                 │
│                                                                     │
│  ConfigService (10 min) ──→ monitoring flags + policy payload       │
│  PolicyEnforcer (10s) ──→ process scan → blacklist match → report  │
│  Heartbeat (60s) ──→ break state + online status                   │
│  ConsentService (60s) ──→ consent gates per collector              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Feature A — Agent Security

### 2.1 What Is "Agent Security"?

Agent Security is a **read-only security dashboard** that displays security-relevant alerts from three sources:

1. **Tamper events** — Agent reports attempts to stop/kill/uninstall/tamper with the agent
2. **Device offline** — Devices missing heartbeats for >15 minutes
3. **Policy violations** — Blocked application processes detected by the Agent

It does NOT contain:
- Agent authentication/encryption settings (these are implicit in the token system)
- Device identity management (handled by `agentKey` + `AgentAccount`)
- Certificate/attestation infrastructure

### 2.2 UI Audit

**File:** `src/components/security/security-page.tsx` (334 lines)

| Element | Type | Functional? | Evidence |
|---------|------|-------------|----------|
| Total Agent Security Alerts card | Stat card | **REAL** | Computed from API response `alerts.length` |
| Critical card | Stat card | **REAL** | Computed from API response `alerts.filter(a => a.severity === 'critical')` |
| High Severity card | Stat card | **REAL** | Computed from API response `alerts.filter(a => a.severity === 'high')` |
| Pending Review card | Stat card | **REAL** | Computed from API response `alerts.filter(a => a.status === 'pending')` |
| Severity filter dropdown | Filter | **REAL** | Modifies API query parameter `severity=` |
| Status filter dropdown | Filter | **REAL** | Modifies API query parameter `status=` |
| Search box | Search | **REAL** | Modifies API query parameter `search=` |
| Refresh button | Action | **REAL** | Re-fetches from `GET /api/alerts` |
| Alert cards | List | **REAL** | Rendered from real API data — title, severity, status, description, timestamp, metadata |
| Tamper Detection Types panel | Info panel | **STATIC** | Reference documentation, not fetched from API |

**Mock data:** NONE. All data from `GET /api/alerts?type=security,device_offline,policy_violation,high_inactivity`.

**Toggles:** NONE. This is a read-only dashboard.

### 2.3 API Audit

**File:** `src/app/api/alerts/route.ts`

| Method | Path | Role | Org Scope | DB Operation | Real? |
|--------|------|------|-----------|--------------|-------|
| GET | `/api/alerts` | viewer+ | `organizationId` from JWT | `db.alert.findMany` with filters | **REAL** |
| POST | `/api/alerts` | admin+ | `admin.organizationId` | `db.alert.create` + audit log | **REAL** |
| PUT | `/api/alerts` | admin+ | `admin.organizationId` | `db.alert.update` + audit log | **REAL** |

### 2.4 Tamper Detection Flow

```
Agent detects tamper (agent_stopped, process_killed, etc.)
    ↓
POST /api/agent/tamper (agent token auth)
    ↓
Creates Alert { type: 'security', severity: mapped }
    ↓
Creates Notification (if org preference enabled)
    ↓
Creates AuditLog
    ↓
Live-updates service polls Alert table
    ↓
Emits 'alert-event' via WebSocket
    ↓
Admin sees "Alert Event" in Live Event Stream
    ↓
Security page auto-refreshes via query invalidation
```

### 2.5 Agent-Side Tamper Detection

**Agent finding:** The agent has **NO local tamper detector wired up**. The `tamperDetectionEnabled` config flag exists and defaults to `false`. The types `TamperReportInput` exist but no agent code generates tamper reports.

The agent heartbeat API comment explicitly states:
> "The agent never POSTs break/tamper/anomaly reports itself (those server endpoints exist as tested ingestion points for integrations — see tests/break-hardening.test.ts and tests/anomaly-hardening.test.ts — but the shipped agent has no local detector wired to them)."

**Impact:** The `/api/agent/tamper` endpoint exists and is fully functional, but the shipped agent never calls it. Tamper detection is currently **not generated by the agent**. The endpoint exists for future agent implementation or third-party integrations.

### 2.6 Device Integrity Monitoring

**File:** `src/lib/jobs/detect-device-integrity.ts` (136 lines)

This is a **server-side** tamper/interruption detector:
- Runs hourly via the job scheduler
- Finds devices with `status: 'online'` whose `lastHeartbeat` is >15 minutes old
- Only flags devices whose bound employee has ACTIVE monitoring consent
- Creates `device_missing` anomalies (low severity, deduped per UTC day)
- Does NOT label devices as "tampered" — admin judges

### 2.7 Agent Security Verdict

| Aspect | Status | Evidence |
|--------|--------|----------|
| UI renders | YES | `security-page.tsx` — 334 lines, real API data |
| API returns real data | YES | `GET /api/alerts` queries `db.alert` with tenant scoping |
| Database records exist | YES | `Alert` model with `type: 'security'` |
| Tamper endpoint exists | YES | `POST /api/agent/tamper` — full auth, validation, persistence |
| Agent generates tamper events | **NO** | Agent has no local tamper detector wired up |
| Device integrity monitoring | YES | Server-side hourly job detects missing heartbeats |
| Policy violations displayed | YES | Filtered from `Alert` model via `type=policy_violation` |
| Notifications generated | YES | Tamper events create org notifications |
| Audit logged | YES | Tamper, alert create/update all audit-logged |
| RBAC enforced | YES | Admin+ for mutations, viewer+ for reads |
| Tenant isolation | YES | All queries scoped to JWT-derived org |

---

## 3. Feature B — Policies

### 3.1 What Is the Policy System?

Policies in OmniSight are an **application whitelist/blacklist** system. The admin defines which applications are allowed or blocked. The desktop Agent enforces this by scanning running processes every 10 seconds and reporting violations.

There is **no** `Policy` model. Policies are stored as `AppListEntry` records with `listType: 'whitelist' | 'blacklist'`.

### 3.2 Policy Lifecycle Audit

| Stage | Status | Evidence |
|-------|--------|----------|
| Create | **REAL** | `POST /api/app-list` — creates `AppListEntry` + bumps policy version |
| Validate | **REAL** | `src/lib/policies/validation.ts` — 308 lines of strict input validation |
| Save | **REAL** | Prisma `db.appListEntry.create` with org scoping |
| Assign | **N/A** | Policies apply to all agents in the org (no per-employee assignment) |
| Publish/Enable | **REAL** | `bumpPolicyVersion()` — monotonic version in `OrganizationSetting` |
| Synchronize | **REAL** | Agent polls `GET /api/agent/config` every 10 minutes; version comparison triggers re-fetch |
| Agent receives | **REAL** | `ConfigService` extracts policy payload; version check triggers cache update |
| Agent enforces | **REAL** | `PolicyEnforcer` scans processes every 10 seconds; blacklist match → violation report |
| Violation generated | **REAL** | `POST /api/agent/policy-violations` — validated, deduped, persisted |
| Backend receives | **REAL** | `db.policyViolation.create` with org/device/policy validation |
| Admin sees violation | **REAL** | Policies page → Violations tab → `GET /api/policy-violations` |

### 3.3 Policy CRUD Audit

| Operation | Endpoint | Role | Real? | Evidence |
|-----------|----------|------|-------|----------|
| Create entry | `POST /api/app-list` | manager+ | **REAL** | `db.appListEntry.create` + version bump + audit log |
| Read entries | `GET /api/app-list` | viewer+ | **REAL** | `db.appListEntry.findMany` with org scoping |
| Delete entry | `DELETE /api/app-list/[id]` | admin+ | **REAL** | Soft-delete (`isActive: false`) + version bump + audit log |
| Enable policy enforcement | `PUT /api/settings/monitoring` | admin+ | **REAL** | Upserts `OrganizationSetting { key: 'app_policy_enforcement', value: 'true' }` |
| Disable policy enforcement | `PUT /api/settings/monitoring` | admin+ | **REAL** | Upserts `OrganizationSetting { key: 'app_policy_enforcement', value: 'false' }` |
| Enable termination | `PUT /api/settings/monitoring` | admin+ | **REAL** | Upserts `OrganizationSetting { key: 'app_policy_terminate', value: 'true' }` |

**No update endpoint exists** for individual `AppListEntry` records. The only mutation is delete (soft-delete).

### 3.4 Policy Enforcement Audit

**This is the critical test.**

```
Admin adds "notepad.exe" to blacklist
    ↓
POST /api/app-list → AppListEntry created
    ↓
bumpPolicyVersion() → OrganizationSetting['app_policy_version'] incremented
    ↓
Agent polls GET /api/agent/config (every 10 minutes)
    ↓
Receives new policy.version (higher than cached)
    ↓
Re-fetches policy.applications array (includes new blacklist entry)
    ↓
PolicyEnforcer scans running processes every 10 seconds
    ↓
Resolves each process against cached policy
    ↓
Match found: notepad.exe matches blacklist entry
    ↓
POST /api/agent/policy-violations → violation reported
    ↓
If appPolicyTerminate=true: native.processTerminate(pid) → process killed
    ↓
Backend creates PolicyViolation + Alert + Notification
    ↓
Admin sees violation in Policies → Violations tab
```

**Every stage is REAL and verified in source code.**

### 3.5 Policy Resolution Logic

**File:** `src/lib/policies/resolver.ts` (149 lines) — server-side
**File:** `omnisight-agent/src/lib/policy-resolution.ts` — agent-side (mirrors server)

Precedence:
1. **Blacklist match = BLOCK** (highest priority)
2. **Whitelist match = ALLOW**
3. **No match = none/default** (no action)

Identity strength scoring:
- SHA256 hash: strength 4 (strongest)
- Process path: strength 3
- Publisher + name: strength 2
- Executable name: strength 1 (weakest)

Both server and agent use identical resolution logic.

### 3.6 Policy Version Mechanism

**File:** `src/lib/policies/version.ts` (50 lines)

- Storage: `OrganizationSetting` with key `app_policy_version`
- Default: `'0'`
- Bumped atomically inside the same transaction as every `AppListEntry` create or soft-delete
- Agent receives version in `GET /api/agent/config` response
- Agent compares cached version against received version
- Higher version → re-fetch full policy list
- Same version → skip (no change)

**Monitoring settings do NOT bump the policy version.** The version mechanism is exclusively for app list changes. Monitoring flags are resolved fresh on every agent config poll.

### 3.7 Policy Assignment Scope

Policies are **organization-wide**. There is no per-employee, per-department, or per-device assignment. Every agent in the organization receives the same policy.

The `PolicyAssignment` model **does not exist** in the schema.

### 3.8 Policy Violation Flow

```
Agent: PolicyEnforcer detects blacklist match
    ↓
POST /api/agent/policy-violations { policyId, executableName, processPath, action: 'blocked', severity: 'high' }
    ↓
Server: validates agent token → derives org from employee
    ↓
Server: verifies policy exists, is ACTIVE, belongs to same org
    ↓
Server: dedupes via unique constraint (org+device+policy+executable+5-min bucket)
    ↓
Server: creates PolicyViolation row
    ↓
Server: if severity high/critical → creates Notification
    ↓
Server: audit log
    ↓
Live-updates: polls PolicyViolation table → emits 'policy-violation' via WebSocket
    ↓
Client: invalidates ['policy-violations'] query → Policies page refreshes
```

### 3.9 Agent Offline Behavior

When the Agent is offline:
- Agent continues running with last-known config from `policy-cache.json` (atomic, versioned)
- Enforcement continues using cached policy (fail-closed: empty cache = no enforcement)
- Violations are queued locally (not implemented — violations are only reported in real-time)
- On reconnect: Agent fetches new config on next 10-minute cycle; any pending config changes take effect

### 3.10 Policies Verdict

| Aspect | Status | Evidence |
|--------|--------|----------|
| UI renders | YES | `policies-page.tsx` — 767 lines, 3 tabs, real API data |
| CRUD works | YES | Create (POST), Read (GET), Delete (DELETE) — all with DB persistence |
| API returns real data | YES | All endpoints query `db.appListEntry` / `db.policyViolation` |
| Database records exist | YES | `AppListEntry` + `PolicyViolation` models with proper relations |
| Agent receives policy | YES | `GET /api/agent/config` returns policy payload with version |
| Agent enforces policy | YES | `PolicyEnforcer` scans processes every 10 seconds |
| Violations reported | YES | `POST /api/agent/policy-violations` — validated, deduped, persisted |
| Violations displayed | YES | Policies → Violations tab |
| Version mechanism | YES | Monotonic integer, atomic bump, agent comparison |
| Notifications generated | YES | High/critical violations create org notifications |
| Audit logged | YES | AppListEntry create/delete, violation creation |
| RBAC enforced | YES | Viewer (read), Manager+ (create), Admin+ (delete, settings) |
| Tenant isolation | YES | All queries scoped to JWT-derived org |

---

## 4. Feature C — Anomaly Detection

### 4.1 What Is the Detection Engine?

Anomaly Detection is a **server-side rule-based statistical engine** that compares recent employee activity against historical baselines. It runs on a hourly schedule and on-demand from the Anomalies page.

**Detection rules (4 rules):**

| Rule | What It Detects | Threshold | Severity |
|------|----------------|-----------|----------|
| `checkProductivityDrop` | 7-day productive ratio vs 30-day baseline | >30% drop | medium (>30%), high (>40%), critical (>50%) |
| `checkExcessiveIdle` | Today's idle minutes | >120 minutes | medium (>120), high (>240) |
| `checkOffHoursActivity` | Activity outside org work window | >50% off-hours AND >5 activities | medium |
| `checkLowActivitySpike` | Today's activity <30% of daily average | <10 total AND avg >20 | medium |

**Additional detection:**
- `detect-device-integrity.ts`: Hourly job detecting devices with stale heartbeats (>15 min) → `device_missing` anomalies (low severity)

### 4.2 Are Metrics Real or Fake?

| Metric | Source | Real? |
|--------|--------|-------|
| Anomaly counts | `db.anomaly.findMany` + `db.anomaly.count` | **REAL** |
| Severity distribution | `db.anomaly.groupBy` | **REAL** |
| Type distribution | Client-side computation from API response | **REAL** |
| Anomaly score | Detection engine: `calculateScore()` — based on magnitude of deviation | **REAL** (deterministic formula) |
| Confidence | Detection engine: `calculateConfidence()` — based on data completeness | **REAL** (deterministic formula) |
| 7-day trend chart | `buildHistory()` — 7-day per-day activity aggregation | **REAL** (DB query) |

**There is NO:**
- `Math.random()`
- `mockData`
- `faker`
- Hardcoded arrays
- Static JSON
- Sample data

All metrics derive from real `Activity` records in the database.

### 4.3 Detection Input Audit

| Input Source | Model | Data |
|-------------|-------|------|
| Activities | `Activity` | Application usage, websites, idle time, keystrokes |
| Employees | `Employee` | Active employees with monitoring consent |
| Devices | `Device` | Device status, heartbeat freshness |

**Input pipeline:**
```
Agent collects activity → POST /api/agent/activity → db.activity.create
    ↓
Detection engine queries: db.activity.findMany (recent 7d + baseline 23d)
    ↓
Per-day aggregation: productive ratio, idle minutes, activity count
    ↓
Rule evaluation against thresholds
    ↓
Anomaly created if threshold exceeded
```

### 4.4 Detection Execution

| Trigger | Frequency | File |
|---------|-----------|------|
| Scheduled job | Hourly | `src/lib/jobs/detect-anomalies.ts` |
| On-demand | Manual via UI button | `POST /api/anomalies/detect` |
| Device integrity | Hourly | `src/lib/jobs/detect-device-integrity.ts` |

The detection engine is NOT realtime. It runs periodically and analyzes batch data.

### 4.5 Detection Output

Each detected anomaly produces:

| Field | Source |
|-------|--------|
| `type` | Rule name (e.g., `productivity_drop`) |
| `severity` | Computed from deviation magnitude |
| `score` | 0-100, based on deviation magnitude |
| `confidence` | 0-1, based on data completeness |
| `title` | Generated from rule + employee name |
| `description` | Generated with specific metrics |
| `employeeId` | From iteration |
| `metadata` | JSON: `{ baseline, current, threshold, history }` |
| `dedupeKey` | `${orgId}:${employeeId}:${type}:${utcDay}` — prevents duplicates |

### 4.6 False Positive / Duplicate Prevention

- **Dedupe key:** `unique` constraint on `${orgId}:${employeeId}:${type}:${utcDay}` — same employee can only have one anomaly of each type per day
- **Resolution:** When resolved as `false_positive` or `resolved`, the `dedupeKey` is cleared, allowing re-detection
- **No randomness:** All detection is deterministic based on activity data

### 4.7 Anomaly → Alert Flow

```
Detection engine finds anomaly
    ↓
db.anomaly.create (with dedupeKey)
    ↓
If severity high/critical:
    ↓
    createOrgAlert → db.alert.create
    createOrgNotification → db.notification.create
    ↓
Live-updates polls Anomaly table → emits 'anomaly' via WebSocket
    ↓
Client: invalidates ['anomalies'] query → Anomalies page refreshes
```

### 4.8 Anomaly Detection Verdict

| Aspect | Status | Evidence |
|--------|--------|----------|
| UI renders | YES | `anomalies-page.tsx` — 987 lines, full CRUD + detection trigger |
| Detection engine exists | YES | `src/lib/anomalies/detect.ts` — 369 lines, 4 rules, pure deterministic |
| Real input data | YES | `Activity` model — real agent-collected telemetry |
| Real output | YES | `Anomaly` model with score, confidence, severity, metadata |
| Deduplication | YES | Unique `dedupeKey` per org+employee+type+day |
| Scheduled execution | YES | Hourly job + on-demand trigger |
| Alerts generated | YES | High/critical → Alert + Notification |
| Audit logged | YES | Detection run audit-logged; manual create/update audit-logged |
| RBAC enforced | YES | Viewer (read), Manager+ (create/update/detect) |
| Tenant isolation | YES | All queries scoped to org |
| Realtime integration | PARTIAL | WebSocket emits `anomaly` event but NOT in Live Event Stream UI |
| False positive handling | YES | Resolve → clears dedupeKey → allows re-detection |

---

## 5. Cross-Cutting Concerns

### 5.1 RBAC Summary

| Feature | Read | Create | Update | Delete | Enable/Disable | Configure |
|---------|------|--------|--------|--------|----------------|-----------|
| Agent Security (alerts) | viewer+ | admin+ | admin+ | — | — | — |
| Policies (app list) | viewer+ | manager+ | — | admin+ | — | — |
| Policy enforcement | viewer+ | — | — | — | admin+ (settings) | — |
| Anomaly Detection | viewer+ | manager+ | manager+ | — | — | manager+ (detect) |
| Monitoring settings | manager+ | — | admin+ | — | admin+ | — |

### 5.2 Tenant Isolation

**ALL** API routes derive `organizationId` from the verified JWT session. Client-supplied `organizationId` is never trusted. Cross-org IDOR guards verify related entity ownership (employeeId, deviceId, policyId) against the caller's org.

Evidence:
- `requireActiveSessionOrg` comment (api.ts:156): "organization identity is taken only from auth.activeOrganizationId or auth.organizationId (both HMAC-signed claims). Query params, request bodies, Zustand state, localStorage and URL values are NEVER consulted."
- Agent routes: `orgId` always from `authResult.employee!.organizationId` (DB-verified via agent token).

### 5.3 Audit Logging

All security-relevant mutations are audit-logged:

| Action | Actor | File |
|--------|-------|------|
| Anomaly created (manual) | Authenticated user | `src/app/api/anomalies/route.ts:240-249` |
| Anomaly status updated | Authenticated user | `src/app/api/anomalies/[id]/route.ts:94-103` |
| Anomaly batch updated | Authenticated user | `src/app/api/anomalies/batch/route.ts:70-79` |
| Anomaly detection run | System (null userId) | `src/lib/anomalies/service.ts:245-253` |
| App entry created | Manager | `src/app/api/app-list/route.ts:142-151` |
| App entry deleted | Admin | `src/app/api/app-list/[id]/route.ts:44-53` |
| Policy violation created | Agent (null userId) | `src/app/api/agent/policy-violations/route.ts:101-110` |
| Tamper event | Agent (null userId, IP logged) | `src/app/api/agent/tamper/route.ts:88-97` |
| Monitoring setting changed | Admin | `src/app/api/settings/monitoring/route.ts:97-106` |
| Alert created (manual) | Admin | `src/app/api/alerts/route.ts:142-151` |
| Alert status updated | Admin | `src/app/api/alerts/route.ts:211-221` |

### 5.4 Notifications

| Trigger | Notification Type | Priority | Gated by Org Preference? |
|---------|-------------------|----------|--------------------------|
| High/critical policy violation | `policy_violation` | high/critical | YES |
| High/critical anomaly detected | `anomaly_detected` | high/critical | YES |
| Tamper event | `security` | mapped from severity | YES |
| Manual alert creation | — | — | NO (alerts don't auto-notify) |

### 5.5 Realtime Integration

| Event Type | WebSocket Event | In Live Event Stream UI? | Query Invalidation? |
|------------|-----------------|--------------------------|---------------------|
| Anomaly detected | `anomaly` | **NO** (not in LiveEventType union) | YES (`['anomalies']`) |
| Policy violation | `policy-violation` | **NO** (not in LiveEventType union) | YES (`['policy-violations']`) |
| Tamper/security alert | `alert-event` | **YES** (shows as "Alert Event") | YES (`['alerts']`) |
| Device offline | `alert-event` | **YES** (shows as "Alert Event") | YES (`['alerts']`) |

**Gap:** Anomaly and policy violation events are emitted via WebSocket but do NOT appear in the Live Event Stream feed. They only trigger query invalidation for their respective pages.

### 5.6 Scheduled Jobs

| Job | Frequency | Purpose | Lease-Guarded? |
|-----|-----------|---------|----------------|
| `anomaly_detection` | Hourly | Rule-based detection for all active orgs | YES |
| `device_integrity` | Hourly | Detect stale heartbeats → `device_missing` anomalies | YES |
| `retention_cleanup` | Hourly | Enforce data retention policies | YES |
| `expire_consents` | Hourly | Expire past-due consent records | YES |
| `agent_token_sweep` | Hourly | Clean expired agent tokens | YES |
| `rate_limit_sweep` | Hourly | Clean stale rate limit counters | YES |
| `user_session_sweep` | Hourly | Clean expired user sessions | YES |

All jobs use atomic `JobRun` leases with 5-minute expiry. Per-org failure isolation prevents cascade failures.

### 5.7 Agent Configuration Sync

| Config Type | Sync Mechanism | Interval |
|-------------|---------------|----------|
| Monitoring flags | `GET /api/agent/config` | 10 minutes |
| App policy | `GET /api/agent/config` (embedded) | 10 minutes |
| Break state | `POST /api/agent/heartbeat` response | 60 seconds |
| Consent | `GET /api/agent/consent` | 60 seconds |
| Commands | `GET /api/agent/commands` | 10 seconds |

**Fail-closed:** Before first successful sync, ALL monitoring and feature flags default to `false`. The agent collects nothing until the server explicitly enables features.

---

## 6. Feature Scorecard

| Feature | UI | API | DB | Agent Integration | Real Processing | Realtime | RBAC | Tenant Isolation | Verdict |
|---------|-----|-----|-----|-------------------|-----------------|----------|------|------------------|---------|
| Agent Security | PASS | PASS | PASS | PARTIAL | PASS | PASS | PASS | PASS | **PARTIALLY FUNCTIONAL** |
| Policies | PASS | PASS | PASS | PASS | PASS | PARTIAL | PASS | PASS | **FULLY FUNCTIONAL** |
| Anomaly Detection | PASS | PASS | PASS | N/A | PASS | PARTIAL | PASS | PASS | **FULLY FUNCTIONAL** |

### Scorecard Notes

**Agent Security — PARTIALLY FUNCTIONAL:**
- UI, API, DB, RBAC, tenant isolation all PASS
- Tamper endpoint exists and is fully functional
- **BUT:** The shipped agent has NO local tamper detector wired up — the endpoint is never called by the agent
- Device integrity monitoring (server-side) DOES work — detects stale heartbeats
- The "Agent Security" page is actually a filtered view of the Alerts system, not a dedicated agent security configuration panel

**Policies — FULLY FUNCTIONAL:**
- Complete lifecycle: Create → Version bump → Agent sync → Enforcement → Violation → Backend → Admin UI
- Agent-side enforcement is real: process scanning, blacklist matching, violation reporting, optional process termination
- Version mechanism ensures agents detect policy changes

**Anomaly Detection — FULLY FUNCTIONAL:**
- Real detection engine with 4 statistical rules
- Real input (agent-collected activity data)
- Real output (anomaly records with score, confidence, metadata)
- Scheduled hourly + on-demand trigger
- Deduplication prevents duplicate anomalies
- Gap: Anomaly events don't appear in Live Event Stream UI (only query invalidation)

---

## 7. What Does It Actually Do?

### Agent Security

```
Purpose:        Display security-relevant alerts (tamper, offline, policy violations)
Who can use it: Org Admin+ (read: viewer+, mutations: admin+)
What the UI does:       Shows filtered alert list with severity/status badges and metadata
What the backend does:  Queries Alert model with tenant scoping; tamper endpoint creates alerts + notifications
What the database stores: Alert records with type, severity, status, metadata, employee/device links
What the Agent does:    Agent has NO tamper detector wired up; device integrity is server-side only
What events are generated: Tamper events (via endpoint, not agent-generated), device_missing anomalies (server-side)
Current limitations:    Agent does not generate tamper events; page is read-only; no agent security configuration
Verdict:        PARTIALLY FUNCTIONAL — dashboard works, but primary data source (agent tamper) is not wired
```

### Policies

```
Purpose:        Control which applications can/cannot run on employee devices
Who can use it: Manager+ (create), Admin+ (delete, enable/disable enforcement)
What the UI does:       Manages whitelist/blacklist entries; shows violations; shows USB events
What the backend does:  CRUD for AppListEntry; version bumping; policy payload assembly for agent
What the database stores: AppListEntry (whitelist/blacklist), PolicyViolation (enforcement events), OrganizationSetting (enforcement flags)
What the Agent does:    Scans running processes every 10s; matches against cached policy; reports violations; optionally terminates blocked processes
What events are generated: Policy violations (blocked process events), alerts for high/critical violations
Current limitations:    No per-employee/dept/device assignment (org-wide only); no update endpoint for individual entries
Verdict:        FULLY FUNCTIONAL — complete end-to-end with real agent enforcement
```

### Anomaly Detection

```
Purpose:        Detect unusual employee behavior patterns via statistical analysis
Who can use it: Manager+ (create/update/detect), Viewer+ (read)
What the UI does:       Displays anomalies with scores; triggers detection; batch-resolves; shows 7-day trends
What the backend does:  Rule-based engine comparing 7-day activity vs 30-day baselines; hourly scheduled job
What the database stores: Anomaly records with type, severity, score, confidence, metadata, dedupeKey
What the Agent does:    N/A (detection is server-side; agent provides input data via activity collection)
What events are generated: Anomaly records, alerts for high/critical, notifications
Current limitations:    4 rules only; no ML/AI; no realtime detection; anomalies not in Live Event Stream
Verdict:        FULLY FUNCTIONAL — real detection with real data, but rule-based only
```

---

## 8. Who Can Use It?

### Agent Security

| Role | Access | Actions |
|------|--------|---------|
| Super Admin | YES (all orgs) | View, acknowledge, resolve alerts |
| Org Admin | YES (own org) | View, acknowledge, resolve alerts |
| Manager | View only | View alerts |
| Viewer | View only | View alerts |

### Policies

| Role | Access | Actions |
|------|--------|---------|
| Super Admin | YES (all orgs) | View entries, create entries, delete entries, enable/disable enforcement |
| Org Admin | YES (own org) | View entries, create entries, delete entries, enable/disable enforcement |
| Manager | YES (own org) | View entries, create entries |
| Viewer | View only | View entries, view violations |

### Anomaly Detection

| Role | Access | Actions |
|------|--------|---------|
| Super Admin | YES (all orgs) | View, create, update status, trigger detection, batch resolve |
| Org Admin | YES (own org) | View, create, update status, trigger detection, batch resolve |
| Manager | YES (own org) | View, create, update status, trigger detection, batch resolve |
| Viewer | View only | View anomalies |

---

## 9. File Report

### Files Inspected (Key Files)

**Admin Panel (omnisight-web):**
- `prisma/schema.prisma` — Anomaly, PolicyViolation, AppListEntry, Alert, AuditLog, Device, AgentAccount models
- `src/components/security/security-page.tsx` — Agent Security dashboard (334 lines)
- `src/components/policies/policies-page.tsx` — Policies page with 3 tabs (767 lines)
- `src/components/anomalies/anomalies-page.tsx` — Anomaly Detection page (987 lines)
- `src/components/settings/settings-page.tsx` — Monitoring/security settings (773 lines)
- `src/app/api/anomalies/route.ts` — Anomaly CRUD (259 lines)
- `src/app/api/anomalies/[id]/route.ts` — Anomaly detail/update (111 lines)
- `src/app/api/anomalies/detect/route.ts` — On-demand detection trigger (54 lines)
- `src/app/api/anomalies/batch/route.ts` — Batch anomaly update (94 lines)
- `src/app/api/policy-violations/route.ts` — Policy violations list (82 lines)
- `src/app/api/agent/policy-violations/route.ts` — Agent violation ingestion (146 lines)
- `src/app/api/agent/config/route.ts` — Agent config endpoint (181 lines)
- `src/app/api/agent/tamper/route.ts` — Agent tamper ingestion (114 lines)
- `src/app/api/app-list/route.ts` — AppListEntry CRUD
- `src/app/api/app-list/[id]/route.ts` — AppListEntry delete
- `src/app/api/settings/monitoring/route.ts` — Monitoring settings
- `src/app/api/alerts/route.ts` — Alert CRUD
- `src/lib/anomalies/detect.ts` — Detection engine (369 lines)
- `src/lib/anomalies/service.ts` — Detection orchestration (271 lines)
- `src/lib/anomalies/constants.ts` — Canonical constants (129 lines)
- `src/lib/anomalies/time.ts` — Timezone handling (95 lines)
- `src/lib/policies/resolver.ts` — Policy resolution logic (149 lines)
- `src/lib/policies/version.ts` — Policy version mechanism (50 lines)
- `src/lib/policies/validation.ts` — Input validation (308 lines)
- `src/lib/policies/constants.ts` — Policy constants (113 lines)
- `src/lib/jobs/detect-anomalies.ts` — Hourly anomaly detection job (98 lines)
- `src/lib/jobs/detect-device-integrity.ts` — Device integrity job (136 lines)
- `src/lib/jobs/settings.ts` — Monitoring settings resolver (246+ lines)
- `src/lib/navigation.ts` — Page role config
- `src/lib/auth.ts` — RBAC hierarchy
- `src/lib/api.ts` — Auth/tenant isolation primitives
- `mini-services/live-updates/index.ts` — WebSocket event emission
- `mini-services/live-updates/notify-triggers.ts` — pg_notify triggers

**Agent (omnisight-agent):**
- `src/api/config.ts` — Config fetch
- `src/api/policy.ts` — Violation reporting
- `src/api/heartbeat.ts` — Heartbeat + break state
- `src/services/config-service.ts` — Config sync (10 min)
- `src/services/heartbeat-service.ts` — Heartbeat service (60s)
- `src/storage/policy-cache.ts` — On-disk policy cache
- `src/collectors/policy-enforcer.ts` — Process scanner + enforcement
- `src/lib/policy-resolution.ts` — Client-side policy resolution
- `src/types/api.ts` — Type definitions

### Files Changed

None — this was a read-only audit.

### Files Created

None — this was a read-only audit.

---

## 10. Validation

### Build

```
npm run build → ✓ Compiled successfully (13.9s)
               ✓ TypeScript passed (9.5s)
               ✓ 129 static pages generated
               ✓ 0 errors
```

### Tests

```
npx tsx --test tests/*.test.ts → 155/155 pass (0 fail)
```

Test suites:
- `rbac-forensic-regression.test.ts` — 44 tests (RBAC, tenant isolation, role hierarchy)
- `svg-validation.test.ts` — 37 tests (SVG branding validation)
- `react-duplicate-key-regression.test.ts` — 8 tests (React key uniqueness)
- `sound-alert.test.ts` — 39 tests (sound alert system)
- Additional test files in the suite

### Browser Verification

Not performed in this audit (read-only code analysis). The audit relied on source-code evidence.

---

## 11. Final Forensic Verdict

### 1. AGENT SECURITY

```
VERDICT: PARTIALLY FUNCTIONAL
```

**Why:**
The Agent Security page is a real, functional dashboard that displays security-relevant alerts (tamper events, device offline, policy violations, high inactivity) from the `Alert` database model. The UI renders real API data, RBAC is enforced, tenant isolation works, and audit logging covers all mutations.

**However**, the primary data source — agent-generated tamper events — is NOT wired up. The agent has `tamperDetectionEnabled` config flag but no local detector implementation. The `/api/agent/tamper` endpoint exists and is fully functional, but the shipped agent never calls it. Tamper events would need to come from future agent implementation or third-party integrations.

The device integrity monitoring (server-side hourly job detecting stale heartbeats) DOES work and generates `device_missing` anomalies.

**What works:** Alert dashboard, tamper endpoint, device integrity monitoring, notification generation, RBAC, tenant isolation.
**What doesn't work:** Agent-generated tamper events (no local detector in shipped agent).

---

### 2. POLICIES

```
VERDICT: FULLY FUNCTIONAL
```

**Why:**
The policy system has a complete end-to-end lifecycle that is fully operational:

1. **Admin creates blacklist entry** → `AppListEntry` persisted + policy version bumped
2. **Agent fetches config** → receives new policy version → re-fetches policy list
3. **Agent enforces policy** → scans running processes every 10 seconds → matches against blacklist
4. **Violation detected** → Agent reports to `POST /api/agent/policy-violations`
5. **Backend persists** → `PolicyViolation` record created with deduplication
6. **Admin sees violation** → Policies → Violations tab refreshes

Every stage has been verified in source code. The Agent's `PolicyEnforcer` is a real process monitor using Windows native APIs (`CreateToolhelp32Snapshot`, `QueryFullProcessImageName`, `ProcessTerminate`). The policy resolution logic is deterministic, with SHA256/path/publisher/executable matching and proper precedence rules.

The only limitation is that policies are org-wide (no per-employee/department assignment), which is a design decision, not a bug.

---

### 3. ANOMALY DETECTION

```
VERDICT: FULLY FUNCTIONAL
```

**Why:**
The anomaly detection system has a real, rule-based statistical engine that processes real agent-collected activity data and produces real anomaly records with scores, confidence levels, and metadata.

**What works:**
- 4 statistical rules comparing 7-day activity against 30-day baselines
- Timezone-aware processing using org-configured IANA timezone
- Hourly scheduled job + on-demand trigger from UI
- Deduplication via unique `dedupeKey` per org+employee+type+day
- High/critical anomalies auto-generate alerts and notifications
- Full CRUD with audit logging
- Device integrity monitoring (server-side) for stale heartbeats
- False positive handling (resolve clears dedupeKey for re-detection)

**What doesn't work:**
- Anomaly events are emitted via WebSocket but do NOT appear in the Live Event Stream UI (only trigger query invalidation)
- Detection is rule-based only (no ML/AI) — but this is a scope decision, not a bug
- Detection runs hourly, not realtime — but this is architecturally appropriate for batch statistical analysis

---

## Summary

| Feature | Verdict | Key Strength | Key Limitation |
|---------|---------|--------------|----------------|
| Agent Security | **PARTIALLY FUNCTIONAL** | Real alert dashboard with tamper endpoint | Agent has no local tamper detector wired up |
| Policies | **FULLY FUNCTIONAL** | Complete end-to-end with real agent enforcement | Org-wide only (no per-employee assignment) |
| Anomaly Detection | **FULLY FUNCTIONAL** | Real statistical engine with real data | Rule-based only; anomalies not in Live Event Stream |

**Overall Assessment:** The OmniSight platform has substantive, production-grade implementations of all three features. Policies and Anomaly Detection are fully functional with real data flow from agent to backend to admin UI. Agent Security is partially functional — the dashboard works perfectly, but the primary data source (agent tamper detection) is not yet wired up in the shipped agent.
