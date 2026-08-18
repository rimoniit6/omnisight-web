# WorkLensAI — E1 Implementation Report (Agent Registration API)

> **File:** workload/22-E1-Agent-Registration.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE
> **Scope:** `POST /api/agent/v1/register` only — the first agent-facing endpoint. **No heartbeat, activity, screenshots, policy, commands, update, activation, or AI.**

---

## 1. Summary

| Item | Result |
|---|---|
| Endpoint | ✅ `POST /api/agent/v1/register` |
| Route | `src/app/api/agent/v1/register/route.ts` |
| Service layer | `src/lib/agent.ts` (token gen, sha256, join-key verify, `registerAgent`) |
| Validation | ✅ Zod (`RegisterSchema`, semver, capability whitelist, size caps) |
| Rate limiting | ✅ 5/min per IP (contract §3), `429 AGENT_RATE_LIMITED` + `Retry-After` |
| Auth model | ✅ anonymous + join key (no JWT, no API key — contract E1) |
| Token | ✅ 256-bit base64url (43 chars), returned once; **only SHA-256 stored** (ADR-011) |
| Middleware | ✅ `/api/agent/v1/register` whitelisted from web-JWT (does not hit API-key bypass branches) |
| Verification | ✅ `scripts/verify-e1.mjs` — **23/23 checks passed** (8 required cases) |
| Build | ✅ `prisma validate`, `db:generate`, `npm run build` all pass |
| Data | ✅ intact — 36 users / 10 devices / 0 leftover test credentials |

---

## 2. Files Changed

| File | Change |
|---|---|
| `src/app/api/agent/v1/register/route.ts` | **NEW** — E1 route handler (zod, rate limit, error envelope, DTO) |
| `src/lib/agent.ts` | **NEW** — agent service layer (crypto, constants, `registerAgent`, `AgentError`) |
| `src/middleware.ts` | **MODIFIED** — added `/api/agent/v1/register` to `PUBLIC_ROUTES` (join-key auth, NOT web JWT) |
| `scripts/verify-e1.mjs` | **NEW** — automated verification (8 cases, 23 assertions) |
| `workload/22-E1-Agent-Registration.md` | **NEW** — this report |
| `workload/07-Progress.md` | **APPENDED** — dated entry |

**Not touched:** `prisma/schema.prisma` (no schema change needed — M003 created the tables), all other API routes, application logic.

---

## 3. API Contract Verification (vs. 17-Agent-API-Contract.md §4 E1)

| Contract requirement | Implementation | Verified |
|---|---|---|
| `POST /api/agent/v1/register` | ✅ exact path | ✅ route registered in build manifest |
| Auth: anonymous + `joinKey` + `installationId` in body, no signature | ✅ | ✅ raw curl with no cookie/Bearer/API-key → 201 |
| Body: installationId, joinKey, clientTime, hostname, os{family,version,build,arch}, hardware{cpu,ramGB,diskGB,mac,serial}, agentVersion, capabilities[] | ✅ full zod schema | ✅ |
| 201 response: deviceId, agentToken, tokenExpiresAt, serverTime, heartbeatIntervalMs, minAgentVersion, policyVersion, configVersion, status `"pending"` | ✅ exact DTO | ✅ exact key-set check |
| Validation: installationId exists · joinKey hash matches · hostname ≤128 · agentVersion semver · capabilities ⊆ whitelist | ✅ all five | ✅ 401 / 422 cases |
| Duplicate hardware fingerprint → 409 (within 24h of retired → `AGENT_REENROLL_REQUIRED`) | ✅ `AGENT_ALREADY_REGISTERED` / `AGENT_REENROLL_REQUIRED` | ✅ 409 + same deviceId |
| Join key is the only secret; hashed at rest; never logged | ✅ SHA-256 at rest + timing-safe compare + no secret logging | ✅ |
| Rate limit 5/min/IP, `429 AGENT_RATE_LIMITED` | ✅ | ✅ (429 path in code; not exercised in test run to avoid lockout) |
| `426 AGENT_UPGRADE_REQUIRED` when below minAgentVersion | ✅ | code path present |
| Error envelope `{ error: { code, message, retryAfter, details } }` | ✅ | ✅ all error cases |

---

## 4. Verification Results (scripts/verify-e1.mjs)

```
=== RESULT: 23 passed, 0 failed ===
```

| # | Case | Result |
|---|---|---|
| 1 | Valid registration → 201, DTO shape, 43-char token | ✅ |
| 2 | Invalid join key → 401 `AGENT_JOIN_KEY_INVALID` | ✅ |
| 3 | Duplicate registration (same fingerprint) → 409 `AGENT_ALREADY_REGISTERED`, same deviceId | ✅ |
| 4 | Missing fields → 422 `AGENT_VALIDATION` | ✅ |
| 5 | Invalid payload (bad semver / unknown capability / oversized hostname) → 422 | ✅ |
| 6 | Database persistence: Device row + Pending status + installation link + fingerprint + AgentCredential row | ✅ |
| 7 | Token hashing: stored hash is sha256 hex, ≠ plaintext, === sha256(agentToken) | ✅ |
| 8 | Response shape: exact 9-key DTO, no tokenHash/passwordHash/joinKey leak | ✅ |

Manual raw curl also confirmed the exact contract response:
```json
{"deviceId":"cmsbx4cmm0005fi8ggmswbror","agentToken":"KlIP7Mq0Uk64uCY7iLxPE0OGq3_MQTmu62YXWTs55aQ",
 "tokenExpiresAt":"2027-01-29T14:51:13.769Z","serverTime":1785682273782,"heartbeatIntervalMs":30000,
 "minAgentVersion":"0.1.0","policyVersion":1,"configVersion":1,"status":"pending"}
```

---

## 4a. Review Fix (edge case — empty hardware)

Post-review hardening: `hardwareSchema` now includes a zod `.refine()` requiring **at least one** hardware identity field (`cpu`/`ramGB`/`diskGB`/`mac`/`serial`). Previously, an agent sending `hardware: {}` would produce a constant fingerprint `sha256('')` → any two hardware-less machines would collide with a false `409 AGENT_ALREADY_REGISTERED`. Empty hardware now returns `422 AGENT_VALIDATION` (verified live).

## 5. Security Verification

- **No API key bypass:** E1 is whitelisted in middleware as a public route — it never reaches the `X-API-Key`/`X-Agent-Token` passthrough branches, and the route itself accepts only `joinKey` (it ignores `X-API-Key` entirely).
- **No JWT:** E1 requires no cookie/Bearer; verified by raw curl with zero auth headers.
- **Join key is the only credential:** verified timing-safe (constant-time hex compare), stored as SHA-256 hash only, never logged.
- **Agent token hashed before storing:** `AgentCredential.tokenHash = SHA-256(token)`; plaintext returned exactly once; verified `storedHash === sha256(agentToken)` and `storedHash !== agentToken`.
- **No secrets in logs:** `[AGENT] registered device=... hostname=...` logs only deviceId/hostname/installation/ip/requestId.
- **No secrets in response:** exact DTO key-set check asserts no `tokenHash`/`passwordHash`/`joinKey` leak.

---

## 6. Known Limitations

1. **In-memory rate limiter** (`Map` keyed by IP) — resets on process restart and is not distributed. Acceptable for single-instance MVP (matches the existing login route pattern); a Postgres-backed or Redis limiter is a Phase-3 item.
2. **`DeviceAssignment` is NOT created at E1** — the contract binds the user server-side at **E2 (activate)** via admin assignment; E1 has no `userId` context by design (anti-spoof). Task's "create DeviceAssignment if appropriate" → not appropriate at registration.
3. **Min-version (`426`) and 24h re-enroll window** paths are implemented but not directly exercised by the verify script (they need a deliberately old agentVersion / a Retired device); logic is unit-visible in `src/lib/agent.ts`.
4. **Legacy middleware bypass remains** for *other* routes (BL-001 — the `X-API-Key`/`X-Agent-Token` passthrough on non-public routes). This task intentionally did **not** touch it (out of scope, tracked in backlog); E1 is unaffected.
5. **Demo join key** `WL-DEMO-JOINKEY-2026` is publicly documented for demo/dev; production deployments must rotate it via the admin Installation flow (future feature).
6. **In-memory rate limiter** Map grows with distinct IPs (no TTL eviction) — matches the existing login-route pattern; a bounded/capped limiter is a production-hardening item.

---

## 7. Rollback

```bash
# Remove the endpoint + service
rm src/app/api/agent/v1/register/route.ts
rm src/lib/agent.ts
# Revert middleware whitelist
git checkout -- src/middleware.ts
# Remove verification script
rm scripts/verify-e1.mjs
# No DB changes were made by this task (M003 created the tables; test rows cleaned up)
npm run db:generate
```

**Data impact:** zero — the task only *reads* `Installation`/`Device`/`AgentCredential` and creates rows at runtime; the verify script deletes its own test rows (devices back to 10).

---

## 8. Git Commit Message

```
feat(agent): implement E1 agent registration API

- POST /api/agent/v1/register (contract 17-Agent-API-Contract.md §4 E1)
- Join-key auth (timing-safe SHA-256), no JWT, no API-key bypass
- 256-bit token returned once; only SHA-256 stored (ADR-011)
- Zod validation, capability whitelist, 5/min IP rate limit
- Error envelope + DTO per contract; secret-free logging
- scripts/verify-e1.mjs: 23/23 automated checks pass
```
