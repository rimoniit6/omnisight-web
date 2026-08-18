# Final Production Release Checklist

Date: 2026-08-10 · Phase G

Status: ✅ PASS · ❌ FAIL · 🔒 BLOCKED (external provisioning required) · ⚠️ NOT VERIFIED

## [P0] Critical

| # | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | Consent enforcement (8 types, fail-closed, approval≠consent) | ✅ PASS | `tests/consent.test.ts` 27/27; workload/62 |
| P0-2 | Zero-touch lifecycle (discover→approve→auto-auth→connect) | ✅ PASS | `tests/zero-touch.test.ts` 29/29; workload/63 |
| P0-3 | Org isolation / RBAC / no client-supplied org trust | ✅ PASS | `tests/security.test.ts` (org/RBAC gates pass); Phase D audit |
| P0-4 | No secrets to renderer; sandbox + CSP intact | ✅ PASS | Phase E regression suite (111/111); renderer-build tests |
| P0-5 | Device revoke immediately invalidates protected ops | ✅ PASS | zero-touch + consent suites; revoke route audit |
| P0-6 | No data-loss path in current (SQLite) DB operations | ✅ PASS | backup/restore executed; workload/52 |

## [P1] Production blockers

| # | Item | Status | Evidence |
|---|---|---|---|
| P1-1 | PostgreSQL production DB + migration | 🔒 BLOCKED | no PG/Docker in env; plan in workload/51 |
| P1-2 | Clean-machine certification executed | 🔒 BLOCKED | no VM; runbook in workload/55 |
| P1-3 | Signed Windows installer | 🔒 BLOCKED | no cert; scaffold in workload/54 |
| P1-4 | Backup performed | ✅ PASS | executed; workload/52 |
| P1-5 | Restore performed | ✅ PASS | executed (SQLite); workload/52 |
| P1-6 | Live HTTPS | 🔒 BLOCKED | no domain/TLS; config verified in workload/53 |
| P1-7 | PostgreSQL backup/restore executed | 🔒 BLOCKED | no PG (procedure documented) |

## [P2] Recommended

| # | Item | Status | Evidence |
|---|---|---|---|
| P2-1 | Background runtime (session) verified | ✅ PASS | code + Phase E tests; workload/56 |
| P2-2 | Windows Service decision documented | ✅ PASS | workload/56 (session-runtime decision) |
| P2-3 | Agent v1.0.0→v1.1.0 artifacts | ✅ PASS | hashes in workload/57 |
| P2-4 | Agent live upgrade executed | ⚠️ NOT VERIFIED | needs Windows machine |
| P2-5 | Performance baseline | ✅ PASS | real measurements; workload/58 |
| P2-6 | Performance re-baseline on PostgreSQL | ⚠️ NOT VERIFIED | blocked by P1-1 |

## [P3] Future

| # | Item | Status | Evidence |
|---|---|---|---|
| P3-1 | External monitoring integrated | ⚠️ NOT VERIFIED | internal health ✅; workload/59 |
| P3-2 | Live Updates WS deployed/verified | ⚠️ NOT VERIFIED | code-audit ✅; workload/60 |
| P3-3 | Password reset (admin-initiated) | ✅ PASS | route audit; workload/61 |
| P3-4 | Self-service email reset | ✅ CLOSED (documented out of scope) | workload/61 |
| P3-5 | Pilot deployment (24h) | 🔒 BLOCKED | no hardware; workload/64 |
| P3-6 | Rollback/recovery procedure | ✅ PASS | workload/47, 48 (documented) |

## Rollback/recovery (P2-6 successor)

- Application: redeploy previous tag (documented).
- Database: restore pre-deployment backup; **never blindly rollback migrations** (additive-only
  migration policy; zero-touch migration verified additive in Phase E).
- Agent: reinstall prior EXE preserves `%APPDATA%` identity/credentials.

## Overall

**Every in-repo-executable gate PASSES.** The release remains blocked on **external provisioning**:
PostgreSQL (P1-1), clean machine (P1-2), code signing (P1-3), live HTTPS (P1-6), and the hardware
pilot (P3-5). See workload/66 for the final verdict.
