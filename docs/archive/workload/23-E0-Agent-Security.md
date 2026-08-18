# WorkLensAI — E0 Implementation Report (Agent Authentication & Security Foundation)

> **File:** workload/23-E0-Agent-Security.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE
> **Scope:** shared, reusable security infrastructure for ALL future agent APIs (`/api/agent/v1/*`). **No business endpoints implemented.**

---

## 1. Summary

| Item | Result |
|---|---|
| Shared library | ✅ `src/lib/agent-auth/` (10 modules) |
| Token primitives | ✅ 256-bit base64url generation, SHA-256 hashing, constant-time compare, rotation helpers |
| Request signing | ✅ HMAC-SHA256, canonical request `METHOD\nPATH\nTS\nNONCE\nsha256hex(body)` (contract §2.2) |
| Timestamp / clock | ✅ ±300 s window (configurable), server-time helper, tolerant heartbeat window (600 s) |
| Replay protection | ✅ `NonceStore` interface + bounded in-memory store, 10-min TTL (contract §2.3) |
| Zod schemas | ✅ Registration, Activation, Heartbeat, Activity, Screenshot, Command Poll + auth headers |
| Error types | ✅ 9+ typed errors (Unauthorized, Forbidden, Invalid Signature, Expired Timestamp, Replay, Invalid Nonce, Invalid Join Key, Invalid Agent, Token Revoked) + envelope |
| Response helpers | ✅ Success / Validation / Security / Server error + `X-Server-Time` on every response |
| Config | ✅ `AGENT_*` env validation with safe defaults (skew, nonce TTL, token lifetime, body/screenshot/batch caps) |
| Unit tests | ✅ `scripts/verify-e0.mjs` — **107/107 checks passed** |
| Regression | ✅ E1 `scripts/verify-e1.mjs` — **23/23 checks passed** (crypto consolidation is behavior-preserving) |
| Build | ✅ `prisma validate` · `prisma generate` · `npm run build` · `tsc` (changed files) · `eslint` all pass |
| Data | ✅ intact — 36 users / 10 devices / no leftover test rows |

---

## 2. Files Changed

| File | Change |
|---|---|
| `src/lib/agent-auth/config.ts` | **NEW** — env validation (`AGENT_*`) + security constants (skew, nonce TTL, token lifetime, body/screenshot/batch caps, rotation grace, expiry warning) |
| `src/lib/agent-auth/errors.ts` | **NEW** — `AgentAuthError` base + 9 required typed errors + envelope codes |
| `src/lib/agent-auth/tokens.ts` | **NEW** — `generateAgentToken`, `hashAgentToken`, `sha256Hex`, `timingSafeEqual(Hex)`, `verifyTokenHash`, `createToken`/`isTokenExpired`/`tokenExpiryWarningDue` rotation helpers |
| `src/lib/agent-auth/signature.ts` | **NEW** — canonicalization, `computeBodyHash`, `signAgentRequest`, `verifyRequestSignature` (constant-time) |
| `src/lib/agent-auth/timestamp.ts` | **NEW** — `serverTime()`, `validateTimestamp`, `assertTimestampFresh` |
| `src/lib/agent-auth/nonce-store.ts` | **NEW** — `NonceStore` interface + bounded `InMemoryNonceStore` (FIFO eviction, TTL), `isValidNonce` |
| `src/lib/agent-auth/schemas.ts` | **NEW** — shared Zod schemas (register/activate/heartbeat/activity/screenshot/command-poll + auth headers) |
| `src/lib/agent-auth/responses.ts` | **NEW** — `agentSuccess`, `agentValidationError`, `agentSecurityError`, `agentError`, `agentServerError`, `agentPayloadTooLarge` |
| `src/lib/agent-auth/verifier.ts` | **NEW** — `parseAgentAuthHeaders`, `verifyAgentRequest` (composed pipeline) |
| `src/lib/agent-auth/index.ts` | **NEW** — barrel export |
| `src/middleware.ts` | **MODIFIED** — whitelisted `/api/agent/v1` prefix as agent-auth (contract §0: agent endpoints are NOT web-JWT; replaces the granular `/api/agent/v1/register` entry) |
| `src/lib/agent.ts` | **MODIFIED** — crypto primitives (`sha256Hex`, `generateAgentToken`, `timingSafeEqualHex`, `AGENT_TOKEN_LIFETIME_DAYS`) consolidated to import/re-export from `agent-auth` (behavior identical; E1 regression 23/23) |
| `scripts/verify-e0.mjs` | **NEW** — automated unit verification (10 sections, 107 assertions) |
| `workload/23-E0-Agent-Security.md` | **NEW** — this report |
| `workload/07-Progress.md` | **APPENDED** — dated entry |

**Not touched:** `prisma/schema.prisma` (no schema change — E0 is library-only), all business routes, application logic.

---

## 3. Security Architecture Implemented

### 3.1 Identity & tokens (contract §1, ADR-011)
- Opaque **256-bit** tokens, base64url (43 chars), returned exactly once.
- Server stores only **SHA-256** (`AgentCredential.tokenHash`); plaintext never persisted or logged.
- `verifyTokenHash` compares `sha256(provided)` vs stored hash with **constant-time** comparison.

### 3.2 Request signing (contract §2.2, ADR-012)
```
canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256hex(rawBody)
signature = base64url( HMAC_SHA256( key = agentToken, message = canonical ) )
```
- PATH includes the query string (`/api/agent/v1/policy?format=v1`).
- Body hash is over the **pre-gzip** bytes (server re-hashes the decompressed body).
- Verification recomputes and compares **constant-time**.
- Independent reference-signer interop test proves the implementation matches the contract.

### 3.3 Replay protection (contract §2.3)
- `|X-Timestamp − serverNow| ≤ clockToleranceMs` (default ±300 s) → else `429 AGENT_CLOCK_SKEW` + `X-Server-Time`.
- Each `(deviceId, nonce)` accepted once; cached 10 min (in-memory MVP; `NonceStore` interface → Postgres `AgentNonce` for multi-instance).
- **Nonce is marked used only AFTER token+signature+clock checks pass** — an unauthenticated request can never burn a legitimate agent's nonce (nonce-burning DoS prevented).

### 3.4 Composed verifier (`verifyAgentRequest`)
Order (each failure throws a typed error):
1. Header parse + presence → `401 AGENT_SIGNATURE_INVALID` / `401 AGENT_UNAUTHORIZED`
2. **Token hash (constant-time)** → `401 AGENT_UNAUTHORIZED` — authenticate first
3. Per-device scoping (header `deviceId`/`installationId` vs credential binding) → `403 AGENT_DEVICE_MISMATCH` — authorize second
4. HMAC signature (constant-time) → `401 AGENT_SIGNATURE_INVALID`
5. Clock window → `429 AGENT_CLOCK_SKEW` (heartbeat uses a tolerant 600 s window, contract §2.4)
6. Nonce format + replay → `400 AGENT_NONCE_INVALID` / `409 AGENT_REPLAY` → then mark used

### 3.5 Clock drift handling (contract §2.4)
- Every response carries `X-Server-Time` (`agentResponseHeaders`).
- `validateTimestamp` returns `serverTime` + `skewMs` for the agent to compute `clockOffset`.
- `tolerant: true` (heartbeat E3) widens the window to 600 s for bootstrap resync.

### 3.6 Token rotation (contract §2.5)
- `createToken(lifetimeDays)` issues a fresh token + hash; `isTokenExpired`, `tokenExpiryWarningDue` (30 d) drive proactive E16 rotation; `AGENT_TOKEN_ROTATION_GRACE_MS` (60 s) documented for the old-token grace window.

### 3.7 Configuration (env validated, defaults safe)
`AGENT_CLOCK_TOLERANCE_MS`, `AGENT_NONCE_TTL_MS`, `AGENT_TOKEN_LIFETIME_DAYS`, `AGENT_MAX_BODY_BYTES`, `AGENT_MAX_SCREENSHOT_BYTES`, `AGENT_MAX_BATCH_EVENTS` — invalid values are ignored with a warning (defaults win); **no secrets in the warning** (only env names).

### 3.8 Never log secrets
No `console.*` call in `agent-auth/` logs tokens, hashes, signatures, or join keys. The only log is the config warning (env **names**).

---

## 4. How Future Endpoints Must Use This (integration recipe)

Every new agent endpoint (E2–E16) follows this pattern — the foundation is NOT auto-wired; routes opt in:

```ts
import { agentConfig, verifyAgentRequest, InMemoryNonceStore, agentError, agentSuccess, AgentAuthError } from '@/lib/agent-auth'

// 1. Resolve the credential (business logic): find AgentCredential by
//    sha256Hex(bearerToken) → device (expectedDeviceId = device.id).
// 2. Verify (token → signature → clock → nonce):
const ctx = await verifyAgentRequest({
  method: req.method,
  pathname: req.nextUrl.pathname,
  search: req.nextUrl.search,
  body: rawBody,                       // exact pre-gzip bytes (decompressed by the server)
  headers: req.headers,
  storedTokenHash: credential.tokenHash,
  expectedDeviceId: device.id,
  expectedInstallationId: device.installationId ?? undefined,
  nonceStore,                          // inject for tests; defaultNonceStore for prod
  clockToleranceMs: agentConfig.clockToleranceMs,
})
// 3. Body size gate: reject > agentConfig.maxBodyBytes with agentPayloadTooLarge(limit).
// 4. Respond: agentSuccess(data, { status }) / agentError(err) / agentValidationError(details).
//    All responses automatically carry X-Server-Time; add X-Token-Expires when < 30 d.
// 5. Check device.status: Pending → 403 AGENT_DEVICE_PENDING; Suspended/Retired → 403 AGENT_DEVICE_REVOKED;
//    token revoked → 401 AGENT_TOKEN_EXPIRED (contract §2.6). Use the codes in errors.ts.
```

---

## 5. Verification Results

### 5.1 Unit tests — `bun scripts/verify-e0.mjs`
```
=== RESULT: 107 passed, 0 failed ===
```
| Section | Covers |
|---|---|
| 1 Token generation & hashing | 43-char base64url, entropy, SHA-256 hex, deterministic, ≠ plaintext, `verifyTokenHash` |
| 2 Constant-time compare | equal / different / length-mismatch / hex variants / 5k-iteration smoke |
| 3 Canonicalization & HMAC | exact `METHOD\nPATH\nTS\nNONCE\nbodyhash` format, query-string path, `sha256hex('')`, **reference-implementation interop**, tamper on body/timestamp/nonce/path/method/key/signature |
| 4 Timestamp & clock drift | ±300 s window, boundary, ±skew, missing/non-numeric, `serverTime` exposure for resync |
| 5 Replay protection | fresh/marked/different-nonce/different-device, TTL expiry, bounded FIFO eviction, `isValidNonce` |
| 6 Configuration | defaults (300 s / 10 min / 180 d / 1 MB / 10 MB / 500), env overrides, invalid fallback |
| 7 Error types | statuses + codes + envelope shape, `Retry-After` propagation, `isAgentAuthError` |
| 8 Zod schemas | valid/invalid per schema, unknown-field stripping, 501-event cap, kind/payload mismatch, 10 MB cap |
| 9 `verifyAgentRequest` pipeline | happy path, nonce consumed, replay 409, wrong token 401, tampered body/signature 401, stale ts 429, tolerant 600 s window, device/installation mismatch 403, missing bearer/headers |
| 10 Token rotation helpers | expiry ±180 d, expired/warning-due logic |

### 5.2 E1 regression — `node scripts/verify-e1.mjs` (dev server)
```
=== RESULT: 23 passed, 0 failed ===
```
Confirms the `src/lib/agent.ts` crypto consolidation preserved exact E1 behavior (201/401/409/422 paths, token hashing, DTO shape, 5/min rate limit untouched).

### 5.3 Build / static checks
- `prisma validate` ✅ (schema valid) · `prisma generate` ✅ (client v6.19.3)
- `npm run build` ✅ (35 routes compiled, standalone assets copied)
- `tsc --noEmit`: only 4 **pre-existing** errors in untouched files (`examples/websocket/*` missing example deps; `src/components/admin/markdown.tsx` ES2017-target regex flag) — none in changed files
- `eslint` on changed files ✅ (exit 0)

---

## 6. Runtime Verification

- E0 unit suite run under bun (native TS import) — 107/107.
- E1 regression run against a freshly started `next dev` (ready in ~350 ms, `.env` loaded, server terminated after) — 23/23; DB returned to 10 devices, 0 leftover test rows.

---

## 7. Known Limitations

1. **In-memory nonce store** — single instance only; resets on restart. Swap the `NonceStore` implementation for a Postgres `AgentNonce` table when multi-instance (contract §7.2). The interface is ready.
2. **FIFO eviction at capacity** — the bounded store evicts the oldest entry even if unexpired; an evicted nonce is theoretically replayable *if* still inside the ±300 s timestamp window (the window is the backstop). Negligible at MVP scale (100k entries ≫ 5-min traffic); documented so nobody raises the cap blindly.
3. **Missing `X-Timestamp` → 401 `AGENT_SIGNATURE_INVALID`** (not the 429 used for out-of-window). Defensible (missing ≠ skew); contract-compliant agents treat any 401 as retry/re-register. A desynced agent always *sends* a timestamp, so it correctly receives 429 + `X-Server-Time`.
4. **E1's inline Zod schema is not yet replaced by `registrationSchema`** — the shared schema is identical by construction and ready for adoption in a follow-up (no behavior change expected; E1 verified independently).
5. **`AgentError` (E1) is not yet unified with `AgentAuthError`** — same shape; a follow-up can make `AgentError extends AgentAuthError` so one catch-all handles both.
6. **Legacy middleware bypass remains** for non-agent routes (BL-001 — `X-API-Key`/`X-Agent-Token` passthrough). E0 did not remove it (tracked backlog); `/api/agent/v1/*` is whitelisted **before** the bypass branches, so agent routes are unaffected. Next.js also warns `middleware` → `proxy` convention (pre-existing, Next 16.2).
7. **Canonical path matching is exact** — the signed PATH must match the server's `pathname + search` byte-for-byte (no trailing-slash or percent-encoding normalization). Proxy rewrites must not alter the path.
8. **`verify-e0.mjs` requires bun** (imports TypeScript directly); run `bun scripts/verify-e0.mjs`. It needs no server/DB.

---

## 8. Rollback

```bash
# Remove the shared library + tests
rm -rf src/lib/agent-auth
rm scripts/verify-e0.mjs
# Revert middleware whitelist to the granular E1 entry
git checkout -- src/middleware.ts
# Restore agent.ts crypto helpers (keeps E1's public exports)
git checkout -- src/lib/agent.ts
# Remove docs
rm workload/23-E0-Agent-Security.md
# Revert the Progress append (git checkout restores the tracked version)
git checkout -- workload/07-Progress.md
npm run db:generate
```

**Data impact:** zero — E0 is library-only; no schema change, no DB writes, no routes. The E1 regression script deletes its own test rows (devices back to 10).

---

## 9. Git Commit Message

```
feat(agent): add E0 shared agent security foundation (src/lib/agent-auth)

- Token primitives: 256-bit base64url gen, SHA-256 hashing, constant-time
  compare, rotation helpers (contract 17-Agent-API-Contract.md §1/§2.5)
- HMAC-SHA256 request signing + canonicalization METHOD\nPATH\nTS\nNONCE\nbodyhash (§2.2)
- Timestamp validation ±300 s (+ tolerant 600 s heartbeat window) (§2.3/§2.4)
- NonceStore replay-protection interface + bounded in-memory store (10 min TTL)
- Composed verifyAgentRequest: token → device binding → signature → clock → nonce
- Zod schemas: registration/activation/heartbeat/activity/screenshot/command-poll
- Typed errors (401/403/409/413/422/426/429) + shared response helpers w/ X-Server-Time
- AGENT_* env validation with safe defaults (body/screenshot/batch caps)
- Middleware: /api/agent/v1 whitelisted as agent-auth (not web-JWT)
- agent.ts crypto consolidated to agent-auth (E1 behavior preserved)
- scripts/verify-e0.mjs: 107/107 unit checks; E1 regression 23/23
```
