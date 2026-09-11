# OmniSight Organization Authorization, RBAC, Permissions & Data-Ownership Audit

**Date:** 2026-09-12
**Scope:** READ-ONLY project-wide discovery audit
**Status:** Complete — no code/schema/UI/routes modified

---

## Table of Contents

1. [Existing Role Architecture](#1-existing-role-architecture)
2. [Existing Permission Architecture](#2-existing-permission-architecture)
3. [Existing Policy Sources](#3-existing-policy-sources)
4. [Current Organization Admin Capabilities](#4-current-organization-admin-capabilities)
5. [Current Manager Capabilities](#5-current-manager-capabilities)
6. [Current Viewer Capabilities](#6-current-viewer-capabilities)
7. [Current Super Admin Capabilities](#7-current-super-admin-capabilities)
8. [Existing Granular Permission Support](#8-existing-granular-permission-support)
9. [Existing User-Management Capability](#9-existing-user-management-capability)
10. [Monitoring Ownership Architecture](#10-monitoring-ownership-architecture)
11. [Organization Resource Permission Matrix](#11-organization-resource-permission-matrix)
12. [Ownership Matrix](#12-ownership-matrix)
13. [Tenant-Isolation Implementation](#13-tenant-isolation-implementation)
14. [Relevant Tests](#14-relevant-tests)
15. [Documentation/Code Conflicts](#15-documentationcode-conflicts)
16. [Missing Capabilities](#16-missing-capabilities)
17. [Security Risks](#17-security-risks)
18. [Organization ID Naming Inconsistencies](#18-organization-id-naming-inconsistencies)
19. [Recommended Decisions Requiring Product Approval](#19-recommended-decisions-requiring-product-approval)

---

## 1. Existing Role Architecture

### 1.1 Two-Tier Role Model

OmniSight uses a **two-tier role system**:

| Tier | Source | Field | Meaning |
|------|--------|-------|---------|
| **Platform role** | `AppUser.role` | `super_admin`, `user` | Global platform authority |
| **Org membership role** | `OrganizationMembership.role` | `org_admin`, `manager`, `viewer` | Per-organization authority |

One user can hold memberships in **multiple organizations** with different roles in each.

### 1.2 Role Hierarchy

**File:** `src/lib/org-members.ts:27-32`

```
super_admin: 50  (platform-wide, never a membership role)
org_admin:   35  (full admin within an organization)
manager:     20  (management capabilities)
viewer:      10  (read-only)
```

**Legacy aliases** (`src/lib/auth.ts:315-322`): `owner` and `admin` both map to level 35 (same as `org_admin`). These exist in the DB but are not in the canonical `ORG_ROLES` array.

### 1.3 Canonical Assignable Roles

**File:** `src/lib/org-members.ts:22`
```ts
export const ORG_ROLES = ['org_admin', 'manager', 'viewer'] as const;
```

`super_admin` is a **global platform role** — never assigned as a per-org membership role.

### 1.4 Database Representation

| Model | Field | Type | Values |
|-------|-------|------|--------|
| `AppUser` | `role` | String | `super_admin`, `user` (legacy: `owner`, `admin`, `manager`, `viewer`) |
| `OrganizationMembership` | `role` | String | `org_admin`, `manager`, `viewer` |
| `OrganizationMembership` | `status` | String | `ACTIVE`, `INVITED`, `SUSPENDED`, `REMOVED` |

### 1.5 How Roles Are Resolved

| Path | Source | Authoritative? | Used By |
|------|--------|----------------|---------|
| `authenticateRequest()` | JWT `role` claim | **No** (can be stale) | Most API routes via `requireActiveSessionOrg` |
| `resolveActorDbRole()` | DB `OrganizationMembership.role` | **Yes** | Member-management routes (add/change/remove members) |

**Key design:** Most routes use JWT role for level checks but verify ACTIVE membership from DB. Member-management operations read the role from DB to prevent stale-role escalation.

---

## 2. Existing Permission Architecture

### 2.1 Permission System Type

**Role-based only. No per-user permissions. No custom roles.**

The system uses a static `ROLE_PERMISSIONS` map in `src/lib/permissions.ts:177-182`:

```ts
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  super_admin: [...PLATFORM_PERMISSIONS, ...ORG_ADMIN_PERMISSIONS],
  org_admin: ORG_ADMIN_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};
```

Authorization checks use `hasPermission(role, permission)` which looks up the role in this static map.

### 2.2 PLATFORM_PERMISSIONS (9 permissions)

**File:** `src/lib/permissions.ts:75-85`

| Permission |
|-----------|
| `platform.organizations.read` |
| `platform.organizations.create` |
| `platform.organizations.update` |
| `platform.organizations.delete` |
| `platform.settings.read` |
| `platform.settings.update` |
| `platform.audit.read` |
| `platform.members.read` |
| `platform.members.manage` |

### 2.3 ORG_ADMIN_PERMISSIONS (41 permissions)

**File:** `src/lib/permissions.ts:87-129`

| Domain | Permissions |
|--------|------------|
| Organization | `read`, `update`, `settings.read`, `settings.update`, `members.read`, `members.create`, `members.update`, `members.delete` |
| Employees | `read`, `create`, `update`, `delete` |
| Devices | `read`, `create`, `update`, `delete` |
| Projects | `read`, `create`, `update`, `delete` |
| Reports | `read`, `create` |
| Audit | `read` |
| Agents | `read`, `manage` |
| Audio | `read`, `manage` |
| Consent | `read`, `manage` |
| Policies | `read`, `manage` |
| Alerts | `read`, `manage` |
| Anomalies | `read`, `manage` |
| Notifications | `read`, `manage` |
| Dashboard | `read` |
| Analytics | `read` |
| Insights | `read` |
| Sentiment | `read` |

### 2.4 MANAGER_PERMISSIONS (22 permissions)

Read on everything + `employees.create`, `employees.update`, `projects.create`, `projects.update`.

**Missing vs org_admin:** No `*.delete`, no `*.manage`, no `organization.update`, no `organization.settings.update`, no `organization.members.*`.

### 2.5 VIEWER_PERMISSIONS (16 permissions)

Pure `*.read` on: organization, organization.settings, employees, devices, projects, reports, agents, audio, consent, policies, alerts, notifications, dashboard, analytics, insights, sentiment.

**Missing vs manager:** No `audit.read`, no `anomalies.read`, no `employees.create/update`, no `projects.create/update`.

### 2.6 Navigation Permission Gates

**File:** `src/lib/navigation.ts:19-80`

| Page | Minimum Role |
|------|-------------|
| Dashboard, Employees, Departments, Devices, Activities, Analytics, Insights, Notifications, Alerts, Screenshots, Break-Status, Live-Monitor, Policies, Anomalies, Projects, Sentiment | `viewer` |
| Audit, Consent, Reports, Daily-Report, Self-Portal | `manager` |
| Audio, Branding | `admin` (legacy alias for org_admin) |
| AI-Provider, Agent-Approvals, Organization, Users, Security, Settings, Billing, Data-Infrastructure | `org_admin` |
| All SA pages | `super_admin` |

### 2.7 Access Matrix

**File:** `src/lib/access-matrix.ts:27-37`

| Capability | super_admin | org_admin | manager | viewer | employee |
|------------|:-----------:|:---------:|:-------:|:------:|:--------:|
| control_plane_org_management | YES | NO | NO | NO | NO |
| package_management | YES | NO | NO | NO | NO |
| subscription_management | YES | SCOPED | NO | NO | NO |
| payment_records | YES | SCOPED | NO | NO | NO |
| license_management | YES | NO | NO | NO | NO |
| managed_tenant_data | YES | SCOPED | SCOPED | SCOPED | SCOPED |
| customer_tenant_data | NO | SCOPED | SCOPED | SCOPED | SCOPED |
| org_member_management | YES | SCOPED | SCOPED | NO | NO |

---

## 3. Existing Policy Sources

| Source | Location | Content |
|--------|----------|---------|
| Prisma Schema | `prisma/schema.prisma` | Organization, OrganizationMembership, AppUser, OrganizationSetting, OrganizationSettings models |
| Role Hierarchy | `src/lib/org-members.ts:27-32` | `ROLE_LEVELS` definition |
| Permission Sets | `src/lib/permissions.ts` | All 4 role permission lists |
| Navigation Gates | `src/lib/navigation.ts:19-80` | `PAGE_MIN_ROLE` table |
| Access Matrix | `src/lib/access-matrix.ts` | 8 capabilities × 5 roles |
| Auth Guards | `src/lib/api.ts` | `require*` function family |
| Proxy Rules | `src/proxy.ts:171-200` | RBAC prefix rules |
| Deployment Modes | `src/lib/deployment-mode.ts` | MANAGED/CUSTOMER_DB/PRIVATE restrictions |
| Control Plane | `src/lib/control-plane.ts` | SA tenant access gating |

---

## 4. Current Organization Admin Capabilities

| Capability | Can Do? | Via | Notes |
|-----------|---------|-----|-------|
| View Dashboard | ✅ | `dashboard.read` permission | |
| Manage Users (create/edit/deactivate) | ✅ | `POST /api/auth/users`, `PUT /api/auth/users/[id]` | Cannot assign super_admin |
| Add Existing User to Org | ✅ | `POST /api/organizations/[orgId]/members` | Admin+ gate |
| Change Member Role | ✅ | `PATCH /api/organizations/[orgId]/members/[memberId]` | DB-verified, privilege-elevation guard |
| Remove Member | ✅ | `DELETE /api/organizations/[orgId]/members/[memberId]` | Last-admin guard |
| Manage Devices (CRUD) | ✅ | `devices.*` permissions | |
| Manage Employees (CRUD) | ✅ | `employees.*` permissions | |
| Manage Projects (CRUD) | ✅ | `projects.*` permissions | |
| Manage Reports (read/create) | ✅ | `reports.read`, `reports.create` | |
| Manage Alerts/Anomalies/Policies | ✅ | `*.manage` permissions | |
| Manage Notifications | ✅ | `notifications.manage` | |
| Configure Monitoring Settings | ✅ | `PUT /api/settings/monitoring` | Admin+ gate. **Except screenshot_frequency** (super_admin only) |
| Configure Retention Settings | ✅ | `PUT /api/settings/retention` | Admin+ gate |
| Configure Branding | ✅ | `PUT /api/branding/organization/*` | Admin+ gate |
| Configure AI Provider | ✅ | `PUT /api/organizations/[orgId]/settings/ai` | Admin+ gate |
| Submit DB/Storage Change Request | ✅ | `PUT /api/organizations/[orgId]/settings/database` | Requires SA approval |
| View Billing | ✅ | `/dashboard/billing` page | org_admin min-role |
| Create Subscription | ✅ | `POST /api/organizations/[orgId]/subscription` | DB-verified org_admin |
| View Audit Logs | ✅ | `audit.read` permission | |
| View Screenshots | ✅ | `requireSessionOrg` (viewer+) | |
| Delete Screenshots | ✅ | Admin+ on `/api/screenshots/[id]` | |
| Export Data | ⚠️ | `PUT /api/export/*` | Manager+ on proxy; actual export routes vary |
| Import Data | ✅ | `POST /api/import/*` | Admin+ on proxy |
| Access Agent Settings | ✅ | `agents.manage` | |
| Access Audio | ✅ | `audio.manage` | |
| Access Consent Management | ✅ | `consent.manage` | |
| Access Live Monitor | ✅ | Viewer+ | |

**Cannot:**
- Access Control Center (super_admin only)
- Manage other organizations
- Modify screenshot frequency (super_admin only)
- Approve infrastructure change requests (super_admin only)
- Access platform settings (super_admin only)

---

## 5. Current Manager Capabilities

| Capability | Can Do? | Via | Notes |
|-----------|---------|-----|-------|
| View Dashboard | ✅ | `dashboard.read` | |
| View Employees | ✅ | `employees.read` | |
| Create/Edit Employees | ✅ | `employees.create`, `employees.update` | |
| Delete Employees | ❌ | Missing permission | |
| View Devices | ✅ | `devices.read` | |
| Create/Edit/Delete Devices | ❌ | Missing permissions | |
| View Projects | ✅ | `projects.read` | |
| Create/Edit Projects | ✅ | `projects.create`, `projects.update` | |
| Delete Projects | ❌ | Missing permission | |
| View Reports | ✅ | `reports.read` | |
| Create Reports | ❌ | Missing permission | |
| View Audit Logs | ✅ | `audit.read` | |
| View Alerts | ✅ | `alerts.read` | |
| Manage Alerts | ❌ | Missing permission | |
| View Anomalies | ✅ | `anomalies.read` | (Note: viewer lacks this) |
| View Notifications | ✅ | `notifications.read` | |
| Manage Notifications | ❌ | Missing permission | |
| Configure Monitoring | ❌ | Admin+ gate on PUT | Can only READ |
| Configure Retention | ❌ | Admin+ gate on PUT | Can only READ |
| Manage Users/Members | ❌ | Admin+ gate | Cannot add/change/remove members |
| View Billing | ❌ | org_admin min-role | Cannot access billing page |
| View Screenshots | ✅ | Viewer+ | |
| View Analytics | ✅ | `analytics.read` | |
| View Insights | ✅ | `insights.read` | |
| View Sentiment | ✅ | `sentiment.read` | |
| Access Consent | ✅ | `consent.read` | |
| Access Policies | ✅ | `policies.read` | |
| Access Audio | ✅ | `audio.read` | |

---

## 6. Current Viewer Capabilities

| Capability | Can Do? | Notes |
|-----------|---------|-------|
| View Dashboard | ✅ | |
| View Employees | ✅ | |
| View Devices | ✅ | |
| View Projects | ✅ | |
| View Reports | ✅ | |
| View Notifications | ✅ | |
| View Alerts | ✅ | |
| View Analytics | ✅ | |
| View Insights | ✅ | |
| View Sentiment | ✅ | |
| View Screenshots | ✅ | |
| View Consent | ✅ | |
| View Policies | ✅ | |
| View Audit Logs | ❌ | Missing `audit.read` |
| View Anomalies | ❌ | Missing `anomalies.read` |
| Any create/update/delete | ❌ | Pure read-only |
| Configure anything | ❌ | |

---

## 7. Current Super Admin Capabilities

Super Admin has **all 50 permissions** (9 platform + 41 org-admin) plus:

| Capability | Via |
|-----------|-----|
| Manage all organizations (CRUD, suspend, archive) | `platform.organizations.*` |
| Access Control Center | SPA routing + `super_admin` min-role |
| View all org members across any org | `platform.members.*` |
| Manage packages/pricing/offers | SA-gated routes |
| Manage purchase requests | SA-gated routes |
| View audit logs for any org | `platform.audit.read` |
| Access MANAGED org data-plane | `requireManagedTenantAccess` |
| Modify screenshot frequency | `PUT /api/admin/organizations/[orgId]/settings` |
| Approve infrastructure change requests | SA-gated |
| Record manual payments/waivers | `POST /api/super-admin/organizations/[orgId]/adjustment` |
| Switch org context | `POST /api/me/organization/switch` |
| Platform branding | SA-gated branding routes |

**Cannot access data-plane for CUSTOMER_DB/PRIVATE orgs** (deployment-mode gate).

---

## 8. Existing Granular Permission Support

**The system does NOT support granular per-user permissions.**

Evidence:
- No `custom_role`, `customRole`, or `CUSTOM_ROLE` anywhere in the codebase (grep: 0 matches)
- `ORG_ROLES` is a hardcoded `const` tuple: `['org_admin', 'manager', 'viewer']`
- `ROLE_PERMISSIONS` is a static `Record` with exactly 4 keys
- No user-to-permission junction table in the Prisma schema
- No dynamic permission assignment API
- No role builder UI

---

## 9. Existing User-Management Capability

### 9.1 Organization Admin User Management

| Action | API | Guard |
|--------|-----|-------|
| List users | `GET /api/auth/users` | admin+ (scoped to own org) |
| Create user | `POST /api/auth/users` | admin+ (creates AppUser + Membership) |
| Edit user | `PUT /api/auth/users/[id]` | admin+ (name, role, password, isActive) |
| Toggle active/inactive | `PUT /api/auth/users/[id]` | admin+ |
| Deactivate (soft-delete) | `DELETE /api/auth/users/[id]` | **super_admin only** |
| Change own password | `POST /api/auth/change-password` | any authenticated user |

**Org Admin CANNOT:**
- Add existing user to org (only create new users)
- Suspend/reactivate at membership level
- Remove member from org
- Revoke sessions explicitly
- Search for existing users to add

### 9.2 Super Admin User Management

| Action | API | Guard |
|--------|-----|-------|
| Add existing user to org | `POST /api/organizations/[orgId]/members` | super_admin |
| Change member role | `PATCH /api/organizations/[orgId]/members/[memberId]` | super_admin (DB-verified) |
| Suspend member | `PATCH .../[memberId]` with `status: "SUSPENDED"` | super_admin |
| Reactivate member | `PATCH .../[memberId]` with `status: "ACTIVE"` | super_admin |
| Remove member | `DELETE /api/organizations/[orgId]/members/[memberId]` | super_admin (last-admin override) |
| Deactivate user | `DELETE /api/auth/users/[id]` | super_admin only |
| Revoke sessions | `POST /api/auth/users/[id]/revoke-sessions` | admin+ |

### 9.3 Invitation System

**Not implemented.** `OrganizationMembership.status` supports `"INVITED"` but no API sets it. No email invitation flow exists. Adding a member immediately sets status to `"ACTIVE"`.

---

## 10. Monitoring Ownership Architecture

### 10.1 Screenshot Capture

- **Agent-initiated, server-enforced:** Agent sends `POST /api/agent/screenshot`; server re-validates consent, monitoring policy, and interval before accepting.
- **Frequency control:** `Organization.screenshotInterval` (0-60 min, default 5). **Super Admin only** — hidden from org admins.
- **Master toggle:** `screenshot_enabled` in OrganizationSetting. Admin+ to modify.

### 10.2 Monitoring Configuration

All monitoring settings stored in `OrganizationSetting` (per-org key-value). **No cross-tenant fallback.**

| Setting | Read | Write |
|---------|------|-------|
| heartbeat_interval | Manager+ | Admin+ |
| screenshot_enabled | Manager+ | Admin+ |
| screenshot_frequency | Manager+ | **Super Admin only** |
| app_tracking | Manager+ | Admin+ |
| website_tracking | Manager+ | Admin+ |
| idle_detection | Manager+ | Admin+ |
| idle_timeout | Manager+ | Admin+ |
| working_hours_only | Manager+ | Admin+ |
| location_tracking | Manager+ | Admin+ |
| keystroke_logging_enabled | Manager+ | Admin+ |
| webcam_capture_enabled | Manager+ | Admin+ |
| usb_monitoring | Manager+ | Admin+ |
| tamper_detection | Manager+ | Admin+ |
| app_policy_enforcement | Manager+ | Admin+ |

### 10.3 Retention Configuration

Per-org, stored in `OrganizationSetting`. Admin+ to modify. 0 = keep forever.

### 10.4 Data Residency (CUSTOMER_DB)

- Org Admin submits change request → requires Super Admin approval
- Customer provides DB credentials (encrypted at rest)
- Platform DB is never switched; only analytics data routes to customer DB
- Phase 1: `CUSTOMER_DB`/`PRIVATE` primary-DB pools not yet implemented (fail-closed)

### 10.5 Storage

- Per-org storage driver (local or Supabase)
- Org Admin submits change request → requires Super Admin approval
- Screenshots stored at `screenshots/<orgId>/<filename>`

---

## 11. Organization Resource Permission Matrix

| Resource | Super Admin | Org Admin | Manager | Viewer | Source |
|----------|:-----------:|:---------:|:-------:|:------:|--------|
| **Dashboard** | ✅ | ✅ | ✅ | ✅ | `dashboard.read` |
| **Employees** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `employees.read` |
| — Create | ✅ | ✅ | ✅ | ❌ | `employees.create` |
| — Edit | ✅ | ✅ | ✅ | ❌ | `employees.update` |
| — Delete | ✅ | ✅ | ❌ | ❌ | `employees.delete` |
| **Devices** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `devices.read` |
| — Create | ✅ | ✅ | ❌ | ❌ | `devices.create` |
| — Edit | ✅ | ✅ | ❌ | ❌ | `devices.update` |
| — Delete | ✅ | ✅ | ❌ | ❌ | `devices.delete` |
| **Screenshots** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `requireSessionOrg` (viewer+) |
| — Delete | ✅ | ✅ | ❌ | ❌ | Admin+ on route |
| **Projects** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `projects.read` |
| — Create | ✅ | ✅ | ✅ | ❌ | `projects.create` |
| — Edit | ✅ | ✅ | ✅ | ❌ | `projects.update` |
| — Delete | ✅ | ✅ | ❌ | ❌ | `projects.delete` |
| **Reports** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `reports.read` |
| — Create | ✅ | ✅ | ❌ | ❌ | `reports.create` |
| **Alerts** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `alerts.read` |
| — Manage | ✅ | ✅ | ❌ | ❌ | `alerts.manage` |
| **Alert Rules** | | | | | |
| — View/Create/Edit | ✅ | ✅ | ❌ | ❌ | Admin+ on routes |
| **Anomalies** | | | | | |
| — View | ✅ | ✅ | ✅ | ❌ | `anomalies.read` (manager+) |
| — Manage | ✅ | ✅ | ❌ | ❌ | `anomalies.manage` |
| **Notifications** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `notifications.read` |
| — Manage | ✅ | ✅ | ❌ | ❌ | `notifications.manage` |
| **Audit Logs** | | | | | |
| — View | ✅ | ✅ | ✅ | ❌ | `audit.read` (manager+) |
| **Consent** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `consent.read` |
| — Manage | ✅ | ✅ | ❌ | ❌ | `consent.manage` |
| **Policies** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `policies.read` |
| — Manage | ✅ | ✅ | ❌ | ❌ | `policies.manage` |
| **Audio** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `audio.read` |
| — Manage | ✅ | ✅ | ❌ | ❌ | `audio.manage` |
| **AI Insights** | ✅ | ✅ | ✅ | ✅ | `insights.read` |
| **Sentiment** | ✅ | ✅ | ✅ | ✅ | `sentiment.read` |
| **Analytics** | ✅ | ✅ | ✅ | ✅ | `analytics.read` |
| **Live Monitor** | ✅ | ✅ | ✅ | ✅ | `requireSessionOrg` (viewer+) |
| **Break Status** | ✅ | ✅ | ✅ | ✅ | `requireSessionOrg` (viewer+) |
| **Activities** | ✅ | ✅ | ✅ | ✅ | `requireSessionOrg` (viewer+) |
| **Users/Members** | | | | | |
| — List | ✅ | ✅ | ❌ | ❌ | Admin+ |
| — Create | ✅ | ✅ | ❌ | ❌ | Admin+ |
| — Edit role | ✅ | ✅ | ❌ | ❌ | Admin+ (DB-verified) |
| — Remove | ✅ | ✅ | ❌ | ❌ | Admin+ |
| — Suspend | ✅ | ⚠️ | ❌ | ❌ | SA: membership-level; OrgAdmin: global isActive only |
| **Organization Settings** | | | | | |
| — View | ✅ | ✅ | ✅ | ✅ | `organization.settings.read` |
| — Update | ✅ | ✅ | ❌ | ❌ | `organization.settings.update` |
| **Monitoring Config** | | | | | |
| — Read | ✅ | ✅ | ✅ | ❌ | Manager+ |
| — Write | ✅ | ✅ | ❌ | ❌ | Admin+ |
| — Screenshot frequency | ✅ | ❌ | ❌ | ❌ | Super Admin only |
| **Retention Config** | | | | | |
| — Read | ✅ | ✅ | ✅ | ❌ | Manager+ |
| — Write | ✅ | ✅ | ❌ | ❌ | Admin+ |
| **Branding** | | | | | |
| — Org branding | ✅ | ✅ | ❌ | ❌ | Admin+ |
| — Platform branding | ✅ | ❌ | ❌ | ❌ | Super Admin only |
| **Billing** | | | | | |
| — View | ✅ | ✅ | ❌ | ❌ | org_admin min-role |
| — Create subscription | ✅ | ✅ | ❌ | ❌ | DB-verified org_admin |
| — Record payment | ✅ | ❌ | ❌ | ❌ | Super Admin only |
| — Waive | ✅ | ❌ | ❌ | ❌ | Super Admin only |
| **Data Infrastructure** | | | | | |
| — View | ✅ | ✅ | ❌ | ❌ | org_admin min-role |
| — Submit change request | ✅ | ✅ | ❌ | ❌ | Admin+ |
| — Approve change request | ✅ | ❌ | ❌ | ❌ | Super Admin only |
| **Imports** | ✅ | ✅ | ❌ | ❌ | Admin+ on proxy |
| **Exports** | ✅ | ✅ | ✅ | ❌ | Manager+ on proxy |
| **Agent Approvals** | ✅ | ✅ | ❌ | ❌ | org_admin min-role |
| **AI Provider** | ✅ | ✅ | ❌ | ❌ | org_admin min-role |
| **Security** | ✅ | ✅ | ❌ | ❌ | org_admin min-role |
| **Data Infrastructure** | ✅ | ✅ | ❌ | ❌ | org_admin min-role |

---

## 12. Ownership Matrix

| Capability | OmniSight-Managed | Customer-DB | Private |
|-----------|:-----------------:|:-----------:|:-------:|
| Screenshot capture | Agent → Platform DB | Agent → Customer DB | Agent → Customer API |
| Screenshot frequency | SA sets interval | SA sets interval | SA sets interval |
| Monitoring config | Org setting (per-org) | Org setting (per-org) | Org setting (per-org) |
| Storage | Platform storage | Customer Supabase | Customer storage |
| Database | Platform DB | Customer DB | Customer DB |
| Org Admin control | Full monitoring/retention | Submit change requests | Submit change requests |
| Manager control | Read monitoring/retention | Read monitoring/retention | Read monitoring/retention |
| Viewer control | Read-only dashboard | Read-only dashboard | Read-only dashboard |
| SA data access | ✅ Full data-plane | ❌ Control-plane only | ❌ Control-plane only |
| SA approve changes | ✅ | ✅ | ✅ |

---

## 13. Tenant-Isolation Implementation

### 13.1 Enforcement Layers

| Layer | Mechanism | File |
|-------|-----------|------|
| **JWT** | Org identity from `auth.activeOrganizationId` | `src/lib/api.ts:197` |
| **Middleware** | RBAC prefix rules, CSRF, rate limiting | `src/proxy.ts:171-200` |
| **Route guards** | `requireSessionOrg`, `requireAdminOrg`, etc. | `src/lib/api.ts` |
| **Query scoping** | `organizationId` in every `where` clause | All API routes |
| **Tenant scope helper** | `withTenantScope()` injects orgId | `src/lib/tenant-scope.ts` |
| **Storage isolation** | `screenshots/<orgId>/<filename>` | `src/lib/storage/index.ts:103` |
| **WebSocket rooms** | `org:<organizationId>` room isolation | `mini-services/live-updates/index.ts:190` |
| **Agent auth** | `validateAgentToken()` with org scope | `src/lib/agent/auth.ts` |
| **Deployment mode** | MANAGED/CUSTOMER_DB/PRIVATE gates | `src/lib/deployment-mode.ts` |
| **Org status** | `active` check blocks paused/archived | `src/lib/api.ts:214` |

### 13.2 Key Isolation Guarantees

1. **Client input never trusted:** `organizationId` from request bodies/query params is ignored. Server-derived org from JWT is always authoritative. Verified by tests: AUTH-12/13/15, AA-A22, P3A-02, P3A-06, P3C-03, P3C-06.

2. **Fail-closed:** `OrgDbMisconfigurationError`, `TenantDatabaseError`, and `assertTenantScope` all throw rather than silently falling back.

3. **21 tenant-scoped models:** `activity`, `screenshot`, `employee`, `device`, `locationEvent`, `keyboardActivity`, `webcamSession`, `audioRecording`, `consent`, `consentLog`, `usbEvent`, `policyViolation`, `appListEntry`, `project`, `timeEntry`, `alert`, `anomaly`, `report`, `aiInsight`, and more.

4. **PAUSED/ARCHIVED org status** immediately blocks both web-admin (403) and agent (401) access at every checkpoint.

---

## 14. Relevant Tests

### 14.1 Tenant Isolation Tests

| File | Tests | Coverage |
|------|-------|----------|
| `multi-org-isolation.test.ts` | 15+ (MO-1 to MO-16+) | Every org-scoped admin surface isolated per org |
| `multi-org.test.ts` | 9 (MO-1 to MO-9) | Membership CRUD, cross-tenant isolation, org switching, settings isolation |
| `multi-org-ga.test.ts` | 12 (A to L) | GA-level API flows, per-org roles, suspension blocking |
| `agent-cross-org-attack.test.ts` | 8 (ACO-01 to ACO-08) | Cross-org agent attack prevention |
| `agent-phase3-attack.test.ts` | 6 (P3A-01 to P3A-06) | Org spoof rejection, anonymous enrollment |
| `agent-phase3-contract.test.ts` | 9 (P3C-01 to P3C-09) | Screenshot policy, heartbeat isolation |
| `agent-phase4-data-plane.test.ts` | 14 (P4A-01 to P4A-35) | Cross-org screenshot upload, path traversal, retention purge |
| `deployment-mode-switch.test.ts` | 9 (DM-01 to DM-09) | Mode switching, fail-closed behavior |
| `full-org-cutover.test.ts` | 10 (FCO-01 to FCO-10) | Full DB cutover, post-activation routing |
| `org-cutover-routing.test.ts` | 21 (RT-01 to RT-21) | Post-activation routing for every data type |

### 14.2 RBAC / Authorization Tests

| File | Tests | Coverage |
|------|-------|----------|
| `rbac-hardening.test.ts` | 30 (RBAC-01 to RBAC-30) | Role resolution, privilege escalation, cross-org denial |
| `rbac-forensic-regression.test.ts` | Multiple | Settings GET role protection, self-role-change guard |
| `role-rbac-nav-fix.test.ts` | Multiple | Role dropdown, PAGE_MIN_ROLE, canAccessPage |
| `super-admin-hardening.test.ts` | 21 (SA-01 to SA-18+) | SA operations, role blocking, membership management |
| `super-admin-privacy.test.ts` | 13 (PV-01 to PV-13) | SA privacy boundaries, deployment mode |
| `admin-prod-reports-rbac.test.ts` | Multiple | Reports RBAC enforcement |

### 14.3 Security / Hardening Tests

| File | Tests | Coverage |
|------|-------|----------|
| `security.test.ts` | Multiple | Auth, org-scoped, admin+ RBAC for mutations |
| `hardening.test.ts` | Multiple | Null role handling, pagination, consent write isolation |
| `screenshots.test.ts` | Multiple | Upload validation, org isolation, path-traversal, 404 concealment |
| `agent-auth-login.test.ts` | 25+ (AUTH-1 to AUTH-25) | Login, token validation, server-derived orgId |
| `rate-limit-shared.test.ts` | Multiple | Rate limiting |

### 14.4 Commercial / Billing Tests

| File | Tests | Coverage |
|------|-------|----------|
| `commercial-v1.test.ts` | Multiple | Device cap per mode, PRIVATE not capped |
| `subscription.test.ts` | Multiple | Subscription management |
| `delete-impact.test.ts` | 12 (DI-01 to DI-12) | Tenant deletion, last-admin guard |
| `manual-payment-history.test.ts` | Multiple | Payment history |

---

## 15. Documentation/Code Conflicts

### A. Already Correct

| Finding | Status |
|---------|--------|
| Role hierarchy matches across `auth.ts` and `org-members.ts` | ✅ Consistent |
| Permission sets match `PAGE_MIN_ROLE` | ✅ Consistent |
| Tenant isolation enforced server-side on all org-scoped routes | ✅ Consistent |
| Deployment mode gating works correctly | ✅ Consistent |
| WebSocket room isolation matches DB orgId | ✅ Consistent |

### B. Documentation Mismatch

| Finding | Status |
|---------|--------|
| `INVITED` status exists in schema but no API uses it | ⚠️ Schema says invite flow exists; code does not implement it |
| Comment in `members/route.ts` says "Add/invite" but behavior is "add only" | ⚠️ Stale comment |
| `employees/[id]/websites/route.ts` comment says "Manager+ read scope" but code uses viewer+ | ⚠️ Stale comment |

### C. Code Mismatch

| Finding | Status |
|---------|--------|
| `audio` and `branding` pages use legacy `'admin'` min-role while other org_admin pages use `'org_admin'` | ⚠️ Works due to legacy alias mapping but inconsistent |
| `getPageMinRole('billing') = 'org_admin'` but billing was hidden from sidebar | ⚠️ Fixed in recent work |
| `requireActiveSubscription` defined but never used in routes | ⚠️ Dead code |
| `requireTenantDataAccess` defined but never used in routes | ⚠️ Dead code |
| `requireValidLicense` defined but never used in routes | ⚠️ Dead code |

### D. Missing Capability

| Finding | Status |
|---------|--------|
| No forgot-password / email-based password reset | ❌ Not implemented |
| No invitation flow (email invite with token acceptance) | ❌ Not implemented |
| Org Admin cannot suspend/reactivate membership (only global isActive) | ⚠️ Limited |
| Org Admin cannot add existing users to org (only create new) | ⚠️ Limited |
| No per-user permission overrides | ❌ Not implemented |
| No custom roles | ❌ Not implemented |

### E. Security Risk

| Finding | Status |
|---------|--------|
| JWT role can be stale if user role is downgraded but JWT not refreshed | ⚠️ Mitigated for member-management (DB-verified), but general routes use JWT role |
| `getSessionOrg` used by 22 routes does NOT check org active status or membership | ⚠️ Relies on proxy JWT validation only |

### F. Ambiguous Policy

| Finding | Status |
|---------|--------|
| Should Manager be able to view Audit Logs? Currently yes (`audit.read`) | ❓ Product decision needed |
| Should Manager be able to view Anomalies? Currently yes (`anomalies.read`) but Viewer cannot | ❓ Asymmetric — viewer lacks `anomalies.read` |
| Should Viewer be able to view Billing? Currently no (org_admin min-role) | ❓ Product decision needed |

---

## 16. Missing Capabilities

| Capability | Current State | Priority |
|-----------|---------------|----------|
| Invitation system (email invite + token acceptance) | Schema supports `INVITED` status; no API/UI implements it | Medium |
| Forgot-password flow | No self-service password reset | Medium |
| Org Admin membership suspension | Org Admin can only toggle global `isActive`; cannot suspend at membership level | Low |
| Org Admin add existing user to org | Only create-new-user model; cannot search/add existing users | Low |
| Custom roles | Not supported; only 4 hardcoded roles | Low (if needed) |
| Per-user permission overrides | Not supported; strictly role-based | Low (if needed) |
| Manager delete employees/projects | Missing `employees.delete` and `projects.delete` permissions | Product decision |
| Viewer audit/anomaly access | Viewer lacks `audit.read` and `anomalies.read` | Product decision |

---

## 17. Security Risks

### 17.1 Stale JWT Role Window (Low Risk)

**Risk:** If a user's org role is downgraded in the DB but they still hold a valid JWT, they retain the higher role until the JWT expires or is refreshed.

**Mitigation:**
- Member-management routes (add/change/remove members) use `resolveActorDbRole()` which reads from DB
- All other routes verify ACTIVE membership from DB
- Role changes trigger session revocation (closes the window for new tokens)

**Remaining exposure:** General API routes (e.g., `PUT /api/settings/monitoring`) accept the JWT role for authorization. A stale JWT with `org_admin` role could theoretically access admin-only routes after demotion to `manager`.

### 17.2 `getSessionOrg` Without Active-Status Check (Low Risk)

**Risk:** 22 routes use `getSessionOrg` which does NOT verify `org.status === 'active'` or membership status. It only checks JWT validity.

**Mitigation:** The proxy middleware (`src/proxy.ts`) performs JWT authentication before any route executes. Paused/archived orgs are blocked at `requireActiveSessionOrg` level for most routes. Routes using `getSessionOrg` are read-only (insights, sentiment summary, etc.).

### 17.3 No Other Security Risks Found

The tenant isolation architecture is defense-in-depth with multiple independent enforcement layers. All org-scoped queries use server-derived `organizationId`. Cross-org access is prevented at every layer. Fail-closed patterns are consistently applied.

---

## 18. Organization ID Naming Inconsistencies

### 18.1 Current State (Post-Recent Cleanup)

| Location | Convention | Status |
|----------|-----------|--------|
| Prisma schema FK | `organizationId` | ✅ Canonical |
| Auth helpers return | `scope.organizationId` | ✅ Canonical |
| API route local variables | `orgId` (72 occurrences) | ✅ Canonical |
| Frontend variables | `orgId` | ✅ Canonical |
| Route segments: `api/organizations/` | `[orgId]` | ✅ Consistent |
| Route segments: `api/admin/organizations/` | `[orgId]` | ✅ Consistent |
| Route segments: `api/super-admin/organizations/` | `[orgId]` | ✅ Consistent (recently fixed) |
| Non-org entity routes | `[id]` | ✅ Correct (devices, employees, etc.) |

### 18.2 Remaining Inconsistencies

**None found.** The recent cleanup resolved the `[id]` vs `[orgId]` conflict in `super-admin/organizations/` routes. All organization routes now consistently use `[orgId]`.

---

## 19. Recommended Decisions Requiring Product Approval

### Decision 1: Invitation System

**Question:** Should OmniSight implement an email invitation flow for adding users to organizations?

**Current state:** Org Admin can create new users and add them directly. No email invite with token acceptance.

**Schema support:** `OrganizationMembership.status` supports `"INVITED"` but no API uses it.

**Recommendation:** Implement invitation flow if the product requires collaborative onboarding.

### Decision 2: Password Reset

**Question:** Should OmniSight implement self-service forgot-password via email?

**Current state:** No forgot-password flow. Admins can reset passwords. Users can change their own password if they know the current one.

### Decision 3: Manager Permission Scope

**Question:** Should Managers be able to:
- Delete employees/projects? (Currently: Create/Edit only)
- View audit logs? (Currently: Yes)
- View anomalies? (Currently: Yes, but Viewers cannot — asymmetric)

**Current gap:** Manager has `audit.read` and `anomalies.read` but lacks `employees.delete` and `projects.delete`.

### Decision 4: Viewer Billing Access

**Question:** Should Viewers be able to view billing/subscription information?

**Current state:** Billing page requires `org_admin` minimum.

### Decision 5: Org Admin Membership Suspension

**Question:** Should Org Admins be able to suspend/reactivate members at the membership level (not just global `isActive`)?

**Current state:** Org Admin can toggle `AppUser.isActive` (global). Only Super Admin can set `OrganizationMembership.status = "SUSPENDED"`.

### Decision 6: Custom Roles

**Question:** Does the product need custom role support?

**Current state:** 4 hardcoded roles (super_admin, org_admin, manager, viewer). No dynamic permission assignment.

### Decision 7: Per-User Permissions

**Question:** Does the product need per-user permission overrides?

**Current state:** Strictly role-based. All users with the same role have identical permissions.

---

*End of audit report. No code, schema, database, UI, routes, permissions, or documentation were modified.*
