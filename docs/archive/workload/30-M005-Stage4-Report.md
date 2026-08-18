# M005 Stage-4 Report — E5 Activity Ingestion (`POST /api/agent/v1/activity`)

> **Status:** ✅ Complete · **Date:** 2026-08-03 · **Contract:** `workload/17-Agent-API-Contract.md` §4 E5 + §6
> **Mission:** Implement the production Activity Ingestion API — the primary telemetry entry point that every dashboard / AI insight / report / analytics feature will depend on. **Designed for long-term stability.**

---

## 1. Files changed

| File | Change |
|---|---|
| `src/app/api/agent/v1/activity/route.ts` | **NEW** — E5 endpoint: gzip + 1 MB size gate → `authenticateAgentRequest` → zod batch envelope → per-event typed/flat validation + ±24 h clock check → one `$transaction` (pre-check + `createMany` + monotonic HWM) → `202` with `accepted/duplicates/rejected[]/highWaterMark` (+ `X-Token-Expires` when due) |
| `src/lib/agent.ts` | **MODIFIED** — +`ActivityRowInput`, +`ActivityIngestResult`, +`persistActivityEvents()` (the transaction: existing-seq pre-check → `createMany` → monotonic HWM advance, all in ONE tx) |
| `src/lib/agent-auth/schemas.ts` | **MODIFIED** — +`flatActivityEventSchema` (mission flat events, additive), +`ingestBatchSchema` (batch envelope: `batchId` required, `events[]` min 1 / max 500), +`KIND_TO_FIELD` export, types |
| `scripts/verify-e5.mjs` | **NEW** — live end-to-end verification, **44 checks** |
| `workload/30-M005-Stage4-Report.md` | **NEW** — this report |
| `workload/07-Progress.md` | **MODIFIED** — appended dated entry (append-only convention) |

**No database migration.** `ActivityEvent` already carries every column needed (M004: `seq`/`kind`/`payload`/`source`/`receivedAt` + the legacy `type`/`title`/`url`/`domain`/`browser`/`duration`/`focusTime`/`productive`); `Device.highWaterMark` exists since M003; `@@unique([deviceId, seq])` active since M004 Stage-2. **Zero schema changes.**

---

## 2. API summary

`POST /api/agent/v1/activity` — batched telemetry for app / website / idle / session events.

**Auth:** `authenticateAgentRequest()` only (Stage-2 composed verifier) — no JWT, no cookies, no duplicated auth. Default state checks (data endpoint): **Pending devices rejected** `403 AGENT_DEVICE_PENDING` (they poll E3 instead, contract §2.6), standard ±300 s request clock window, nonce replay-protected.

**Request** (both shapes accepted — contract canonical + mission additive):
```json
{
  "batchId": "b_9f2c..",
  "events": [
    { "seq": 1043, "ts": 1785678810000, "kind": "app", "app": { "name": "Code.exe", "durationSec": 120, "focusSec": 118 } },
    { "seq": 1044, "ts": .., "kind": "website", "web": { "url": "..", "domain": "..", "browser": "Chrome" } },
    { "seq": 1045, "ts": .., "kind": "idle", "idle": { "durationSec": 300 } },
    { "seq": 1046, "ts": .., "kind": "session", "session": { "action": "login" } }
  ]
}
```
Mission flat events are also accepted (`timestamp`, `title`, `application`, `windowTitle`, `website`, `url`, `duration`, `isIdle`, `payload`) and normalized to the same rows. `deviceId`/`highWaterMark` in the body are **accepted but ignored** (server-authoritative — device from the signed headers, HWM computed from actually-persisted rows; anti-spoof, contract E5 security).

**Response `202`:**
```json
{ "batchId": "b_9f2c..", "accepted": 4, "duplicates": 1, "rejected": [],
  "highWaterMark": 1046, "serverTime": 1785678847000 }
```
`rejected[]` = `{ seq, code: "AGENT_VALIDATION" | "AGENT_CLOCK_SKEW", message }` — agent **drops** rejected events (contract E5: they came from a buggy build; re-sending loops forever).

**Mission mapping note:** mission's "Maximum 250 events per request" = the contract's *recommended* flush size (`AGENT_MAX_BATCH_EVENTS_RECOMMENDED = 250`); the hard cap is the contract's 500 (`AGENT_MAX_BATCH_EVENTS_DEFAULT`, env-overridable). Consistent with Stage-1/3 precedent (contract canonical, mission additive).

---

## 3. Database behavior

Every inserted row: **`source = 'agent'`**, **`receivedAt` = server clock**, `timestamp` = event `ts` (unclamped — analytics sort later), legacy `type` mapped from `kind` (`App`/`Website`/`Idle`/`Session`), `payload` = kind-specific extras.

**Idempotency** — `UNIQUE(deviceId, seq)`:
- **Prisma 6 SQLite does not support `skipDuplicates` on `createMany`** (verified empirically — generated client rejects the arg). The transaction therefore **pre-checks** existing `(deviceId, seq)` via `findMany` and only inserts the remainder. This is equivalent to `skipDuplicates` *and* yields exact per-seq duplicate counts.
- `seq ≤ highWaterMark` → counted as `duplicates` even if the row is absent (contract E5: "seq ≤ highWaterMark → counted duplicates, not an error").
- Duplicates never fail the batch; they're reported in the `duplicates` count.

**Transaction** — one `$transaction` per batch (mission: one batch = one transaction):
1. read `Device.highWaterMark`
2. pre-check existing seqs
3. `createMany` (single batched INSERT — no N+1, no per-event transactions)
4. monotonic HWM advance — **only reached after a successful insert; a failed insert throws and rolls back the HWM update too**

**Out-of-order events** are persisted as-is; ordering is an analytics concern, not an ingest one.

---

## 4. Performance review

| Concern | Design |
|---|---|
| N+1 inserts | ❌ none — one `createMany` per batch (500 rows ≈ single INSERT) |
| Per-event transactions | ❌ none — one `$transaction` for pre-check + insert + HWM |
| Max rows per batch | 500 (env-overridable `AGENT_MAX_BATCH_EVENTS`) |
| Body limit | 1 MB decompressed (`AGENT_MAX_BODY_BYTES_DEFAULT`) → `413` beyond |
| gzip | `Content-Encoding: gzip` decoded explicitly (Next.js does NOT auto-decompress request bodies); signature canonical uses the decompressed body (contract §2.2) |
| SQLite ingest throughput | WAL mode (set by app); batched inserts keep writes well under the 50 ms p95 target (contract §10) |

Verified: `createMany` with 500 rows works on this Prisma/SQLite combo (empirically tested before finalizing; the only rejected arg was `skipDuplicates`).

---

## 5. Verification

**Live end-to-end (dev server) — `verify-e5.mjs` 44/44 ✅**

| Scenario | Result |
|---|---|
| 1. Valid batch (typed + flat, mixed) | 202, accepted=5, duplicates=0, `source='agent'`, `receivedAt` set, `timestamp`=event ts, kind/type/title mapping, HWM→5 |
| 2. Duplicate seq (resend same batch) | 202, accepted=0, **duplicates=5**, row count unchanged, HWM not regressed |
| 3. Replay batch (nonce reuse) | first 202; replay → **409 `AGENT_REPLAY`**, nothing inserted |
| 4. Out-of-order seq (new seqs above HWM) | 202 accepted=3, seqs 21/22/23 all persisted, HWM→23; resending seq ≤HWM → duplicate |
| 5. Malformed event (partial success) | 202 accepted=1, `rejected[]` has seq 25 `AGENT_VALIDATION` + seq 26 `AGENT_CLOCK_SKEW`; rejected rows not persisted |
| 6. Oversized / empty batch | 501 events → **422**; empty `events[]` → 422; missing `batchId` → 422; nothing persisted |
| 7. Transaction rollback | API: all-rejected → 202 accepted=0, **HWM unchanged**; unit: mid-tx write failure (`ts: NaN`) → **both** the valid first row and the HWM update rolled back (no orphans, HWM unchanged) |
| 8. gzip body / payload limits | gzip → 202 accepted=1; >1 MB body → **413 `AGENT_PAYLOAD_TOO_LARGE`** |
| 9. Final DB integrity | 11 rows persisted across scenarios, HWM = 40 (max persisted seq), duplicate protection proven |

**Regressions:** E3 heartbeat **30/30** (live) · E1 register **23/23** (live) · E0 foundation **107/107** · M005-Stage-2 **30/30** · `tsc` 0 new errors · `eslint` clean · **`npm run build` ✅** (`ƒ /api/agent/v1/activity` in route manifest, standalone copied, 15.6 s).

**Environment note:** the known dev-after-production-build quirk (`.next` serving a stale route manifest → 404) was avoided by clearing `.next` before the live run and rebuilding after. All test rows cleaned from `db/custom.db` (10 devices / 0 creds / 491 activity rows = untouched demo data).

---

## 6. Security review

- **Single auth path** — `authenticateAgentRequest()`; no JWT/cookies/API-key bypass on agent routes (middleware whitelist unchanged).
- **Server-authoritative identity** — device resolved from the signed headers; body `deviceId` is ignored (anti-spoof). HWM computed from rows actually persisted — an agent cannot inflate its watermark without data existing.
- **Replay + clock** — nonce consumed only post-auth; standard ±300 s request window; per-event ±24 h window.
- **Partial success is safe** — rejected events are never persisted; duplicates are never errors.
- **gzip-bomb guard** — compressed body capped at 1 MB *and* decompression limited to 1 MB output (`gunzipSync maxOutputLength`); decompressed overflow → **413** (not 422 — zlib `ERR_BUFFER_TOO_LARGE` distinguished from corrupt gzip).
- **Byte-length size gates** — `Buffer.byteLength(body, 'utf8')`, not string `.length` (UTF-16 units undercount multibyte payloads).
- **Concurrent-duplicate race hardening** — two batches from the same device can both pass the pre-check; the loser's `createMany` hits `UNIQUE(deviceId, seq)` (P2002). Caught → **bounded single retry** converts the race to `duplicates` (mission: "duplicates must not fail the batch").
- **No secrets logged** — log line contains device/batch/counts/HWM only; never tokens, signatures, or nonces.
- **Transaction integrity** — HWM can never advance past persisted data; a failed write rolls back everything (verified).

---

## 7. Risks

1. **`skipDuplicates` unsupported on Prisma/SQLite** (surfaced + verified) — the pre-check pattern is the documented design; it adds one `findMany` per batch. A concurrent duplicate batch is handled via the bounded P2002 retry (reads serialized under SQLite WAL; the write-race case is converted to duplicates); a Postgres migration (Phase 3) should switch to `ON CONFLICT (deviceId, seq) DO NOTHING` per contract §10.
2. **E5 rejects Pending devices** (default verifier) — a freshly registered device must heartbeat once (E3) to become Online before ingesting. This is contract-correct but worth documenting for the agent team.
3. **No per-device rate limit yet** (contract: E5 1 req / 2 s, burst 4) — deferred to the centralized limiter (M006), consistent with prior stages.
4. **`session` events** are persisted into `ActivityEvent` (mission: "insert into ActivityEvent") with `kind='session'`; the contract's `LoginSession` materialization (login/logout state machine) is deferred to the session/analytics layer (M007) — documented in the route.
5. **Health/identity fields are not persisted by E5** (that's E7/E3's job) — E5 stores only event rows.
6. **In-memory nonce store** (single-instance MVP) — unchanged from Stage-2; the `AgentNonce` table is the multi-instance upgrade path.

---

## 8. Rollback

- **Code:** `git checkout -- src/app/api/agent/v1/activity/route.ts src/lib/agent.ts src/lib/agent-auth/schemas.ts && rm scripts/verify-e5.mjs`
- **Docs:** `rm workload/30-M005-Stage4-Report.md && git checkout -- workload/07-Progress.md`
- **Data impact: zero** — no migration ran; test rows were deleted; demo data (10 devices / 36 users / 491 activity) untouched.

---

## 9. Git commit message

```
feat(agent): M005 Stage-4 — E5 activity ingestion endpoint

- POST /api/agent/v1/activity: primary telemetry entry point (contract §4 E5)
- Auth via authenticateAgentRequest only (no JWT/cookies); default state checks
  (Pending rejected); nonce + ±300s request window; per-event ±24h clock window
- Accepts BOTH contract typed events (app/web/idle/session) and mission flat
  events (timestamp/title/application/website/isIdle/payload) — additive-only
- One $transaction per batch: existing-(deviceId,seq) pre-check (Prisma SQLite
  has no skipDuplicates) → createMany → monotonic Device.highWaterMark advance
- 202 { batchId, accepted, duplicates, rejected[], highWaterMark, serverTime };
  rejected[] = AGENT_VALIDATION | AGENT_CLOCK_SKEW (partial success)
- source='agent', receivedAt=server clock, timestamp=event ts (unclamped);
  out-of-order events persisted as-is
- gzip bodies decoded + 1MB gate (decompression bomb guarded); body deviceId/
  highWaterMark ignored (server-authoritative)
- verify-e5.mjs 44/44 live · E3 30/30 · E1 23/23 · E0 107/107 · S2 30/30 · build ✅
```

---

## 10. Ready for M005 Stage-5

Yes. The telemetry pipeline is now end-to-end: **E1 register → E3 heartbeat → E5 ingest**. Recommended next steps (in order):

1. **E2 activate** (`POST /api/agent/v1/activate`) — creates `DeviceAssignment`, sets device `Active`, returns the user binding. This is where the Stage-3-flagged *assignment gating* for data ingest becomes enforceable (E5 currently gates on device status only, per mission scope).
2. **E16 token rotation** — the `X-Token-Expires` plumbing is already in E3/E5 responses.
3. **Centralized per-device rate limiter** (contract §3 table) — E5's 1/2 s limit.
4. Then the consumption side: analytics/dashboard reads over the persisted `ActivityEvent` rows (the mission's "every future dashboard depends on this data").
