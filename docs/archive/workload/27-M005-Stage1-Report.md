# WorkLensAI — M005 Stage-1 Implementation Report (Agent Registration Backend Foundation)

> **File:** workload/27-M005-Stage1-Report.md · **Date:** 2026-08-02 · **Status:** ✅ COMPLETE — verified, **no code changes required**
> **Scope:** server-side registration layer only — `POST /api/agent/v1/register`. **No heartbeat, screenshots, uploads, commands, telemetry ingestion, or updates.**
> **Reads:** 17-Agent-API-Contract.md (§4 E1), 18-Telemetry-Database-Design.md, 19-Prisma-Migration-Plan.md, 09-Architecture-Decisions.md, 21-M003-Implementation.md, 22-E1-Agent-Registration.md, 23-E0-Agent-Security.md

---

## 0. Executive Summary

The M005 Stage-1 registration foundation is **already fully implemented and verified** as contract **E1** (`POST /api/agent/v1/register`) built on the **E0** shared agent-security library. This stage re-verified the entire layer end-to-end against a live dev server, re-ran the full VERIFY checklist (`prisma validate/generate`, `migrate status`, `tsc`, `eslint`, E0 unit suite, E1 integration suite, production build), and documented the mission ↔ contract mapping.

**Decision (user-confirmed):** the contract-aligned E1 implementation is authoritative (17-Agent-API-Contract.md was mandated reading). **No code changes** were made. `DeviceAssignment` creation is intentionally deferred to E2/activate (see §3) and documented rather than implemented.

---

## 1. Files Changed

| File | Change | Status |
|---|---|---|
| `src/app/api/agent/v1/register/route.ts` | E1 route handler (Zod, 5/min IP rate limit, error envelope, contract DTO) | existing · verified |
| `src/lib/agent.ts` | service layer (`registerAgent`, timing-safe join-key verify, hardware fingerprint, token issue) | existing · verified |
| `src/lib/agent-auth/` (10 modules) | shared security foundation: tokens, signature, timestamp, nonce-store, schemas, errors, responses, verifier, config, index | existing · verified |
| `src/middleware.ts` | `/api/agent/v1` whitelisted as **agent-auth** (NOT web JWT; never reaches the API-key bypass branches) | existing · verified |
| `scripts/verify-e0.mjs` · `scripts/verify-e1.mjs` | 107 + 23 automated checks | existing · passing |
| `workload/27-M005-Stage1-Report.md` | **this report** | **NEW** |
| `workload/07-Progress.md` | appended dated entry | **MODIFIED** (append-only) |

**No application source code, schema, or database was modified in this stage.**

---

## 2. API Contract Implemented — Mission ↔ Implementation Mapping

`POST /api/agent/v1/register` per 17-Agent-API-Contract.md §4 E1. The mission's field names map onto the contract shape as follows:

| Mission requirement | Contract E1 implementation | Delta / note |
|---|---|---|
| `installationId` | ✅ accepted (body) | identical |
| `joinKey` | ✅ accepted; **timing-safe SHA-256** compare vs `Installation.joinKeyHash` | identical (only secret; hashed at rest; never logged) |
| `deviceName` | → `hostname` (`Device.hostname`) | mission name; contract uses `hostname` |
| `hostname` | ✅ `hostname`, ≤ 128 chars | identical |
| `username` | not accepted | contract E1 has no OS username; employee binding happens server-side at **E2/activate** (anti-spoof). Not persisted. |
| `hardwareFingerprint` | **computed server-side** = SHA-256(`cpu\|ramGB\|diskGB\|mac\|serial`) from `hardware{}` | a raw client-supplied fingerprint string is never trusted; the agent can still vary the `hardware{}` inputs it sends (expected — it reports its own machine) |
| `platform` | → `os.family` → `Device.agentPlatform` | mapping |
| `architecture` | → `os.arch` → `Device.agentArch` | mapping |
| `agentVersion` | ✅ semver-validated; `426 AGENT_UPGRADE_REQUIRED` below `minAgentVersion` | identical |
| `capabilities` | ✅ array, ⊆ whitelist `[activity, screenshots, health, logs, errors, commands]` | identical |
| `timezone` | not accepted | no `Device` column; not in contract E1 |
| Validate every field with Zod | ✅ `RegisterSchema` + semver + capability whitelist + size caps | `422 AGENT_VALIDATION` |
| Reject malformed requests | ✅ | `422 AGENT_VALIDATION` |
| Reject duplicate hardware fingerprints within the installation | ✅ `findFirst({ hardwareFingerprint })` → `409 AGENT_ALREADY_REGISTERED` (retired < 24 h → `409 AGENT_REENROLL_REQUIRED`) | global check ≈ within-installation (single tenant, ADR-001); installation-scoped tightening is optional hardening (see §5.5) |
| Reject unknown installations | ✅ `401 AGENT_JOIN_KEY_INVALID` | **deliberately not 404** — avoids installation-ID enumeration (contract §4 E1 security) |
| Reject invalid join keys | ✅ `401 AGENT_JOIN_KEY_INVALID` | identical |
| 256-bit AgentToken, returned **once**, SHA-256 at rest | ✅ 43-char base64url; only `AgentCredential.tokenHash = SHA-256(token)` stored | identical |
| One transaction (Installation / Device / AgentCredential / DeviceAssignment) | ✅ `db.$transaction`: Installation lookup + `Device` create + `AgentCredential` create | **DeviceAssignment intentionally skipped** (see §3) |
| No JWT / no cookies / no web auth — join key only | ✅ `/api/agent/v1` whitelisted agent-auth; route ignores `X-API-Key`/`X-Agent-Token`/`Authorization` | identical |
| Response: `deviceId, agentToken, heartbeatInterval, policyVersion, serverTime` | ✅ `deviceId`, `agentToken`, `heartbeatIntervalMs` (= 30000), `policyVersion` (= 1), `serverTime` **+ contract-required extras** `tokenExpiresAt`, `minAgentVersion`, `configVersion`, `status: "pending"` | mission names map onto the contract DTO (superset) |
| Errors 400/401/403/404/409/500 | `401` join-key/install · `409` duplicate/re-enroll · `422` validation · `426` upgrade · `429` rate-limited · `500` internal | contract superset of the mission list; `400 → 422` (contract), `403` reserved for E2+ (`AGENT_DEVICE_PENDING/REVOKED`), `404` not used (enumeration defense) |
| Do NOT implement heartbeat / screenshots / uploads / commands / telemetry / updates | ✅ none present | identical |

**Raw contract response (verified live):**
```json
{"deviceId":"cmsbx4cmm0005fi8ggmswbror","agentToken":"KlIP7Mq0Uk64uCY7iLxPE0OGq3_MQTmu62YXWTs55aQ",
 "tokenExpiresAt":"2027-01-29T14:51:13.769Z","serverTime":1785682273782,"heartbeatIntervalMs":30000,
 "minAgentVersion":"0.1.0","policyVersion":1,"configVersion":1,"status":"pending"}
```

---

## 3. Database Changes

**None in this stage.**

- M003 (`20260802143318_m003_identity`) created the tables the registration layer writes to: `Installation` (join-key hash), `AgentCredential` (token lifecycle, `tokenHash` unique, `onDelete: Cascade`), `DeviceAssignment` (attribution windows, partial-unique active index), plus `Device` extensions (`installationId`, `hardwareFingerprint`, `lastHeartbeatAt`, `highWaterMark`, `capabilities`, `agentPlatform`/`agentArch`, extended `status`).
- E1 **reads** `Installation` and **writes** `Device` + `AgentCredential` at runtime, all inside one transaction.
- Demo data present: `Installation` row `inst_demo_default` (join key `WL-DEMO-JOINKEY-2026`, SHA-256 at rest) · 10 devices · 0 credentials · 0 assignments (clean — the verify script deletes its own test rows).

**Why `DeviceAssignment` is NOT created at registration (mission objective → documented skip):**
1. `DeviceAssignment.userId` is a **required FK** → impossible without a user context, and registration has none (the agent never supplies an employee identity — anti-spoof, contract E2).
2. The contract binds a device to an employee **only via admin action at E2/activate** (`status: pending` → `active`), which is the correct point to create the assignment.
3. The mission's own phrasing ("create DeviceAssignment if appropriate") + user decision: defer to E2. This matches ADR-024 (attribution windows) and the M003 report.

---

## 4. Verification (mission VERIFY checklist)

| Step | Command | Result |
|---|---|---|
| Prisma validate | `npx prisma validate` | ✅ schema valid |
| Prisma generate | `npx prisma generate` | ✅ Client generated (after clearing orphaned dev-server DLL lock, see §5.7) |
| Migrate status | `npx prisma migrate status` | ✅ 5 migrations, up to date |
| Typecheck | `npx tsc --noEmit` | ✅ **0 new errors** (only 4 pre-existing in untouched `examples/websocket/*` + `src/components/admin/markdown.tsx`) |
| Lint | `npx eslint src/lib/agent.ts src/lib/agent-auth src/app/api/agent/v1/register/route.ts src/middleware.ts` | ✅ exit 0 |
| Unit (E0 foundation) | `bun scripts/verify-e0.mjs` | ✅ **107/107** (tokens, constant-time, HMAC canonicalization + interop, clock window, replay/nonce, config, errors, Zod schemas, verifier pipeline, rotation helpers) |
| Integration (E1) | `BASE_URL=http://localhost:3100 node scripts/verify-e1.mjs` (live `next dev`) | ✅ **23/23** — valid 201 + exact DTO, invalid join key 401, duplicate 409 + same deviceId, missing fields 422, bad semver / unknown capability / oversized hostname 422, DB persistence (Device Pending + fingerprint + AgentCredential), token hashing (`storedHash === sha256(token)`), response key-set (no secret leak) |
| Manual — mission "invalid installation" | `curl` unknown `installationId` + wrong `joinKey` against live `next dev` | ✅ both → **401** `AGENT_JOIN_KEY_INVALID` `{"error":{"code":"AGENT_JOIN_KEY_INVALID","message":"Invalid installation or join key"}}` — unknown install is deliberately indistinguishable from a bad join key (enumeration defense); no device row created |
| Build | `npm run build` | ✅ compiled; `/api/agent/v1/register` in `app-paths-manifest.json`; standalone assets copied |

> **Environment note:** running `next dev` against a `.next` left by a production `npm run build` served a stale route manifest (register returned 404 until `.next` was cleared). Run dev before a build, or `rm -rf .next` first — this is a dev-tooling quirk, not an endpoint issue (re-verified 401/422/201 after clearing).
| Data integrity | post-test DB check | ✅ 10 devices / 0 leftover test credentials (verify script self-cleans) |

---

## 5. Risks & Known Limitations

1. **Mission↔contract field deltas** (table in §2): a client sending the mission's flat field names (`deviceName`, `username`, `hardwareFingerprint`, `platform`, `architecture`, `timezone`) instead of the contract shape will get `422 AGENT_VALIDATION`. Agents must send the contract body (`hostname`, `os{}`, `hardware{}`). If a third-party consumer requires the flat names, extend the schema as backward-compatible optional aliases (v1 allows additive optional fields) — tracked, not done.
2. **`DeviceAssignment` at E2, not E1** — by design (no `userId` at registration; anti-spoof). Documented, not a gap.
3. **In-memory rate limiter** (5/min/IP, `Map` keyed by IP) — resets on restart, not distributed. Matches the existing login-route pattern; Postgres/Redis limiter is Phase 3.
4. **In-memory nonce store** (E0) — single instance only; `NonceStore` interface ready for a Postgres `AgentNonce` table at Phase 3.
5. **Global (not installation-scoped) fingerprint dedup** — single-tenant (ADR-001) makes this equivalent today. Optional hardening: scope `findFirst` to `{ hardwareFingerprint, installationId }`.
6. **`426` min-version and 24 h re-enroll paths** are implemented but not exercised by the verify script (need a deliberately old `agentVersion` / a `Retired` device); logic is unit-visible in `src/lib/agent.ts`.
7. **Windows DLL lock on `prisma generate`** — a lingering `next dev`/node process holds `node_modules/.prisma/client/query_engine-windows.dll.node` → `EPERM`. Fixed here by `taskkill //F //PID <pid>` on the orphaned server (port 3100). Stop stale dev servers before running Prisma commands.
8. **E1 inline Zod schema not yet unified** with the shared `registrationSchema` in `agent-auth/schemas.ts` — behavior-identical by construction; adoption is a mechanical follow-up.
9. **`AgentError` (E1) not yet unified** with `AgentAuthError` — same envelope shape; a follow-up can make one extend the other.
10. **Legacy middleware API-key bypass (BL-001)** remains for *non-agent* routes — `/api/agent/v1/*` is whitelisted *before* those branches, so agent endpoints are unaffected.
11. **Pre-existing git merge conflict** on `docs/` (repo state at session start) — untouched; not part of this stage.
12. **`verify-e1.mjs` has no dedicated unknown-installation case** — the mission VERIFY asks to test "invalid installation". It is covered indirectly (unknown install and invalid join key share the same `401 AGENT_JOIN_KEY_INVALID` path, manually verified this stage, §4), but a dedicated case in the script is a trivial follow-up.

---

## 6. Rollback

No application code changed this stage — rollback is docs-only:

```bash
# Remove this report + revert the Progress append
rm workload/27-M005-Stage1-Report.md
git checkout -- workload/07-Progress.md
```

To also remove the E1/E0 implementation (the actual registration layer), follow the rollback sections in `workload/22-E1-Agent-Registration.md` (§7) and `workload/23-E0-Agent-Security.md` (§8). **Data impact of this stage:** zero — verification scripts delete their own test rows.

---

## 7. Git Commit Message

```text
docs(agent): M005 Stage-1 report — agent registration foundation verified (E1)

- Confirmed POST /api/agent/v1/register (contract E1, on the E0 security
  foundation) fully delivers the M005 Stage-1 registration layer:
  installation lookup, join-key validation, device registration,
  AgentCredential + 256-bit token (SHA-256 at rest, returned once)
- Re-verified: prisma validate/generate, migrate status (5/5), tsc 0 new
  errors, eslint clean, verify-e0 107/107, verify-e1 23/23 (live dev
  server), npm run build (route in manifest, standalone copied)
- Documented mission↔contract mapping + deliberate deltas: DeviceAssignment
  deferred to E2/activate (no userId at registration, anti-spoof),
  401-not-404 for unknown installation (enumeration defense), contract DTO
  is a superset of the mission response
- Fixed environment: killed orphaned dev server holding the Prisma DLL
- Files: workload/27-M005-Stage1-Report.md, workload/07-Progress.md (append)
```

---

## 8. Ready for M005 Stage-2

The registration layer is stable, verified, and committed-able. Next milestones (per `workload/07-Progress.md`):

1. **E3 Heartbeat** (`POST /api/agent/v1/heartbeat`) on the E0 foundation — `verifyAgentRequest` pipeline, `Device.lastHeartbeatAt`, offline-after-3-misses, tolerant 600 s clock window.
2. **E5 Activity ingest** (`POST /api/agent/v1/activity`) on `db.activityEvent` — agent `seq` → idempotent upsert via `UNIQUE(deviceId, seq)`, `receivedAt` = server clock, `source = 'agent'`.
3. **E2 Activate** — server-side user binding → `DeviceAssignment` creation (this is where the mission's "DeviceAssignment" objective lands).
4. **E16 Token rotation** — `createToken`/grace helpers already in E0.
5. Windows Agent .NET spike (transport + signing + queue) can start against the frozen E1 contract.
