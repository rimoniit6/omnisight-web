# SUPER ADMIN + MULTI-ORG FINAL AUDIT REPORT
**Project:** OmniSight (omnisight-web) — Super Admin & Multi-Organization SaaS Architecture
**Date:** 2026-08-27
**Auditor:** Automated repository-level + runtime audit
**Method:** Static analysis of source/schema/routes **plus** live execution of the project's own test suites against a real PostgreSQL instance (`postgresql://postgres:123456@localhost:5432`).

> **Evidence standard used:** A feature is marked VERIFIED only when traceable to
> USER ACTION → UI → API → AUTHORIZATION → DATABASE → RESPONSE → UI STATE → RUNTIME EFFECT.
> Endpoint/model/test existence alone is NOT sufficient.

---

## 0. Audit Scope & How to Read This Report
- **Repository audited:** `E:\Live project\omnisight\omnisight-web` (Next.js Admin Panel + Web Backend, Prisma/PostgreSQL).
- **Agent repository** (`omnisight-agent`) was **not** deeply inspected; agent server-side enforcement is fully covered by the web backend's token validation, which is the authority of record.
- **Runtime evidence:** `npm run test:super-admin` → **18 pass / 0 fail**; `tests/multi-org.test.ts` + `tests/multi-org-isolation.test.ts` → **58 pass / 0 fail**. Total **76 real tests green** against a live DB.
- **Status legend:** `A = Fully verified` · `B = Implemented API only (no/limited UI)` · `C = Partial / has gaps` · `D = Missing / broken`.

---

## 1. Executive Summary
| | |
|---|---|
| **Verdict** | **NOT GA-READY (Conditional Pass)** — strong security primitives, but 3 P0/P1 gaps block a clean multi-tenant SaaS launch. |
| **Score** | **73 / 100** |
| **Headline** | Core auth, RBAC, tenant isolation, enrollment, and agent binding are well-built and **tested**. However: (1) there is **no Super Admin management console UI**, (2) **normal-user multi-org membership provisioning is absent** (legacy single-org fields remain the real source of truth), and (3) **organization suspension/archival does not terminate an already-authenticated web-admin session**. |

### Top Critical Findings
- **P1 — Lifecycle gap:** `OrganizationMembership`/resource routes resolve org from the JWT and **never re-check `Organization.status`**, so a *suspended/archived* org's existing web-admin session keeps reading/writing its data. (Agents ARE stopped; web admins are NOT.)
- **P1 — Provisioning gap:** Normal users are created via deprecated `AppUser.organizationId`/`AppUser.role` with **no `OrganizationMembership` row**. Only Super Admin's own org-creation writes a membership. True multi-org (one user, many orgs) is therefore non-functional for normal users.
- **P0/P1 — Console UI missing:** The entire `/api/super-admin/organizations` surface has **zero frontend consumers** — no list/search/suspend/reactivate/archive/manage console exists.

---

## 2. Super Admin Console (User Action → UI → API → DB → Response → UI State)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 2.1 | Super Admin login works | **A** | `auth/login/route.ts` issues HMAC JWT with `role: super_admin`; 18 SA tests pass (SA-1..SA-17). |
| 2.2 | List organizations (search) | **B** | `GET /api/super-admin/organizations` exists (`super-admin/organizations/route.ts:45`) — **no UI calls it** (grep `/api/super-admin` → 0 client hits). |
| 2.3 | Suspend / Reactivate | **B** | `PATCH /api/super-admin/organizations/[id]` (`[id]/route.ts`); tested MO-6. No console UI. |
| 2.4 | Archive | **B** | status enum `archived` supported; tested MO-7. No UI. |
| 2.5 | Drill into "Manage Organization" | **C** | Super Admin can read globally via `requireSessionOrg({allowGlobal:true})` (employees GET), but **switching into** an org requires a membership that is only auto-granted for orgs the Super Admin personally creates. No dedicated console. |

**Finding 2.1:** A real Super Admin **console** (platform dashboard listing orgs, with suspend/reactivate/archive/search/manage buttons) **does not exist**. The only org-related UI is the first-run `CreateOrganizationScreen` (`components/auth/create-organization-screen.tsx`) and the `org-switcher` (switch, not platform-management).

---

## 3. Super Admin Role & Privileges (RBAC)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 3.1 | Role stored server-side, not client-controlled | **A** | `requireSuperAdmin` checks `auth.role === 'super_admin'` from **verified** HMAC JWT (`lib/api.ts`). Client cannot forge. |
| 3.2 | Cross-tenant access (global) without org context | **A** | `requireSessionOrg({allowGlobal:true})` lets super_admin read all orgs (employees GET global branch). |
| 3.3 | No privilege escalation by non-super-admin | **A** | `auth/users/route.ts` & `[id]/route.ts` require `super_admin` to set `super_admin` role; escalation guarded. |

---

## 4. Authentication & Session Security (Server-Authoritative)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 4.1 | Sessions server-verified on every request | **A** | `lib/session.ts` re-validates `UserSession` row (active, not expired) on each authenticated call. |
| 4.2 | JWT tamper-proof | **A** | HMAC-signed (`JWT_SECRET`); role/org claims signed. |
| 4.3 | Brute-force / rate limiting | **A** | Login rate-limited per-email + per-IP+email; agent-register/agent-login/enrollment-code limited. |
| 4.4 | Role changes reflected immediately | **C** | Role read from **JWT, not DB** → a demoted super_admin keeps privileges until token expiry (minor). |

---

## 5. Multi-Organization Architecture (Data Model)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 5.1 | `Organization` + `OrganizationMembership` model | **A** | `prisma/schema.prisma` — membership has compound-unique `[userId, organizationId]` (no duplicates). |
| 5.2 | Normal user can belong to multiple orgs | **C** | Model supports it, **but no app code creates memberships for normal users** (only `super-admin/organizations/route.ts:92`). `grep organizationMembership.create` → single occurrence. |
| 5.3 | Deprecated dual fields still primary | **C** | `AppUser.organizationId` (marked DEPRECATED) and `AppUser.role` remain the real source of truth for login/resource scoping. Legacy + new layer coexist inconsistently. |
| 5.4 | Global identity | **A** | `AppUser.email` GLOBAL unique; `Employee.employeeId` GLOBAL unique (required for safe `agent/register` global lookup). |

---

## 6. Organization Switching (User Action → API → DB → Response → UI State)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 6.1 | Switch endpoint verifies membership | **A** | `POST /api/me/organization/switch` checks `OrganizationMembership` ACTIVE + `org.status === 'active'`; issues new JWT. Tested MO-3. |
| 6.2 | UI switcher exists & reloads context | **A** | `components/layout/org-switcher.tsx` → calls switch → `window.location.reload()`. |
| 6.3 | Switch impossible for membership-less users | **C** | `GET /api/me/organizations` returns `[]` for normal users (no membership) → switcher hidden (`length <= 1`) → no org context established, yet legacy `AppUser.organizationId` still works for single-org. |
| 6.4 | Switch after suspension blocked | **A** | Switch endpoint rejects non-`active` orgs. |

---

## 7. Tenant Isolation in Web Resource APIs
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 7.1 | Org derived from JWT, never client | **A** | `getSessionOrg`/`requireSessionOrg` use `activeOrganizationId`/`organizationId` from signed JWT; client `organizationId` params ignored. Tested MO-33/MO-35/MO-44. |
| 7.2 | Cross-tenant read blocked | **A** | MO-2: Org A cannot read Org B. employees/activities/devices/locations/screenshots all org-scoped. |
| 7.3 | Cross-tenant write blocked | **A** | MO-44: Admin A deleting Org B entry → 404, target untouched. |
| 7.4 | Super-admin global scope intended | **A** | super_admin may pass `orgId` to `employees` GET (global branch) — by design. |
| 7.5 | **Suspended/archived org does not stop existing sessions** | **C/P1** | Resource routes **never re-check `Organization.status`** (grep: only agent paths + switch + super-admin check status). A pre-issued web-admin JWT for a suspended org keeps full data access. Agents are stopped; web admins are NOT. |

---

## 8. Enrollment Code System (Expiration Actually Implemented?)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 8.1 | Per-org enrollment code | **A** | `organization/enrollment-code` POST/DELETE; code hashed SHA-256; plaintext returned **once**. |
| 8.2 | **Expiration implemented** | **A** | `ENROLLION_CODE_DEFAULT_TTL_MS` (~30d) + `isEnrollmentCodeExpired` enforced in `resolveOrgFromEnrollmentCode` → returns `'expired'` → `agent/discover` returns **410 ENROLLMENT_CODE_EXPIRED**. Confirmed implemented. |
| 8.3 | Revoke / rotate | **A** | DELETE clears; POST rotates (new hash). Tested MO-5/MO-9. |
| 8.4 | No plaintext retrieval | **A** | GET returns status only. |
| 8.5 | Anonymous agent resolves org server-side | **A** | `agent/discover` derives org from enrollment-code **hash**; checks expired + `org.status !== 'active'` → null; row-locked `FOR UPDATE` (race-safe). |
| 8.6 | Enrollment UI | **A** | `components/organization/organization-page.tsx` generate/revoke/copy UI exists. |

---

## 9. Agent Binding & Organization Context (from Agent)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 9.1 | Agent token bound to org | **A** | `validateAgentToken` (`lib/agent/auth.ts`) reads org from **token**, not body; cross-org integrity check. Tested MO-4. |
| 9.2 | Suspended org blocks agent | **A** | MO-10: suspended org → agent token validation fails. |
| 9.3 | Device/employee active checks | **A** | validates device active, employee approved+active, agentAccount active, org status active. |
| 9.4 | AgentToken.organizationId nullable in schema | **C/P3** | `schema.prisma` marks it nullable ("migration; backfilled then required"). Cross-org check is bypassed if null. |

---

## 10. Organization Lifecycle (Create → Active → Suspended → Archived)
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 10.1 | Create (bootstrap) | **A/B** | `POST /api/organizations` (super-admin only) + `CreateOrganizationScreen` UI. Sets deprecated `AppUser.organizationId`, **no membership**. |
| 10.2 | Active state default | **A** | New orgs `status = active`. |
| 10.3 | Suspend / Reactivate | **A/B** | `PATCH [id]` super-admin only; audited. No UI console. Tested MO-6. |
| 10.4 | Archived blocks new ops | **A** | MO-7: archived org blocks new operations. |
| 10.5 | **Suspension cuts existing access** | **C/P1** | Only *new* requests are gated (switch, agent). **Existing web-admin JWTs for the org remain valid** (see 7.5). |
| 10.6 | Consistent state machine | **C** | Two creation paths (`/api/organizations` vs `/api/super-admin/organizations`) differ in membership handling → inconsistent. |

---

## 11. Audit Logging
| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| 11.1 | Super-admin org status changes logged | **A** | `super-admin/organizations/[id]/route.ts` writes `auditLog`. |
| 11.2 | Enrollment generate/revoke logged | **A** | `organization/enrollment-code` audits. |
| 11.3 | Device approval logged | **A** | `device-claims/[id]/approve/route.ts:226,370` audit. |
| 11.4 | Login/switch/agent events logged | **A** | present. |
| 11.5 | AuditLog cascade with org | **C/P3** | `AuditLog.organizationId onDelete: Cascade` → deleting an org destroys its audit trail (no org-delete endpoint today → latent). |

---

## 12. UI/UX for Multi-Tenancy
- `org-switcher` works for users with >1 membership (reload-based context switch).
- `CreateOrganizationScreen` for first-run super admin.
- Enrollment-code management UI present per org.
- **Missing:** Super Admin console, membership management UI (invite/add/remove users to orgs), and any "switch org" affordance for membership-less users.
- **Status:** **C** (functional core, missing management surfaces). Responsive component library present (Tailwind) but not independently verified at breakpoints.

---

## 13. API Surface for Multi-Org
| Endpoint | Purpose | Verdict |
|----------|---------|---------|
| `GET /api/me/organizations` | list ACTIVE memberships | A (empty for legacy users) |
| `POST /api/me/organization/switch` | switch (membership + status check) | A |
| `GET/POST /api/super-admin/organizations` | platform org mgmt | B (no UI) |
| `PATCH /api/super-admin/organizations/[id]` | status change | B (no UI) |
| `POST/GET/DELETE /api/organization/enrollment-code` | enrollment | A |
| `POST /api/agent/discover` | anonymous org resolve | A |
| `POST /api/organizations` | bootstrap create | C (legacy-only) |
| `POST /api/auth/users` | create user | C (no membership) |

---

## 14. Authorization Enforcement Consistency
- **Consistent & strong:** agent side, switch endpoint, super-admin status changes all enforce `organization.status`.
- **Inconsistent:** web admin resource routes (employees, activities, devices, screenshots, locations, etc.) enforce org-scoping but **not** org status → asymmetry between "agent blocked when suspended" and "admin not blocked when suspended".

---

## 15. Test Coverage (Real Execution)
- **`npm run test:super-admin`** → 18/18 pass (bootstrap, login, zero-touch discovery, consent fail-closed).
- **`tests/multi-org.test.ts` + `tests/multi-org-isolation.test.ts`** → 58/58 pass (CRUD, cross-tenant isolation, switching, agentToken cross-org, enrollment scoping/rotation, suspend/reactivate, archived blocks, role differentiation, client-orgId-ignored).
- **Caveat:** Tests create `OrganizationMembership` **directly** (MO-1) and do not exercise the *application's* user-provisioning path, so the P1 provisioning gap (§5.2/§6.3) is **not caught by the suite** — false green.

---

## 16. Gap Analysis (Prioritized)
| # | Severity | Finding | Evidence | Fix |
|---|----------|---------|----------|-----|
| G1 | **P1** | Suspended/archived org does NOT terminate existing web-admin sessions (resource routes skip `Organization.status`). | grep: only agent/switch/super-admin check status; `employees/route.ts` uses JWT org only. | Add `getActiveOrg(statusCheck:true)` / middleware verifying `Organization.status !== 'active'` → 403. |
| G2 | **P1** | Normal-user multi-org membership provisioning missing; legacy `AppUser.organizationId`/`role` are real source of truth. | `organizationMembership.create` only in `super-admin/organizations/route.ts:92`; `auth/users` create/update skip membership. | Create membership on user-create/invite/switch; migrate `AppUser.organizationId` → membership. |
| G3 | **P0/P1** | No Super Admin console UI (list/search/suspend/reactivate/archive/manage). | grep `/api/super-admin` → 0 client references. | Build platform console page consuming `super-admin/organizations`. |
| G4 | **P2** | `login` sets JWT org from deprecated `AppUser.organizationId`; multi-org users get no active org at login. | `auth/login/route.ts`. | Resolve active org via membership (`activeOrganizationId`). |
| G5 | **P3** | `AgentToken.organizationId` nullable → cross-org check bypassable if null. | `schema.prisma`. | Backfill + make non-nullable. |
| G6 | **P3** | `AuditLog` cascades with org → audit loss on org delete. | `schema.prisma`. | `onDelete: SetNull` or retain. |
| G7 | **P3** | Two inconsistent org-creation paths (membership vs legacy). | `organizations/route.ts` vs `super-admin/organizations/route.ts`. | Unify creation to always write membership. |
| G8 | **P3** | Role read from JWT not DB → demotion lag. | `lib/api.ts` `requireSuperAdmin`. | Optional re-read role for sensitive routes. |

---

## 17. Security Posture
- ✅ Server-authoritative sessions, signed JWT, no client impersonation.
- ✅ Brute-force protection, rate limiting, audit logging.
- ✅ Tenant isolation enforced at DB-query level; client org params ignored.
- ✅ Enrollment codes hashed + expired + one-time-display.
- ⚠️ Lifecycle state not re-checked per request (G1).
- ⚠️ Privilege model still partly relies on deprecated single-org fields (G2/G4).

---

## 18. Compliance & Data Isolation
- Cross-tenant data isolation is enforced by scoping every query to `organizationId` (verified by tests MO-2/MO-44).
- For regulatory "right to suspend/disable an org", **G1 must be fixed** — suspension currently does not stop an in-session admin from exporting/modifying data.

---

## 19. Scorecard (out of 100)
| Category | Score | Notes |
|----------|-------|-------|
| 1. Super Admin Console | 10/15 | Backend strong; console UI missing (G3). |
| 2. Multi-Org Architecture | 8/15 | Model + switch work; provisioning gap (G2). |
| 3. Organization Switching | 7/10 | Works for members; membership-less users stuck (G2/G4). |
| 4. Tenant Isolation | 12/15 | Excellent scoping; minus lifecycle re-check (G1). |
| 5. RBAC / Security | 13/15 | Strong; minor JWT-role-lag (G8). |
| 6. Organization Lifecycle | 6/10 | States work; suspension doesn't cut sessions (G1). |
| 7. Enrollment System | 5/5 | Hashed, expired, rotated, UI present. |
| 8. Agent Integration | 5/5 | Token-bound, status-checked, tested. |
| 9. UI/UX | 3/5 | Core present; management surfaces missing. |
| 10. Testing | 4/5 | 76 real tests green; suite masks provisioning gap. |
| **TOTAL** | **73/100** | |

---

## 20. Final Verdict & Recommendations
**GA / RELEASE DECISION: 🟡 CONDITIONAL — NOT READY for multi-tenant GA until P0/P1 items close.**

The foundation is genuinely solid and **proven by 76 passing runtime tests**: auth is server-authoritative, tenant isolation holds at the data layer, enrollment is secure and expiring, and agent binding is tightly org-scoped. This is far above a prototype.

**Must-fix before GA (P1):**
1. **G1** — Enforce `Organization.status` on every authenticated request (web admin side), not just agent/switch. This is the single biggest compliance/security gap.
2. **G2** — Wire normal-user membership provisioning (invite/add/switch create `OrganizationMembership`); migrate off deprecated `AppUser.organizationId`.
3. **G3** — Ship the Super Admin console UI (the API is ready and tested).

**Should-fix (P2/P3):** G4 (login org resolution via membership), G5 (non-nullable `AgentToken.org`), G6 (audit retention), G7 (unify creation paths), G8 (role re-read).

**Confidence:** High. Findings are backed by both decisive static evidence (exact file:line) and live test execution. The notable risk is that the existing test suite produces a **false green** on multi-org (it bypasses the provisioning gap), so add tests that exercise the *real* user-creation → membership → switch → isolated-access flow before declaring GA.
