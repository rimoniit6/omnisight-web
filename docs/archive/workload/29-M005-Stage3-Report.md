# WorkLensAI — M005 Stage-3 Implementation Report (E3 Heartbeat)

> **File:** workload/29-M005-Stage3-Report.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE
> **Scope:** `POST /api/agent/v1/heartbeat` — the first authenticated agent endpoint, establishing **device presence only**. No telemetry, screenshots, commands, token rotation, activation, assignment, or analytics.
> **Reads:** 17-Agent-API-Contract.md (§2 auth, §4 E3), 18-Telemetry-Database-Design.md, 19-Prisma-Migration-Plan.md, 28-M005-Stage2-Report.md, 09-Architecture-Decisions.md

---

## 0. Executive Summary

E3 is the first endpoint built on the Stage-2 composed verifier (`authenticateAgentRequest`) — **zero duplicated auth logic**. It:
- authenticates with token + HMAC signature + clock window + nonce replay + device/installation state (tolerant 600 s window for bootstrap clock sync, and `allowPending` so freshly-registered Pending devices can poll — contract §2.6);
- validates every body field with the shared `heartbeatSchema` (zod, 422 on malformed);
- updates the Device row with **changed values only** (presence + identity fields);
- returns the contract E3 DTO plus `timeOffset = serverTime − clientTimestamp` (mission).

**No schema change required** — every persisted field already exists on `Device` (M003).

---

## 1. Files Changed

| File | Change |
|---|---|
| `src/app/api/agent/v1/heartbeat/route.ts` | **NEW** — E3 route: authenticate → size-gate → zod → changed-only `Device` update → contract DTO + `timeOffset`, `X-Token-Expires` header when due, `lastKnownIp` falls back to the observed request IP |
| `src/lib/agent-auth/schemas.ts` | **MODIFIED** — `heartbeatSchema` extended with the mission's additive optional fields (`agentVersion`, `platform`, `architecture`, `hostname`, `ipAddress`, `bootTime`, `uptimeSeconds`, `memoryUsage`, `cpuUsage`, `diskUsage`, `capabilities`, `policyVersion`, `highWaterMark`, `timezone`) — v1 additive-only (contract §8) |
| `src/lib/agent-auth/context.ts` | **MODIFIED** — `allowPending` option on `resolveAgentContext`/`authenticateAgentRequest` (E3 heartbeat is the pending-device poll channel; default remains reject) |
| `scripts/verify-e3.mjs` | **NEW** — live verification (26 checks) |
| `workload/29-M005-Stage3-Report.md` | **NEW** — this report |
| `workload/07-Progress.md` | **MODIFIED** — appended dated entry |

**Not touched:** middleware whitelist (already agent-auth), E1 register, all web routes, DB schema.

---

## 2. Heartbeat API Summary

### 2.1 Wire contract

**`POST /api/agent/v1/heartbeat`** — auth via `authenticateAgentRequest` (tolerant clock window 600 s, `allowPending`).

**Request body** — contract E3 canonical fields *plus* mission's additive optional fields (all optional):

| Group | Fields |
|---|---|
| Contract E3 | `clientTime`, `uptimeS`, `status` (`online\|offline\|booting`), `queueDepth`, `lastAckedSeq`, `lastScreenshotId`, `pending{}`, `device{}` |
| Mission (additive) | `agentVersion`, `platform`, `architecture`, `hostname`, `ipAddress`, `bootTime`, `uptimeSeconds`, `memoryUsage`, `cpuUsage`, `diskUsage`, `capabilities[]`, `policyVersion`, `highWaterMark`, `timezone` |

**Response 200:**
```json
{
  "serverTime": 1785694800000,
  "heartbeatIntervalMs": 30000,
  "policyVersion": 1,
  "configVersion": 1,
  "updateAvailable": false,
  "updateVersion": null,
  "commands": [],
  "flags": { "forceActivitySync": false, "forcePolicyFetch": false, "suspended": false },
  "timeOffset": 12
}
```
`timeOffset = serverTime − clientTimestamp` where `clientTimestamp = body.clientTime ?? X-Timestamp` (mission: "return it, do not modify client data").

**Mission → contract name mapping (documented, no duplicate keys):** `heartbeatInterval` ≡ `heartbeatIntervalMs` · `configurationVersion` ≡ `configVersion` · `pendingCommands` ≡ `commands` (pending command *metadata* only — always `[]` until the M006 `AgentCommand` plane; nothing is executed).

### 2.2 Auth (mission: "Use ONLY authenticateAgentRequest()")
Single call: token (SHA-256 lookup, constant-time) → revoked/expired `401` → device state (`Pending` allowed here, `Suspended`/`Retired` → `403`) → installation state (`≠ Active` → `403`) → per-device scoping → HMAC signature → clock (±600 s tolerant) → nonce replay (`409`) + consume. **No JWT, no cookies.**

### 2.3 Payload validation
`heartbeatSchema.safeParse` — all fields zod-typed (semver for `agentVersion`, 0–100 for `cpuUsage`/`diskUsage`, nonnegative ints for `uptimeS`/`uptimeSeconds`/`highWaterMark`, ≤ 128-char hostname, ≤ 64-char platform/architecture/timezone/ip, capabilities whitelist-agnostic but capped at 32). Body ≤ 8 KB (`413` beyond, contract E3).

---

## 3. Database Updates (changed values only)

`Device` updated with **only** fields that are present and differ from the current row:

| Field | Source | Rule |
|---|---|---|
| `lastHeartbeatAt` | server now | always |
| `lastSeen` | server now | always (mission `lastSeenAt` ≡ `lastSeen`) |
| `status` | — | → `Online` after a successful heartbeat (presence; offline detection is a separate future job — none implemented) |
| `agentVersion` | `body.agentVersion ?? X-Agent-Version` header | only if differs |
| `agentPlatform` | `body.platform` | only if differs |
| `agentArch` | `body.architecture` | only if differs (mission `agentArchitecture` ≡ `agentArch`) |
| `hostname` | `body.hostname` | only if differs |
| `ipAddress` | `body.ipAddress` | only if differs (mission `lastKnownIp` ≡ `ipAddress`) |
| `highWaterMark` | `body.highWaterMark ?? body.lastAckedSeq` | **monotonic** — only if `> current` (never decreases) |
| `capabilities` | `body.capabilities` | only if the JSON serialization differs |

Health/identity fields without a `Device` column (`bootTime`, `uptimeSeconds`, `memoryUsage`, `cpuUsage`, `diskUsage`, `timezone`, `policyVersion`) are **validated but not persisted** — presence-only endpoint; the `DeviceHealthSnapshot` table (M007) will own sampled health later.

**Mission "Do not overwrite unchanged fields unnecessarily"** → implemented via the changed-only diff above.

---

## 4. Runtime Verification

| Step | Command | Result |
|---|---|---|
| E3 live suite | `BASE_URL=http://localhost:3105 bun scripts/verify-e3.mjs` (real E1-registered device) | ✅ **30/30** — authenticated heartbeat 200 + exact DTO + `timeOffset` sanity · **revoked token 401** · **disabled installation 403** · **disabled (Suspended) device 403** · **stale timestamp (>600 s) 429** · **replay nonce 409** · **invalid payload (negative uptimeS, cpuUsage>100) 422** · DB: `status→Online`, `lastHeartbeatAt`/`lastSeen` recent, `agentVersion→0.2.0`, `agentPlatform/agentArch→Windows/x64`, `highWaterMark 0→42`, `capabilities` persisted, credential hash untouched · **highWaterMark monotonic** (5 does not lower 42; 99 advances) · **`X-Token-Expires` header** present when the credential is within 30 d · **`lastKnownIp` fallback** to the observed `X-Forwarded-For` IP |
| E1 regression | `node scripts/verify-e1.mjs` (same server) | ✅ **23/23** |
| E0 regression | `bun scripts/verify-e0.mjs` | ✅ **107/107** (schema extension is additive) |
| Stage-2 regression | `bun scripts/verify-m005s2.mjs` | ✅ **30/30** (Pending still rejected by default — `allowPending` is opt-in) |
| Prisma | `validate` · `migrate status` | ✅ schema valid · 6 migrations up to date (no new migration) |
| Typecheck | `npx tsc --noEmit` | ✅ 0 new errors (4 pre-existing in untouched files) |
| Lint | `npx eslint src/lib/agent-auth src/app/api/agent/v1` | ✅ exit 0 |
| Build | `npm run build` | ✅ Compiled in 13.1 s · `ƒ /api/agent/v1/heartbeat` in route manifest · standalone copied |
| Data | post-test DB | ✅ 10 devices / 0 leftover test rows / 36 users / 491 activity |

---

## 5. Security Review

- **One auth path.** `authenticateAgentRequest` only — no JWT, no cookies, no duplicated verification. Web-JWT middleware already whitelists `/api/agent/v1`.
- **Token hash-at-rest.** Credential resolved by `SHA-256(bearer)`; no plaintext compare (verified: credential `tokenHash` unchanged after heartbeats).
- **Replay + clock.** Nonce consumed only after full auth; replay → `409`. Stale timestamp → `429 AGENT_CLOCK_SKEW` + `X-Server-Time` (tolerant 600 s for bootstrap).
- **State enforcement.** Revoked/expired → `401`; `Suspended`/`Retired` → `403`; disabled installation → `403`. `Pending` is deliberately allowed on E3 only (poll channel) — data endpoints keep the default rejection.
- **Changed-only writes.** A malicious/duplicated heartbeat can't corrupt fields it doesn't own; `highWaterMark` is monotonic.
- **Token-expiry signaling.** `X-Token-Expires` returned when the credential is within 30 d so the agent schedules E16 rotation (contract §3).
- **No secrets logged.** Route logs `deviceId/hostname/status/hwm/ip/requestId` only.

---

## 6. Risks & Known Limitations

1. **No per-device rate limiting yet** — contract §3 specifies heartbeat 1/15 s; deferred to the centralized limiter (Stage-2 risk #1). The auth layer already bounds abuse via nonce/timestamp.
2. **`Pending` → `Online` on first heartbeat erases the "awaiting activation" marker (design consequence — E5 must NOT rely on status gating).** The single `status` column conflates lifecycle + connectivity (ADR decision); the mission mandates Online-on-heartbeat. ⚠ Consequence for Stage-4: once a device has heartbeated it is `Online`, so the default Pending rejection (`allowPending: false`) will *never* fire for it — **E5/E6 must gate data ingestion on an active `DeviceAssignment` (created by E2), not on device status.** E2 activation will later set `Active` + create `DeviceAssignment`.
3. **Health fields validated but not persisted** (`bootTime`/`uptimeSeconds`/`memoryUsage`/`cpuUsage`/`diskUsage`/`timezone`/`policyVersion`) — they're presence-only here; sampled health lands with `DeviceHealthSnapshot` (M007). `memoryUsage` is liberal (percent or bytes).
4. **`commands` is always `[]`** — pending command metadata is returned but the `AgentCommand` plane is M006; nothing is executed (mission compliance).
5. **`agentVersion` from body takes precedence over the header** (both semver-validated); a mismatch is not an error — the body is the agent's self-reported truth.
6. **Min-version `426` not enforced on heartbeat** — registration gates new agents; per-endpoint upgrade enforcement is a follow-up (Stage-2 risk #6).
7. **`timeOffset` reflects the *header* `X-Timestamp` when `clientTime` is absent** — both are validated within the tolerant window before the response, so it is always a meaningful skew value.

---

## 7. Rollback

```bash
rm src/app/api/agent/v1/heartbeat/route.ts
rm scripts/verify-e3.mjs
git checkout -- src/lib/agent-auth/schemas.ts src/lib/agent-auth/context.ts
rm workload/29-M005-Stage3-Report.md
git checkout -- workload/07-Progress.md
npm run build   # route removed from manifest
```
**Data impact:** zero — E3 only writes runtime heartbeat state (reverted by the next heartbeat or a device update); no schema migration this stage; the verify script deletes its own test rows.

---

## 8. Git Commit Message

```text
feat(agent): M005 Stage-3 — E3 heartbeat endpoint (first authenticated API)

- POST /api/agent/v1/heartbeat on authenticateAgentRequest (tolerant 600s
  window + allowPending for the pending-device poll channel, contract §2.6)
- Presence-only: changed-value Device update (lastHeartbeatAt/lastSeen/status→
  Online/agentVersion/agentPlatform/agentArch/hostname/ipAddress/capabilities;
  highWaterMark monotonic) — no telemetry, commands, or analytics
- heartbeatSchema extended with additive optional identity/health fields
- Response: contract E3 DTO + timeOffset = serverTime − clientTimestamp
- scripts/verify-e3.mjs: 26/26 live; E1 23/23, E0 107/107, S2 30/30,
  tsc/eslint/build green
```

---

## 9. Ready for M005 Stage-4

Yes. The authenticated endpoint pattern is proven end-to-end. Recommended Stage-4 order:

1. **E5 Activity ingest** (`POST /api/agent/v1/activity`) on `db.activityEvent` — idempotent `UNIQUE(deviceId, seq)` upsert, `receivedAt` = server clock, `source = 'agent'`, `rejected[]` semantics, per-device `highWaterMark` advancement (already maintained by E3).
2. **E2 Activate** — creates `DeviceAssignment` (the Stage-1 mission's assignment objective) + sets device `Active`.
3. **E16 Token rotation** on the composed verifier (helpers already in E0).
4. Centralized per-device rate limiting (contract §3) before the data plane opens.
