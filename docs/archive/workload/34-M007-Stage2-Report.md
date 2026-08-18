# M007 Stage-2 — E7 Device Health Endpoint — Implementation Report

## 1. Files changed

**New:**
- `src/app/api/agent/v1/health/route.ts` — `POST /api/agent/v1/health` (E7).
- `src/lib/agent-health/report.ts` + `index.ts` — persistence service: changed-values-only Device update, DeviceHealthSnapshot build, warnings, semver no-downgrade; one `$transaction`.
- `scripts/verify-e7.mjs` — live verification suite (97 checks).
- `prisma/migrations/20260803065520_m007_stage2_device_health_snapshot/` — `DeviceHealthSnapshot` table.

**Modified:**
- `prisma/schema.prisma` — `DeviceHealthSnapshot` model (14 fields, `@@index([deviceId, ts])`, FK Cascade per ADR-024) + `Device.healthSnapshots` relation.
- `src/lib/agent-auth/config.ts` — `AGENT_MAX_HEALTH_BYTES_DEFAULT` 16 KB → **131 072 (128 KB)** (mission supersedes contract 17's 16 KB example).
- `src/lib/agent-auth/schemas.ts` — `healthReportSchema` (mission payload list + contract 17 `ram/av/os/agent` aliases; unknown keys stripped — forward compatible).
- `src/lib/agent-rate-limit/types.ts` + `limiter.ts` — `'health'` rule `{capacity: 2, refillMs: 60_000}` (contract §3: 1/60 s, burst 2) via the centralized limiter only.
- `src/lib/agent.ts` — `AGENT_HEALTH_INTERVAL_MS = 60_000` (nextHeartbeat guidance, matches the rate limit).

## 2. API summary

- **Auth:** the composed one-call `authenticateAgentRequest` — no JWT/cookies/API keys/plaintext; **strict** mode (`requireAssignment: true`, no `allowPending`, no tolerant clock window — E7 is telemetry, not the E3 bootstrap channel). Suspended/Retired → 403 `AGENT_DEVICE_REVOKED`, installation ≠ Active → 403 `AGENT_INSTALLATION_DISABLED`, no active assignment → 403 `AGENT_DEVICE_UNASSIGNED`, Pending → 403 `AGENT_DEVICE_PENDING`, revoked/expired token → 401 `AGENT_TOKEN_EXPIRED`, clock outside ±300 s → 429 `AGENT_CLOCK_SKEW` (retryable, thrown inside auth before the rate limiter — verified), replay → 409 `AGENT_REPLAY`.
- **Ordering:** size gate (pre-auth, 128 KB → 413 `AGENT_PAYLOAD_TOO_LARGE`) → auth → centralized rate limit (`health`, 1/60 s burst 2, 429 + `Retry-After`) → parse/validate (422 `AGENT_VALIDATION`) → business logic.
- **Body:** `{clientTime, cpu{cores,loadPct}, memory{totalGB,freeGB} (alias: ram), disk{totalGB,freeGB}, battery{percent}, uptime, processes[], network{ssid,ip}, services[], temperatures[], agentVersion, osVersion, hostname, bootTime, antivirus{name,enabled} (alias: av), os{version,build,patches[]}, agent{threads,memMB,uptimeS,lastGcMs}, firewall{name,enabled}, pendingReboot, ...}`. All fields optional; unknown top-level/nested fields **ignored** (zod strips — contract §8 forward compatibility).
- **Response (additive-only):** `200 {serverTime, accepted: true, warnings[], nextHeartbeat}` (`nextHeartbeat = serverTime + 60 s`).
- **Warnings (server-computed, contract §4 E7 "may compute risk flags"):** `Antivirus disabled`, `Pending reboot`, `Low disk space (< 10 GB free)`, `High CPU load`, `Low battery` — computed from payload, never persisted.

## 3. DB behavior

- **DeviceHealthSnapshot** created exactly per 18-Telemetry-Database-Design §5.17: `id` PK, `deviceId` FK (Cascade — ADR-024 device-scoped control row), `ts` (server-authoritative — clientTime is never trusted), `cpuPct`, `ramPct`, `diskFreeGB`, `batteryPct`, `network` (JSON `{ssid, ip}`), `osVersion`, `patches` (JSON array), `avName`, `avEnabled`, `agentMemMB`, `agentUptimeS`; `@@index([deviceId, ts])`; 90-day retention is an ops job (no cron exists in-repo yet — §8).
- **Device (changed-values-only):** `hostname`, `osVersion`, `ram` (= memory/ram `totalGB`), `diskSpace` (= disk `totalGB`), `ipAddress` (= network.ip), `agentVersion` (semver — only ever bumped, never downgraded). Comparison is against the current row inside the transaction; when nothing changed the UPDATE is **skipped entirely** (verified: `updatedAt` stays identical on re-reports). `Device.cpu`/`macAddress` are never touched (payload carries no CPU name/mac). Presence fields (`lastHeartbeatAt`/`status`) remain E3's job — health does not mutate them.
- **One transaction** (`db.$transaction`): read → conditional update → snapshot insert; a rejected request leaves the Device row byte-identical and writes no snapshot (verified). No N+1, no per-field updates, single insert per report.
- **Not persisted (validated but dropped — M005 Stage-3 precedent, 29-M005-Stage3-Report):** `processes`, `services`, `temperatures`, `bootTime`, `firewall`, `pendingReboot`, `uptime` (top-level), `agent.threads/lastGcMs`, `os.build`, `cpu.cores` — §5.17 is the persistence contract; the mission's "create exactly as specified" outweighs inventing columns. Relevant ones still surface as warnings (`pendingReboot`, AV state).

## 4. Security review

- Signed-request pipeline unchanged; health adds **no** new auth surface — the composed verifier enforces every gate (state, installation, assignment, credential, signature, clock, nonce).
- Client-supplied values never authorize anything: identity/assignment come from the server DB; `hostname`/`ip` are stored as reported telemetry only (E1 already does the same); timestamps for persistence are always server-side.
- Rate limit keyed per device, called after auth → a 429 never leaks identity state; clock-skew 429 fires inside auth (before the limiter) — verified ordering by probe.
- Body gate is pre-auth (cheap byte check before HMAC work) — same pattern as heartbeat/screenshots.
- Logging excludes tokens/signatures/nonces (single `[AGENT] health` line with device + warning count + requestId).
- DB cleanup paths tested: FK cascade on device delete, zero orphan snapshots, `(deviceId, ts)` index present.

## 5. Performance review

- One transaction, 1 read + ≤1 update + 1 insert per accepted report; sampling cadence (agent 1/hour) + rate limit (1/60 s) bound writes to ~2/min/device max — §5.17's "2,400 rows/day at 100 users" holds.
- No per-field update calls, no JSON re-parsing beyond the single `safeParse`, no filesystem I/O, no N+1.
- Warnings computation is O(1) over the payload.

## 6. Verification

- **`scripts/verify-e7.mjs`: 97/97 live** (server `npx next dev -p 3107`), twice back-to-back:
  - happy path (22) — full mission payload → 200; every snapshot field asserted; Device changed-only mapping; nextHeartbeat = +60 s; X-Server-Time.
  - changed-only (6) — identical re-report → no UPDATE (updatedAt identical), 2nd snapshot; equal/lower agentVersion → no write, no downgrade.
  - atomicity (4) — rejected request → Device row byte-identical + zero snapshots; follow-up lands both writes.
  - warnings (7) — all five risk flags, clean report → none, flagged payload still persisted.
  - validation (9) — invalid JSON, wrong types, out-of-range, empty hostname, bad semver, non-object, minimal body OK.
  - oversized (2) — >128 KB → 413 pre-auth; ≈120 KB → 200.
  - forward compat + aliases (11) — contract `ram/av/os/agent` keys map correctly; unknown fields ignored.
  - auth matrix (16) — no auth 401, unknown token 401, clock skew 429 ×2, revoked 401, suspended/retired 403, disabled installation 403, unassigned 403, pending 403, all restores re-authorize.
  - replay (2) — 409 AGENT_REPLAY.
  - rate limit (2) — 200,200,429 + Retry-After.
  - X-Token-Expires (1).
  - DB integrity (6) — server ts (clientTime −999 999 s ignored), index exists, zero orphans, FK cascade.
  - regression (9) — E1 register, E2 activate, E3 heartbeat, E5 activity (202), E6 single-shot + file on disk, E16 rotate + re-auth, E7 on rotated credential.
- **Build:** `prisma validate` ✅ · `prisma migrate status` up to date (11 migrations) ✅ · `tsc` = exactly the 4 pre-existing baseline errors (socket.io ×2, markdown.tsx ×2 — zero new) · `eslint` on all changed files clean (full-src has 20 pre-existing `react-hooks/set-state-in-effect` on admin components — untouched) · `npm run build` ✅ (`/api/agent/v1/health` in manifest).
- E1/E2/E3/E5/E6/E16 suites remain green (their gates — assignment, nonce, signature — are exercised inside E7's auth matrix too).

## 7. Risks

- **Body limit deviation:** mission's 128 KB supersedes contract 17's 16 KB (`AGENT_MAX_HEALTH_BYTES_DEFAULT = 131_072`). Documented in code + report; the size gate rejects 413 beyond it either way. E7 payloads stay small in practice (agent samples 1/hour).
- **Mission payload fields without §5.17 columns** (`processes/services/temperatures/bootTime/firewall/pendingReboot/threads/lastGcMs/build`) are validated but not persisted. If fleet analytics later needs them, the additive-only path is a new migration + mapping — no breaking change.
- **`ram`/`av` aliases:** accepted alongside mission `memory`/`antivirus` for contract 17 example compatibility; memory alias wins over `ram` when both present (same for `av`).
- **90-day snapshot retention** is documented but no purge job exists in-repo (screenshots GC has the same standing gap from Stage-1).
- **Register rate limit is a per-route inline 5/min/IP map** (pre-existing); the centralized limiter rules for register/activate/heartbeat/activity/rotate exist but are not yet wired to those routes (pre-existing M006 gap, out of scope).
- In-memory rate limit store resets on server restart (accepted MVP tradeoff, documented in limiter).

## 8. Rollback

1. `npx prisma migrate resolve` — or simply drop the table + migration file:
   `DROP TABLE "DeviceHealthSnapshot";` (SQLite) and delete `prisma/migrations/20260803065520_m007_stage2_device_health_snapshot/`, then `npx prisma generate`.
2. Delete `src/app/api/agent/v1/health/`, `src/lib/agent-health/`, revert `schemas.ts` (healthReportSchema), `config.ts` (16 KB constant + comment), `agent.ts` (interval constant), rate-limit types/limiter rows, `scripts/verify-e7.mjs`.
3. No production data depends on E7 yet; the Device-column mappings (hostname/osVersion/ram/diskSpace/ipAddress/agentVersion) revert to E1/E3-only updates automatically.

## 9. Git commit message

```
M007 Stage-2: E7 device health endpoint

- POST /api/agent/v1/health: size gate 128 KB (mission supersedes 16 KB) →
  auth (strict: assignment, no pending, no tolerant clock) → centralized
  rate limit (1/60s burst 2) → zod (unknown ignored, contract aliases
  ram/av/os/agent) → one $transaction: changed-only Device update (semver
  no-downgrade) + DeviceHealthSnapshot (18 §5.17, server ts) → additive DTO
  {serverTime, accepted, warnings[], nextHeartbeat}
- DeviceHealthSnapshot model + migration (FK Cascade ADR-024, (deviceId,ts))
- healthReportSchema, health rate-limit rule, AGENT_HEALTH_INTERVAL_MS
- verify-e7.mjs: 97/97 live (auth matrix, replay, clock-skew 429, warnings,
  atomicity, cascade, E1/E2/E3/E5/E6/E16 regression)
- prisma validate OK; tsc 0 new; eslint changed files clean; build OK
```

## 10. Ready for Stage-3

- `verify-e7.mjs` 97/97 (×2), all baseline suites unaffected, build green.
- DB clean post-run: 10 demo devices / 146 legacy screenshots / 0 test rows / 0 snapshots (cleanup verified).
- Port 3000 dev server restored (health route live there as well — probe returned the expected 401 unsigned).
- Stage-3 candidates: storage consumption (viewer/gallery), OCR pipeline on stored screenshots, or the next data-plane endpoint.
