# PHASE 6 BASELINE — Realtime & Production-Readiness Forensic Audit

Phases 0–5 GREEN. This document records the Phase 6 forensic audit of the
production-critical dimensions mandated by the phase prompt. Every area is
classified PASS / PARTIAL / WARN / BLOCKED / NOT VERIFIED with evidence.

## 1. Realtime architecture (WebSocket)

**PASS**

- **Service**: `mini-services/live-updates/index.ts` — a Socket.IO server
  (port 3010, `LIVE_UPDATES_PORT`), started by `scripts/dev.mjs` alongside the
  Next app; production proxied via Caddy `XTransformPort=3010` when
  `NEXT_PUBLIC_LIVE_UPDATES_URL` is absent.
- **Server-authoritative auth** (verified by live probe, §6):
  - Handshake requires a JWT via `auth.token` OR the `worklens_token` httpOnly
    cookie. HS256 only (`alg` enforced), HMAC compared with `timingSafeEqual`,
    `exp`/`iat` validated.
  - The JWT `sessionId` must map to a **non-revoked, unexpired `UserSession`**
    row (S-04) — revoked/expired/unknown sessions are disconnected exactly like
    invalid tokens (fail closed on store errors).
  - No `organizationId` in the token → rejected (`no-organization`); a user
    without an org receives no tenant data.
- **Tenant isolation**: every socket joins `org:<organizationId>` from the
  VERIFIED token. All 15+ broadcast types emit only to `io.to('org:'+…)` with
  the org taken from the **row's** organizationId / the employee's organization
  — never from the client.
- **Real data only**: events derive from DB polling (`createdAt/updatedAt >
  cursor`) or `pg_notify` wake-ups; the service never writes and never
  fabricates. Transition-only maps (`deviceStatus`, `claimStatus`,
  `employeePresence`) prevent repeat broadcasts.
- **RBAC consistency**: all org-broadcast payload types (alerts, anomalies,
  notifications, presence, devices, activity, screenshots, USB, policy
  violations) mirror data the corresponding org-member HTTP GET endpoints
  already authorize (e.g. `GET /api/alerts` = any member; mutations admin+).
  So a viewer's socket receives nothing the viewer could not already read over
  HTTP — verified route-by-route in §3 of the audit.
- **Reconnect**: `WebSocketProvider` uses socket.io auto-reconnection (20
  attempts, capped delay); token/session changes re-run the effect and rebuild
  the socket with the new credential; `connect_error: unauthorized` stops
  retrying (no stale-credential loop); after reconnect the client refetches
  from the API (the DB is the source of truth, the socket is a delta layer).
- **Presence**: heartbeat-driven, server-side. An employee is online iff a
  device `lastHeartbeat` is inside the centralized 5-minute threshold; the
  realtime poll's in-memory sweep flips stale employees to OFFLINE without any
  frontend timer, and the DB-side `device_integrity` job surfaces silent
  devices as anomalies. `Device.status` (sticky lifecycle) is never used for
  liveness.
- **Bounded/durable delivery**: per-table `take` caps, a persisted poll cursor
  (at-least-once; reconnect refetch dedupes), re-entrancy-guarded poller,
  debounced notify wake-ups, boot-time model assertion.

## 2. Presence model

**PASS** — `src/lib/presence.ts` (API snapshot) and
`mini-services/live-updates/presence.ts` (realtime) share identical semantics
(offline threshold constant, lifecycle-pinned statuses). `presence.ts`,
`presence-hardening.ts` suites green in the regression gate. Crashed agents
become offline server-side (heartbeat staleness), not via UI timers.

## 3. Realtime RBAC consistency check

**PASS** — route-by-route read-scope comparison:

| Realtime payload | Org HTTP read gate | Same for viewers? |
|---|---|---|
| `alert-event` | `GET /api/alerts` → `requireSessionOrg` (any member) | yes |
| `notification` | `GET /api/notifications` → any member | yes |
| `anomaly` | `GET /api/anomalies` → session org (mutation manager+) | yes |
| presence/device/activity/screenshot/usb | devices/employees/dashboard live feeds → session org | yes |

Mutations stay role-gated server-side (POST alerts admin+, POST anomalies
manager+, notification writes manager+); sockets carry no write capability
(the service never writes).

## 4. Background jobs

**PASS** — every scheduled job runs under the crash-safe `JobRun` lease
(`claimJob` = one atomic UPDATE, `finishJob` records status/error/result):

```
expire_consents  retention_cleanup  project_time_sync  anomaly_detection
agent_token_sweep rate_limit_sweep  device_integrity   user_session_sweep
audio_transcription screenshot_processing workday_summary alert_rule_evaluation
```

Bounded execution + observability: retention is org-scoped with per-org
error collection; screenshot processing drains `uploaded` rows in bounded
batches and retires corrupt rows after 3 attempts; workday + alert-rule jobs
are deterministic whole-window/upsert workloads; every job writes
`lastResult`/`lastError`/`lastDurationMs` to JobRun. Concurrency safety is
proven by suite tests (concurrent aggregation AR-9-style in workday-summary,
alert-rules, activity-dedupe).

## 5. Database

**PASS** — 41 additive migrations; `prisma migrate diff` (live dev DB →
schema) → **No difference detected** (rerun Phase 6). Index audit for hot
queries: Activity `(employeeId,timestamp,category)`, Screenshot org/employee/
timestamp + processing status, WorkDaySummary unique `(org,employee,workDate)`
+ `(org,workDate)`/`(employee,workDate)`, ActivityBatchReceipt unique
`(org,employee,batchId)` + `receivedAt`, AlertRuleFiring unique
`(rule,entity)` — all added with the query they serve documented in the
phase reports. FK cascades are tenant-safe (org-scoped deletes). No
cross-tenant query path found in the audited routes.

## 6. Storage

**PASS** (Phase 2 verified, suites green) — `src/lib/storage/` abstraction
(`index.ts` driver switch, `local.ts`, `supabase.ts`) stores screenshot
binaries outside the DB; thumbnail generation is async (bounded processing
job); retention deletes original + thumbnail through the two-phase
file-first path; orphan cleanup runs in the retention job; original survives
thumbnail failure (state machine `uploaded → processed/processing_failed`).
Org-scoped byte accounting + optional quota layer added in Phase 2.

## 7. Rate limiting

**PARTIAL / WARN** — shared Postgres token bucket (`RateLimitCounter`) with
one atomic UPSERT (no read-modify-write race); fail-closed for
security-critical prefixes (login, agent-auth, agent-login, agent-register,
agent-discover, orgCreate, device-claim, agent-account-write, ai-test) and
fail-open for convenience throttles; stale-row sweep job bounds the table.
Keying is **identity/IP-based, never spoofable-header-only** (`agent-auth:IP`,
login per-email + per-IP, orgCreate per user+IP). Coverage today:
auth login, agent login/authenticate/discover/register, org creation, device
claims, agent-account writes, AI test-connection. **Gap**: the authenticated
write endpoints (agent activity upload, screenshot upload, exports) are not
token-bucket throttled — they rely on the device credential, per-request
row/size caps, server-side screenshot cadence config, and bounded export
limits. Recommended before heavy production load: org+device-keyed
`agent-write:` buckets (the rate-limit design already reserves that prefix).

## 8. Health endpoints

**PASS (with this phase's additive improvement)** — `/api/health` (public,
whitelisted in the proxy) reports app liveness + storage driver configuration
+ (new in Phase 6) **database reachability** (`SELECT 1`, degrades instead of
500s, no secrets). `/api/health/database` distinguishes reachable/bootstrap
pending/complete and returns 503 only on true connectivity failure with a
safe body (suites H-1..H-5). Worker/realtime liveness are intentionally not
part of the public probe — jobs expose state via JobRun, the socket service
answers client pings — documented as operational signals.

## 9. Error handling / observability

**PASS** — shared `logger` with request context; user-facing APIs return
stable safe errors (no stack traces/SQL/paths/secrets — verified by the
health + hardening suites); realtime events carry safe identifiers only;
production-safe logs exist for auth failures, job failures, screenshot
processing, storage failures, realtime connect/disconnect, DB errors; no
passwords/JWTs/session tokens/screenshot content logged (code audit + suite
assertions).

## 10. Production configuration

**PASS with deployment caveat** — `.env.example` contains placeholders only;
git secret scan found no committed credentials/API keys; session cookie is
`httpOnly` + `sameSite:lax` (`src/lib/auth.ts`); proxy enforces CSRF
defense-in-depth (cross-origin state-changing requests rejected); realtime
CORS restricted to `ALLOWED_ORIGIN`; upload/body size caps enforced on the
agent routes. Actual production values (HTTPS `Secure` cookie, hosted DB,
S3/Supabase credentials, Caddy/CORS origin) are deployment-specific and are
**NOT VERIFIED** here — no staging/production environment is available in
this workspace.

## 11. Cross-repo contract

**PASS (suite evidence)** — web agent-API suites (agent-compat,
agent-hardening, telemetry-backend, activity-dedupe, screenshot suites,
claim-cancel, agent-active-device, location, usb) + the agent repo's own
contract tests (628, including its API client payload/retry tests) run green;
Phase 1 batch idempotency is proven cross-repo (old payload no-batchId and
new payload batchId+batchSeq both accepted).

## 12. Load / stress evidence

**PASS (synthetic)** — Phase 3/4 perf suites run in the gate: 100 orgs × 100
rules × 10k activities ≈ 1.6 s classification with zero cross-org leak; 100
orgs × 30 employees × 30 days = 3.6M rows ≈ 362k rows/s aggregation. No
production/user data involved.

## 13. Areas requiring follow-up before final verdict

1. Write-endpoint rate throttling (agent-write/screenshot/export buckets) —
   see §7 (WARN).
2. Public health does not surface worker/realtime liveness — documented as
   operational signals (WARN/design note).
3. Deployment-specific configuration can only be certified against a real
   environment (NOT VERIFIED, not a code defect).
