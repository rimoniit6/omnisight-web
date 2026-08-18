# Authentication Recovery Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| Admin-initiated password reset (backend) | ✅ PASS — `PUT /api/auth/users/[id]` |
| Reset is admin-role-protected | ✅ PASS (`hasRolePermission(role,'admin')`; super_admin protection) |
| Password hashing on reset | ✅ PASS (bcrypt via `hashPassword`) |
| Audit logging of reset | ✅ PASS (`auditLog` entry records the change) |
| Self-service email reset (token flow) | ⚠️ **NOT REQUIRED FOR CURRENT RELEASE** (documented decision below) |
| Login rate limiting | ✅ PASS (login: 10/5min/IP+email) |
| No secrets in logs | ✅ PASS (logger redaction + no token logging) |

---

## 1. Existing recovery mechanism (verified)

`src/app/api/auth/users/[id]/route.ts` `PUT`:
- Admin-only (JWT + `hasRolePermission('admin')`).
- `password` field (≥8 chars) → `hashPassword()` (bcrypt) → persisted.
- Cannot modify `super_admin` unless caller is `super_admin`.
- Writes an `AuditLog` (action `update`, resource `user`) recording the change.
- Combined with `POST /api/auth/login` (rate-limited, constant-time-ish bcrypt compare) and
  httpOnly session cookies.

**Supported recovery path:** a super-admin/owner resets a locked-out admin's password from the
admin Users screen (or via the same API from ops tooling). This is the documented recovery
procedure in `workload/48` §Recovery.

## 2. Decision: self-service email reset

**NOT REQUIRED FOR CURRENT RELEASE.** Rationale:
- The product is a single-tenant admin console (1 org); operators provision admin accounts and
  reset passwords via the admin Users screen — no public self-service signup exists.
- There is **no email integration** in the codebase (no nodemailer/resend/etc.) — building one
  would add new product infrastructure, which Phase G explicitly forbids.
- The existing admin-initiated reset satisfies the operational need.

## 3. Security requirements (if self-service reset is later added)

- Cryptographically random one-time reset token (≥32 bytes), short expiry (≤30 min)
- Hashed token storage; invalidate old tokens on use/new request
- Rate limiting on the request endpoint
- No password/token in logs
- Audit every reset event
- Email integration or an explicitly documented admin recovery procedure (the current admin
  route already provides the latter)

## 4. Conclusion

**P3 blocker B-11 CLOSED** with a documented decision: admin-initiated password reset exists and
is secure; self-service email reset is explicitly out of scope for this release.
