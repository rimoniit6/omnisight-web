# WorkLensAI — Production Data Cleanup & Super Admin Env Bootstrap

**Date:** 2026-08-10 · **Environment:** Windows + local PostgreSQL `workai`
**Phase scope:** remove all demo/test/seed business data, make the Super Admin
bootstrappable exclusively from `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`,
keep the zero-touch + consent + PostgreSQL architecture untouched.

---

## 1. Demo-data sources found

| # | Source | What it creates | Classification |
|---|---|---|---|
| D1 | `src/lib/seed.ts` | Demo org `TechVision Global`, demo users `admin123`/`manager123`/`viewer123`, 40 employees, 30 devices, ~2300 activities, 303 consent logs, 248 consents, alerts, reports, AI insights, notifications, audit logs, monitoring policies, agent registrations, time entries, screenshots | **DEV-ONLY seed.** Ran unguarded at import time (BL-605); now guarded (see §3) |
| D2 | `src/components/auth/login-page.tsx` | Hardcoded **demo credential buttons** (`admin@worklens.ai`/`Admin@2025`, `admin@techvision.com`/`admin123`) + `fillCredentials` auto-fill + `admin@worklens.ai` placeholder | **Removed** (§4) |
| D3 | `src/lib/auth.ts` | *(already fixed in Phase D)* `getSuperAdminCredentials()` throws when env unset — no fallbacks | PASS — verified |
| D4 | `scripts/doc-capture/*.mjs`, `scripts/smoke-consent.mjs` | Login with demo credentials for docs/smoke tooling | Dev tooling only — unchanged, documented |
| D5 | Dev database `workai` | 2 orgs (TechVision Global + mig-org), 42 employees, 30 devices, 1 device claim, 2300 activities, 28 screenshots, 303 consent logs, 248 consents, etc. | **Cleaned** (§6) |

## 2. Files changed / created

### Created
- `src/lib/super-admin.ts` — production-safe, idempotent bootstrap module
- `scripts/bootstrap-super-admin.ts` — bootstrap CLI (`npm run bootstrap:super-admin`)
- `scripts/production-cleanup.ts` — gated cleanup CLI (`npm run db:production-clean`)
- `tests/super-admin.test.ts` — 18-test regression suite (`npm run test:super-admin`)
- `prisma/migrations/20260810120000_auditlog_org_nullable/migration.sql`
- `scripts/check-login-response.mjs` — live-login verification helper

### Modified
- `src/lib/seed.ts` — added `seedAllowed()` guard (BL-605); refuses in
  production / without `SEED_ALLOWED=1`; exit(1) only when run as entrypoint
- `src/components/auth/login-page.tsx` — removed demo credential buttons,
  `fillCredentials`, and the demo email placeholder
- `src/app/api/auth/login/route.ts` — audit log `organizationId: user.organizationId ?? null`
- `src/app/api/auth/logout/route.ts` — `payload.organizationId ?? null`
- `src/app/api/auth/change-password/route.ts` — `payload.organizationId ?? null`
- `src/app/api/auth/users/route.ts` — `payload.organizationId ?? null`
- `src/app/api/auth/users/[id]/route.ts` — `payload.organizationId ?? null` (×2)
- `prisma/schema.prisma` — `AuditLog.organizationId` → nullable
- `.env.example`, `.env.production.example` — neutral placeholders + bootstrap docs
- `package.json` — `bootstrap:super-admin`, `db:production-clean`,
  `db:seed:dev`, `test:super-admin` scripts

## 3. Seed policy (production never seeds demo data)

- `seed()` now only runs when **both** hold: `NODE_ENV !== 'production'` **and**
  `SEED_ALLOWED === '1'` (explicit opt-in).
- Running the seed as an entrypoint without the opt-in **exits non-zero**
  before touching any table (verified: SA-14b spawns the real CLI with
  `NODE_ENV=production SEED_ALLOWED=1` and asserts refusal + no writes).
- Production bootstrap = migrations + `npm run bootstrap:super-admin` (no demo
  data, no demo users, no org auto-creation).

## 4. Login page

- Removed: the "Demo Credentials" section, both hardcoded buttons, the
  `fillCredentials` helper.
- Email placeholder is now neutral (`you@company.com`).
- Login remains env-driven via the backend route; no demo credentials are
  reachable from the UI.

## 5. Super Admin bootstrap (idempotent, env-only)

`bootstrapSuperAdmin()`:

1. Reads `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` — **throws** when missing.
2. Validates email format; validates password ≥ 12 chars with upper/lower/digit.
3. Finds an existing account by email (case-insensitive).
4. **Creates** a hashed-password `super_admin` AppUser **only if missing**;
   org-less (global), exactly the supported bootstrap state.
5. **Never overwrites** an existing account's password/role/state on startup.
   A deliberate rotation is a separate explicit operation.
6. Creates **no** demo users, **no** org, **no** employees, **no** consent.

CLI: `npx tsx scripts/bootstrap-super-admin.ts` (never prints the password).

## 6. Production database cleanup (executed)

Command:
```
CONFIRM_PRODUCTION_CLEANUP=YES DATABASE_URL=postgresql://…/workai \
  SUPER_ADMIN_EMAIL=admin@worklens.ai npx tsx scripts/production-cleanup.ts
```

Safety: refuses without `CONFIRM_PRODUCTION_CLEANUP=YES`; auto `pg_dump`
custom-format backup; single transaction; dependency-ordered deletes; keeps
the env-configured Super Admin + `SystemSetting` + `JobRun`; dry-run mode
(`CONFIRM_PRODUCTION_CLEANUP=DRYRUN`).

### Before → After (executed against `workai`)

| Table | Before | After |
|---|---|---|
| Organization | 2 | **0** |
| Employee | 42 | **0** |
| Department | 9 | **0** |
| Device | 30 | **0** |
| DeviceClaim | 1 | **0** |
| Activity | 2300 | **0** |
| Screenshot | 28 (+56 files) | **0** (files removed) |
| Consent | 248 | **0** |
| ConsentLog | 303 | **0** |
| ConsentPolicy | 8 | **0** |
| Project | 11 | **0** |
| ProjectMember | 47 | **0** |
| TimeEntry | 435 | **0** |
| Notification | 30 | **0** |
| Alert | 22 | **0** |
| Report | 35 | **0** |
| AiInsight | 15 | **0** |
| AuditLog | 111 | **0** |
| AgentRegistration | 4 | **0** |
| MonitoringPolicy | 3 | **0** |
| OrganizationSetting | 6 | **0** |
| Anomaly | 22 | **0** |
| SentimentRecord | 36 | **0** |
| AppUser | 4 | **1 (super admin preserved)** |
| SystemSetting | 36 | 36 (system config preserved) |

- Backup: `backups/pg/workai-cleanup-2026-08-10T12-25-33-944Z.dump`
- Screenshot files: 56 removed from `uploads/screenshots`

## 7. Defect found & fixed: org-less login 500

**Root cause:** `AuditLog.organizationId` was `String` NOT NULL + FK. Auth
routes wrote `organizationId: payload.organizationId || ''`. An org-less
super_admin (the production bootstrap state) produced `''` → FK violation →
**500 on every login**. Wrong-password (401) worked; correct login crashed.

**Fix (minimal, no redesign):**
- `prisma/schema.prisma`: `AuditLog.organizationId String?` (+ nullable relation)
- Migration `20260810120000_auditlog_org_nullable` (`DROP NOT NULL`)
- 6 auth routes write `organizationId: … ?? null`

**Regression coverage:** SA-11 (login works org-less), SA-12 (wrong password
401), SA-13 (no credentials in response).

## 8. Test results

| Suite | Result |
|---|---|
| **`tests/super-admin.test.ts` (new)** | **18/18 PASS** |
| zero-touch + consent + projects + security (PostgreSQL) | **101/101 PASS** |
| Admin `tsc --noEmit` | PASS |
| Admin `npm run build` | PASS |
| Desktop agent tests | **123/123 PASS** |
| Fresh migration deploy (`prisma migrate deploy`) | PASS (AuditLog now nullable) |

### New regression coverage (SA-1…SA-17)
1. Missing `SUPER_ADMIN_EMAIL` → fail 2. Missing password → fail
3. Invalid email → fail 4. Weak password → fail
5. First bootstrap creates Super Admin (bcrypt, org-less)
6. No duplicate on second bootstrap
7. Password never overwritten on re-bootstrap (verified via hash comparison)
8. No demo users created 9. No org created 10. No employees created
11. Login works with env super admin 12. Wrong password → 401
13. No credentials leaked in API response
14. Seed refuses in production (SEED_ALLOWED guard) 14b. Seed CLI refuses + wipes nothing
15. Zero-touch discovery still works 16. Approval creates no consent
17. Consent fail-closed (403 upload) remains intact

## 9. Live verification (against cleaned `workai` DB)

```
POST /api/auth/login {admin@worklens.ai, <env password>}
  → 200, token (243 chars), role=super_admin, org=org-less (global)
  → no password field, no bcrypt hash in response
POST /api/auth/login wrong password → 401
GET /api/organizations (global scope) → {"data":[]} ✓
```

## 10. Repository security scan

Scanned: `src/`, `desktop-agent/src/`, `tests/`, `scripts/`, `prisma/` for
`Admin@2025`, `admin@worklens.ai`, `admin123`, `manager123`, `viewer123`.

- **Production code paths: CLEAN** (no demo credential values).
- `src/lib/seed.ts` retains demo users — **dev-only, now `SEED_ALLOWED`-guarded**
  and unreachable from production.
- `scripts/doc-capture/*.mjs`, `scripts/smoke-consent.mjs` log in with demo
  creds for dev tooling — documented, unchanged.
- `.env` (gitignored) holds the real configured values — not tracked.

### Git-history exposure (REPORTED — action required before external sharing)
`Admin@2025` / `admin@worklens.ai` exist in **git history** (earlier commits
and audit docs: `MASTER-AUDIT.md`, `API-AUDIT.md`, `DATABASE-AUDIT.md`,
`worklog.md`). **Recommendation:** rotate `SUPER_ADMIN_PASSWORD` and `JWT_SECRET`
before distributing the repository outside the current trust boundary; use
BFG/filter-repo if history purge is required.

## 11. Consent & zero-touch regression (unchanged semantics)

- Approval ≠ consent — SA-16 verifies an approved device has **zero** consent rows.
- Fail-closed — SA-17 verifies activity upload without consent → **403**, nothing persisted.
- Zero-touch discovery — SA-15 verifies discover → pending claim → one-time secret.
- Full backend suite (101/101) and desktop suite (123/123) confirm no regressions
  from the audit-log nullability change.

## 12. Final production database state

```
PostgreSQL workai
 ├── System schema/migrations          ✓ (prisma migrate deploy, deterministic)
 ├── Super Admin (admin@worklens.ai)   ✓ created/verified from env, bcrypt, org-less
 └── No demo business data             ✓ zero rows in all 26 business tables
```

**Deployment recipe (repeatable):**
```
npx prisma migrate deploy          # schema only — no seed, no db push
npm run bootstrap:super-admin      # idempotent — env-driven Super Admin
# Admin then creates the org, employees, departments, projects via the UI
```
