# OmniSight RBAC, Login Role & Authorization — Deep Functional Audit

**Date:** 2026-08-27
**Auditor:** Buffy (Codebuff)
**Scope:** Complete RBAC audit — login, JWT, session, frontend display, API authorization

---

## Executive Summary

**CRITICAL RBAC bugs found.** The system has **3 critical bugs** that cause role display and authorization inconsistencies.

### Root Cause

The frontend displays the **wrong role** because `/api/auth/me` returns `AppUser.role` (the legacy global role field) instead of the **membership role** (from `OrganizationMembership`). Additionally, the sidebar has a **hardcoded fallback of "Super Admin"** that shows for ALL users when `roleLabel` is undefined.

### Impact

1. **All accounts may appear as "Super Admin"** in the sidebar when `roleLabel` is not populated
2. **Frontend shows the wrong role** — e.g., a Viewer may see "Admin" because `AppUser.role` is "admin" while the membership role is "viewer"
3. **Seed script creates users without OrganizationMembership records** — breaking the multi-org role model

---

## 1. Database Role Model

### AppUser.role (LEGACY — Deprecated for multi-org)

**File:** `prisma/schema.prisma` line 637
```
role  String  @default("admin") // super_admin, owner, admin, manager, viewer
```

- Default: `"admin"`
- Values: super_admin, owner, admin, manager, viewer
- `organizationId` is nullable (null for super_admin)
- **DEPRECATED** for multi-org: comment says "use OrganizationMembership instead"

### OrganizationMembership.role (AUTHORITATIVE for org-scoped roles)

**File:** `prisma/schema.prisma` line 664
```
role  String  @default("viewer") // owner, admin, manager, viewer
status  String  @default("ACTIVE") // ACTIVE, INVITED, SUSPENDED, REMOVED
```

- Default: `"viewer"`
- Values: owner, admin, manager, viewer
- Scoped to `organizationId`
- Compound unique: `(userId, organizationId)`

### Authoritative Source of Role

| Context | Source | Code Location |
|---------|--------|---------------|
| JWT creation (login) | `resolved?.role ?? user.role` | `src/app/api/auth/login/route.ts` line ~95 |
| JWT creation (refresh) | `membership.role` (DB-verified) | `src/app/api/auth/refresh-token/route.ts` line ~65 |
| JWT creation (org switch) | `membership.role` (DB-verified) | `src/app/api/me/organization/switch/route.ts` |
| `/api/auth/me` response | `adminUser.role` (AppUser.role) | `src/app/api/auth/me/route.ts` line ~55 |
| Frontend display | `displayUser?.roleLabel \|\| 'Super Admin'` | `src/components/layout/app-sidebar.tsx` line 325 |
| API authorization | `auth.role` (from JWT) | `src/lib/api.ts` various helpers |

**CONFLICT:** `/api/auth/me` returns `AppUser.role` while JWT carries `membership.role`. These can differ!

---

## 2. CRITICAL BUG #1: `/api/auth/me` Returns Wrong Role

### File
`src/app/api/auth/me/route.ts`

### Current Code (Line ~55)
```typescript
return NextResponse.json({
  user: {
    id: adminUser.id,
    name: adminUser.name,
    email: adminUser.email,
    role: adminUser.role,  // ❌ Uses AppUser.role, NOT membership role
    roleLabel: roleLabels[adminUser.role] || adminUser.role,
    initials,
    avatar: adminUser.avatar,
    lastLogin: adminUser.lastLogin,
  },
  organization: organization
    ? { id: organization.id, name: organization.name, ... }
    : null,
});
```

### Expected Behavior
Should resolve the active membership and return the membership role, matching the login route's logic:
```typescript
const resolved = await resolveActiveMembership(user.id, user.organizationId);
const effectiveRole = resolved?.role ?? user.role;
```

### Security Impact
**HIGH** — Frontend receives wrong role, displays wrong role, may filter navigation incorrectly.

### Evidence
- Login route: `effectiveRole = resolved?.role ?? user.role` (membership role)
- `/api/auth/me`: `role: adminUser.role` (AppUser.role)
- These are DIFFERENT when membership role ≠ AppUser.role

---

## 3. CRITICAL BUG #2: Sidebar Fallback is "Super Admin"

### File
`src/components/layout/app-sidebar.tsx`

### Current Code (Line 325)
```tsx
<p className="text-[11px] text-muted-foreground truncate">
  {displayUser?.roleLabel || 'Super Admin'}
</p>
```

### Expected Behavior
Should fall back to the actual role or a generic label:
```tsx
{displayUser?.roleLabel || displayUser?.role || 'User'}
```

### Security Impact
**HIGH** — If `roleLabel` is ever undefined/null/empty, ALL users see "Super Admin" in the sidebar.

### When This Triggers
- `displayUser = user || authUser` (line 132)
- `user` comes from `useCurrentUser()` which queries `/api/auth/me`
- `authUser` comes from Zustand store
- If BOTH return data with `roleLabel` set, the fallback is never reached
- But if the Zustand store's `user` is populated without `roleLabel` (e.g., from a stale hydration), the fallback triggers

---

## 4. CRITICAL BUG #3: Seed Script Missing OrganizationMembership

### File
`src/lib/seed-demo.ts`

### Current Code (Lines ~238-244)
```typescript
await db.appUser.createMany({
  data: [
    { email: superAdminEmail, name: 'Super Admin', password: superAdminHash, role: 'super_admin', organizationId: null, isActive: true },
    { email: 'org.admin@acmetech.com', name: 'Jordan Blake', password: demoHash, role: 'admin', organizationId: orgId, isActive: true },
    { email: 'manager@acmetech.com', name: 'Casey Rivera', password: demoHash, role: 'manager', organizationId: orgId, isActive: true },
    { email: 'viewer@acmetech.com', name: 'Pat Morgan', password: demoHash, role: 'viewer', organizationId: orgId, isActive: true },
  ],
  skipDuplicates: true,
});
```

### Problem
Creates AppUser records but **NOT** OrganizationMembership records.

### Impact
- `resolveActiveMembership()` returns null (no membership found)
- JWT falls back to `AppUser.role` (which happens to be correct for seed data)
- But the multi-org membership model is broken for seed users
- If admin changes a membership role later, the system breaks

### Expected
Should also create OrganizationMembership records:
```typescript
await db.organizationMembership.createMany({
  data: [
    { userId: superAdminUser.id, organizationId: org.id, role: 'owner', status: 'ACTIVE' },
    { userId: orgAdminUser.id, organizationId: org.id, role: 'admin', status: 'ACTIVE' },
    { userId: managerUser.id, organizationId: org.id, role: 'manager', status: 'ACTIVE' },
    { userId: viewerUser.id, organizationId: org.id, role: 'viewer', status: 'ACTIVE' },
  ],
});
```

---

## 5. BUG #4: Organization Creation Hardcodes "super_admin" in Response

### File
`src/app/api/organizations/route.ts`

### Current Code (Lines ~180-190)
```typescript
user: {
  id: auth.userId,
  name: user.name,
  email: auth.email,
  role: 'super_admin',  // ❌ Hardcoded!
  roleLabel: 'Super Admin',  // ❌ Hardcoded!
  initials: user.name
    ? user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : 'SA',
  avatar: null,
  lastLogin: null,
},
```

### Problem
After creating an organization, the response **hardcodes** `role: 'super_admin'` in the user object, regardless of the actual user's role.

### Expected
Should use the actual role from the session:
```typescript
role: auth.role,
roleLabel: getRoleLabel(auth.role),
```

---

## 6. Login Flow Trace

### Login Route (`src/app/api/auth/login/route.ts`)

```
1. Find user by email (AppUser)
2. Verify password (bcrypt)
3. resolveActiveMembership(userId, legacyOrgId)
   → Returns { organizationId, role } from OrganizationMembership
   → Falls back to AppUser.role if no membership
4. effectiveRole = resolved?.role ?? user.role
5. Create UserSession
6. Sign JWT with:
   - userId: user.id
   - email: user.email
   - role: effectiveRole  ← MEMBERSHIP ROLE
   - organizationId: activeOrgId
   - activeOrganizationId: activeOrgId
   - sessionId
7. Return response with:
   - token (JWT)
   - user.role: effectiveRole  ← CORRECT
   - user.roleLabel: roleLabels[effectiveRole]  ← CORRECT
   - organization
```

### Refresh Token Route (`src/app/api/auth/refresh-token/route.ts`)

```
1. Verify existing JWT + session
2. Find user (AppUser)
3. If user.role !== 'super_admin':
   - Find OrganizationMembership for activeOrgId
   - Verify membership.status === 'ACTIVE'
   - effectiveRole = membership.role  ← DB-VERIFIED MEMBERSHIP ROLE
4. Sign new JWT with effectiveRole
5. Return response with:
   - user.role: effectiveRole  ← CORRECT
   - user.roleLabel: getRoleLabel(effectiveRole)  ← CORRECT
```

### `/api/auth/me` Route (`src/app/api/auth/me/route.ts`)

```
1. Verify JWT + session
2. Find user (AppUser)
3. Return response with:
   - user.role: adminUser.role  ← ❌ WRONG (AppUser.role, not membership role)
   - user.roleLabel: roleLabels[adminUser.role]  ← ❌ WRONG
```

**CONFLICT:** Login and refresh return `membership.role`, but `/api/auth/me` returns `AppUser.role`!

---

## 7. Authorization Helpers Analysis

### `authenticateRequest(req)` — `src/lib/api.ts`

```typescript
export async function authenticateRequest(req: NextRequest): Promise<AuthContext | null> {
  const token = extractToken(req) || req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token);  // JWT + session recheck
  return {
    userId: payload.userId,
    email: payload.email,
    role: payload.role,  // ← FROM JWT (membership role)
    organizationId: payload.organizationId,
    activeOrganizationId: payload.activeOrganizationId,
  };
}
```

**Role comes from JWT** — which carries `membership.role` (correct).

### `requireSuperAdmin(req)` — `src/lib/api.ts`

```typescript
export async function requireSuperAdmin(req: NextRequest): Promise<SuperAdminResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401 };
  if (auth.role !== 'super_admin') return { ok: false, status: 403 };
  return { ok: true, userId: auth.userId, email: auth.email };
}
```

**Checks:** JWT role === 'super_admin'
**Security:** ✅ Correct — only super_admin passes

### `requireAdminOrg(req)` — `src/lib/api.ts`

```typescript
export async function requireAdminOrg(req: NextRequest): Promise<AdminOrgResult> {
  const r = await requireActiveSessionOrg(req, { minRole: 'admin' });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, organizationId: r.organizationId as string, userId: r.userId, email: r.email };
}
```

**Checks:**
1. Authenticated (JWT valid + session active)
2. Has active organization (org status === 'active')
3. Has active membership for that org
4. Role ≥ admin (super_admin > owner > admin > manager > viewer)

**Security:** ✅ Correct

### `requireManagerOrg(req)` — `src/lib/api.ts`

```typescript
export async function requireManagerOrg(req: NextRequest): Promise<ManagerOrgResult> {
  const r = await requireActiveSessionOrg(req, { minRole: 'manager' });
  // ...
}
```

**Checks:** Role ≥ manager
**Security:** ✅ Correct

### `requireDbVerifiedRole(req)` — `src/lib/api.ts`

```typescript
export async function requireDbVerifiedRole(req: NextRequest, opts): Promise<DbVerifiedRoleResult> {
  const auth = await authenticateRequest(req);
  // ...
  const dbUser = await db.appUser.findUnique({ where: { id: auth.userId }, select: { role: true } });
  // Reject if DB role is weaker than JWT claims
  if (opts.requireSuperAdmin && dbUser.role !== 'super_admin') return { ok: false, status: 403 };
}
```

**Checks:** DB-verified role (not just JWT)
**Security:** ✅ Correct — closes JWT/DB role drift window

### `requireOrgAdmin(req, targetOrgId)` — `src/lib/api.ts`

```typescript
export async function requireOrgAdmin(req: NextRequest, targetOrgId: string, minRole = 'admin'): Promise<OrgAdminResult> {
  const auth = await authenticateRequest(req);
  if (auth.role === 'super_admin') return { ok: true, ... }; // super_admin passes
  const callerOrg = auth.activeOrganizationId || auth.organizationId;
  if (!callerOrg || callerOrg !== targetOrgId) return { ok: false, status: 403 };
  if (!hasRolePermission(auth.role, minRole)) return { ok: false, status: 403 };
}
```

**Checks:**
1. super_admin → passes (global authority)
2. Non-super_admin → must be in same org AND role ≥ minRole
**Security:** ✅ Correct

---

## 8. Role Hierarchy

From `src/lib/auth.ts`:
```typescript
export function hasRolePermission(userRole: string, requiredRole: string): boolean {
  const hierarchy: Record<string, number> = {
    super_admin: 50,
    owner: 40,
    admin: 30,
    manager: 20,
    viewer: 10,
  };
  return (hierarchy[userRole] || 0) >= (hierarchy[requiredRole] || 0);
}
```

**Hierarchy:** super_admin (50) > owner (40) > admin (30) > manager (20) > viewer (10)

---

## 9. API RBAC Matrix

### Routes Tested

| Route | Method | Auth Helper | Super Admin | Org Admin | Manager | Viewer |
|-------|--------|-------------|-------------|-----------|---------|--------|
| `/api/super-admin/organizations` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations` | POST | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations/[id]` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations/[id]/employees` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations/[id]/devices` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations/[id]/projects` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations/[id]/audit-logs` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/super-admin/organizations/[id]/memberships` | GET | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/employees` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/employees` | POST | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/devices` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/devices` | POST | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/projects` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/projects` | POST | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/activities` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/screenshots` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/reports` | GET | `requireManagerOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ❌ 403 |
| `/api/reports` | POST | `requireManagerOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ❌ 403 |
| `/api/settings` | GET | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/settings` | PUT | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/ai-provider/test-connection` | POST | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/auth/users` | GET | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/auth/users` | POST | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/organizations` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/organizations` | POST | `requireSuperAdmin` | ✅ ALLOW | ❌ 403 | ❌ 403 | ❌ 403 |
| `/api/audit-logs` | GET | `requireManagerOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ❌ 403 |
| `/api/analytics` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/consent` | GET | `requireManagerOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ❌ 403 |
| `/api/app-list` | GET | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/notifications` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/alerts` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/anomalies` | GET | `requireSessionOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW |
| `/api/export/[type]` | GET | `requireManagerOrg` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ❌ 403 |
| `/api/audio` | POST | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |
| `/api/audio` | GET | `requireAdminOrg` | ✅ ALLOW | ✅ ALLOW | ❌ 403 | ❌ 403 |

---

## 10. Navigation Filtering

### `src/lib/navigation.ts`

```typescript
export const PAGE_MIN_ROLE: Record<PageType, NavMinRole> = {
  dashboard: 'viewer',
  employees: 'viewer',
  devices: 'viewer',
  activities: 'viewer',
  analytics: 'viewer',
  audit: 'manager',
  screenshots: 'viewer',
  reports: 'manager',
  settings: 'admin',
  organization: 'admin',
  'super-admin-organizations': 'admin',  // But canAccessPage restricts to super_admin
  // ...
};
```

### `canAccessPage()` Special Case
```typescript
if (page === 'super-admin-organizations' || page === 'super-admin-organization-detail') {
  return role === 'super_admin';  // EXACTLY super_admin, not admin+
}
```

**Super Admin page requires EXACTLY `super_admin` role** — not just admin+ hierarchy.

---

## 11. Session & Role Revalidation

### `src/lib/session.ts`

```typescript
export async function verifySessionToken(token: string): Promise<JWTPayload | null> {
  const payload = await verifyJWT(token);
  if (!payload) return null;
  if (!payload.sessionId) return payload;  // Legacy stateless token
  const active = await isWebSessionActive(payload.sessionId);
  if (!active) return null;
  const orgMatch = await verifySessionActiveOrg(payload.sessionId, payload.activeOrganizationId);
  return orgMatch ? payload : null;
}
```

**Checks:**
1. JWT signature valid
2. JWT not expired
3. Session row exists (if sessionId present)
4. Session not revoked
5. Session not expired
6. activeOrganizationId matches session's server-authoritative value

**Security:** ✅ Correct — revoked sessions are rejected even with valid JWT

### Role Change Invalidation

When a role is changed:
1. The JWT still carries the old role until refresh
2. `requireDbVerifiedRole()` re-checks from DB for sensitive operations
3. Refresh token route re-resolves from membership DB
4. Old JWT expires after `JWT_EXPIRES_IN` (default 7d)

**Gap:** For non-sensitive operations using JWT role, there's a window where old role persists until JWT expiry. This is mitigated by `requireDbVerifiedRole()` for sensitive mutations.

---

## 12. Privilege Escalation Protection

### Client-Supplied Role Test

Search for `{ role: "super_admin" }` in request bodies:

| Endpoint | Accepts Role from Client? | Server Validates? |
|----------|---------------------------|-------------------|
| `/api/auth/users` POST | Yes (creates user with role) | ✅ Yes — checks assigner's role ≥ target role |
| `/api/auth/users/[id]` PATCH | Yes (updates user role) | ✅ Yes — checks assigner's role ≥ target role |
| `/api/settings` PUT | No (key/value only) | ✅ Requires super_admin |
| `/api/ai-provider/test-connection` | No | ✅ Requires super_admin |

**Security:** ✅ Correct — admin cannot create super_admin, manager cannot create admin

### Org Switching + Role

When switching organizations:
1. `POST /api/me/organization/switch` re-resolves membership
2. New JWT carries the membership role for the new org
3. Old JWT's `activeOrganizationId` is invalidated (P2-01)

**Security:** ✅ Correct — role changes with org context

---

## 13. Final Role Table

| Account Type | AppUser.role | OrganizationMembership.role | JWT Role | /api/auth/me Role | UI Display | Expected | Status |
|--------------|--------------|----------------------------|----------|-------------------|------------|----------|--------|
| Super Admin | super_admin | null (no membership) | super_admin | super_admin | Super Admin | super_admin | ✅ CORRECT |
| Org Admin | admin | admin (if membership exists) | admin | admin | Admin | admin | ⚠️ DEPENDS ON BUG #3 |
| Manager | manager | manager (if membership exists) | manager | manager | Manager | manager | ⚠️ DEPENDS ON BUG #3 |
| Viewer | viewer | viewer (if membership exists) | viewer | viewer | Viewer | viewer | ⚠️ DEPENDS ON BUG #3 |

**Note:** The seed script (BUG #3) does NOT create OrganizationMembership records. So `resolveActiveMembership()` returns null, and the JWT falls back to `AppUser.role`. This happens to produce the correct result for seed data, but breaks when membership roles are changed.

---

## 14. Score Breakdown

| Category | Score | Evidence |
|----------|-------|----------|
| Database Role Model | 70/100 | Two conflicting role sources (AppUser.role + OrganizationMembership.role) |
| Login Role Resolution | 90/100 | Correctly uses membership role with AppUser fallback |
| JWT Role Integrity | 90/100 | JWT carries membership role (correct) |
| Session Role Integrity | 95/100 | Server-authoritative session revalidation |
| Membership Role Resolution | 60/100 | Seed script missing membership creation |
| Authorization Helpers | 95/100 | All helpers check correctly |
| API RBAC | 90/100 | Routes properly protected |
| Frontend Role State | 50/100 | `/api/auth/me` returns wrong role (BUG #1) |
| Sidebar/UI Authorization | 40/100 | Hardcoded "Super Admin" fallback (BUG #2) |
| Super Admin Isolation | 95/100 | requireSuperAdmin works correctly |
| Privilege Escalation Protection | 90/100 | Server validates role changes |
| Role Change Invalidation | 85/100 | DB-verified for sensitive ops, JWT for others |
| Multi-org Role Switching | 80/100 | Works when membership exists |
| Test Coverage | 70/100 | Tests exist but don't cover membership role scenario |

### Overall RBAC Score: 75/100

---

## 15. Final Verdict

### 1. Does each account receive its correct role after login?
**PARTIAL** — JWT role is correct (membership role), but `/api/auth/me` returns AppUser.role.

### 2. Does the Admin Panel display the correct role?
**NO** — `/api/auth/me` returns wrong role, sidebar has "Super Admin" fallback.

### 3. Is "Super Admin" incorrectly displayed for normal users?
**POSSIBLE** — If `roleLabel` is undefined, the sidebar fallback shows "Super Admin".

### 4. Can Org Admin access Super Admin APIs?
**NO** — `requireSuperAdmin()` correctly rejects non-super_admin roles.

### 5. Can Manager access Admin-only APIs?
**NO** — `requireAdminOrg()` correctly requires admin+ role.

### 6. Can Viewer perform mutations?
**NO** — All mutation endpoints require manager+ or admin+ role.

### 7. Is role derived correctly from OrganizationMembership?
**PARTIAL** — Login and refresh use membership role, but `/api/auth/me` uses AppUser.role.

### 8. Is JWT role trustworthy and correctly generated?
**YES** — JWT carries membership role (correct).

### 9. Is session role correctly revalidated?
**YES** — Server-authoritative session revalidation works.

### 10. Does organization switching correctly change permissions?
**YES** — When membership exists, role changes with org context.

### 11. Is there any privilege escalation vulnerability?
**NO** — Server validates all role changes.

### 12. Is Super Admin truly platform-level?
**YES** — `requireSuperAdmin()` checks JWT role === 'super_admin'.

### 13. Are all intended permissions actually enforced server-side?
**YES** — API RBAC is correct. Frontend display is wrong.

---

## 16. Required Fixes

### Fix #1 (CRITICAL): `/api/auth/me` should return membership role

**File:** `src/app/api/auth/me/route.ts`

**Change:**
```typescript
// BEFORE (line ~55):
role: adminUser.role,
roleLabel: roleLabels[adminUser.role] || adminUser.role,

// AFTER:
const resolved = await resolveActiveMembership(adminUser.id, adminUser.organizationId);
const effectiveRole = resolved?.role ?? adminUser.role;
role: effectiveRole,
roleLabel: roleLabels[effectiveRole] || effectiveRole,
```

### Fix #2 (CRITICAL): Sidebar fallback should not be "Super Admin"

**File:** `src/components/layout/app-sidebar.tsx`

**Change:**
```typescript
// BEFORE (line 325):
{displayUser?.roleLabel || 'Super Admin'}

// AFTER:
{displayUser?.roleLabel || displayUser?.role || 'User'}
```

### Fix #3 (HIGH): Seed script should create OrganizationMembership

**File:** `src/lib/seed-demo.ts`

**Add after creating AppUser records:**
```typescript
// Create OrganizationMembership records
await db.organizationMembership.createMany({
  data: [
    { userId: superAdminUser.id, organizationId: orgId, role: 'owner', status: 'ACTIVE' },
    { userId: orgAdminUser.id, organizationId: orgId, role: 'admin', status: 'ACTIVE' },
    { userId: managerUser.id, organizationId: orgId, role: 'manager', status: 'ACTIVE' },
    { userId: viewerUser.id, organizationId: orgId, role: 'viewer', status: 'ACTIVE' },
  ],
});
```

### Fix #4 (MEDIUM): Organization creation response should not hardcode role

**File:** `src/app/api/organizations/route.ts`

**Change:**
```typescript
// BEFORE (line ~180):
role: 'super_admin',
roleLabel: 'Super Admin',

// AFTER:
role: auth.role,
roleLabel: getRoleLabel(auth.role),
```

---

*Audit complete. The API RBAC is correct. The bugs are in frontend role display and seed data.*
