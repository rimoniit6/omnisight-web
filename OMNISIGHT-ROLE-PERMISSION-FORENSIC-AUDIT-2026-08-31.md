# OMNISIGHT — ORGANIZATION ROLE & PERMISSION FORENSIC AUDIT

## OmniSight — 2026-08-31

### STRICT READ-ONLY AUDIT — NO CODE CHANGES

---

## A. Executive Summary

OmniSight implements a **two-tier role model**: a global platform role (`super_admin`) and three organization-scoped membership roles (`org_admin`, `manager`, `viewer`). The server-side authorization is well-implemented with proper privilege escalation guards, organization boundary enforcement, and tenant isolation.

**One significant UI inconsistency was found**: the `UserManagement` component (Settings → User Management) displays `super_admin` as a selectable role in the role dropdown, but the API correctly rejects it with 400 "Invalid role". The API is MORE restrictive than the UI — a security-positive finding, but a UX issue.

The Super Admin Organization Detail page correctly limits roles to `['org_admin', 'manager', 'viewer']`.

---

## B. Exact Role Inventory

### Global Application Roles (AppUser.role)

| Role | Internal Value | Scope | Source |
|------|---------------|-------|--------|
| Super Admin | `super_admin` | Global platform | `prisma/schema.prisma` — AppUser.role default: `admin` |
| User | `user` | Platform (normal account) | `prisma/schema.prisma` — AppUser.role |

### Organization Membership Roles (OrganizationMembership.role)

| Role | Internal Value | Scope | Source |
|------|---------------|-------|--------|
| Organization Admin | `org_admin` | Own organization | `prisma/schema.prisma` — Membership.role |
| Manager | `manager` | Own organization | `prisma/schema.prisma` — Membership.role |
| Viewer | `viewer` | Own organization | `prisma/schema.prisma` — Membership.role |

### Legacy Roles (mapped for backward compatibility)

| Legacy Value | Maps To | Source |
|-------------|---------|--------|
| `owner` | `org_admin` (level 35) | `src/lib/auth.ts` — hasRolePermission hierarchy |
| `admin` | `org_admin` (level 35) | `src/lib/auth.ts` — hasRolePermission hierarchy |

### Role Count

```
Global roles:        2 (super_admin, user)
Organization roles:  3 (org_admin, manager, viewer)
Legacy aliases:      2 (owner, admin — mapped to org_admin)
Total distinct:      4 effective + 2 legacy aliases
```

---

## C. Global vs Organization Role Model

The architecture correctly separates:

```
GLOBAL ROLE (AppUser.role)
    └── super_admin  ← platform-level authority

ORGANIZATION MEMBERSHIP ROLE (OrganizationMembership.role)
    ├── org_admin    ← full admin within own org
    ├── manager      ← operational within own org
    └── viewer       ← read-only within own org
```

**Source of truth**: `src/lib/org-members.ts` line 10:
```typescript
export const ORG_ROLES = ['org_admin', 'manager', 'viewer'] as const;
```

**Comment explicitly states**: "super_admin is a platform role and is never a per-org membership value."

---

## D. Organization Admin Login Audit

### Login Flow Trace

```
POST /api/auth/login
  → verifyPassword → OK
  → resolveActiveMembership(userId, legacyOrgId)
  → Returns: { organizationId, role } from OrganizationMembership
  → effectiveRole = membership.role (NOT AppUser.role)
  → JWT signed: { role: effectiveRole, activeOrganizationId }
  → Session row created
  → Cookie set
```

### Effective Role Resolution (in /api/auth/me)

```typescript
// For non-super_admin: resolve from membership
if (activeOrgId && adminUser.role !== 'super_admin') {
  const membership = await db.organizationMembership.findUnique({ ... });
  if (membership && membership.status === 'ACTIVE') {
    effectiveRole = membership.role;  // ← Membership role is authoritative
  }
}
```

**Result**: Organization Admin sees `role: 'org_admin'` after login. ✅

### What Org Admin Sees

- **Settings → User Management**: ✅ Visible (canAccessPage: org_admin+ required)
- **Super Admin navigation**: ❌ Hidden (requires exact `super_admin` role)
- **Organization Switcher**: Shows only own org(s) where membership exists

---

## E. Super Admin Login Audit

### Login Flow Trace

```
POST /api/auth/login
  → user.role === 'super_admin'
  → effectiveRole = 'super_admin' (hardcoded, never overridden)
  → JWT signed: { role: 'super_admin' }
```

### Key Code (src/app/api/auth/login/route.ts line ~78)

```typescript
const effectiveRole = user.role === 'super_admin' ? 'super_admin' : (resolved?.role ?? user.role);
```

**Super Admin role is ALWAYS preserved** regardless of membership. ✅

### Super Admin Capabilities

- ✅ Global organization management
- ✅ Organization Switcher shows ALL organizations
- ✅ Organization Detail → Members management
- ✅ Settings → User Management (hidden per requirement)
- ✅ Cross-organization access
- ✅ Role remains `super_admin` after org switch

---

## F. Organization Admin Permissions

### Permission Map (src/lib/permissions.ts)

```typescript
const ORG_ADMIN_PERMISSIONS: OrganizationPermission[] = [
  'organization.read', 'organization.update',
  'organization.settings.read', 'organization.settings.update',
  'organization.members.read', 'organization.members.create',
  'organization.members.update', 'organization.members.delete',
  'employees.read', 'employees.create', 'employees.update', 'employees.delete',
  'guests.read', 'guests.manage',
  'devices.read', 'devices.create', 'devices.update', 'devices.delete',
  'projects.read', 'projects.create', 'projects.update', 'projects.delete',
  'reports.read', 'reports.create', 'audit.read',
  'agents.read', 'agents.manage',
  'audio.read', 'audio.manage',
  'consent.read', 'consent.manage',
  'policies.read', 'policies.manage',
  'alerts.read', 'alerts.manage',
  'anomalies.read', 'anomalies.manage',
  'notifications.read', 'notifications.manage',
  'dashboard.read', 'analytics.read', 'insights.read', 'sentiment.read',
];
```

### Org Admin Capability Matrix

| Capability | Status | Notes |
|-----------|--------|-------|
| View organization | ALLOW | organization.read |
| Edit organization | ALLOW | organization.update |
| Organization settings | ALLOW | organization.settings.update |
| List members | ALLOW | organization.members.read |
| Create users | ALLOW | organization.members.create |
| Change member roles | ALLOW | organization.members.update |
| Remove members | ALLOW | organization.members.delete |
| Manage employees | ALLOW | employees.create/update/delete |
| Manage devices | ALLOW | devices.create/update/delete |
| Manage projects | ALLOW | projects.create/update/delete |
| View reports | ALLOW | reports.read |
| Create reports | ALLOW | reports.create |
| Cross-org access | DENY | Not in permissions |
| Assign super_admin | DENY | Not in validRoles |
| Platform management | DENY | Platform permissions are super_admin only |

---

## G. Manager Permissions

```typescript
const MANAGER_PERMISSIONS: OrganizationPermission[] = [
  'organization.read', 'organization.settings.read',
  'employees.read', 'employees.create', 'employees.update',
  'guests.read', 'guests.manage',
  'devices.read',
  'projects.read', 'projects.create', 'projects.update',
  'reports.read', 'audit.read',
  'agents.read', 'audio.read', 'consent.read', 'policies.read',
  'alerts.read', 'anomalies.read', 'notifications.read',
  'dashboard.read', 'analytics.read', 'insights.read', 'sentiment.read',
];
```

| Capability | Status |
|-----------|--------|
| Organization settings (write) | DENY |
| Member management | DENY |
| Device management (write) | DENY |
| Employee management (delete) | DENY |
| Project management (delete) | DENY |
| Reports (create) | DENY |
| Audit logs | ALLOW (read only) |

---

## H. Viewer Permissions

```typescript
const VIEWER_PERMISSIONS: OrganizationPermission[] = [
  'organization.read', 'organization.settings.read',
  'employees.read', 'devices.read', 'projects.read',
  'reports.read', 'agents.read', 'audio.read', 'consent.read',
  'policies.read', 'alerts.read', 'notifications.read',
  'dashboard.read', 'analytics.read', 'insights.read', 'sentiment.read',
];
```

Viewer is **read-only** for all resources. ✅

---

## I. Super Admin Permissions

```typescript
super_admin: [...PLATFORM_PERMISSIONS, ...ORG_ADMIN_PERMISSIONS],
```

Super Admin gets **ALL platform permissions + ALL organization permissions**.

Platform permissions include:
```typescript
'platform.organizations.read', 'platform.organizations.create',
'platform.organizations.update', 'platform.organizations.delete',
'platform.settings.read', 'platform.settings.update',
'platform.audit.read', 'platform.members.read', 'platform.members.manage',
```

---

## J. Role Assignment Audit

### UI Role Selectors

| Component | Roles Shown | Expected | Status |
|-----------|------------|----------|--------|
| Super Admin Org Detail (Add Member) | org_admin, manager, viewer | org_admin, manager, viewer | ✅ CORRECT |
| Super Admin Org Detail (Change Role) | org_admin, manager, viewer | org_admin, manager, viewer | ✅ CORRECT |
| Settings → User Management (Create/Edit) | super_admin, owner, admin, manager, viewer | org_admin, manager, viewer | ⚠️ INCONSISTENT |

### API Role Validation

| Endpoint | validRoles | Rejects super_admin? | Status |
|----------|-----------|---------------------|--------|
| POST /api/auth/users | ['org_admin', 'manager', 'viewer'] | ✅ Yes (400) | ✅ SECURE |
| PUT /api/auth/users/[id] | ['org_admin', 'manager', 'viewer'] | ✅ Yes (400) | ✅ SECURE |
| POST /api/organizations/[id]/members | isOrgRole() → ['org_admin', 'manager', 'viewer'] | ✅ Yes (400) | ✅ SECURE |
| PATCH /api/organizations/[id]/members/[memberId] | isOrgRole() → ['org_admin', 'manager', 'viewer'] | ✅ Yes (400) | ✅ SECURE |

### Super Admin Assignment Protection

**Multiple layers of defense:**

1. **API validRoles**: `['org_admin', 'manager', 'viewer']` — `super_admin` not in list → 400
2. **isOrgRole()**: Returns false for `super_admin` → 400
3. **canAssignRole()**: `if (actorRole === 'super_admin') return targetRole !== 'super_admin'` — even Super Admin cannot assign super_admin via membership
4. **AppUser creation**: Always sets `role: 'user'` — never `super_admin`

---

## K. Cross-Organization Isolation

### Tenant Isolation Enforcement

**API routes (non-super-admin)**:
```typescript
if (payload.role !== 'super_admin' && payload.organizationId) {
  where.organizationId = payload.organizationId;
}
```

**Membership routes**:
```typescript
const auth = await requireOrgAdmin(req, orgId);
// requireOrgAdmin checks: caller's activeOrganizationId === targetOrgId
```

### Organization Boundary Test

```
User: Organization Admin of Org A
Target: Org B

→ requireOrgAdmin(req, orgB.id)
→ auth.activeOrganizationId = orgA.id
→ orgA.id !== orgB.id → 403 Forbidden ✅
```

### Cross-Organization Access Matrix

| Actor | Own Org | Other Org | Global |
|-------|---------|-----------|--------|
| Super Admin | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| Org Admin | ✅ ALLOW | ❌ DENY | ❌ DENY |
| Manager | ✅ ALLOW | ❌ DENY | ❌ DENY |
| Viewer | ✅ READ | ❌ DENY | ❌ DENY |

---

## L. Super Admin Global Access

### Organization Switch Flow

```
POST /api/me/organization/switch
  → Super Admin: verify org exists and is active → OK
  → New JWT signed with activeOrganizationId = target org
  → Session row updated
  → Cookie set
```

### Role Preservation After Switch

```typescript
// In switch endpoint:
if (auth.role === 'super_admin') {
  jwtRole = 'super_admin'; // ← Preserved, not membership role
}
```

**Super Admin role remains `super_admin` after every switch.** ✅

---

## M. Role Escalation Security

### Defense Layers

1. **API validRoles**: Only `['org_admin', 'manager', 'viewer']` accepted
2. **isOrgRole()**: Single source of truth for assignable roles
3. **canAssignRole()**: Privilege elevation guard
4. **resolveActorDbRole()**: DB-verified role (not JWT)
5. **Self-role-change guard**: Members cannot change their own role
6. **Last Super Admin protection**: Cannot demote the last active Super Admin
7. **Super Admin modification guard**: Only Super Admin can modify Super Admin users

### Escalation Test

```
Actor: Organization Admin (level 35)
Target: Assign super_admin (level 50)

→ API: validRoles check → "super_admin" not in list → 400 ✅
→ Even if bypassed: canAssignRole('org_admin', 'super_admin') → false ✅
→ Even if bypassed: AppUser.role always set to 'user' on creation ✅
```

**Role escalation is protected at multiple layers.** ✅

---

## N. UI vs API Authorization Consistency

### Finding 1: User Management Role Dropdown (MEDIUM)

**UI** (`src/components/auth/user-management.tsx`):
```tsx
<SelectItem value="super_admin">Super Admin</SelectItem>
<SelectItem value="owner">Owner</SelectItem>
<SelectItem value="admin">Admin</SelectItem>
<SelectItem value="manager">Manager</SelectItem>
<SelectItem value="viewer">Viewer</SelectItem>
```

**API** (`POST /api/auth/users`):
```typescript
const validRoles = ['org_admin', 'manager', 'viewer'];
```

**Result**: UI shows 5 options, API accepts 3. Selecting `super_admin`, `owner`, or `admin` in the UI produces a 400 error from the API.

**Severity**: MEDIUM — UX issue, not security issue. The API is MORE restrictive.

### Finding 2: Super Admin Org Detail (PASS)

**UI** (`super-admin-organization-detail-page.tsx`):
```typescript
const ORG_ROLES = ['org_admin', 'manager', 'viewer'] as const;
```

**API** (`POST /api/organizations/[id]/members`):
```typescript
if (!isOrgRole(role)) { return apiError('Invalid role...', 400); }
```

**Result**: UI and API are consistent. ✅

### Finding 3: Navigation Permission (LOW)

**`PAGE_MIN_ROLE`** for `super-admin-organizations`: `'org_admin'`

**`canAccessPage()`**: Has special case:
```typescript
if (page === 'super-admin-organizations' || page === 'super-admin-organization-detail') {
  return role === 'super_admin'; // ← Exact match, not hierarchy
}
```

**Result**: `PAGE_MIN_ROLE` says `org_admin` but `canAccessPage` enforces `super_admin`. The special case takes precedence, so the behavior is correct. But `PAGE_MIN_ROLE` is misleading.

---

## O. Active Organization Interaction

### After Organization Switch

```
Cookie JWT:    activeOrganizationId = OrgA
Session row:   activeOrganizationId = OrgA
Zustand state: organization = OrgA (after hydrate)
AppUser.role:  super_admin (unchanged)
```

### Super Admin with Org Context

```
GET /api/auth/me
  → activeOrgId = OrgA
  → membership lookup → may or may not have membership
  → effectiveRole = 'super_admin' (always preserved)
  → organization = OrgA
```

### Org Admin with Org Context

```
GET /api/auth/me
  → activeOrgId = OrgA
  → membership lookup → role = 'org_admin'
  → effectiveRole = 'org_admin' (from membership)
  → organization = OrgA
```

**No role downgrade for Super Admin.** ✅

---

## P. Database / Prisma Findings

### AppUser Model

```prisma
model AppUser {
  role String @default("admin") // super_admin, owner, admin, manager, viewer
  organizationId String?  // DEPRECATED for multi-org
}
```

**Note**: Default role is `admin` (legacy alias for `org_admin`). New users created via API get `role: 'user'` (not from this default).

### OrganizationMembership Model

```prisma
model OrganizationMembership {
  role String @default("viewer") // owner, admin, manager, viewer
  status String @default("ACTIVE")
}
```

**Note**: Default membership role is `viewer`. Comment says `owner, admin, manager, viewer` but the actual assignable roles are `org_admin, manager, viewer` (enforced by `isOrgRole()`).

### Unique Constraint

```prisma
@@unique([userId, organizationId])
```

Prevents duplicate memberships. ✅

---

## Q. Existing Test Coverage

### Test Files Found

| File | Tests | Coverage |
|------|-------|----------|
| `tests/super-admin.test.ts` | 18 | Bootstrap, login, zero-touch, RBAC |
| `tests/super-admin-hardening.test.ts` | 21 | Super Admin org management, membership CRUD |
| `tests/super-admin-organization-context.test.ts` | 12 | Org-less SA, org count, role preservation |
| `tests/super-admin-detail-members-only.test.ts` | 7 | Org detail is members-only |
| `tests/super-admin-create-member-flow.test.ts` | 20 | Create user flow, P2-01, tenant isolation |
| `tests/super-admin-org-switch-auth.test.ts` | 12 | Org switch auth sync, multi-tab |
| `tests/create-user-flow-integration.test.ts` | 15 | End-to-end create user |
| `tests/demo-data-integrity.test.ts` | 23 | Seed data integrity |

### Coverage Gaps

| Scenario | Covered? | Notes |
|----------|----------|-------|
| Super Admin global access | ✅ | super-admin-hardening.test.ts |
| Org Admin own-org admin | ⚠️ Partial | Implied by membership tests |
| Org Admin cross-org denial | ⚠️ Partial | requireOrgAdmin tested implicitly |
| Manager operational access | ❌ Not directly | |
| Viewer read-only | ❌ Not directly | |
| Role escalation prevention | ⚠️ Implicit | validRoles + canAssignRole tested |
| UI/API consistency | ❌ Not tested | |

---

## R. Missing Regression Tests

1. **Org Admin full CRUD test**: Verify org_admin can create/edit/delete employees, devices, projects within own org
2. **Org Admin cross-org denial test**: Explicitly verify org_admin of Org A gets 403 on Org B resources
3. **Manager limited access test**: Verify manager can read but not delete
4. **Viewer read-only test**: Verify viewer gets 403 on any write operation
5. **Role escalation test**: Explicitly test that org_admin cannot assign super_admin
6. **UI role dropdown consistency test**: Verify UI only shows roles the API accepts

---

## S. Security Findings

### FINDING 1: User Management Shows super_admin in Dropdown

**Severity**: MEDIUM (UX issue, not security bypass)
**File**: `src/components/auth/user-management.tsx`
**Issue**: Role selector shows `super_admin`, `owner`, `admin` but API only accepts `org_admin`, `manager`, `viewer`
**Impact**: Users see options they can't use; API correctly rejects invalid roles
**Root cause**: UI not synchronized with API validRoles

### FINDING 2: PAGE_MIN_ROLE Misleading for Super Admin Pages

**Severity**: LOW (code readability, not security)
**File**: `src/lib/navigation.ts`
**Issue**: `super-admin-organizations: 'org_admin'` but `canAccessPage` enforces `super_admin`
**Impact**: None — special case in `canAccessPage` takes precedence
**Root cause**: Historical artifact; `PAGE_MIN_ROLE` not updated when super-admin pages were restricted

### FINDING 3: AppUser Default Role is 'admin' (Legacy)

**Severity**: INFO (no security impact)
**File**: `prisma/schema.prisma`
**Issue**: `AppUser.role` defaults to `"admin"` (legacy alias), but new users created via API always get `role: 'user'`
**Impact**: Only affects direct DB inserts, not API-created users
**Root cause**: Schema not updated after role model change

---

## T. Severity Classification

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | User Management shows super_admin in role dropdown | MEDIUM | UI/API inconsistency |
| 2 | PAGE_MIN_ROLE misleading for super-admin pages | LOW | Code readability |
| 3 | AppUser default role is legacy 'admin' | INFO | No security impact |

---

## Final Requirement Matrix

| Requirement | Expected | Actual | Status |
|-------------|----------|--------|--------|
| Global role exists | super_admin | super_admin | ✅ PASS |
| Organization roles count | 3 | 3 (org_admin, manager, viewer) | ✅ PASS |
| Organization Admin exists | org_admin | org_admin | ✅ PASS |
| Manager exists | manager | manager | ✅ PASS |
| Viewer exists | viewer | viewer | ✅ PASS |
| Super Admin global access | Yes | Yes | ✅ PASS |
| Org Admin full own-org administration | Yes | Yes | ✅ PASS |
| Org Admin cross-org access | No | No (403 enforced) | ✅ PASS |
| Manager organization administration | No | No (permissions restricted) | ✅ PASS |
| Viewer write access | No | No (read-only permissions) | ✅ PASS |
| Org Admin can assign Super Admin | No | No (validRoles rejects) | ✅ PASS |
| Super Admin downgraded by membership | No | No (role preserved) | ✅ PASS |
| UI/API permission consistency | Yes | ⚠️ User Management UI inconsistent | ⚠️ MINOR |
| Tenant isolation | Enforced | Enforced (org scope in queries) | ✅ PASS |
| Role escalation protection | Enforced | Enforced (multi-layer) | ✅ PASS |
| Active organization integrity | Enforced | Enforced (P2-01, session sync) | ✅ PASS |

---

## Final Verdict

```
============================================================
OMNISIGHT ROLE & PERMISSION FORENSIC AUDIT
============================================================

Role Model:
[PASS] — Clean two-tier model: global (super_admin) + org (org_admin, manager, viewer)

Super Admin Global Authority:
[PASS] — Platform-level, never downgraded by membership

Organization Admin Full Control:
[PASS] — Full admin within own organization

Cross-Organization Isolation:
[PASS] — Enforced at API and query level

Role Escalation Protection:
[PASS] — Multi-layer: validRoles, isOrgRole, canAssignRole, resolveActorDbRole

UI/API Consistency:
[MINOR ISSUE] — User Management shows super_admin in dropdown (API rejects it)

Tenant Isolation:
[PASS] — Non-super-admin users scoped to own organization

P2-01 Session Integrity:
[PRESERVED] — verifySessionActiveOrg unchanged

Settings → User Management (Super Admin):
[PASS] — Hidden for Super Admin

Navigation (Super Admin):
[PASS] — Only super_admin role can access super-admin-* pages

AFFECTED FILES:
src/components/auth/user-management.tsx (UI inconsistency)
src/lib/navigation.ts (PAGE_MIN_ROLE misleading)

SEVERITY:
MEDIUM — One UI inconsistency, no security bypass

SECURITY BYPASS:
NONE — All API endpoints correctly reject super_admin assignment

FINAL STATUS:
PASS WITH MINOR ISSUES — Role/permission model verified

============================================================
```

---

## Recommended Fixes

### Fix 1: User Management Role Dropdown (MEDIUM)

**File**: `src/components/auth/user-management.tsx`

**Current**:
```tsx
<SelectItem value="super_admin">Super Admin</SelectItem>
<SelectItem value="owner">Owner</SelectItem>
<SelectItem value="admin">Admin</SelectItem>
<SelectItem value="manager">Manager</SelectItem>
<SelectItem value="viewer">Viewer</SelectItem>
```

**Recommended**:
```tsx
<SelectItem value="org_admin">Organization Admin</SelectItem>
<SelectItem value="manager">Manager</SelectItem>
<SelectItem value="viewer">Viewer</SelectItem>
```

**Regression test**: Verify role dropdown only shows org_admin, manager, viewer

### Fix 2: PAGE_MIN_ROLE (LOW)

**File**: `src/lib/navigation.ts`

**Current**:
```typescript
'super-admin-organizations': 'org_admin',
'super-admin-organization-detail': 'org_admin',
```

**Recommended**: Remove from `PAGE_MIN_ROLE` entirely since `canAccessPage` has a special case, or document the discrepancy.

**Regression test**: Verify super-admin pages are only accessible to super_admin
