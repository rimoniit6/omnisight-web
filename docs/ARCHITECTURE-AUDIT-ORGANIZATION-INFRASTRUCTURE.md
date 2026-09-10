# Architecture Audit — Organization Data Infrastructure & Agent Builder

Status: LIVE (updated as corrective work lands)
Scope: `omnisight-web` (control plane) + `omnisight-agent` (Local Agent Builder)
Method: code inspection with file:line evidence, PRD cross-reference (`master.PRD`), targeted tests.

---

## A. Purpose & Scope

This audit verifies the implementation against the Product Requirements (PRD)
for two areas targeted by the current directive:

1. **Web — Organization Data Infrastructure**: who may change an
   organization's Database / Storage destination, how a change is requested,
   validated, approved, migrated, and switched; secret safety and audit.
2. **Local Agent Builder**: the build flow must be the minimal single flow
   `Server URL → Test Connection → Agent Configuration → Agent Logo/SVG →
   Build EXE` — no multi-step wizard, no organization creation, no invented
   deployment platform.

Audit findings are grouped A–F: Document, Current State, Issues, PRD
Evaluation, Recommended Design, Implemented Corrections.

---

## B. Document Set (authoritative sources)

| Doc | Role |
| --- | --- |
| `E:\Live project\omnisight\omnisight-web\master.PRD` | Product Requirements Document — authoritative |
| `E:\Live project\omnisight\omnisight-web\prisma\schema.prisma` | Data model |
| `E:\Live project\omnisight\omnisight-web\src\lib\auth.ts`, `session.ts`, `api.ts` | Auth / session / route guards |
| `E:\Live project\omnisight\omnisight-web\src\lib\crypto.ts` | Secret encryption |
| `E:\Live project\omnisight\omnisight-web\src\lib\storage\*.ts` | Binary storage drivers |
| `E:\Live project\omnisight\omnisight-agent\builder\ui\index.html` | Builder UI |
| `E:\Live project\omnisight\omnisight-agent\builder\{server.mjs,lib\config.mjs,lib\pipeline.mjs,lib\verify.mjs,scripts\copy-assets.mjs}` | Builder backend |
| `E:\Live project\omnisight\omnisight-agent\docs\AGENT-BUILDER-UNIVERSAL-AGENT-CERTIFICATION.md` | Prior builder certification (656/656, live HTTP, browser QA) |

---

## C. Current State (verified inventory)

### C.1 Authentication, Roles, Sessions — EXISTS ✅
- Custom JWT + bcrypt + server-side session revocation
  (`src/lib/auth.ts`, `src/lib/session.ts`, `src/app/api/auth/login/route.ts`).
- Roles `super_admin` / `org_admin` / `manager` / `viewer`; 50+ permissions in
  `src/lib/permissions.ts`.
- API enforcement via `requireOrgAdmin` / `requireSuperAdmin`
  (`src/lib/api.ts`, `src/lib/session.ts`); UI gating via `PAGE_MIN_ROLE` in
  `src/lib/navigation.ts`. No middleware — routes self-authenticate.

### C.2 Org Creation + Org Admin Provisioning — EXISTS ✅
- Super Admin creates organizations; initial org-admin credentials are
  provisioned at creation. Org admin login works against the provisioned
  credential. See `src/app/api/organizations/...` routes and RBAC tests
  (`tests/rbac-hardening.test.ts`).

### C.3 Secret Management — EXISTS ✅
- AES-256-GCM via `src/lib/crypto.ts` (`encryptSecret`/`decryptSecretWithMeta`,
  keyed by `ENCRYPTION_KEY`). Database password in `OrganizationSettings` is
  stored encrypted, never returned in plaintext.

### C.4 Audit Logging — EXISTS (partial coverage) ✅/⚠️
- `AuditLog` model + service; org/db/storage events are not yet wired into the
  infrastructure change workflow (no workflow existed).

### C.5 Database Settings — PARTIAL ⚠️
- Org admin can **directly write** the optional analytics DB destination
  (`PUT /api/organizations/[orgId]/settings/database`, `OrganizationSettings`
  model: `useOwnDb / dbHost / dbPort / dbName / dbUser / dbPassword(encrypted) /
  dbSsl`, `prisma/schema.prisma` ~600–637).
- **NO approval workflow. NO connection validation loop. NO migration.
  NO switch safety. NO state machine.** A mis-typed host overwrites the active
  configuration in one write.

### C.6 Storage Configuration — MISSING ❌
- Binary storage is driver-based (`src/lib/storage/*`), but there is **no
  per-organization storage destination configuration**, no validation, no
  change workflow. PRD §18/§20 (Customer DB + Customer Storage) unimplemented.

### C.7 Infrastructure Change / Migration — MISSING ❌
- No `InfrastructureChangeRequest` concept, no submitted/pending/approved/
  rejected/switch lifecycle, no org-scoped migration engine,
  no "organization cannot activate independently" enforcement
  (PRD §3340, §3344).

### C.8 Agent Builder — NOT MINIMAL ⚠️
- UI is a 3-step wizard: Organization → Review → Build
  (`builder/ui/index.html:221-282`), card titled literally **"Deployment
  Wizard"** (line 223), with an organization-slug requirement enforced in
  `buildMatrix()` (line 667-669). This exceeds the mandated minimal flow and
  references a deployment platform concept that does not exist.
- Build pipeline itself is sound and verified (MANAGED-only Universal Agent,
  preflight server validation, source-tree cleanliness, artifact gate,
  secret-redacted logs — `builder/lib/pipeline.mjs`, 656/656 tests, live HTTP,
  0-console-error browser QA).

---

## D. Issues (ranked)

| # | Severity | Issue | Evidence |
| -- | -- | -- | -- |
| D1 | HIGH | No org storage destination config | C.6 |
| D2 | HIGH | DB settings are a direct self-serve write with no test/validate, no approval, no state machine | C.5 |
| D3 | HIGH | No org-scoped migration or switch safety | C.7 |
| D4 | HIGH | Builder UI "Deployment Wizard" + 3-step wizard + org requirement — not the mandated minimal flow | C.8 |
| D5 | MEDIUM | Org admin could flip the DB destination without Super Admin approval (security boundary) | C.5 |
| D6 | MEDIUM | Audit log does not record infra change lifecycle | C.4 |
| D7 | LOW | Builder ships a fixed brand mark; no configurable Agent logo/SVG | builder UI + `scripts/copy-assets.mjs` |

---

## E. PRD Evaluation

| PRD ref | Requirement | Status |
| -- | -- | -- |
| §333-336 | "An Organization Admin may request infrastructure changes but cannot activate them independently" | ❌ NOT IMPLEMENTED |
| §3344 | "Super Admin approval is required before an infrastructure change becomes active" | ❌ NOT IMPLEMENTED |
| §18 / §20 | Customer DB + Customer Storage model; Storage = authoritative binary destination | ❌ PARTIAL (DB fields exist; Storage missing) |
| §51 | Agent Builder: Super Admin/local tool, select org, validate, build Universal Agent, no embedded customer secrets, fail safely | ⚠️ PARTIAL (pipeline correct; wizard not minimal) |
| §50 | Build-time = org, service model, package, capabilities, initial config | ⚠️ PARTIAL (server remains authoritative ✅; builder not minimal) |
| §3713 | "controlled data migration" | ❌ NOT IMPLEMENTED |
| §1871 | Infrastructure change UI must clearly communicate status | ❌ NOT IMPLEMENTED |

**Verdict:** the web control plane has the auth/secret/audit substrate but is
missing the entire requested-change → approval → migration → switch workflow and
the storage-side config. The builder backend is correct but its UI is not
minimal. This audit is the implementation work-order for the corrections below.

---

## F. Implemented Corrections (filled as work lands)

- (pending) Builder minimalization — single flow, logo/SVG config.
- (pending) Web: InfrastructureChangeRequest state machine (per §D requirements).
- (pending) Web: storage destination config + validation.
- (pending) Web: test/validate endpoints, approval endpoints, org-scoped
  migration + switch safety, audit + secrets wiring.