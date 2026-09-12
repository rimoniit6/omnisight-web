# OmniSight Super Admin Operator Guide

Operational reference for the platform **Super Admin (control-plane) layer**: how to
log in, what the control-plane owns, the authoritative API surface, key ownership
decisions, and how to keep the layer healthy in production.

Companion documents: `docs/SUPER-ADMIN-CONTROL-CENTER-CERTIFICATION.md`
(implementation certification), `docs/SUPER-ADMIN-FORENSIC-AUDIT.md` (audit record),
`docs/ADMIN_GUIDE.md` (organization-admin guide), `docs/ARCHITECTURE.md`.

---

## 1. Roles and Access Control

| Role | Scope | Notes |
|------|-------|-------|
| `super_admin` | Entire platform + control-plane | `requireSuperAdmin` on every control-plane route; role re-read from DB on each request (`requireDbVerifiedRole` for mutations) so a revoked role takes effect immediately. |
| `org_admin` | Single organization | Scoped to `activeOrganizationId \|\| organizationId`; `super_admin` bypasses org scoping for control-plane surfaces. |
| `employee` / `viewer` / `manager` | Org-local | No control-plane access. |

Super admin is provisioned through the bootstrap seed
(`npm run bootstrap:super-admin`, `src/lib/seed.ts`) or org creation flow
(`organization-provision-flow.tsx`), not through self-registration.

### Session model (security invariants)

- Sessions carry `sessionId`; tokens whose session row is missing/revoked get **401**
  on every request (session revocation is immediate, not TTL-based).
- `signTestJWT`/real sessions bind `organizationId` **and** `activeOrganizationId`;
  org-scoped routes read `auth.activeOrganizationId || auth.organizationId`.
- Membership removal revokes all of the user's sessions
  (`revokeAllUserSessions`) — including the "last admin" guard, which refuses to
  remove the final `org_admin` of an organization.

---

## 2. Control-Plane Surface

### UI

| View | Component |
|------|-----------|
| Overview (metrics) | `sa-overview-page.tsx` |
| Organizations list | `super-admin-organizations-page.tsx` |
| Organization detail (members/projects/invoices/devices/audit) | `super-admin-organization-detail-page.tsx` |
| Packages / Subscriptions / Payments / Licenses | `sa-billing-pages.tsx` |
| Audit log | `sa-audit-page.tsx` |
| Create organization | `sa-create-organization-page.tsx` + `organization-provision-flow.tsx` |
| Shared pagination control | `ui.tsx` → `Pagination` |

### API inventory

`/api/super-admin/*`

| Route | Role guard | Purpose |
|-------|-----------|---------|
| `GET metrics` | SA | Platform overview counters |
| `GET organizations` (+PATCH org, delete) | SA | Org list with page-scoped search + `{data,pagination}` envelope |
| `GET/POST organizations/create` | SA | Provision an organization |
| `GET organizations/[id]/*` (audit-logs, devices, employees, memberships, projects, delete-impact) | SA | Org-scoped control-plane views |
| `GET/POST` + `PATCH /api/super-admin/packages[/id]` | SA | `Plan` catalog CRUD (`activate`/`deactivate`) |
| `GET /subscriptions` / `PATCH /subscriptions/[id]` | SA | Subscription management |
| `GET audit` | SA | Global audit browse (`orderBy createdAt DESC`, optional `action` filter, `{data,pagination}`) — exposes **control-plane metadata only**, never `AuditLog.metadata` bodies |
| `GET ai-usage`, `GET devices`, `GET storage` | SA | Metering / device / storage overview |

`/api/admin/*`

| Route | Role guard | Purpose |
|-------|-----------|---------|
| `GET/PATCH /invoices`, `GET/PATCH /invoices/[invoiceId]` | SA | Payment lifecycle; **no DELETE** (history preserved) |
| ~~`/licenses`~~ | — | **Removed.** License keys went with the Self-Hosted / LicenseKey architecture (not a V1 service model) |
| `POST /organizations/create` | SA | Org create |
| `PATCH /organizations/[orgId]/settings` | SA | Super-admin-owned org settings (see §3) |
| `GET/POST /data-retention`, `GET/POST /delete-impact` | SA | Retention + delete-impact preview (uses `src/lib/delete-impact.ts`) |

---

## 3. Key Ownership Decisions (documented, deliberate)

### 3.1 "Package" vs "Plan" naming — a documented alias, not a rename

The product/UI naming is **"Package"** (`/api/super-admin/packages`,
`sa-billing-pages.tsx`, license UI "package"), while the data model column is
**`Plan`** (`prisma/schema.prisma`, `planId` foreign keys). These describe the same
entity.

**Decision (P6.4/L5-resolution):** keep both; the alias is intentional.
- `Plan` is the canonical model name in code and DB (`packageId` never exists).
- `packages` is the product-facing HTTP/UI term.
- Do **not** rename the URL/UI to `plans`: it would be a breaking change to the
  public control-plane surface with zero functional benefit (audit trail + tests
  pin the current paths).

### 3.2 Screenshot cadence is owned by the Super Admin

- `Organization.screenshotInterval` (0–60 seconds, **0 = disabled**) is controlled
  only at `PATCH /api/admin/organizations/[orgId]/settings` (`requireSuperAdmin`).
- The agent resolves its frequency server-side:
  `effectiveScreenshotFrequency = hasScreenshots ? (org.screenshotInterval ?? 5) : 0`
  (`/api/agent/config`). The upload path re-checks `screenshotInterval <= 0` → **403
  `SCREENSHOT_INTERVAL_DISABLED`** even if a client bypasses config.
- The legacy `screenshot_frequency` key is **hidden** from the org-facing
  monitoring API (`/api/settings/monitoring`, `ORG_SETTABLE_KEYS` filter) and may
  only be written by the super admin. It remains in `MONITORING_KEYS` for
  resolution validity. No org-facing component renders `screenshot_frequency`.

### 3.3 Members API pagination contract (P4/P4.1)

`GET /api/organizations/[orgId]/members?page=&pageSize=`

| Param | Rules |
|-------|-------|
| `page` | Positive integer (`0`, negatives, floats, `abc` → **400**). Default `1`. |
| `pageSize` | One of `10`, `25`, `50`, `100`; anything else → **400**. Default `25`. |
| Ordering | `createdAt ASC, id ASC` — stable across pages (no new/duplicate rows between pages). |
| Response | `{ members, pagination: { page, pageSize, total, pages } }` — `members` shape unchanged for backward compatibility. |

The SA org-detail member list renders the shared `Pagination` control (`ui.tsx`);
the `* 25` hardcoded range bug is fixed via a `pageSize` prop (defaults to 25, so
the Audit page is unaffected). Search is page-scoped and resets to page 1.

### 3.4 Migration history is not rewritten

Migration `rr` and `add_missing_tables` (and all older migrations) are retained
verbatim — no history rewrite. Deploy forward-only with:

```bash
prisma migrate deploy   # against the production DATABASE_URL
```

`docs/SUPER-ADMIN-FORENSIC-AUDIT.md` P6 item 1 (absorb into a clean baseline) is
**declined** in favor of forward-only migrations.

---

## 4. Database Indexes (P5)

Migration `20260908000000_add_super_admin_p5_indexes` adds five query-backed
indexes (non-destructive, verified by `prisma migrate deploy` on a disposable DB):

| Index | Serves |
|-------|--------|
| `AuditLog_createdAt_idx` | Global SA audit browse (`orderBy createdAt DESC`, no org filter) |
| `AuditLog_action_createdAt_idx` | SA audit `?action=` filter |
| `Subscription_organizationId_status_createdAt_idx` | `getActiveSubscription()` hot path on every authenticated request |
| `Invoice_status_createdAt_idx` | Admin invoice list filtered by status |
| `Invoice_organizationId_status_createdAt_idx` | Admin invoice list scoped + status-filtered |

Already satisfied (verified, no change needed):

- `Employee.employeeId` — `@unique` (brute-force account identity)
- `Device.agentKey` — `@unique` (stable machine identity)
- `OrganizationSettings.organizationId` — `@unique` (its legacy `@@index` is
  redundant but harmless)

---

## 5. Operational Procedures

### Apply the latest migrations

```bash
git pull && npm install
npx prisma migrate deploy
npm run build
# restart your app process (process manager of your choice)
```

### Verify a clean-DB migration chain (disposable database)

```bash
node scripts/pg-test-db.mjs ensure workai_test_migrate
# Prisma CLI overrides process env with .env, so move .env aside for this run:
# (restore it immediately afterwards — see scripts/migration-verify.mjs)
```

### Run the Super Admin test surface

```bash
npm run test:super-admin
npm run test:super-admin-orgs
npm run test:members-add
npm run test:members-pagination
node --import tsx --test tests/control-plane-lifecycle.test.ts
```

Full suite: `npm test` (requires the dev server on :3000 for ~60% of files).

### Common tasks

- **Review an overdue invoice** → Payments → filter `OVERDUE` → edit → mark PAID
  (audited; no hard delete exists).
- **Audit trail** → Super Admin → Audit (`/api/super-admin/audit`). Rows are written
  transactionally on every auditable SA mutation (org create/patch, membership,
  invoice, package, platform branding, login).

---

## 6. Known Issues (OPEN, non-blocking)

| Item | Status |
|------|--------|
| `prisma:error` P2025 noise when a member-delete request races a parallel delete of an already-deleted membership | Cosmetic log noise; tests pass. Tracked for the final audit. |
| Lint baseline of 423 unused-variable warnings | Pre-existing; not treated as failures. |
| Deferred live suites (`ai-config-org-admin`, `rbac-forensic-regression`, `rbac-hardening`) | Require the dev server on :3000; run during live smoke. |