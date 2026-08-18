# WorkLensAI — Clean Production Bootstrap Audit

**Phase:** Clean production database + Super Admin organization bootstrap
**Date:** 2026-08-10
**Database:** PostgreSQL (`workai`)
**Status:** ✅ FIXED — org-less Super Admin can now create the first organization

---

## 1. Root cause of "No organization found"

After the demo-data cleanup removed all organizations, the org-less Super Admin was
stuck in a dead end:

1. **`POST /api/organizations` did not exist.** The route only implemented `GET`
   (a filter-dropdown list). There was no server path to create an organization at all.
2. **The org-scoped read (`GET /api/organization`) correctly returned 404** for an
   org-less session (`getSessionOrg` → null → "No organization found") — that was the
   exact message on the Organization page, but the UI had **no "Create Organization"
   alternative**.
3. **The Super Admin session was intentionally org-less by design** (login derives the
   org strictly from `AppUser.organizationId`, never a `findFirst()` fallback — tenant
   isolation). That part was correct; the missing piece was the bootstrap-creation path.

**The bug was a missing feature (no first-organization creation flow), not a broken
auth/session mechanism.**

---

## 2. Files changed

| File | Change |
|---|---|
| `src/app/api/organizations/route.ts` | **Added `POST`** — super-admin-only first-organization creation: name validation (2–100 chars), server-derived slug, case-insensitive duplicate check (409), transactional create + Super Admin binding + audit log, JWT re-sign with the new org context (cookie + response). Org-bound sessions are rejected (403) — no silent context re-bind. P2002 race → 409. Rate limited. |
| `src/components/auth/create-organization-screen.tsx` | **New** — org-less Super Admin bootstrap screen ("Create your organization"), posts to `/api/organizations`, updates the auth store with the re-signed session, then the normal (empty) Admin control plane loads. |
| `src/app/page.tsx` | `AuthGuard` renders `CreateOrganizationScreen` for `role === 'super_admin' && !organization` (after login/hydration) instead of the org-scoped layout. |
| `src/lib/rate-limit.ts` | Added `orgCreate: { limit: 10, windowMs: 60_000 }` — dedicated limit for the bootstrap path. |
| `src/lib/store.ts` | (Review cleanup: no dead `updateOrg` — the create screen uses the existing `login()`, which sets token + org.) |
| `tests/organization-bootstrap.test.ts` | **New** — 14-test regression suite (see §5). |

**Untouched by design:** zero-touch discovery/approval/auth, consent system (8 types,
fail-closed, approval ≠ consent), device lifecycle, Admin RBAC, org isolation semantics,
`prisma migrate deploy` workflow, legacy agent auth.

---

## 3. Super Admin bootstrap behavior

- Credentials come **only** from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` (env).
- `scripts/bootstrap-super-admin.ts` is idempotent: creates once, never overwrites the
  password on restart, creates **no** demo org/employees/departments/projects/devices.
- After bootstrap the Super Admin is **org-less** (by design). Login succeeds; the
  AuthGuard routes to the Create-Organization screen.

## 4. First-Organization creation flow (verified)

```
Fresh DB (0 orgs)
  → migrations
  → bootstrap Super Admin (env)
  → login  (org-less, 200, organization: null)
  → Create-Organization screen
  → POST /api/organizations { name }
      → 201: org created + Super Admin bound (AppUser.organizationId)
      → fresh JWT + httpOnly cookie carry organizationId
  → AuthGuard now sees an organization → normal Admin control plane
  → /api/organization 200 (was 404)
  → dashboard loads; Employees/Departments/Projects/Devices = 0 (valid empty state)
  → employees/departments/projects can be created org-scoped
```

Security rules enforced:
- Only **org-less** `super_admin` may create (org-bound → 403; admin/manager/viewer → 403; unauthenticated → 401).
- Duplicate name (case-insensitive) → 409.
- Organization identity in every later request derives from the verified JWT only — never a client field.
- No demo data is created anywhere in the flow.

## 5. Tests executed

| Suite | Count | Result |
|---|---|---|
| `organization-bootstrap.test.ts` (new) | 14 | ✅ 14/14 (bootstrap state, org-less login, 404-before-create, first-org 201, audit log, dup 409, bound-SA 403, non-SA 403, 401, JWT carries org, org-scoped read 200, dashboard 200, dept+employee+project creation, no demo data) |
| `super-admin.test.ts` | 18 | ✅ 18/18 |
| `zero-touch.test.ts` | 29 | ✅ PASS |
| `consent.test.ts` | 27 | ✅ PASS |
| `projects.test.ts` | 17 | ✅ PASS |
| `security.test.ts` | 28 | ✅ PASS |
| **Backend total** | **133** | ✅ **133/133** |
| Admin `npx tsc --noEmit` | — | ✅ clean |
| Admin `npm run build` | — | ✅ compiled successfully |
| Desktop agent `npm run test:src` | 123 | ✅ 123/123 |

## 6. Live smoke test (against the running server, PostgreSQL)

```
org count before            → 0
login                       → role=super_admin, org=org-less
POST /api/organizations     → 201, slug=worklens-test-org, token re-sent
GET /api/organization       → 200, org details returned (no more 404)
duplicate name (lowercase)  → 409
cleanup                     → org removed, super admin unbound, org count back to 0
```

## 7. Zero-touch / consent regressions

Unaffected — the full suites still pass against PostgreSQL. Device approval still
creates zero consent rows; no-consent uploads still return 403.

## 8. Remaining issues

- The dashboard API route remains **globally unscoped** (pre-existing, outside this
  phase) — with a single org it returns correct data; multi-tenant dashboard scoping is
  tracked separately.
- Org-bound Super Admins cannot create additional organizations (intentional 403 —
  prevents silent context re-bind). A future multi-org management flow (explicit org
  switching) would be a separate feature.
- Test suites use `prisma db push` for throwaway test DBs; production deploys with
  `prisma migrate deploy` (unchanged).

## 9. Acceptance criteria — final state

✅ Fresh DB → migrations → Super Admin bootstrap from ENV → org-less login → Create Organization → normal Admin control plane → empty Employees/Departments/Projects/Devices → real data appears only when created/discovered. **Zero demo business data.**
