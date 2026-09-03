# PHASE 6 IMPLEMENTATION — Realtime Hardening & Production Readiness

## Scope & Method

Phase 6 is the certification phase mandated by the V1 master plan: audit and
harden the realtime system, jobs, storage, rate limiting, health, production
configuration and cross-repo contracts, then produce a production-readiness
checklist. The full audit is in `docs/PHASE-6-BASELINE.md`; the checklist with
per-item verdicts is in `docs/V1-PRODUCTION-READINESS.md`.

**Method:** every mandated dimension was inspected in source, cross-checked
against the pinned test suites, and (where the claim was runtime-verifiable)
probed live. No subsystem was rewritten — the phase found the realtime,
jobs, storage and health layers already hardened by Phases 0–5, so the code
change surface is deliberately minimal.

## Audit conclusions (summary)

1. **Realtime (WebSocket mini-service)** — already server-authoritative:
   HS256 JWT verified with `timingSafeEqual`, `sessionId` → active
   `UserSession` check on every handshake (fail closed), org rooms from the
   verified token, DB-driven transition-only events, org-scoped broadcasts,
   durable cursor + reconnect refetch. RBAC parity verified route-by-route:
   every org-broadcast payload type corresponds to data the same role can
   already read over HTTP; sockets carry no write capability.
2. **Presence** — heartbeat-driven, offline transitions detected server-side
   (in-memory sweep + device-integrity job); no frontend-timer dependency.
3. **Jobs** — all 12 scheduled jobs run under the crash-safe JobRun lease with
   bounded execution, per-org isolation where relevant, failure state and
   result observability.
4. **Storage** — Phase 2 architecture (abstraction, async thumbnails,
   org retention, orphan cleanup, byte accounting/quota) intact and suite-
   verified.
5. **Rate limiting** — shared atomic Postgres token bucket, fail-closed
   security-critical prefixes, identity/IP keying. Identified one gap:
   authenticated agent-write endpoints are not token-bucket throttled
   (covered by credential + per-request caps today) → WARN, recommended
   before heavy production load.
6. **Health** — app + storage liveness existed; **database reachability was
   missing from the public probe** (only `/api/health/database` covered it).
7. **Configuration** — `.env.example` placeholders only, no committed
   credentials (git scan), httpOnly/sameSite cookies, proxy CSRF origin
   rejection, realtime CORS restricted. Deployment-specific values cannot be
   certified without a real environment → NOT VERIFIED (not a code defect).

## Implementation changes

### 1. `/api/health` now distinguishes database availability

**File:** `src/app/api/health/route.ts`

The public probe previously reported app liveness + storage-driver
configuration only. It now also performs a lightweight `SELECT 1`
connectivity probe and reports `database: 'ok' | 'unreachable'`, degrading
`status` to `degraded` (never 500s) when the store is unreachable, so load
balancers still see the app process alive while monitors read the field.
Response fields are additive (`database` added; `status`/`uptime`/`version`/
`storage` unchanged) — the pinned health contract (H-1..H-5) remains valid.
No credentials, URLs or internals are exposed; `/api/health/database`
continues to own the hard-outage 503 semantics with a safe body.

**Test:** `tests/health.test.ts` H-1 now additionally asserts
`body.database === 'ok'` and `body.storage === 'ok'` (additive assertions).

**Rationale:** the phase mandate (§13) requires health to distinguish
application-alive / database / storage. Worker and realtime liveness are
deliberately kept out of the public probe: jobs expose state via JobRun
(lastRun/lastError/lastResult/lastDuration) and the realtime service answers
socket pings — probing either from the Next process would couple the app to
internal service details (documented in `V1-PRODUCTION-READINESS.md`).

### 2. Live realtime auth probe (evidence, not committed)

A throwaway probe booted `mini-services/live-updates` on a scratch port and
connected with five token scenarios. Result **6/6 PASS** (see report §7).
The probe file was deleted after the run; the semantics it verifies are
covered by the pinned suites for the non-runtime parts.

## Explicitly NOT changed

- Realtime mini-service code (already hardened; no defect found in audit).
- Presence logic, jobs, retention, storage, rate-limit core.
- No new notifications/alerts semantics, no new collectors, no schema change.
- No agent changes.

## Rollback

The only code change is additive and self-contained:

1. Revert `src/app/api/health/route.ts` to the pre-Phase-6 body (drop the
   `SELECT 1` probe + `database` field) and the H-1 additions in
   `tests/health.test.ts`.
2. No migration, no flag, no data — nothing else is affected.

Everything else in this phase is documentation (`PHASE-6-BASELINE.md`,
`PHASE-6-IMPLEMENTATION.md`, `PHASE-6-REPORT.md`,
`V1-PRODUCTION-READINESS.md`).
