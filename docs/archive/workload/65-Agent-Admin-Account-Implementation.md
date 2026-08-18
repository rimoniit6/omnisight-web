# Phase 2 — Admin Agent-Account Management: Implementation Report

> **Status:** COMPLETE
> **Date:** 2026-08-10
> **Objective:** Make AgentAccount fully manageable from the Admin Panel via API + UI.

---

## 1. Executive Summary

Phase 2 built on the Phase 1 `AgentAccount` model and service to add:

- **4 API endpoints** nested under `/api/employees/[id]/agent-account` (GET/POST/PATCH + reset-password)
- **2 UI components** — `AgentAccountCard` (status display + actions) and `AgentAccountDialog` (create/reset password dialogs)
- **22 new tests** covering create, RBAC, org isolation, reset, enable/disable, audit, rate limit, concurrent safety
- **No schema changes** — the Phase 1 migration is sufficient

---

## 2. Files changed

| File | Action | Purpose |
|---|---|---|
| `src/app/api/employees/[id]/agent-account/route.ts` | **CREATE** | GET (safe status), POST (create), PATCH (enable/disable) |
| `src/app/api/employees/[id]/agent-account/reset-password/route.ts` | **CREATE** | POST (admin-supplied password reset) |
| `src/lib/rate-limit.ts` | **MODIFY** | Added `agentAccountWrite` (20/min/IP) |
| `src/components/employees/agent-account-card.tsx` | **CREATE** | Agent Account status card for employee details page |
| `src/components/employees/agent-account-dialog.tsx` | **CREATE** | Create/reset password dialog with validation |
| `src/components/employees/employee-details-page.tsx` | **MODIFY** | Mounted `AgentAccountCard` below Personal Information |
| `tests/agent-account-admin.test.ts` | **CREATE** | 22 tests (AA-A1…AA-A22) |
| `package.json` | **MODIFY** | Added `test:agent-account-admin` script |

---

## 3. API endpoints

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/employees/:id/agent-account` | `requireAdminOrg` | Returns safe account shape or `{ data: null }` |
| `POST` | `/api/employees/:id/agent-account` | `requireAdminOrg` | Create account (admin-supplied password) |
| `PATCH` | `/api/employees/:id/agent-account` | `requireAdminOrg` | Enable/disable (`{ status: "active"|"disabled" }`) |
| `POST` | `/api/employees/:id/agent-account/reset-password` | `requireAdminOrg` | Reset password (admin-supplied) |

**Security invariants across all four:**

- `organizationId` from request body is **never read** — org comes from the JWT
- `employeeId` from request body is **never read** — the route param is verified org-scoped
- `passwordHash` is **never returned** — `toPublicAccount()` strips it before every response
- Plaintext password is **never logged** — audit descriptions only contain employee name + agentId
- Rate-limited at 20/min/IP via `agentAccountWrite`
- Audited via `AuditLog` with action/resource/description/userId/organizationId/ipAddress

---

## 4. Request/response contracts

### POST create — Request

```json
{ "password": "Admin!SetPass123", "agentId": "OPTIONAL-CUSTOM-ID" }
```

### POST create — Response (201)

```json
{
  "data": {
    "id": "clx...",
    "employeeId": "EMP-001",
    "agentId": "EMP-001",
    "status": "active",
    "lastLoginAt": null,
    "failedLoginCount": 0,
    "lockedUntil": null,
    "passwordChangedAt": "2026-08-10T...",
    "createdAt": "2026-08-10T...",
    "updatedAt": "2026-08-10T..."
  }
}
```

### GET — Response (200, no account)

```json
{ "data": null }
```

### PATCH — Request

```json
{ "status": "disabled" }
```

### POST reset-password — Request

```json
{ "password": "Admin!ResetPass456" }
```

---

## 5. Admin UI

### AgentAccountCard (mounted in employee details page)

Shows four states:

| State | Badge | Actions |
|---|---|---|
| **No account** | "Not Created" (gray) | [Create Agent Account] |
| **Active** | "Active" (green) | [Reset Password] [Disable Account] |
| **Disabled** | "Disabled" (red) | [Reset Password] [Enable Account] |
| **Locked** | "Locked" (orange) with lockout timestamp | [Reset Password] [Disable Account] |

All cards display: Agent ID, Last Login (if any), Password Last Changed (if any).

### AgentAccountDialog

Shared dialog for Create + Reset modes with:
- Password field (with show/hide toggle)
- Confirm password field
- Client-side validation (≥12 chars, uppercase, lowercase, digit)
- Password fields cleared on close
- Disabled submit button while saving

---

## 6. Security model

| Control | Implementation |
|---|---|
| **Authentication** | `requireAdminOrg` on all 4 endpoints — JWT bearer + session cookie |
| **RBAC** | `hasRolePermission(role, 'admin')` — super_admin, owner, admin pass; manager, viewer, unauthenticated fail |
| **Org isolation** | Employee resolved via `findFirst({ id, organizationId: admin.organizationId })` — cross-org → 404 concealment |
| **Password hashing** | bcrypt via `hashPassword()` (cost 12) — never stored plaintext |
| **No hash exposure** | `toPublicAccount()` strips `passwordHash` before every API response |
| **No password logging** | Audit descriptions contain only `employee name (agentId)` — never password or hash |
| **Rate limiting** | `agentAccountWrite` — 20 requests/minute/IP for POST/PATCH |
| **Concurrency safety** | DB unique indexes on `agentId` + `employeeId` — P2002 → 409 |
| **Disabled accounts** | `verifyAgentCredential()` returns `{ ok: false }` before any password check |
| **Locked accounts** | `isLocked()` returns true during lockout window; correct password rejected |

---

## 7. RBAC matrix

| Role | GET | POST | PATCH | RESET |
|---|---|---|---|---|
| super_admin (org-bound) | ✅ | ✅ | ✅ | ✅ |
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ |
| manager | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| viewer | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| unauthenticated | 401 | 401 | 401 | 401 |

---

## 8. Organization isolation evidence

- Cross-org employee ID → 404 (AA-A4)
- Client-supplied `organizationId` in body → ignored by the route (AA-A22)
- Employee always resolved via `findFirst(id, admin.organizationId)` — cross-org ids produce `null` → 404 concealment
- AgentAccount is reached through the employee (1:1 relation), never by a client-supplied account id

---

## 9. Audit logging evidence

| Action | resource | Description pattern |
|---|---|---|
| create | `agent_account` | `Agent account created for <name> (<agentId>)` |
| update | `agent_account` | `Agent account enabled/disabled for <name> (<agentId>)` |
| reset | `agent_account` | `Agent account password reset for <name> (<agentId>)` |

All entries: `userId`, `organizationId`, `ipAddress` from the verified admin session. **No password, no hash, no token in any log entry.**

---

## 10. Test results

| Suite | Result |
|---|---|
| Agent Account Admin (22 new tests) | **22/22 PASS** |
| Full backend regression (12 suites) | **238/238 PASS** (up from 216) |
| Desktop agent | **129/129 PASS** |
| Admin TypeScript | **PASS** |
| Admin production build | **PASS** |

---

## 11. Agent self-registration audit

The desktop agent renderer was searched for: `register`, `sign.?up`, `create.?account`, `self.?registration`.

**Result: ZERO matches for employee self-registration UI.** The only "register" occurrences are:
- `"This device is being registered with WorkLensAI automatically."` — informational zero-touch text
- `"Registering"` — status label on the onboard pill
- `"unregistered"` — auth phase name in the view-mapping switch

The legacy PATH B `register()`/`enroll()` methods exist in `auth-service.ts` and `api/device.ts` but are **never called from the renderer** (no IPC handler invokes them, no preload method exposes them).

**✅ PASS — no employee self-registration capability exists in the agent.**

---

## 12. Known limitations

1. **No server-generated temp password** — the admin enters the password. This is intentional per the master prompt's alternative: "If this architecture is not desired, require the admin to enter a new password instead." It avoids the one-time-secret display/retention problem entirely.
2. **No "Show password on creation"** — the password field uses a show/hide toggle so the admin can verify what they typed. The password is never stored in the UI after the dialog closes.
3. **No unlock** action — lockout is only cleared by admin password reset. This is intentional: a manual "unlock" would bypass the lockout security boundary.

---

## 13. Final verdict

**PHASE 2 COMPLETE**

All required gates verified:

| Gate | Result |
|---|---|
| Admin creates AgentAccount | ✅ (AA-A1) |
| Duplicate → 409 | ✅ (AA-A2) |
| Invalid password → 400 | ✅ (AA-A3) |
| Cross-org employee → 404 | ✅ (AA-A4) |
| Unauthenticated → 401 | ✅ (AA-A5) |
| Viewer → 403 | ✅ (AA-A6) |
| Manager → 403 | ✅ (AA-A7) |
| GET safe shape, no hash | ✅ (AA-A8, AA-A16) |
| GET no account → `data: null` | ✅ (AA-A9) |
| PATCH disable → fail closed | ✅ (AA-A10) |
| PATCH enable → re-grant | ✅ (AA-A11) |
| Reset password — old fails, new works | ✅ (AA-A14) |
| Audit log created, no secret leaked | ✅ (AA-A17, AA-A18) |
| Concurrent create safety | ✅ (AA-A19) |
| Rate limiting | ✅ (AA-A20) |
| Locked account fail closed | ✅ (AA-A21) |
| Client orgId ignored | ✅ (AA-A22) |
| Backend regression | 238/238 PASS |
| Desktop regression | 129/129 PASS |
| Admin tsc + build | PASS |
| No employee self-registration UI | PASS |

---

*Phase 2 complete. STOP per master-prompt instruction. Do NOT start Phase 3 automatically.*