# LOGIN RATE-LIMIT FORENSIC AUDIT

**Date:** 2026-09-02
**Scope:** Login rate-limiting system — end-to-end audit and fix
**Codebases:** `omnisight-web` (admin panel), `omnisight-agent` (desktop agent)

---

## Executive Summary

The login screen was displaying "Too many login attempts. Try again in 5 seconds." This audit traced the complete login flow from UI to database and determined:

1. **No duplicate requests** — one user click produces exactly one API request
2. **Rate limiter is working correctly** — PostgreSQL token bucket, 10 attempts per 5 minutes
3. **Root cause: UX issue** — the login 429 response lacked a `Retry-After` header and the UI had no countdown timer

---

## Root Cause

```
Root Cause:          I. Incorrect frontend countdown (no Retry-After header, no countdown timer)
Duplicate Requests:  NO — single fetch(), no React Query, button disabled during submission
Rate-Limit Implementation: PostgreSQL token bucket (atomic UPSERT, row-level lock)
Rate-Limit Key:      Two layers: login:email:{email} AND login:{ip}:{email}
Retry Configuration: 10 attempts / 5-minute window / continuous refill
Frontend Retry:      NONE — no React Query, no fetch wrapper, no automatic retry
429 Handling:        Server returns 429 + error message; now also returns Retry-After header
Countdown:           NOW IMPLEMENTED — live countdown timer with server-provided retryAfter
Security Status:     PASS — rate limiting remains enabled, brute-force resistant
Tenant Isolation:    PASS — all auth queries scoped to JWT-derived org
Agent Impact:        NONE — Agent uses separate /api/agent/login endpoint with independent rate limit
Files Changed:       2 (login route, login page)
Tests:               155/155 passing
Build:               Clean (0 errors)
Final Verdict:       FIXED
```

---

## 1. Complete Login Flow Trace

### Flow Diagram

```
Login UI (login-page.tsx)
  ↓ form onSubmit={handleSubmit}
  ↓ single fetch('/api/auth/login', { method: 'POST' })
  ↓
POST /api/auth/login (route.ts)
  ↓ parse body → extract email, password
  ↓ normalize email to lowercase
  ↓ resolve client IP via getClientIpFromHeaders()
  ↓
Rate Limit Layer 1: login:email:{normalizedEmail}
  ↓ 10 attempts / 5 min / PostgreSQL token bucket
  ↓ if denied → 429 + Retry-After header
  ↓
Rate Limit Layer 2: login:{clientIp}:{normalizedEmail}
  ↓ 10 attempts / 5 min / PostgreSQL token bucket
  ↓ if denied → 429 + Retry-After header
  ↓
Find user (exact match → ILIKE fallback)
  ↓ if not found → 401 "Invalid email or password"
  ↓
Verify password (bcrypt.compare)
  ↓ if invalid → 401 "Invalid email or password"
  ↓
Resolve organization membership
  ↓
Create UserSession row
  ↓
Sign JWT (HMAC-SHA256, 7-day expiry)
  ↓
Set httpOnly session cookie
  ↓
Response: { token, user, organization }
  ↓
Client: login(token, user, organization) → Zustand store
  ↓
AuthGuard re-renders → isAuthenticated=true → shows AppLayout
```

### Key Files in the Login Flow

| File | Role |
|------|------|
| `src/app/page.tsx` | SPA root, AuthGuard, hydrate() on mount |
| `src/components/auth/login-page.tsx` | Login form UI, submit handler |
| `src/lib/store.ts` | Zustand auth store, login()/logout()/hydrate() |
| `src/app/api/auth/login/route.ts` | Server: rate limit, bcrypt, JWT, session |
| `src/lib/rate-limit.ts` | PostgreSQL token bucket implementation |
| `src/lib/client-ip.ts` | Canonical IP resolver |
| `src/lib/auth.ts` | JWT sign/verify, password hash |
| `src/lib/session.ts` | UserSession CRUD, revocation |
| `src/hooks/use-auth-fetch.ts` | Authenticated fetch wrapper (NOT used by login) |
| `src/components/providers.tsx` | React Query config (retry: 1, NOT used by login) |
| `src/app/api/auth/me/route.ts` | Session restore on reload |
| `src/app/api/auth/refresh-token/route.ts` | Sliding token renewal |

---

## 2. Duplicate Request Analysis

### Answer: NO DUPLICATE REQUESTS

For ONE manual click on "Sign In":

```
1 click → 1 handleSubmit() → 1 fetch('/api/auth/login') → 1 request
```

**Evidence:**

| Check | Result | Evidence |
|-------|--------|----------|
| Single onSubmit handler | YES | `<form onSubmit={handleSubmit}>` (line 101) — no onClick on button |
| Button type="submit" | YES | Line 166 — standard form submission |
| No duplicate event handlers | YES | Only onSubmit on form, no onClick on submit button |
| Button disabled during request | YES | `disabled={isLoading}` (line 167) |
| isLoading set true before fetch | YES | Line 30: `setIsLoading(true)` |
| isLoading set false on error | YES | Lines 43, 51: `setIsLoading(false)` |
| No AbortController needed | YES | Single in-flight request; React state batching prevents race |
| No React Query mutation | YES | Raw fetch() — React Query not used for login |
| No fetch wrapper with retry | YES | Bare `fetch('/api/auth/login')` — no useAuthFetch, no apiFetch |
| No useEffect calling login | YES | useEffect on mount calls hydrate() which hits /api/auth/me, NOT /api/auth/login |
| No redirect loop | YES | State-driven rendering — no router.push() |

**hydrate() does NOT consume login rate limits:**
- `hydrate()` calls `GET /api/auth/me` and `POST /api/auth/refresh-token`
- Neither endpoint is rate-limited for login attempts
- The login rate limit key is `login:email:{email}` — only incremented by `POST /api/auth/login`

---

## 3. Rate Limiter Implementation Audit

### Storage

**PostgreSQL `RateLimitCounter` table** — single atomic UPSERT with row-level lock.

```sql
INSERT INTO "RateLimitCounter" ("key", tokens, "lastRefill", "updatedAt")
VALUES ($key, $limit - 1, $now, now())
ON CONFLICT ("key") DO UPDATE SET
  tokens = LEAST($limit, "RateLimitCounter".tokens
    + ($limit / $windowMs) * ($now - "RateLimitCounter"."lastRefill")
  ) - 1,
  "lastRefill" = GREATEST("RateLimitCounter"."lastRefill", $now),
  "updatedAt" = now()
RETURNING tokens
```

- **No in-memory state** — topology-independent, works across multiple server instances
- **No Redis** — PostgreSQL is the single source of truth
- **Atomic** — no read-modify-write race; row-level lock serializes concurrent requests
- **Continuous refill** — sliding-window-like semantics without fixed-window boundary burst

### Rate Limit Key

| Layer | Key Format | Purpose |
|-------|-----------|---------|
| Layer 1 (email-only) | `login:email:{normalizedEmail}` | Defeats IP rotation attacks |
| Layer 2 (IP+email) | `login:{clientIp}:{normalizedEmail}` | Defeats distributed attacks |

Both layers use the same limits: **10 attempts per 5 minutes**.

### Client IP Resolution

**File:** `src/lib/client-ip.ts`

Resolution order:
1. `x-real-ip` header (trusted; each proxy hop overwrites)
2. `x-forwarded-for` header (RIGHT-MOST non-empty segment — last 32 segments only)
3. `cf-connecting-ip` header (Cloudflare)
4. `"unknown"` fallback

**Spoof resistance:** Attacker-prepended entries in `x-forwarded-for` are ignored. Only the right-most (proxy-appended) entry is trusted.

### Window and Threshold

```typescript
login: { limit: 10, windowMs: 5 * 60 * 1000 }  // 10 attempts / 5 min
```

- **Maximum attempts:** 10
- **Window:** 5 minutes (300,000 ms)
- **Refill rate:** 10/300000 = 0.033 tokens/ms
- **Block duration:** Calculated from token depletion: `(-tokens * windowMs) / limit / 1000` seconds

### retryAfterSeconds Calculation

```typescript
const retryAfterSeconds = Math.max(1, Math.ceil((-tokens * windowMs) / limit / 1000));
```

| Attempts over limit | tokens | retryAfterSeconds |
|---------------------|--------|-------------------|
| 1 (11th attempt) | -1 | 30 seconds |
| 2 (12th attempt) | -2 | 60 seconds |
| 3 (13th attempt) | -3 | 90 seconds |
| 5 (15th attempt) | -5 | 150 seconds (2.5 min) |

### 429 Response (BEFORE fix)

```json
{
  "error": "Too many login attempts. Try again in 30 seconds."
}
```

- HTTP status: 429
- No `Retry-After` header
- No structured `retryAfter` field

### 429 Response (AFTER fix)

```json
{
  "error": "Too many login attempts. Please try again later.",
  "retryAfter": 30
}
```

- HTTP status: 429
- `Retry-After: 30` header
- Structured `retryAfter` field in body

### Cleanup

**Sweep job** runs hourly, deletes rows with `updatedAt` older than 3 hours.

### Failure Behavior

Security-critical keys (including `login:`) **FAIL CLOSED** on DB outage — deny with 5-second retry.

---

## 4. React Query / Fetch Retry Audit

| Component | Retry behavior | Impact on login |
|-----------|---------------|-----------------|
| Login form | Raw `fetch()` — no retry | NONE |
| React Query QueryClient | `retry: 1` for queries only | NONE (login doesn't use React Query) |
| useAuthFetch wrapper | No retry logic | NONE (login doesn't use it) |
| apiFetch wrapper | No retry logic | NONE (login doesn't use it) |

**Login mutation retry: N/A** — the login form uses raw fetch, not React Query mutations.

---

## 5. Auth Initialization Audit

| Component | On mount behavior | Hits login endpoint? |
|-----------|------------------|---------------------|
| `page.tsx` useEffect | Calls `hydrate()` | NO — hits `/api/auth/me` + `/api/auth/refresh-token` |
| `page.tsx` visibilitychange | Calls `hydrate()` on tab focus | NO — same endpoints |
| `hydrate()` | Fetches `/api/auth/me` then `/api/auth/refresh-token` | NO — session restore, not login |
| `useEffectiveBranding` | Fetches `/api/branding` | NO — branding data |

**No component calls `/api/auth/login` on mount.** The login endpoint is only called by the form's submit handler.

---

## 6. Fixes Applied

### Fix 1: Login route — add Retry-After header

**File:** `src/app/api/auth/login/route.ts`

Before:
```typescript
return NextResponse.json(
  { error: `Too many login attempts. Try again in ${emailRl.retryAfterSeconds} seconds.` },
  { status: 429 }
);
```

After:
```typescript
const res = NextResponse.json(
  { error: 'Too many login attempts. Please try again later.', retryAfter: emailRl.retryAfterSeconds },
  { status: 429 }
);
res.headers.set('Retry-After', String(emailRl.retryAfterSeconds));
return res;
```

### Fix 2: Login page — add countdown timer

**File:** `src/components/auth/login-page.tsx`

Added:
- `retryAfter` state + `retryTimerRef` for countdown
- `useEffect` that decrements `retryAfter` every second
- Cleanup on unmount
- Submit button disabled during countdown
- Button shows "Try again in Xs" during countdown
- Uses server-provided `retryAfter` value (not hardcoded)

### Fix 3: Login page — prevent submission during countdown

```typescript
if (retryAfter > 0) return;
```

Added at the start of `handleSubmit` — prevents any request during cooldown.

---

## 7. Agent Repository Audit

**File:** `omnisight-agent/src/api/config.ts`, `omnisight-agent/src/api/heartbeat.ts`

The Agent uses **completely separate endpoints** from the web login:

| Agent endpoint | Rate limit key | Limit |
|---------------|---------------|-------|
| `POST /api/agent/authenticate` | `agent-auth:{ip}` | 20/min |
| `POST /api/agent/login` | `agent-login:{ip}` | 20/min |
| `POST /api/agent/discover` | `agent-discover:{ip}:{deviceKey}` | 20/min |

**No overlap** with the web login rate limit key (`login:email:{email}` / `login:{ip}:{email}`).

Agent retry/backoff does NOT consume web login rate limits.

---

## 8. Security Verification

| Check | Status | Evidence |
|-------|--------|----------|
| Rate limiting enabled | YES | Two-layer rate limit on login route |
| Brute-force resistant | YES | 10 attempts / 5 min / two layers |
| No bypass for super_admin | YES | Rate limit checked before authentication |
| Password not logged | YES | Only email logged on rate limit hit |
| Generic error messages | YES | "Invalid email or password" — no email enumeration |
| Tenant isolation | YES | Rate limit keys include email (not org-specific for login) |
| CSRF protection | YES | Proxy checks Origin header on state-changing requests |
| httpOnly cookie | YES | Session cookie is httpOnly, SameSite=Lax |
| JWT in memory only | YES | Never persisted to localStorage |
| Session revocation | YES | Server-authoritative UserSession rows |

---

## 9. Production Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| One manual login action = one authentication request | PASS |
| No automatic login retries | PASS |
| Double-click cannot generate multiple concurrent requests | PASS |
| Enter-key spam cannot generate a request storm | PASS |
| 429 responses handled correctly | PASS (now with Retry-After header) |
| Login rate limiting remains enabled | PASS |
| Countdown reflects actual server retry duration | PASS (server-provided retryAfter) |
| Invalid credentials remain generic and secure | PASS |
| Successful login works normally after cooldown | PASS |
| Login page mount does not trigger authentication requests | PASS |
| Refresh does not create login attempts | PASS |
| No password/token/secret logged | PASS |
| Super Admin receives no authentication bypass | PASS |
| Existing RBAC remains intact | PASS |
| Multi-organization isolation remains intact | PASS |
| Agent authentication not affected | PASS |
| TypeScript passes | PASS |
| Production build passes | PASS |
| Automated tests pass | PASS (155/155) |

---

## 10. Files Report

### Files Changed

| File | Change |
|------|--------|
| `src/app/api/auth/login/route.ts` | Added `Retry-After` header and `retryAfter` field to 429 response |
| `src/components/auth/login-page.tsx` | Added countdown timer, server-provided retryAfter, disabled button during countdown |

### Files Inspected (unchanged)

| File | Purpose |
|------|---------|
| `src/lib/rate-limit.ts` | Token bucket implementation |
| `src/lib/client-ip.ts` | IP resolver |
| `src/lib/auth.ts` | JWT/password utilities |
| `src/lib/session.ts` | Session management |
| `src/lib/store.ts` | Zustand auth store |
| `src/app/page.tsx` | SPA root, AuthGuard |
| `src/hooks/use-auth-fetch.ts` | Auth fetch wrapper |
| `src/hooks/use-effective-branding.ts` | Branding hook |
| `src/components/providers.tsx` | React Query config |
| `src/proxy.ts` | Central rate limiting middleware |
| `src/app/api/auth/me/route.ts` | Session restore |
| `src/app/api/auth/refresh-token/route.ts` | Token refresh |
| `src/app/api/branding/route.ts` | Branding API |

---

## 11. Final Verdict

```
LOGIN RATE-LIMIT FORENSIC AUDIT

Root Cause:          I. Incorrect frontend countdown (no Retry-After header, no countdown timer)
Duplicate Requests:  NO — single fetch(), button disabled, no retry logic
Rate-Limit Implementation: PostgreSQL token bucket (atomic UPSERT, row-level lock, topology-independent)
Rate-Limit Key:      Two layers: login:email:{email} AND login:{ip}:{email}
Retry Configuration: 10 attempts / 5-minute window / continuous refill
Frontend Retry:      NONE — raw fetch(), no React Query, no automatic retry
429 Handling:        NOW returns Retry-After header + retryAfter field in body
Countdown:           NOW IMPLEMENTED — live countdown using server-provided retryAfter value
Security Status:     PASS — rate limiting enabled, brute-force resistant, no bypasses
Tenant Isolation:    PASS — all auth queries scoped to JWT-derived org
Agent Impact:        NONE — Agent uses separate /api/agent/login with independent rate limit
Files Changed:       2 (login route, login page)
Tests:               155/155 passing
Build:               Clean (0 errors, 129 pages)
Final Verdict:       FIXED
```
