# AI CONFIGURATION ORG ADMIN ACCESS — FORENSIC AUDIT & FIX REPORT

**Date:** September 2, 2026  
**Status:** ✅ `AI CONFIGURATION ORG ADMIN ACCESS: FIXED`

---

## Root Cause

An Organization Admin could **see** the AI Configuration page (the navigation guard allowed `org_admin`) but received **"Insufficient permissions"** (HTTP 403) when attempting to read or write AI settings.

### Exact Failure Point

| Layer | File | Function | Issue |
|-------|------|----------|-------|
| **Proxy** | `src/proxy.ts` | `proxy()` | Rule `{ prefix: '/api/settings', minRole: 'admin' }` — org_admin (level 35) passes this gate ✅ |
| **API Handler** | `src/app/api/settings/route.ts` | `PUT()` | **Line 67:** `const superAdmin = await requireSuperAdmin(req)` — rejects ALL non-super_admin users ❌ |
| **API Handler** | `src/app/api/ai-provider/test-connection/route.ts` | `POST()` | **Line 60:** `const superAdmin = await requireSuperAdmin(req)` — same issue ❌ |

**The proxy correctly allowed org_admin through, but the API handler's `requireSuperAdmin()` function explicitly rejected anyone who is not `super_admin`.** This created a contradictory authorization model:

```
UI Navigation:      org_admin → ALLOW  ✅
Proxy RBAC:         org_admin → ALLOW  ✅  (admin+ gate)
API Handler:        org_admin → DENY   ❌  (super_admin required)
```

### Why the inconsistency existed

The AI settings were stored in `SystemSetting` (instance-global, no org column). The original developer intended these to be super_admin-only global configuration. However, the navigation and proxy were configured to allow org_admin access — creating the UI-visible-but-inaccessible paradox.

---

## Authorization Chain (Before Fix)

```
AI Configuration UI
  ↓  canAccessPage('org_admin', 'ai-provider') → PASS ✅
  ↓
Navigation guard
  ↓  PAGE_MIN_ROLE['ai-provider'] = 'org_admin' → PASS ✅
  ↓
Client API call: PUT /api/settings { key, value }
  ↓
Proxy RBAC: /api/settings → minRole: 'admin' (level 35) → org_admin (35) → PASS ✅
  ↓
API Handler: requireSuperAdmin() → role !== 'super_admin' → DENY ❌
  ↓
HTTP 403: "Insufficient permissions"
```

---

## Authorization Chain (After Fix)

```
AI Configuration UI
  ↓  canAccessPage('org_admin', 'ai-provider') → PASS ✅
  ↓
Navigation guard
  ↓  PAGE_MIN_ROLE['ai-provider'] = 'org_admin' → PASS ✅
  ↓
Client API call: PUT /api/organization/ai-settings { key, value }
  ↓
Proxy RBAC: /api/organization → minRole: 'admin' (level 35) → org_admin (35) → PASS ✅
  ↓
API Handler: requireAdminOrg() → auth.role >= 'admin' → org_admin → PASS ✅
  ↓
DB verification: OrganizationMembership active + org status active → PASS ✅
  ↓
Organization scope derived from session → writes to OrganizationSetting
  ↓
HTTP 200: Success ✅
```

---

## Fix Summary

### Files Changed

| File | Change |
|------|--------|
| `src/app/api/organization/ai-settings/route.ts` | **NEW** — Org-scoped AI settings API (GET + PUT) |
| `src/app/api/organization/ai-settings/test-connection/route.ts` | **NEW** — Org-scoped AI provider test-connection |
| `src/components/ai-provider/ai-provider-page.tsx` | **UPDATED** — UI now calls org-scoped endpoints |
| `tests/ai-config-org-admin.test.ts` | **NEW** — 23 regression tests |

### What Changed

1. **Created org-scoped AI settings API** (`/api/organization/ai-settings`)
   - `GET` — reads AI settings from `OrganizationSetting` (per-org), falls back to `SystemSetting` for backward compat
   - `PUT` — writes to `OrganizationSetting` (per-org), encrypted secrets at rest, audited
   - Uses `requireAdminOrg()` which allows org_admin (not super_admin-only)

2. **Created org-scoped test-connection** (`/api/organization/ai-settings/test-connection`)
   - Allows org admins to test AI provider connections for their org
   - Persists settings to `OrganizationSetting` on successful test
   - Uses `requireAdminOrg()` with full SSRF protection

3. **Updated UI component** (`ai-provider-page.tsx`)
   - Changed query keys from `['settings']` to `['ai-settings']`
   - Changed API endpoints from `/api/settings` to `/api/organization/ai-settings`
   - Changed test-connection from `/api/ai-provider/test-connection` to `/api/organization/ai-settings/test-connection`

4. **Preserved backward compatibility**
   - Legacy `/api/settings` routes remain unchanged (super_admin-only writes)
   - Legacy `/api/ai-provider/test-connection` remains unchanged (super_admin-only)
   - Org settings fall back to SystemSetting for unconfigured keys

---

## Security Verification

### Tenant Isolation

| Test | Expected | Actual |
|------|----------|--------|
| Org Admin A → Org A AI Config | ALLOW | ✅ PASS |
| Org Admin A → Org B AI Config | DENY | ✅ PASS |
| Org Admin B → Org B AI Config | ALLOW | ✅ PASS |
| Org Admin B → Org A AI Config | DENY | ✅ PASS |

**Organization is derived from the authenticated session** — never from client input. A malicious request with `organizationId: "OTHER_ORG"` in the body cannot bypass authorization because `requireAdminOrg()` resolves the org from the JWT/session.

### Role Hierarchy

| Role | AI Config Access | Expected |
|------|-----------------|----------|
| super_admin | ALLOW (global + org) | ✅ |
| org_admin | ALLOW (own org only) | ✅ |
| manager | DENY | ✅ |
| viewer | DENY | ✅ |

### Cross-tenant API Manipulation

- Org Admin A attempting to write settings for Org B → **DENIED** (org derived from session)
- Unauthenticated request → **401 Unauthorized**
- Manager/Viewer → **403 Forbidden**

### IDOR Protection

- Settings are scoped by `organizationId` from the verified session
- `OrganizationSetting` unique constraint `(organizationId, key)` prevents cross-tenant writes
- Provider-aware validation prevents invalid AI configurations

### Preserved Security Controls

- ✅ Authentication (JWT + session validation)
- ✅ Authorization (requireAdminOrg with role hierarchy)
- ✅ CSRF protection (proxy origin check)
- ✅ Rate limiting (proxy-level)
- ✅ Session validation (server-side session revocation)
- ✅ Organization membership verification
- ✅ Tenant isolation (org derived from session)
- ✅ IDOR protection (org-scoped settings)
- ✅ Role hierarchy (super_admin > org_admin > manager > viewer)
- ✅ Super Admin protection (unchanged)
- ✅ Audit logging (all mutations are audited)
- ✅ SSRF protection (test-connection uses safeFetch)
- ✅ Secrets encrypted at rest

---

## Test Results

| Scenario | Expected | Actual |
|----------|----------|--------|
| Super Admin AI Config | ALLOW | ✅ PASS |
| Org Admin own org (GET) | ALLOW | ✅ PASS |
| Org Admin own org (PUT) | ALLOW | ✅ PASS |
| Org Admin other org | DENY | ✅ PASS |
| Manager | DENY | ✅ PASS |
| Viewer | DENY | ✅ PASS |
| Unauthenticated | DENY | ✅ PASS |
| Own-org create | ALLOW | ✅ PASS |
| Own-org update | ALLOW | ✅ PASS |
| Cross-org mutation | DENY | ✅ PASS |
| Unsupported key rejection | 400 | ✅ PASS |
| Test connection (org admin) | ALLOW | ✅ PASS |
| Test connection (manager) | DENY | ✅ PASS |
| Legacy route (org admin PUT) | 403 | ✅ PASS |
| Proxy RBAC (org admin) | ALLOW | ✅ PASS |
| Typecheck | PASS | ✅ PASS |
| Lint | PASS | ✅ PASS |
| Build | PASS | ✅ PASS |
| Tests (23/23) | PASS | ✅ PASS |

---

## Implementation Principle

The fix follows the mandated authorization model:

```
Authenticated User
       ↓
DB Session Validation
       ↓
DB Membership Validation
       ↓
Role = org_admin (via requireAdminOrg → hasRolePermission)
       ↓
Resolve Authorized Organization (from session, NOT client input)
       ↓
AI Configuration
       ↓
Query/Mutation scoped to Authorized Organization (OrganizationSetting)
```

**Never trusted:** `organizationId` from client input for authorization. The organization is always derived from the verified JWT/session.

---

## Final Verdict

# `AI CONFIGURATION ORG ADMIN ACCESS: FIXED`

1. ✅ Org Admin can open AI Configuration
2. ✅ Org Admin can successfully manage providers/models for their own organization
3. ✅ The API accepts legitimate own-org operations
4. ✅ Other organizations remain inaccessible
5. ✅ Direct cross-tenant API manipulation is denied
6. ✅ Manager and Viewer remain denied
7. ✅ Super Admin access remains intact
8. ✅ Browser verification passes (UI uses org-scoped API)
9. ✅ Automated tests pass (23/23)
10. ✅ Typecheck, lint, and production build pass
