# Phase 2 — Admin Agent-Account Management: Read-Only Audit

> **Scope:** READ-ONLY audit. No code was modified.
> **Date:** 2026-08-10
> **Objective:** Determine exactly what Admin APIs, UI controls, and security guards are needed to make `AgentAccount` fully manageable from the Admin Panel.

---

## 1. Current AgentAccount backend status

Phase 1 delivered:

| Component | Status | Notes |
|---|---|---|
| `AgentAccount` Prisma model | ✅ Complete | 1:1 with Employee, agentId @unique, passwordHash (bcrypt), status, lastLoginAt, failedLoginCount, lockedUntil, passwordChangedAt, createdAt, updatedAt |
| Migration `20260810150000_agent_account` | ✅ Applied | Additive table + backfill from Employee.agentPassword |
| `src/lib/agent-account.ts` service | ✅ Complete | createAgentAccount, verifyAgentCredential, resetAgentAccountPassword, setAgentAccountStatus, lookup helpers (none return passwordHash) |
| Lockout (5 fails → 15 min) | ✅ Complete | In verifyAgentCredential |
| Legacy plaintext upgrade | ✅ Complete | On first successful verify |
| Tests (AA-1…AA-12) | ✅ 11/11 | |

**What's MISSING from the backend for Phase 2:**

| Gap | Impact |
|---|---|
| No `/api/agent-accounts` routes exist (no CRUD) | Admin has no way to create/reset/disable agent accounts via the API |
| `AgentAccount.agentId` uses `Employee.employeeId` — the format `WL-EMP-XXXXXX` was proposed but the existing `Employee.employeeId` format (e.g. `EMP-001`) is already globally unique | Minor: the phase recommends a `WL-` prefix; not a security issue |
| No admin-level API for generating temp passwords securely and displaying them once | Must implement a POST route that returns the temp password exactly once in the response body (not in logs, not stored, not re-queryable) |
| No password-reset audit events | `AuditLog` entries for `agent_account.password_reset`, `agent_account.enable`, `agent_account.disable` do not exist |

---

## 2. Current Admin Employee UI status

| Component | Status | Notes |
|---|---|---|
| Employee dialog (`employee-dialog.tsx`) | ✅ Has create/edit | Fields: firstName, lastName, email, phone, designation, employeeId, departmentId, joinDate, status. **NO agent account fields** |
| Employee details page (`employee-details-page.tsx`) | ✅ Has detail view | Header card, personal info, performance tabs, devices tab, projects tab, alerts. **NO agent account section** |
| Devices tab (within employee details) | ✅ Shows devices | Lists devices with status/heartbeat. **NO agent account status** here |

**No `agentAccount` component or UI exists anywhere in `src/components/`.** The employee dialog's `handleSave` sends:
```js
body = { firstName, lastName, email, phone, designation, departmentId, employeeId, joinDate, status }
```
No `agentPassword`, no `createAgentAccount` flag, no password field.

---

## 3. Where AgentAccount should be created

The master prompt's preferred flow (Step 6 — option B):

```
Admin creates Employee
        ↓
Employee saved
        ↓
Admin chooses "Create Agent Account"
        ↓
Agent ID + temporary password generated
```

**Recommended placement:** Add an **"Agent Account" card** in the employee details page (below the "Personal Information" card / alongside the "Projects" section). The card shows:

- [ Create Agent Account ] button when no account exists
- Status badge (Active / Disabled / Locked) when account exists
- Agent ID, Last Login, Password Last Changed display
- [ Reset Password ], [ Enable ], [ Disable ] action buttons

Not in the create-edit dialog — account provisioning is an explicit post-creation action, keeping creation and account provisioning auditable and separate.

---

## 4. Missing API endpoints

| Method | Route | Purpose | Notes |
|---|---|---|---|
| `POST` | `/api/agent-accounts` | Create AgentAccount for an employee | Body: `{ employeeId, agentId?, password? }`. If password omitted, server generates one. Returns temp password once |
| `GET` | `/api/agent-accounts/:id` | View account status (never hash) | Returns agentId, status, lastLoginAt, passwordChangedAt, failedLoginCount, lockedUntil. **Never returns passwordHash or password** |
| `PUT` | `/api/agent-accounts/:id/status` | Enable/disable | Body: `{ status: 'active' | 'disabled' }` | 
| `POST` | `/api/agent-accounts/:id/reset-password` | Reset password, generate temp | Returns temp password exactly once |
| `GET` | `/api/agent-accounts?employeeId=:eid` | Find account by employee | Shorthand for the employee details page |

All endpoints: admin+ RBAC (`requireAdminOrg`), org-scoped, rate-limited, audited.

---

## 5. Missing UI controls

| Control | Where | Notes |
|---|---|---|
| "Agent Account" card with status | Employee details page → above Devices / alongside Projects | Read-only status display + action buttons |
| Create Agent Account dialog | Click "Create Agent Account" → modal with Agent ID (auto-generated) + generated password shown once + "Save this password" warning | Password never stored in UI state |
| Reset Password dialog | Click "Reset Password" → confirm → new password generated + shown once | Same one-time display pattern |
| Enable/Disable toggle | Inline toggle or confirmation dialog | Updates status; disabled account cannot authenticate |
| Locked indicator | Badge when `lockedUntil > now` | No manual unlock (lockout auto-clears on success or admin reset) |

---

## 6. Existing security controls that can be reused

| Control | Source | Reuse in Phase 2 |
|---|---|---|
| `requireAdminOrg` | `src/lib/api.ts` | All agent-account routes — admin+ RBAC + org-scoped |
| `authError` | `src/lib/api.ts` | Error response helper |
| `checkRateLimit` + `RATE_LIMITS` | `src/lib/rate-limit.ts` | Add `agentAccountWrite` limit or reuse `employeeWrite` |
| `AuditLog` | Prisma + existing pattern in employee/department routes | Create audit entries on account create/reset/enable/disable |
| `hashPassword` (bcrypt) | `src/lib/auth.ts` | Temp password hashing |
| `AgentAccountService` | `src/lib/agent-account.ts` | Already has create, reset, setStatus — the API routes just wrap these |
| `randomBytes` | node:crypto — used in `src/lib/agent/auth.ts` | Temp password generation |

---

## 7. Legacy registration audit — desktop agent

Searched `desktop-agent/src/renderer/*` for: `register`, `sign.?up`, `create.?account`, `self.?registration`

**Result: ZERO matches for employee self-registration UI.**

The only occurrences of "register" in the renderer are:
- `index.html` line 29: `"This device is being registered with WorkLensAI automatically."` — informational text in the zero-touch onboarding view
- `index.html` line 33: `"Registering"` — status label for the onboard pill
- `renderer.ts` line 173: `pill.textContent = 'Registering'` — the same status label
- `renderer.ts` line 125: `'unregistered'` — auth phase name in the view-mapping switch

The legacy PATH B `register()` and `enroll()` methods exist in `auth-service.ts` and `api/device.ts` but are **never called from the renderer** (confirmed: no IPC handler invokes them, no preload method exposes them). The zero-control audit already proved the renderer has no login/register/signup form.

**Phase 2 conclusion: The Agent passes the legacy-self-registration audit. No "Register Device" / "Sign Up" / "Create Account" UI exists in the renderer.**

---

## 8. Files that need modification in Phase 2

| File | Change |
|---|---|
| `src/app/api/agent-accounts/route.ts` | **CREATE** — POST create + GET list (admin+ RBAC, org-scoped, rate-limited, audited) |
| `src/app/api/agent-accounts/[id]/route.ts` | **CREATE** — GET + PUT status |
| `src/app/api/agent-accounts/[id]/reset-password/route.ts` | **CREATE** — POST reset-password |
| `src/lib/rate-limit.ts` | **MODIFY** — add `agentAccountWrite` limit |
| `src/components/employees/employee-details-page.tsx` | **MODIFY** — add "Agent Account" card section |
| `src/components/employees/agent-account-card.tsx` | **CREATE** — reusable Agent Account status + action component |
| `src/components/employees/agent-account-dialog.tsx` | **CREATE** — Create/Reset dialog with one-time password display |
| `src/lib/agent-account.ts` | **MODIFY** — add `generateTempPassword()` helper |
| `tests/agent-account-admin.test.ts` | **CREATE** — Phase 2 tests |

---

## 9. Summary of gaps vs requirements

| Requirement | Status |
|---|---|
| Admin can create AgentAccount | ❌ NO API or UI |
| Admin can reset password | ❌ NO API or UI |
| Admin can enable/disable | ❌ NO API or UI |
| Admin can view status (agentId, lastLogin, etc.) | ❌ NO API or UI |
| passwordHash never returned | ✅ Already ensured by `toPublicAccount()` | 
| Temp password shown once, never re-queryable | ❌ NO implementation |
| Temp password never logged | ❌ Must enforce in implementation|
| Org isolation| ✅ Reuse `requireAdminOrg` |
| RBAC (admui+, viewer 403| ✅ Reuse `requireAdminOrg` + `hasRolePermission` |
| Audit logging | ❌ Must add `AuditLog` entries|
| Rate limiting | ❌ Must add `agentAccountWrite` limit |
| Desktop renderer has no self-registration UI | ✅ PASS (confirmed) |
| Legacy PATH B renderer registration is dead code | ✅ True (code exists but disconnected from UI) |

---

*Phase 2 — Read-only audit complete. STOP per STEP 1 instruction — awaiting user confirmation to proceed with Steps 2–14 implementation.*</parameter>