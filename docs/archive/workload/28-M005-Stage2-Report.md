# WorkLensAI — M005 Stage-2 Implementation Report (Agent Authentication Layer)

> **File:** workload/28-M005-Stage2-Report.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE
> **Scope:** reusable production authentication for every signed agent API (`/api/agent/v1/*`). **No heartbeat, telemetry, screenshots, commands, or token rotation** (those remain E3/E5/E6/E12/E16).
> **Reads:** 17-Agent-API-Contract.md (§2 auth), 18-Telemetry-Database-Design.md, 19-Prisma-Migration-Plan.md, 27-M005-Stage1-Report.md, 09-Architecture-Decisions.md (ADR-011…017), 23-E0-Agent-Security.md

---

## 0. Executive Summary

M005 Stage-2 builds the **production authentication layer** on the E0 crypto foundation (`src/lib/agent-auth/`). The E0 pipeline already verified token (SHA-256, constant-time), HMAC signature, clock window, and nonce replay. This stage adds what E0 deliberately left to endpoints:

1. **Composed one-call verifier** — `authenticateAgentRequest()` resolves the credential from the DB, rejects **revoked credentials / inactive devices / disabled installations**, then runs the full crypto pipeline. Future endpoints call one function — no duplicated auth logic.
2. **Header aliases** — `X-Agent-Timestamp` / `X-Agent-Nonce` accepted alongside the contract canonical `X-Timestamp` / `X-Nonce` (both specs satisfied; contract names win when both present).
3. **`Installation.status`** — new additive column (`Active | Disabled`) via migration `20260802175839_m005_stage2_installation_status`; the verifier rejects non-Active installs with `403 AGENT_INSTALLATION_DISABLED`.

**User decision:** add `Installation.status` via migration (chosen over deferring).

**Post-review hardening (code-reviewer findings applied):** the Prisma loaders were split into `loaders.ts` so `context.ts` is DB-pure (tests import it without constructing a Prisma client); the state-before-crypto ordering, the redundant header-parse/token re-check, and the legacy null-`installationId` scoping skip are now explicitly documented in `context.ts`; the verify script uses a top-level `node:crypto` import (portable beyond bun); the E1 regression claim in this report is backed by a live re-run this stage.

---

## 1. Files Changed

| File | Change |
|---|---|
| `src/lib/agent-auth/context.ts` | **NEW** — `AgentAuthLoaders` interface (DB-agnostic), `resolveAgentContext` (state checks), `authenticateAgentRequest` (one-call composed verifier). **DB-pure** — the Prisma binding lives in `loaders.ts` |
| `src/lib/agent-auth/loaders.ts` | **NEW** — `createPrismaLoaders` + `defaultAgentAuthLoaders` (the only agent-auth file touching the DB) |
| `src/lib/agent-auth/verifier.ts` | **MODIFIED** — `parseAgentAuthHeaders` reads `x-agent-timestamp`/`x-agent-nonce` as aliases of `x-timestamp`/`x-nonce` |
| `src/lib/agent-auth/errors.ts` | **MODIFIED** — +`AGENT_INSTALLATION_DISABLED` (403), +`AgentInstallationDisabledError`, +`AgentDevicePendingError`, +`AgentDeviceRevokedError` |
| `src/lib/agent-auth/index.ts` | **MODIFIED** — exports `./context` |
| `prisma/schema.prisma` | **MODIFIED** — `Installation.status String @default("Active")` |
| `prisma/migrations/20260802175839_m005_stage2_installation_status/` | **NEW** — additive migration (table-recreate, data-preserving; existing row → `'Active'`) |
| `scripts/verify-m005s2.mjs` | **NEW** — 30 automated checks (mission's 8 cases + extras) |
| `db/custom.db.bak-m005s2` | **NEW** — pre-migration DB backup |
| `workload/28-M005-Stage2-Report.md` | **NEW** — this report |
| `workload/07-Progress.md` | **MODIFIED** — appended dated entry |

**Not touched:** `src/middleware.ts` (already whitelists `/api/agent/v1` as agent-auth — web JWTs never reach agent routes), E1 register route, all web routes.

---

## 2. Authentication Architecture

### 2.1 Pipeline (`authenticateAgentRequest`, order of checks)

| # | Check | Failure |
|---|---|---|
| 1 | Parse headers — `Authorization: Bearer`, `X-Timestamp`\|`X-Agent-Timestamp`, `X-Nonce`\|`X-Agent-Nonce`, `X-Agent-Signature`, + contract scoping headers (`X-Installation-ID`, `X-Device-ID`, `X-Agent-Version`) | `401` missing/malformed |
| 2 | Resolve credential by `SHA-256(bearer)` — **never the plaintext token** | `401 AGENT_UNAUTHORIZED` |
| 3 | Token revoked / expired | `401 AGENT_TOKEN_EXPIRED` |
| 4 | Device state: `Pending` → `403 AGENT_DEVICE_PENDING`; `Suspended`/`Retired` → `403 AGENT_DEVICE_REVOKED` (`Online`/`Offline`/`Active` pass — connectivity is not a rejection state) | `403` |
| 5 | Installation state: `status ≠ Active` | `403 AGENT_INSTALLATION_DISABLED` |
| 6 | Crypto pipeline (`verifyAgentRequest`): token-hash constant-time re-check · per-device scoping (`X-Device-ID`/`X-Installation-ID` must match the credential's device) → `403 AGENT_DEVICE_MISMATCH` · HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256hex(body)` → `401 AGENT_SIGNATURE_INVALID` · clock window ±300 s → `429 AGENT_CLOCK_SKEW` · nonce replay → `409 AGENT_REPLAY`, then consume | per check |

**Design rationale:**
- **State before crypto, nonce after crypto.** State-failing requests never reach the nonce-consumption step, so they can't burn a legitimate agent's nonce (extends E0's nonce-burning-DoS protection). Error codes 401/403 already disclose state by design (contract §2.6) — no new information leaks.
- **Hash-only token handling.** The credential is resolved by `sha256Hex(bearer)`; the plaintext token is used only as the HMAC key inside `verifyAgentRequest` and is never stored or logged.
- **DB-agnostic.** `AgentAuthLoaders` is an interface; tests inject fakes, production uses `defaultAgentAuthLoaders` (Prisma). Swap for a Postgres `AgentNonce`/different store later without touching endpoints.

### 2.2 Future-endpoint recipe (one call)

```ts
import { authenticateAgentRequest, defaultAgentAuthLoaders, defaultNonceStore,
         agentSuccess, agentError, agentConfig } from '@/lib/agent-auth'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()                 // exact bytes for the signature
  if (rawBody.length > agentConfig.maxBodyBytes) return agentPayloadTooLarge(agentConfig.maxBodyBytes)
  try {
    const ctx = await authenticateAgentRequest({
      method: 'POST', pathname: req.nextUrl.pathname, search: req.nextUrl.search,
      body: rawBody, headers: req.headers,
      loaders: defaultAgentAuthLoaders, nonceStore: defaultNonceStore,
    })
    const body = MySchema.parse(JSON.parse(rawBody))   // zod, 422 on failure
    return agentSuccess({ deviceId: ctx.device.id, ... }, { status: 200 })
  } catch (err) {
    return agentError(err)                            // consistent envelope + X-Server-Time
  }
}
```

### 2.3 Error model (mission: 401 / 403 / 409 / 422)

| Code | Status | Trigger |
|---|---|---|
| `AGENT_UNAUTHORIZED` / `AGENT_SIGNATURE_INVALID` | 401 | missing/malformed headers, unknown token, signature mismatch |
| `AGENT_TOKEN_EXPIRED` | 401 | revoked or expired credential |
| `AGENT_DEVICE_PENDING` / `AGENT_DEVICE_REVOKED` / `AGENT_INSTALLATION_DISABLED` / `AGENT_DEVICE_MISMATCH` | 403 | inactive device / disabled installation / wrong scope |
| `AGENT_REPLAY` | 409 | reused nonce |
| `AGENT_VALIDATION` | 422 | zod body failure (route-level) |
| `AGENT_CLOCK_SKEW` (429), `AGENT_NONCE_INVALID` (400), `AGENT_RATE_LIMITED` (429), `AGENT_PAYLOAD_TOO_LARGE` (413), `AGENT_UPGRADE_REQUIRED` (426) | — | contract codes retained (superset of the mission's list) |

Malformed nonce is rejected as a malformed required header → `401` (the `400 AGENT_NONCE_INVALID` path in `assertValidNonce` remains as defense-in-depth).

---

## 3. Verification Results

| Step | Command | Result |
|---|---|---|
| New auth suite | `bun scripts/verify-m005s2.mjs` | ✅ **30/30** — valid request · invalid signature (tampered body) · invalid timestamp (stale/future → 429) · invalid nonce (malformed 401, replay 409) · revoked token (401 + reason) · expired token (401) · disabled installation (403) · disabled device (Suspended/Retired/Pending 403; Offline still authenticates) · malformed headers (missing Authorization/timestamp/nonce/signature/device-id → 401) · **X-Agent-Timestamp/X-Agent-Nonce aliases** · unknown token (401) · **hash-at-rest proof** (loaders receive `sha256(token)`, never plaintext) · device/installation mismatch (403) · error envelope shape |
| E0 regression | `bun scripts/verify-e0.mjs` | ✅ **107/107** (unchanged — alias support is additive) |
| E1 regression | `node scripts/verify-e1.mjs` (live dev server, port 3103) | ✅ **23/23** — re-run this stage; register route + token generation untouched by Stage-2 |
| Prisma | `npx prisma validate` · `migrate status` · `generate` | ✅ schema valid · **6 migrations** up to date · client regenerated |
| Typecheck | `npx tsc --noEmit` | ✅ 0 new errors (only 4 pre-existing in untouched `examples/websocket/*` + `markdown.tsx`) |
| Lint | `npx eslint src/lib/agent-auth src/lib/agent.ts src/app/api/agent/v1/register/route.ts src/middleware.ts` | ✅ exit 0 |
| Build | `npm run build` | ✅ Compiled in 15.2 s · standalone assets copied · exit 0 |
| Data | post-migration DB check | ✅ 36 users / 10 devices / 491 activity intact · `Installation.status = 'Active'` |

---

## 4. Security Review

- **No plaintext tokens anywhere.** Credential resolved by `sha256Hex(bearer)`; comparison of the derived hash to the stored hash is constant-time (`timingSafeEqualHex`). Proven by the hash-at-rest assertion in the suite.
- **Replay-safe.** (deviceId, nonce) consumed only after token+state+signature+clock pass; replay → `409 AGENT_REPLAY`. In-memory store (single instance) per ADR; `NonceStore` interface ready for Postgres.
- **Clock window** ±300 s (600 s tolerant heartbeat window available) → `429 AGENT_CLOCK_SKEW` + `X-Server-Time` for agent resync.
- **Per-device scoping** is server-authoritative: `X-Device-ID`/`X-Installation-ID` must match the authenticated credential's device — an agent can never act as another device.
- **Web JWT isolation.** `/api/agent/v1` is whitelisted in `src/middleware.ts` as agent-auth (public to web-JWT); agent routes never accept cookies or web tokens. The composed verifier is the only auth path into signed endpoints.
- **No secret logging.** `agent-auth/` logs nothing at runtime (only the config-warning for invalid env names). Error `details` carry IDs/statuses, never tokens, hashes, or signatures.
- **Nonce-burning DoS prevented** (state checks run before nonce consumption).

---

## 5. Risks & Known Limitations

1. **In-memory nonce store & rate limiter** — single-instance MVP; resets on restart. `NonceStore` interface ready for a Postgres `AgentNonce` table; rate limiting is not yet centralized (E1 has its own per-IP limiter; future signed endpoints should add one — auth is centralized, rate-limit policy is per-endpoint).
2. **`Installation.status` only enforced when the device has an `installationId`** — pre-M003 legacy rows with NULL installationId skip the check (documented in `context.ts`). All agent-registered devices always have an installation.
3. **Device/Installation status are free strings** (ADR-026 — no Prisma enums on SQLite). Value sets are documented in the schema; DB-level CHECK constraints are optional hardening.
4. **Malformed nonce → 401, not 400** — rejected as a malformed required header before the dedicated `AGENT_NONCE_INVALID` path runs (defense-in-depth only). Documented so a test harness expecting 400 can be corrected.
5. **Header alias precedence** — contract names (`X-Timestamp`/`X-Nonce`) win when both are sent. Signatures must be computed over the same values the server parses; an agent must not send conflicting pairs.
6. **`AGENT_UPGRADE_REQUIRED` (426, min agent version) is not in the verifier** — the contract applies it per-endpoint/version-check (E8/E9); the composed verifier deliberately doesn't enforce `minAgentVersion` (a future endpoint-level concern). Noted for Stage-3.
7. **`AgentError` (E1) not yet unified with `AgentAuthError`** — same envelope shape; a follow-up can make one extend the other so one catch-all handles both (E0 limitation #5, still open).
8. **Migration was a table-recreate** (SQLite) — data-preserving (verified: 36/10/491 intact). Installation has no hand-written indexes, so no raw-SQL index was lost (cf. M003's DeviceAssignment partial-index fragility note — that index is on a different table and is unaffected).
9. **Windows DLL lock on `prisma generate`** if a dev server lingers — kill stray `next dev` before Prisma commands (see Stage-1 report §5.7).

---

## 6. Rollback

```bash
# Schema + migration (restores pre-Stage-2 DB)
cp db/custom.db.bak-m005s2 db/custom.db
git checkout -- prisma/schema.prisma
rm -rf prisma/migrations/20260802175839_m005_stage2_installation_status
npm run db:generate

# Code
git checkout -- src/lib/agent-auth/verifier.ts src/lib/agent-auth/errors.ts src/lib/agent-auth/index.ts
rm src/lib/agent-auth/context.ts

# Tests + docs
rm scripts/verify-m005s2.mjs
rm workload/28-M005-Stage2-Report.md
git checkout -- workload/07-Progress.md
```

**Data impact of the migration:** zero — additive column, existing row defaulted to `'Active'` (the verifier's rejection state `'Disabled'` is opt-in per installation).

---

## 7. Git Commit Message

```text
feat(agent): M005 Stage-2 — production agent authentication layer

- Composed one-call verifier authenticateAgentRequest() (agent-auth/context.ts):
  resolve credential by SHA-256(bearer) → reject revoked/expired token (401),
  inactive device (403 PENDING/REVOKED), disabled installation (403 DISABLED)
  → then HMAC signature / clock window / nonce replay (verifyAgentRequest)
- State checks run before nonce consumption (no nonce-burning DoS); per-device
  scoping stays server-authoritative; no plaintext tokens (hash-at-rest proven)
- Header aliases: X-Agent-Timestamp/X-Agent-Nonce accepted alongside contract
  X-Timestamp/X-Nonce (contract names win)
- New errors: AGENT_INSTALLATION_DISABLED + AgentDevicePending/Revoked/
  InstallationDisabled error classes
- Schema: Installation.status (Active|Disabled) via migration
  20260802175839_m005_stage2_installation_status (additive, data preserved)
- scripts/verify-m005s2.mjs: 30/30; E0 regression 107/107; E1 23/23;
  prisma validate/migrate/tsc/eslint/build all green
```

---

## 8. Ready for M005 Stage-3

Yes — the authentication layer is complete, verified, and the recipe (§2.2) is frozen for all signed endpoints. Recommended Stage-3 order:

1. **E3 Heartbeat** (`POST /api/agent/v1/heartbeat`) — first consumer of `authenticateAgentRequest` (uses the tolerant 600 s clock window); updates `Device.lastHeartbeatAt`, derives `Offline` after 3 missed beats; returns the heartbeat DTO + command/flags scaffolding.
2. **E5 Activity ingest** (`POST /api/agent/v1/activity`) — on `db.activityEvent` with idempotent `UNIQUE(deviceId, seq)` upsert, `receivedAt` = server clock, `source = 'agent'`.
3. **E2 Activate** — creates `DeviceAssignment` (where the Stage-1 mission's assignment objective lands).
4. **E16 Token rotation** — `createToken`/grace helpers already in E0; uses the composed verifier with the current token.
