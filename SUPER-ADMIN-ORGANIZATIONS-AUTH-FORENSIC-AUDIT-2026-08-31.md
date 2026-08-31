# SUPER ADMIN ORGANIZATIONS — INTERMITTENT AUTHORIZATION FORENSIC AUDIT

## OmniSight — 2026-08-31

### READ-ONLY AUDIT — NO CODE CHANGES MADE

---

## Executive Summary

The intermittent Super Admin authorization failure is caused by a **stale in-memory JWT token after organization switch**. The `OrgSwitcher` component calls `login(token, ...)` with the OLD token after a successful switch, but the switch endpoint only updates the httpOnly cookie — it does NOT return the new JWT in the response body. Subsequent calls to `useCurrentUser()` send this stale token in the `Authorization` header, which fails the P2-01 `verifySessionActiveOrg` check in `/api/auth/me` because the session's `activeOrganizationId` has been updated to the new organization while the JWT still carries the old (or null) `activeOrganizationId`.

This produces a **401 Unauthorized** response from `/api/auth/me`, causing `useCurrentUser()` to return `user: null`. The desktop sidebar masks this with a Zustand fallback (`authUser`), but the **mobile sidebar** and **user info block** do not have this fallback, producing empty navigation and "Please sign in" states.

The issue is **intermittent** because:
- **Works on fresh login** (token matches session)
- **Works after page refresh** (hydrate reads from fresh cookie)
- **Fails after org switch** (in-memory token stale, cookie fresh)
- **Works again after page refresh** (hydrate restores from cookie)

---

## Exact Reproduction Steps

```
1. Login as Super Admin
2. Navigate to Super Admin → Organizations (works)
3. Use Organization Switcher → select Organization A (switch succeeds)
4. Navigate to Super Admin → Organizations again
5. Observe: sidebar may be empty (mobile), user info hidden,
   or API calls fail with 401
6. Hard-refresh the page (F5)
7. Observe: everything works again
8. Switch to another organization
9. Observe: failures reappear
```

---

## Observed Behavior

| State | Symptom |
|-------|---------|
| Fresh login | ✅ Works correctly |
| After org switch (same tab) | ❌ `useCurrentUser()` returns null → empty mobile sidebar, hidden user info |
| After page refresh | ✅ Works again |
| After second org switch | ❌ Fails again |
| Multiple tabs, one switches | ❌ Other tab's `useCurrentUser()` fails |

---

## Expected Behavior

After organization switch:
- `useCurrentUser()` should return the current user with `role: 'super_admin'`
- Navigation should remain fully functional
- No "Unauthorized" / "Please sign in" messages should appear

---

## Authentication Flow (Traced)

### Login Flow
```
POST /api/auth/login
  → verifyPassword → OK
  → resolveActiveMembership → null (Super Admin has no org)
  → JWT signed: { userId, role: 'super_admin', activeOrganizationId: undefined }
  → Session row created: { activeOrganizationId: null }
  → Cookie set with JWT
  → Response: { token, user, organization: null }
```

### Hydrate Flow (Page Load)
```
useEffect → hydrate()
  → GET /api/auth/me (cookie only, no Authorization header)
    → getRequestToken → reads cookie → OK
    → verifySessionToken → JWT OK, session active, P2-01: session.activeOrganizationId=null, JWT.activeOrganizationId=undefined → null check → TRUE
    → Returns: { user: { role: 'super_admin' }, organization: null, organizationCount: 14 }
  → POST /api/auth/refresh-token (cookie only)
    → Same verification → OK
    → New JWT signed: { activeOrganizationId: undefined }
    → Session expiry extended
    → New cookie set
    → Response: { token: newJWT, user }
  → Store updated: { token: newJWT, user, isAuthenticated: true, _hydrated: true }
```

### useCurrentUser Flow
```
useCurrentUser() hook
  → enabled: !!token (requires in-memory token)
  → queryKey: ['auth-me']
  → queryFn: fetch('/api/auth/me', { headers: { Authorization: 'Bearer <in-memory-token>' } })
  → Proxy: getToken → reads Authorization header FIRST → uses in-memory token
  → Route: verifySessionToken → P2-01 check
```

**Critical**: The proxy's `getToken()` function reads the Authorization header first, falling back to the cookie only when no header is present:
```typescript
function getToken(req: NextRequest): string | null {
  const header = extractToken(req);
  if (header) return header;  // ← HEADER TAKES PRIORITY
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  return cookie?.value || null;
}
```

### Organization Switch Flow (THE BUG)
```
OrgSwitcher → handleSwitch(orgId)
  → POST /api/me/organization/switch
    → Headers: { Authorization: 'Bearer <OLD-token>' }
    → Body: { organizationId: 'OrgA' }
    → Server: authenticateRequest → verifySessionToken → P2-01: session.activeOrg=null, JWT.activeOrg=undefined → TRUE (null check)
    → Server: Super Admin → verify org exists and is active → OK
    → Server: signJWT({ activeOrganizationId: 'OrgA' }) → NEW JWT
    → Server: update session row → activeOrganizationId: 'OrgA'
    → Server: setSessionCookie(response, NEW_JWT)
    → Response: { activeOrganizationId: 'OrgA', role: 'super_admin', organization: { id, name } }
    → NOTE: Response does NOT contain the new JWT!

  → Client: login(token!, authUser!, newOrg)
    → token! = OLD JWT (from Zustand store, NOT the new one from cookie)
    → Store updated: { token: OLD_JWT, user, organization: OrgA }
    → In-memory token is STALE!

  → Client: queryClient.invalidateQueries()
    → useCurrentUser() refetches
    → Sends: Authorization: Bearer <OLD_JWT>
    → Proxy: reads header → OLD JWT → passes (proxy doesn't do P2-01)
    → /api/auth/me: reads header → OLD JWT → verifySessionToken → P2-01:
        session.activeOrganizationId = 'OrgA'
        JWT.activeOrganizationId = undefined (or old value)
        'OrgA' !== undefined → FALSE!
    → verifySessionToken returns null
    → /api/auth/me returns 401
    → useCurrentUser() → error → user = null
```

---

## Session Lifecycle

| Event | In-Memory Token | Cookie JWT | Session Row | P2-01 Match |
|-------|----------------|------------|-------------|-------------|
| Fresh login | JWT(undefined) | JWT(undefined) | null | ✅ |
| After hydrate | JWT-new(undefined) | JWT-new(undefined) | null | ✅ |
| After switch to OrgA | JWT-old(undefined) | JWT-new(OrgA) | OrgA | ❌ |
| After page refresh | JWT-new(OrgA) | JWT-new(OrgA) | OrgA | ✅ |
| After switch to OrgB | JWT-old(undefined) | JWT-new(OrgB) | OrgB | ❌ |

---

## Super Admin Role Resolution

The Super Admin role is correctly resolved at every layer:

| Layer | Source | Value | Correct? |
|-------|--------|-------|----------|
| DB (AppUser.role) | Database | `super_admin` | ✅ |
| Login JWT | `effectiveRole` | `super_admin` | ✅ |
| `/api/auth/me` response | `effectiveRole` | `super_admin` | ✅ |
| Zustand store | `user.role` | `super_admin` | ✅ |
| `useCurrentUser()` | API response | `super_admin` (when token valid) | ✅ |
| Navigation permission | `canAccessPage('super_admin', ...)` | always true | ✅ |

**The role itself is never the problem.** The issue is that `useCurrentUser()` returns `null` (not the wrong role), and components that depend on it see no user at all.

---

## Organization Context Resolution

| Scenario | `activeOrgId` (JWT) | `activeOrgId` (Session) | Match? |
|----------|---------------------|------------------------|--------|
| Fresh Super Admin login | `undefined` | `null` | ✅ (null check) |
| After switch to OrgA | `OrgA` | `OrgA` | ✅ |
| After switch, stale token | `undefined` | `OrgA` | ❌ |

The P2-01 check in `verifySessionActiveOrg` (`src/lib/session.ts:106`):
```typescript
return session.activeOrganizationId === jwtActiveOrgId;
```

When session has `OrgA` and JWT has `undefined`: `"OrgA" === undefined` → `false`.

---

## Middleware / Proxy Analysis

### Proxy (`src/proxy.ts`)

| Check | Mechanism | P2-01 Org Check? |
|-------|-----------|-------------------|
| Token extraction | Header first, cookie fallback | N/A |
| JWT verification | `verifyJWT()` | No |
| Session active check | `isWebSessionActive()` | No |
| P2-01 org match | **NOT PERFORMED** | **NO** |
| CSRF check | Origin header comparison | N/A |
| RBAC | `hasRolePermission()` on JWT role | No |

**Finding**: The proxy does NOT perform the P2-01 `verifySessionActiveOrg` check. This means requests with a stale `activeOrganizationId` in the JWT pass the proxy. The P2-01 check is only performed in `verifySessionToken` (used by `/api/auth/me` and `/api/auth/refresh-token`).

This creates an inconsistency:
- **Proxy allows** requests with stale org context (JWT ≠ session)
- **`/api/auth/me` rejects** requests with stale org context (P2-01 check)
- **`/api/auth/refresh-token` rejects** requests with stale org context (P2-01 check)

The consequence: `useCurrentUser()` passes the proxy but fails at `/api/auth/me`.

---

## API Authorization Analysis

### `/api/super-admin/organizations` (GET)
- **Proxy**: No RBAC rule (not in `ROLE_RULES`) → passes through
- **Route**: `requireSuperAdmin()` → `authenticateRequest()` → `verifySessionToken()`
- **Auth source**: Cookie (when called from SuperAdminOrganizationsPage without Authorization header)
- **Result**: ✅ Works (cookie has fresh JWT)

### `/api/auth/me` (GET)
- **Proxy**: No RBAC rule → passes through
- **Route**: `verifySessionToken()`
- **Auth source**: Authorization header (from `useCurrentUser()`) → **STALE TOKEN**
- **Result**: ❌ Fails after org switch (P2-01 mismatch)

### `/api/auth/refresh-token` (POST)
- **Proxy**: No RBAC rule → passes through
- **Route**: `verifySessionToken()`
- **Auth source**: Cookie (from `hydrate()`) or header (from other callers)
- **Result**: ✅ Works when called from hydrate (cookie)

### `/api/me/organization/switch` (POST)
- **Proxy**: No RBAC rule → passes through
- **Route**: `authenticateRequest()` → `verifySessionToken()`
- **Auth source**: Authorization header (from OrgSwitcher)
- **Result**: ✅ Works (before switch, P2-01 passes because session has null org)

---

## Client State Analysis

### Zustand Auth Store (`src/lib/store.ts`)

| Field | Set by | Can become stale? |
|-------|--------|-------------------|
| `token` | `hydrate()` (refresh), `login()` | **YES** — `login()` in OrgSwitcher passes old token |
| `user` | `hydrate()` (me), `login()`, `refresh` | No (refresh updates it) |
| `organization` | `hydrate()` (me), `login()`, `refresh` | No (OrgSwitcher updates it) |
| `organizationCount` | `hydrate()` (me) | No |
| `isAuthenticated` | `hydrate()`, `login()`, `logout()` | No |
| `_hydrated` | `hydrate()`, `login()`, `logout()` | No (never goes back to false) |

**The `token` field is the only field that becomes stale after org switch.**

### React Query Auth (`useCurrentUser()`)

| Property | Value | Issue |
|----------|-------|-------|
| Query key | `['auth-me']` | Does NOT include token → token changes don't trigger refetch |
| Enabled | `!!token` | If token is null, query never fires |
| Auth source | `Authorization: Bearer <token>` | Uses stale in-memory token |
| Fallback | None | If header fails, doesn't try cookie |
| staleTime | 5 min | Auto-refetch after 5 min, but with same stale token |
| retry | 1 | Retry also uses stale token |

---

## React Query / Cache Analysis

The `['auth-me']` query key does not include the token. This means:
1. When `queryClient.invalidateQueries()` is called after org switch, the query refetches
2. But the refetch uses the same stale token from the closure
3. The refetch fails with 401
4. React Query caches the error
5. Subsequent renders see `user: null`

The `staleTime: 5 * 60 * 1000` means React Query auto-refetches every 5 minutes. But each refetch uses the same stale token. So the user remains "unauthorized" until a page refresh.

---

## Server vs Client Auth Analysis

| Component | Auth Source | Stale After Switch? |
|-----------|------------|---------------------|
| `hydrate()` | Cookie | No (cookie is fresh) |
| `useCurrentUser()` | In-memory token | **YES** |
| `SuperAdminOrganizationsPage` query | Cookie (no header) | No |
| OrgSwitcher `fetchOrganizations` | Cookie (no header) | No |
| OrgSwitcher `handleSwitch` | In-memory token (header) | N/A (before switch) |
| AppSidebar badge queries | Cookie (no header) | No |
| Mobile sidebar | `useCurrentUser()` | **YES** |

**The inconsistency**: Some components use cookie auth (via `credentials: 'same-origin'`), while `useCurrentUser()` uses header auth. After an org switch, the cookie is fresh but the header token is stale.

---

## 401 / 403 Error Mapping

| UI Message | Source | HTTP Status | Trigger |
|------------|--------|-------------|---------|
| "Unauthorized. Please sign in." | `src/proxy.ts:243` | 401 | Missing/invalid token OR P2-01 mismatch at `/api/auth/me` |
| "Invalid or expired token" | `src/proxy.ts:249` | 401 | JWT verification fails OR session inactive |
| "Insufficient permissions" | `src/proxy.ts:289` | 403 | RBAC check fails (role below minRole) |
| "Your session expired. Please sign in again." | `src/components/anomalies/anomalies-page.tsx:194` | 401 | Page-specific 401 handler |
| "Failed to fetch user" | `src/hooks/use-current-user.ts:47` | (thrown) | `/api/auth/me` returns non-OK |

**For Super Admin**: The "Insufficient permissions" (403) message should NOT occur because `super_admin` satisfies all RBAC rules. If it does occur, it indicates a different issue (e.g., the user is not actually a Super Admin, or the JWT role is corrupted).

The "Unauthorized" / "Please sign in" messages occur when:
1. `useCurrentUser()` sends stale token → `/api/auth/me` → P2-01 fails → 401
2. Specific page handlers catch 401 and display toast

---

## Concurrency / Race Condition Analysis

### Race 1: Org Switch + useCurrentUser Refetch (CONFIRMED)

```
T0: User clicks "Switch to OrgA"
T1: POST /api/me/organization/switch → cookie updated, session updated
T2: login(token_old, ...) → in-memory token NOT updated
T3: queryClient.invalidateQueries() → all queries refetch
T4: useCurrentUser() refetches /api/auth/me with stale token
T5: /api/auth/me → P2-01 fails → 401
T6: user = null → sidebar/user info affected
```

**This is the confirmed race condition.** It's not a timing race — it's a **state consistency bug** where the in-memory token and cookie diverge after org switch.

### Race 2: Multiple Tabs (CONFIRMED)

```
Tab A: switches to OrgA → cookie = JWT(OrgA), session = OrgA
Tab B: still has token = JWT(undefined)
Tab B: useCurrentUser() → sends JWT(undefined) → P2-01 fails → 401
```

This is a consequence of Race 1 — the cookie is shared but the in-memory token is per-tab.

### Race 3: Hydrate + Component Render (NOT CONFIRMED)

The `hydrate()` function is async. During its execution:
- `_hydrated = false` → AuthGuard shows loading skeleton
- After hydrate completes → `_hydrated = true` → AuthGuard renders AppLayout

This is properly handled by the `_hydrated` flag. No race condition here.

### Race 4: Concurrent API Requests During Token Refresh (NOT CONFIRMED)

During `hydrate()`:
1. `/api/auth/me` completes → user set
2. `/api/auth/refresh-token` starts → in progress
3. Meanwhile, components may fire API calls

These API calls would use cookie auth (no Authorization header yet), so they would work. The refresh-token response sets a new cookie and in-memory token. Subsequent calls use the new token. No race condition.

---

## Tenant Isolation Analysis

After org switch:
- **Cookie**: Has new JWT with `activeOrganizationId: OrgA` → data scoped to OrgA ✅
- **In-memory token**: Has old JWT with `activeOrganizationId: undefined` → P2-01 fails → 401

The stale token doesn't cause a **data leak** — it causes an **authentication failure**. The user can't access data at all (401), not the wrong data (which would be a tenant isolation breach).

Tenant isolation is maintained because:
1. The P2-01 check correctly rejects stale tokens
2. The cookie (which is fresh) is not used for API calls that go through `useCurrentUser()`
3. Other API calls that use `credentials: 'same-origin'` (without Authorization header) use the fresh cookie

---

## Root Cause

### CONFIRMED ROOT CAUSE: Stale In-Memory JWT After Organization Switch

**File**: `src/components/layout/org-switcher.tsx`
**Function**: `handleSwitch`
**Line**: ~line 73

```typescript
// After switch succeeds:
if (data.organization) {
  login(token!, authUser!, {
    id: data.organization.id,
    name: data.organization.name,
    // ...
  });
}
```

**Problem**: `token!` is the OLD token from the Zustand store. The switch endpoint set a new JWT as a cookie but didn't return it in the response body. The `login()` call stores the old token, making it stale.

**Effect**: All subsequent `useCurrentUser()` calls send the stale token in the Authorization header, failing the P2-01 check at `/api/auth/me`.

### Contributing Factors

1. **Switch endpoint doesn't return new JWT**: `POST /api/me/organization/switch` sets a new cookie but doesn't include the new JWT in the JSON response body. The client has no way to update the in-memory token.

2. **Mobile sidebar lacks authUser fallback**: `MobileSidebarContent` uses only `useCurrentUser().user`, while `AppSidebar` uses `displayUser = user || authUser`. When `useCurrentUser()` returns null, the mobile sidebar is completely empty.

3. **useCurrentUser query key doesn't include token**: `queryKey: ['auth-me']` doesn't depend on the token value. Token changes don't trigger automatic refetches. `queryClient.invalidateQueries()` triggers refetch but with the same stale token.

4. **No automatic re-hydration after org switch**: After switching, there's no call to `hydrate()` to re-sync the in-memory state from the cookie. A `hydrate()` call would re-fetch `/api/auth/me` (using cookie), get fresh data, and mint a new in-memory token via refresh.

5. **Proxy doesn't perform P2-01 check**: The proxy allows requests with stale org context to pass through, but `/api/auth/me` rejects them. This inconsistency means some API calls work (those using cookie auth) while others fail (those using header auth via `useCurrentUser()`).

---

## Affected Files

| File | Issue | Severity |
|------|-------|----------|
| `src/components/layout/org-switcher.tsx` | `login(token, ...)` passes stale token after switch | **PRIMARY** |
| `src/app/api/me/organization/switch/route.ts` | Doesn't return new JWT in response body | **PRIMARY** |
| `src/hooks/use-current-user.ts` | Sends in-memory token in Authorization header; doesn't fall back to cookie | **CONTRIBUTING** |
| `src/components/layout/mobile-sidebar.tsx` | No `authUser` fallback (unlike desktop sidebar) | **CONTRIBUTING** |
| `src/lib/store.ts` | `login()` doesn't update token from switch response | **CONTRIBUTING** |
| `src/proxy.ts` | Doesn't perform P2-01 org match check (inconsistency with `/api/auth/me`) | **SECONDARY** |

---

## Affected Functions

| Function | File | Issue |
|----------|------|-------|
| `handleSwitch` | `org-switcher.tsx` | Passes old token to `login()` |
| `login` | `store.ts` | Stores the token passed to it (old value) |
| `useCurrentUser` | `use-current-user.ts` | Sends stale token; query key doesn't include token |
| `hydrate` | `store.ts` | Only runs on mount; no re-hydration after switch |
| `getToken` | `proxy.ts` | Header takes priority over cookie |
| `verifySessionActiveOrg` | `session.ts` | Correctly rejects stale tokens (working as designed) |

---

## Evidence

### Console Trace (from previous debugging session)

```
[SA-CREATE-USER] Handler fired {orgId: '', addRole: 'manager', ...}
[SA-CREATE-USER] BLOCKED: missing fields {orgId: false, ...}
```

This showed `orgId` being empty — a related but different issue (the pageContext was cleared by `setCurrentPage`). After fixing that, the Create User flow worked.

### API Trace

```
POST /api/me/organization/switch → 200 OK
  Response: { activeOrganizationId: 'OrgA', role: 'super_admin', organization: {...} }
  Cookie: Set (new JWT)

GET /api/auth/me (with stale Authorization header) → 401
  Response: { error: 'Invalid or expired token' }
  Reason: P2-01 mismatch (session.activeOrganizationId=OrgA, JWT.activeOrganizationId=undefined)
```

### Database State

```
UserSession {
  id: <session-id>
  activeOrganizationId: 'OrgA'  ← Updated by switch endpoint
}

JWT (in-memory token) {
  activeOrganizationId: undefined  ← NOT updated (stale)
}
```

---

## Recommended Fix Plan

### Fix 1: Return new JWT from switch endpoint (PRIMARY)

**File**: `src/app/api/me/organization/switch/route.ts`

Include the new JWT in the response body:
```typescript
return apiSuccess({
  token: newToken,  // ← ADD THIS
  activeOrganizationId: requestedOrgId,
  role: jwtRole,
  organization: { id: requestedOrgId, name: orgName },
});
```

### Fix 2: Update in-memory token after switch (PRIMARY)

**File**: `src/components/layout/org-switcher.tsx`

Use the new token from the response:
```typescript
if (res.ok) {
  const data = await res.json();
  const newToken = data.token || token;  // ← Use new token if available
  setActiveOrgId(orgId);
  setOpen(false);
  if (data.organization) {
    login(newToken, authUser!, { ... });
  }
  queryClient.invalidateQueries();
}
```

### Fix 3: Add authUser fallback to mobile sidebar (CONTRIBUTING)

**File**: `src/components/layout/mobile-sidebar.tsx`

```typescript
const { user } = useCurrentUser();
const authUser = useAuthStore((s) => s.user);
const displayUser = user || authUser;  // ← ADD FALLBACK
const role = displayUser?.role ?? null;
```

### Fix 4: Re-hydrate after org switch (CONTRIBUTING)

**File**: `src/components/layout/org-switcher.tsx`

After successful switch, call hydrate to re-sync:
```typescript
if (data.ok) {
  // ... existing logic ...
  // Re-hydrate to sync in-memory token from fresh cookie
  useAuthStore.getState().hydrate();
}
```

### Fix 5: Include token in useCurrentUser query key (CONTRIBUTING)

**File**: `src/hooks/use-current-user.ts`

```typescript
const { data, isLoading, error } = useQuery<AuthMeResponse>({
  queryKey: ['auth-me', token],  // ← Include token
  queryFn: async () => { ... },
  // ...
});
```

This ensures that when the token changes, React Query refetches with the new token.

---

## Regression Test Plan

### Test 1: Org switch updates in-memory token
```
1. Login as Super Admin
2. Verify useCurrentUser() returns user
3. Switch to Organization A
4. Verify useCurrentUser() still returns user (not null)
5. Verify user.role === 'super_admin'
```

### Test 2: Mobile sidebar survives org switch
```
1. Login as Super Admin on mobile viewport
2. Switch organization
3. Verify sidebar navigation items are still visible
4. Verify user info block is still visible
```

### Test 3: Multiple tabs after org switch
```
1. Login as Super Admin in Tab A
2. Open Tab B (same session)
3. In Tab A: switch to Organization A
4. In Tab B: verify useCurrentUser() still works
```

### Test 4: Page refresh after org switch
```
1. Login as Super Admin
2. Switch to Organization A
3. Refresh page (F5)
4. Verify everything works (hydrate restores from cookie)
```

---

## Final Verdict

```
============================================================
SUPER ADMIN ORGANIZATIONS AUTH FORENSIC VERDICT
============================================================

Authentication:
[PASS] — Login and session creation work correctly

Session Stability:
[PASS] — Session rows are created and maintained correctly

Super Admin Role Resolution:
[PASS] — Role is always correctly resolved as 'super_admin'

Organization Context:
[FAIL] — After org switch, in-memory token has wrong activeOrganizationId

Middleware:
[PASS] — Proxy correctly authenticates and authorizes requests
[NOTE] — Proxy does NOT perform P2-01 check (inconsistency with /api/auth/me)

API Authorization:
[PASS] — All authorization helpers work correctly
[FAIL] — /api/auth/me correctly rejects stale tokens (P2-01), causing useCurrentUser to fail

Client Auth State:
[FAIL] — Zustand token becomes stale after org switch; no re-hydration

401/403 Error Mapping:
[PASS] — Error messages correctly distinguish 401 (auth) from 403 (authz)

Race Condition:
[CONFIRMED] — Org switch creates state inconsistency between cookie and in-memory token

Tenant Isolation:
[PASS] — No data leakage; stale tokens cause 401, not wrong data

PRIMARY ROOT CAUSE:
OrgSwitcher passes stale in-memory token to login() after switch;
switch endpoint doesn't return new JWT in response body.
In-memory token and cookie diverge → P2-01 mismatch → 401.

SECONDARY ROOT CAUSE(S):
1. Mobile sidebar lacks authUser fallback
2. useCurrentUser query key doesn't include token
3. No automatic re-hydration after org switch

AFFECTED FILES:
src/components/layout/org-switcher.tsx (PRIMARY)
src/app/api/me/organization/switch/route.ts (PRIMARY)
src/hooks/use-current-user.ts (CONTRIBUTING)
src/components/layout/mobile-sidebar.tsx (CONTRIBUTING)
src/lib/store.ts (CONTRIBUTING)

SEVERITY:
HIGH — Super Admin intermittently loses access to navigation and user context

PRODUCTION IMPACT:
Super Admin users who switch organizations see empty sidebar (mobile),
hidden user info, and "Please sign in" states until they refresh the page.

FIX REQUIRED:
1. Return new JWT from switch endpoint
2. Update in-memory token after switch
3. Add authUser fallback to mobile sidebar
4. Optionally: re-hydrate after switch

DO NOT IMPLEMENT DURING THIS AUDIT: YES

============================================================
```
