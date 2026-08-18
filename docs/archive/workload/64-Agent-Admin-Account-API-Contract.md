# Phase 2 — STEP 1: Agent Account API Design Contract

> **Scope:** READ-ONLY. No code modified.
> **Objective:** Lock the REST contract for Admin-side AgentAccount management before implementation.

---

## 1. Route structure decision

The master prompt proposes `/api/admin/employees/[id]/agent-account`. The existing project **already nests employee sub-resources** under `/api/employees/[id]/...`:

- `src/app/api/employees/[id]/route.ts` (GET/PUT/DELETE)
- `src/app/api/employees/[id]/detail/route.ts`
- `src/app/api/employees/[id]/projects/route.ts`
- `src/app/api/employees/[id]/performance/route.ts`

There is **no `/api/admin/*` prefix anywhere** in the codebase. Introducing one for a single feature would break the established convention and complicate the proxy whitelist. **Decision: use the project-consistent nested path.**

### Final API contract

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/employees/:employeeId/agent-account` | Fetch safe account status (or "not configured") |
| `POST` | `/api/employees/:employeeId/agent-account` | Create account (admin-supplied password) |
| `PATCH` | `/api/employees/:employeeId/agent-account` | Enable/disable (`{ status }` only) |
| `POST` | `/api/employees/:employeeId/agent-account/reset-password` | Reset password (admin-supplied new password) |

File layout:
```
src/app/api/employees/[id]/agent-account/route.ts          (GET, POST, PATCH)
src/app/api/employees/[id]/agent-account/reset-password/route.ts  (POST)
```

---

## 2. Request schemas

### POST `/api/employees/:employeeId/agent-account`

```json
{
  "password": "Admin!SetPass123",
  "agentId": "OPTIONAL-CUSTOM-ID"
}
```

- `password` — REQUIRED (admin supplies it; matches Step 4/7/8 UX which uses admin-entered passwords; no server-generated temp password handoff needed — simpler and avoids one-time-secret display concerns).
- `agentId` — OPTIONAL. Defaults to `Employee.employeeId` (Phase 1 behavior). Client-supplied `agentId` is validated: unique, 3–64 chars, `[A-Za-z0-9._-]` only. Never derived from the employee's DB id in the URL.

### PATCH `/api/employees/:employeeId/agent-account`

```json
{ "status": "active" }
```
Allowed: `active | disabled`. Only this field is read — `agentId`, `passwordHash`, `employeeId`, `organizationId` are never accepted.

### POST `/api/employees/:employeeId/agent-account/reset-password`

```json
{ "password": "Admin!ResetPass456" }
```

---

## 3. Response schemas

### GET 200 — account exists

```json
{
  "data": {
    "id": "clx…",
    "employeeId": "EMP-001",
    "agentId": "EMP-001",
    "status": "active",
    "lastLoginAt": "2026-08-10T12:00:00.000Z",
    "failedLoginCount": 0,
    "lockedUntil": null,
    "passwordChangedAt": "2026-08-10T11:00:00.000Z",
    "createdAt": "2026-08-10T10:00:00.000Z",
    "updatedAt": "2026-08-10T11:00:00.000Z"
  }
}
```

### GET 200 — no account ("not configured", NOT an error)

```json
{ "data": null }
```

### POST 201 / PATCH 200 / RESET 200

Same safe shape as GET. **Never** `passwordHash`, `password`, tokens.

### Errors

| Case | Status |
|---|---|
| Unauthenticated | 401 |
| Viewer / insufficient role | 403 |
| Employee not found or cross-org | 404 (concealment — org-scoped `findFirst`) |
| Duplicate account (create) | 409 |
| Invalid password (policy) | 400 |
| Invalid status (patch) | 400 |
| Invalid agentId format | 400 |
| Rate limit exceeded | 429 |
| Reset on non-existent account | 404 |

---

## 4. Authorization model

| Role | GET | POST | PATCH | RESET |
|---|---|---|---|---|
| super_admin (org-bound) | ✅ | ✅ | ✅ | ✅ |
| owner / admin | ✅ | ✅ | ✅ | ✅ |
| manager | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| viewer | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| unauthenticated | 401 | 401 | 401 | 401 |
| agent (AgentToken) | N/A (never accepted by admin JWT middleware) | | | |

Implementation: `requireAdminOrg(req)` — requires org-bound JWT **and** `hasRolePermission(role, 'admin')` (super_admin=50, owner=40, admin=30 pass; manager=20, viewer=10 fail). GET uses the same gate for consistency with the rest of employee management (the employees GET route uses `requireSessionOrg`; the details route uses admin gate — agent-account is a mutation surface, so **all four verbs use `requireAdminOrg`** — a viewer must not even read lockout/status internals).

---

## 5. Organization isolation strategy

1. **Employee ownership** — resolve the employee with `findFirst({ where: { id: employeeId, organizationId: admin.organizationId } })`. Cross-org id → `null` → **404** (concealment).
2. **AgentAccount ownership** — the account is found **via the org-scoped employee** (`employee.agentAccount`), never by a client-supplied account id. There is no `:accountId` in any route.
3. `organizationId` in the request body is **ignored** — never read.
4. `employeeId` in the request body is **ignored** — the route param is used, then verified org-scoped.

---

## 6. Rate-limit strategy

Add to `src/lib/rate-limit.ts`:

```ts
agentAccountWrite: { limit: 20, windowMs: 60 * 1000 }, // create/reset/status / IP
```

- Applied to POST, PATCH, RESET with `checkRateLimit('agent-account-write:' + clientIp, ...)`.
- GET is not rate-limited (cheap, authenticated read) — or reuse `employeeWrite` (30/min) if a single key is preferred. **Decision: dedicated `agentAccountWrite` 20/min/IP.**
- IP from `getClientIpFromHeaders(req.headers)` (spoof-resistant, rightmost XFF).

---

## 7. Audit-log strategy

Reuse `tx.auditLog.create` (existing pattern from `employees/[id]/route.ts`):

| Action | resource | Description |
|---|---|---|
| create | `agent_account` | `Agent account created for <first> <last> (<agentId>)` |
| update | `agent_account` | `Agent account <enabled|disabled> for <name> (<agentId>)` |
| reset | `agent_account` | `Agent account password reset for <name> (<agentId>)` |

All entries: `userId: admin.userId`, `organizationId: admin.organizationId`, `ipAddress: clientIp`. **Never** include the password or hash in `description`/`metadata`. Audit writes happen **inside the same transaction** as the mutation.

---

## 8. Race-condition / duplicate strategy

- Unique `AgentAccount.agentId` + unique `Employee.employeeId` (1:1) constraints provide DB-level protection.
- POST create: wrap in `db.$transaction`; catch `P2002` → **409** `"Agent account already exists for this employee"`.
- Cross-instance safety: the unique index is the source of truth — even two concurrent POSTs cannot create two accounts.
- Test: `Promise.all` two concurrent creates → exactly one succeeds (201), one 409.

---

## 9. Password handling

- Admin **enters** the password (create + reset) — no server-generated temp password, so no one-time-secret display/retention problem. This matches the master prompt's explicit alternative: *"If this architecture is not desired, require the admin to enter a new password instead."*
- Validate with existing `validateAgentPassword()` (≥12 chars, upper, lower, digit).
- Hash with existing `hashPassword()` (bcrypt, cost 12).
- Reset clears `failedLoginCount` + `lockedUntil`, sets `passwordChangedAt`.
- Never logged, never in audit descriptions, never in GET responses, never stored plaintext.

---

## 10. Test plan (tests/agent-account-admin.test.ts)

| # | Case | Expect |
|---|---|---|
| AA-A1 | Admin creates account (201) | safe shape, no hash |
| AA-A2 | Duplicate create → 409 | |
| AA-A3 | Invalid password → 400 | |
| AA-A4 | Cross-org employee → 404 | |
| AA-A5 | Unauthenticated → 401 | |
| AA-A6 | Viewer → 403 | |
| AA-A7 | Manager → 403 | |
| AA-A8 | GET account (200, safe fields, no hash) | |
| AA-A9 | GET no account → `data: null` (200) | |
| AA-A10 | PATCH disable → status disabled; verifyAgentCredential fails | |
| AA-A11 | PATCH enable → status active; login works with existing password | |
| AA-A12 | PATCH invalid status → 400 | |
| AA-A13 | PATCH ignores agentId/passwordHash in body | |
| AA-A14 | Reset password → old fails, new works, lockout cleared | |
| AA-A15 | Reset on missing account → 404 | |
| AA-A16 | Password hash never in any response body | |
| AA-A17 | Audit log entries created (create/reset/enable/disable) | |
| AA-A18 | Audit log description contains no password/hash | |
| AA-A19 | Concurrent create → exactly one 201 + one 409 | |
| AA-A20 | Rate limit → 429 after N attempts | |
| AA-A21 | Disabled account fails closed; locked account fails closed | |
| AA-A22 | Client-supplied organizationId in body ignored | |

Reuse the throwaway-PostgreSQL harness from `tests/agent-account.test.ts` (workai_test_agentaccount_admin).

---

## 11. Files (planned for later steps)

| File | Action |
|---|---|
| `src/app/api/employees/[id]/agent-account/route.ts` | CREATE (GET/POST/PATCH) |
| `src/app/api/employees/[id]/agent-account/reset-password/route.ts` | CREATE (POST) |
| `src/lib/rate-limit.ts` | MODIFY (+agentAccountWrite) |
| `src/components/employees/agent-account-card.tsx` | CREATE (UI states A–D) |
| `src/components/employees/agent-account-dialog.tsx` | CREATE (create/reset dialogs) |
| `src/components/employees/employee-details-page.tsx` | MODIFY (mount card) |
| `tests/agent-account-admin.test.ts` | CREATE |
| `workload/65-Agent-Admin-Account-Implementation.md` | CREATE (Step 12) |

---

*STEP 1 complete — STOP per the master prompt. Awaiting approval to proceed to STEP 2 (create account API).*
