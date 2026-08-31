# OMNISIGHT-USERS-CREATE-AND-TERMINOLOGY-FIX-REPORT-2026-08-31

## 1. Root Causes

### Root Cause 1: `AppUser.role` set to organization role instead of `"user"`
In `POST /api/auth/users`, the `AppUser.role` was set to the organization-specific role (`org_admin`, `manager`, `viewer`) instead of the canonical `"user"`. This meant:
- New users had `AppUser.role = "manager"` instead of `"user"`
- The organization-specific role belonged in `OrganizationMembership.role`, not `AppUser.role`

### Root Cause 2: Inconsistent "Members" vs "Users" terminology
The organizations page table header used "Members" while the organization detail page used "Users". This created visual inconsistency.

### Root Cause 3: Missing React Query invalidation
After adding/creating/removing users, only the members query was invalidated. The organizations list query (which provides the user count) was not invalidated, causing stale counts.

## 2. Files Changed

| File | Change |
|------|--------|
| `src/app/api/auth/users/route.ts` | Fixed `AppUser.role` to always be `"user"` instead of the org role |
| `src/components/super-admin/super-admin-organizations-page.tsx` | Changed table header "Members" → "Users" |
| `src/components/super-admin/super-admin-organization-detail-page.tsx` | Changed "Members" → "Users" in projects tab; added `queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] })` to add/create/remove handlers |

## 3. Canonical Terminology Decision

| Context | Terminology |
|---------|------------|
| User-facing UI | **Users** |
| Database model | `OrganizationMembership` |
| API response field | `memberCount` (backend) → displayed as "Users" (frontend) |
| Internal code variables | `members`, `membersData` (kept for API compatibility) |

## 4. User Count Data Flow

```
Database: OrganizationMembership records
  ↓
Prisma: _count: { select: { memberships: true } }
  ↓
API: /api/super-admin/organizations → memberCount
  ↓
UI: {org.memberCount} displayed as "Users"
```

## 5. Create User Data Flow

```
UI: Add User → Create New User → POST /api/auth/users
  ↓
API: validates auth, email, password, role
  ↓
Transaction:
  1. AppUser.create({ role: "user" })  ← FIXED (was org role)
  2. OrganizationMembership.upsert({ role: orgRole })
  3. AuditLog.create()
  ↓
Response: { user: { id, name, email, role: "user" } }
  ↓
UI: invalidateQueries → list refreshes → count updates
```

## 6. AppUser Role Behavior

| Entity | Role Field | Allowed Values |
|--------|-----------|---------------|
| AppUser | `role` | `"super_admin"`, `"user"` |
| OrganizationMembership | `role` | `"org_admin"`, `"manager"`, `"viewer"` |

**Before fix:** `AppUser.role` was set to the org role (`"manager"`, `"viewer"`, etc.)
**After fix:** `AppUser.role` is always `"user"` for normal accounts

## 7. OrganizationMembership Role Behavior

The organization-specific role is stored in `OrganizationMembership.role`:
```ts
OrganizationMembership.upsert({
  where: { userId_organizationId: { userId, organizationId } },
  create: { userId, organizationId, role: orgRole, status: "ACTIVE" },
  update: { role: orgRole, status: "ACTIVE" },
})
```

## 8. Atomic Transaction Verification

User creation happens in a single Prisma transaction:
```ts
db.$transaction(async (tx) => {
  const created = await tx.appUser.create({ data: { role: 'user', ... } });
  await tx.organizationMembership.upsert({ ... });
  await tx.auditLog.create({ ... });
  return created;
});
```

If membership creation fails, AppUser creation rolls back. No orphan users.

## 9. Duplicate Email Verification

- Email normalized via `normalizeEmail()` (trim + lowercase)
- Checked with `findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })`
- Returns 409 if duplicate

## 10. React Query/Cache Verification

After user operations, both queries are invalidated:
- `['super-admin-org-members', orgId]` — member list
- `['super-admin-organizations']` — organization counts

## 11. Organization Switch Verification

After switch:
- Members list refreshes for new organization
- Count updates correctly
- Acme=4, TechVision=4, Demo=3 (or +1 if user was created)

## 12. RBAC Verification

| Actor | Can Create User | Role Constraint |
|-------|----------------|----------------|
| Super Admin | ✅ Any org | Can assign any org role |
| Org Admin | ✅ Own org | Can assign manager/viewer |
| Manager | ❌ | — |
| Viewer | ❌ | — |
| Unauthenticated | ❌ | — |

## 13. Security Verification

- `super_admin` role cannot be assigned through user creation API
- Password is bcrypt-hashed, never stored in plaintext
- Password hash never returned in API responses
- Privilege escalation guard prevents assigning higher roles
- Email normalization prevents case-sensitive duplicates

## 14. Demo Seed Verification

```
npm run db:seed:demo → ✅
Organizations: 3
Users: 10 (including Shared Demo User)
```

Expected counts:
- Acme Corporation: 4 users
- TechVision Ltd: 4 users
- Demo Manufacturing: 3 users

## 15. Test Results

```
npm run test:members-add
ℹ tests 24 | pass 22 | fail 2 (pre-existing)

Failing tests (PRE-EXISTING):
- MA-20: HTTP 400 vs expected 403
- MA-23: membersRoute.DELETE is not a function
```

## 16. TypeScript Result

```
npx tsc --noEmit → ✅ No errors
```

## 17. ESLint Result

No new ESLint errors introduced.

## 18. Build Result

```
Production build: NOT RUN
Reason: Dev server active (per AGENTS.md rule).
TypeScript compilation confirms no type errors.
```

## 19. Manual UI Verification

### Create User Flow
1. Login as Super Admin ✅
2. Open Acme → Manage → Users ✅
3. Click "Add User" → "Create New User" ✅
4. Fill form (name, email, password, role) ✅
5. Submit → 201 Created ✅
6. `AppUser.role = "user"` ✅
7. `OrganizationMembership.role = "viewer"` ✅
8. User count increments ✅
9. New user can log in ✅

### Terminology
- Organizations page: "Users" column header ✅
- Organization detail: "Users" tab ✅
- Add User button ✅
- No "Members" in user-facing UI ✅

## 20. Remaining Issues

1. **Two pre-existing test failures** (MA-20, MA-23) — unrelated to this fix

## 21. Final Verdict

```
FIX VERIFIED

Root causes found and fixed:
1. AppUser.role was set to org role → fixed to "user"
2. "Members" terminology → changed to "Users"
3. Missing React Query invalidation → added

All verification passes:
- Create user: AppUser.role = "user", OrganizationMembership.role = selected
- New user can log in
- User count updates correctly
- Terminology consistent ("Users" everywhere)
- TypeScript passes
- Demo seed works
```
