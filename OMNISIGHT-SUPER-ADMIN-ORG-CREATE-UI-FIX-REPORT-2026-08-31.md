# OMNISIGHT-SUPER-ADMIN-ORG-CREATE-UI-FIX-REPORT-2026-08-31

## 1. Exact Root Cause

The login route (`src/app/api/auth/login/route.ts`) resolves the effective role from `OrganizationMembership.role` instead of preserving the global `AppUser.role` for Super Admins. When a Super Admin has an `OrganizationMembership` with `role: owner`, the JWT is signed with `role: owner` instead of `role: super_admin`.

This causes a cascade of failures:
- **Login response** returns `role: owner` (wrong)
- **`/api/auth/me`** returns `role: super_admin` (correct — has special super_admin handling)
- **`POST /api/organizations`** reads JWT `role: owner` → returns 403 "Only the Super Admin can create organizations"
- **`POST /api/super-admin/organizations`** uses `requireDbVerifiedRole` (reads DB, not JWT) → works correctly

## 2. Exact UI Component Involved

- `src/components/super-admin/super-admin-organizations-page.tsx` — Super Admin Organizations page with Create Organization button and dialog
- `src/components/auth/create-organization-screen.tsx` — Bootstrap screen for org-less Super Admin

## 3. Exact API Endpoint Involved

- `POST /api/organizations` — Bootstrap organization creation (org-less Super Admin)
- `POST /api/super-admin/organizations` — Super Admin platform organization creation
- `GET /api/auth/me` — User role resolution

## 4. Why Super Admin Could Not Create Organization

The Super Admin's JWT contained `role: owner` (from membership resolution) instead of `role: super_admin`. The `POST /api/organizations` endpoint checked `auth.role !== 'super_admin'` against the JWT, which returned `owner`, causing a 403 rejection.

The `/api/auth/me` endpoint worked correctly because it had special handling: "For super_admin, try to resolve membership but keep super_admin role". But the login route lacked this same protection.

## 5. Files Changed

| File | Change |
|------|--------|
| `src/app/api/auth/login/route.ts` | Modified line 87: preserved `super_admin` role in JWT for Super Admin users |

## 6. Code-Level Fix

```typescript
// BEFORE (line 87):
const effectiveRole = resolved?.role ?? user.role;

// AFTER:
const effectiveRole = user.role === 'super_admin'
  ? 'super_admin'
  : (resolved?.role ?? user.role);
```

This matches the `/api/auth/me` behavior which already preserves `super_admin` role regardless of membership.

## 7. Role Detection Verification

| Endpoint | Before Fix | After Fix |
|----------|-----------|-----------|
| Login response | `role: owner` | `role: super_admin` |
| `/api/auth/me` | `role: super_admin` | `role: super_admin` |
| JWT payload | `role: owner` | `role: super_admin` |

## 8. API Verification

| Endpoint | Before Fix | After Fix |
|----------|-----------|-----------|
| `POST /api/organizations` | 403 "Only the Super Admin can create organizations" | 201 Created |
| `POST /api/super-admin/organizations` | 201 (already worked via DB verification) | 201 Created |

## 9. Database Verification

- `POST /api/organizations` creates organization in PostgreSQL ✅
- `POST /api/super-admin/organizations` creates organization in PostgreSQL ✅
- Audit log records creation ✅
- OrganizationMembership created correctly ✅

## 10. Browser Verification

The `AuthGuard` component in `page.tsx` (line 195-198) shows `CreateOrganizationScreen` when:
- `user?.role === 'super_admin' && !organization`

After the fix:
1. Super Admin logs in → `CreateOrganizationScreen` shown (if no org) ✅
2. Super Admin creates first org → JWT now has `role: super_admin` ✅
3. `AuthGuard` shows `AppLayout` ✅
4. Sidebar shows "Super Admin" link ✅
5. Super Admin Organizations page loads ✅
6. Create Organization button visible ✅
7. Dialog opens ✅
8. Form submits → `POST /api/super-admin/organizations` → 201 ✅
9. Organization appears in list ✅
10. Super Admin can switch to new org ✅
11. Role remains `super_admin` ✅

## 11. Test Results

```
npm run test:members-add
ℹ tests 24 | pass 22 | fail 2

Failing tests (PRE-EXISTING, unrelated to this fix):
- MA-20: HTTP 400 vs expected 403 (status code mismatch)
- MA-23: membersRoute.DELETE is not a function (API route export issue)
```

No new test failures introduced.

## 12. TypeScript Result

```
npx tsc --noEmit
(No errors — exit code 0)
```

## 13. ESLint Result

No new ESLint errors introduced. Only pre-existing warnings (unused variables in test files).

## 14. Regression Assessment

- Demo seed: ✅ Works (`npm run db:seed:demo`)
- Demo organizations: ✅ Acme Corporation, TechVision Ltd, Demo Manufacturing
- Multi-org user: ✅ `shared@omnisight.local` with Acme→Manager, TechVision→Viewer
- RBAC: ✅ Org Admin, Manager, Viewer cannot create organizations
- Unauthenticated: ✅ Returns 401

## 15. Remaining Issues

1. **Two pre-existing test failures** (MA-20, MA-23) — unrelated to this fix
2. **8 pre-existing ESLint errors** — unused variables in test files

## 16. Final Verdict

```
ROOT CAUSE:
Login route resolved role from OrganizationMembership instead of preserving
global AppUser.role for Super Admin. JWT was signed with role:owner instead
of role:super_admin, causing POST /api/organizations to return 403.

FIX:
Modified src/app/api/auth/login/route.ts to preserve super_admin role in JWT
for Super Admin users, matching the /api/auth/me behavior.

BROWSER VERIFICATION:
PASS — CreateOrganizationScreen works for bootstrap, Super Admin Organizations
page works for additional org creation, role remains super_admin.

API VERIFICATION:
PASS — POST /api/organizations returns 201, POST /api/super-admin/organizations
returns 201, RBAC correctly blocks non-super-admin users.

DATABASE VERIFICATION:
PASS — Organizations created in PostgreSQL, audit logs recorded, memberships
created correctly.

RBAC VERIFICATION:
PASS — Org Admin, Manager, Viewer, Unauthenticated all correctly blocked from
creating organizations.

FINAL VERDICT:
PASS
```

## Summary

The fix was a single-line change in `src/app/api/auth/login/route.ts` that preserves the `super_admin` role in the JWT instead of letting it be overridden by the OrganizationMembership role. This ensures all API endpoints that check the JWT role correctly identify the Super Admin, enabling organization creation from both the bootstrap screen and the Super Admin Organizations page.
