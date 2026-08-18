# M007 Stage-1 — E6 Screenshot Upload Foundation — Implementation Report

> **Scope:** Resumable chunked screenshot upload pipeline for the agent data plane: `POST /api/agent/v1/screenshots` (initiate + `?mode=single` fast path), `PUT /api/agent/v1/screenshots/{ticket}/chunk?index=N`, `POST /api/agent/v1/screenshots/{ticket}/complete`. Mission gates (WebP-only, ≤ 5 MB, 256 KB chunks, 10-min ticket TTL, ±24 h clock), SHA-256 content dedup (ADR-014), privacy-mode (metadata-only, no bytes), the centralized Agent Rate Limiter (screenshots rule = 2 MB/s aggregate), and `STORAGE_PATH` wiring. No OCR, AI, viewer UI, or consumption side.

---

## 1. Files changed

| File | Change |
|---|---|
| `src/app/api/agent/v1/screenshots/route.ts` | **NEW** — E6 initiate endpoint + single-shot fast path (`?mode=single`, metadata as signed query params) |
| `src/app/api/agent/v1/screenshots/[ticket]/chunk/route.ts` | **NEW** — E6 chunk PUT (`?index=N`, raw bytes body) |
| `src/app/api/agent/v1/screenshots/[ticket]/complete/route.ts` | **NEW** — E6 explicit completion (empty body, all state on ticket) |
| `src/lib/screenshots/upload.ts` | **NEW** — pipeline orchestration: `initiateUpload`, `acceptChunk`, `completeUpload`, `uploadSingleShot`, ticket invariants, dedup, `createScreenshotRow` |
| `src/lib/screenshots/hash.ts` | **NEW** — `sha256HexOfBuffer`, `isSha256Hex`, `sha256Equal` (constant-time) |
| `src/lib/screenshots/paths.ts` | **NEW** — storage root, ticket temp dir, chunk file path, final `{yyyy}/{mm}/{dd}/{id}.webp` layout (posix, relative-only) |
| `src/lib/screenshots/storage.ts` | **NEW** — chunk write/read/assemble, atomic final-file placement, temp-dir purge |
| `src/lib/screenshots/validator.ts` | **NEW** — mission constants (5 MB / 256 KB / 10 min), `isWebpMagic`, `assertWebp`, `WebpFormatError` |
| `src/lib/screenshots/index.ts` | **NEW** — barrel |
| `src/lib/agent-rate-limit/index.ts` | **NEW** — barrel (was missing; fixed TS2307) |
| `src/lib/agent-rate-limit/limiter.ts` | **MODIFIED** — +`screenshots: { capacity: 16, refillMs: 125 }` rule (2 MB/s aggregate, contract §3) |
| `src/lib/agent-rate-limit/types.ts` | **MODIFIED** — +`'screenshots'` rule name |
| `src/lib/agent-auth/errors.ts` | **MODIFIED** — +`AGENT_UPLOAD_NOT_FOUND` (404), `AGENT_UPLOAD_EXPIRED` (410), `AGENT_UPLOAD_CONFLICT` (409) + error classes |
| `src/lib/config.ts`, `.env`, `.env.example`, `.gitignore` | **MODIFIED** — `STORAGE_PATH` (default `storage/screenshots`), `/storage/` ignored |
| `prisma/schema.prisma` | **MODIFIED** — `Screenshot` extended (required `deviceId` + `device` Restrict, `sha256 @unique`, `storagePath`, `size`, `format`, `width/height`, `monitorId`, `uploadId @unique` → UploadTicket SetNull, `privacyMode`, `dedupRef` self-relation SetNull, `sessionId` → LoginSession SetNull, indexes); `UploadTicket` model added; reverse relations on `Device`/`LoginSession` |
| `prisma/migrations/20260803061442_m007_stage1_screenshot_upload/` | **NEW** — `Screenshot`/`UploadTicket` DDL |
| `prisma/migrations/20260803061909_m007_stage1_uploadticket_privacy_mode/` | **NEW** — privacy-mode + index refinement |
| `prisma/migrations/20260803063827_m007_stage1_uploadticket_metadata/` | **NEW** — ticket capture metadata (`capturedAt`, `width`, `height`, `multiMonitor`, `monitorId`, `blurSensitive`, `sessionId`) |
| `scripts/verify-e6.mjs` | **NEW** — live E2E verification, **113 checks** |

## 2. Upload flow

```
POST /api/agent/v1/screenshots            → 201 { uploadId, chunkSize: 262144, chunks, expiresAt, duplicate }
                                            or { duplicate: true, existingId } (dedup hit — no ticket)
PUT  /api/agent/v1/screenshots/{ticket}/chunk?index=N   → 200 { received, nextIndex }
POST /api/agent/v1/screenshots/{ticket}/complete        → 201 { screenshotId, duplicate, stored }
POST /api/agent/v1/screenshots?mode=single              → 201 { screenshotId, duplicate, stored }
```

- **Auth:** `authenticateAgentRequest` (signed body = exact raw bytes — string or Buffer; `requireAssignment: true`) → then `checkAgentRateLimit('screenshots', device.id)` → business logic. Optional `X-Token-Expires` on success.
- **Ticket-scoped chunking:** chunk index rides the signed query string; the mission's `{ticket}/chunk?index=N` shape wins over the contract's `{uploadId}/chunks/{index}` + `Content-Range` (noted as a deviation, same semantics).
- **Progress = bitmap:** `UploadTicket.receivedBitmap` (JSON array of indices) + `receivedBytes` — resumability without a row-per-chunk table. `nextIndex` = first missing chunk (out-of-order uploads verified).
- **Complete verifies everything from the ticket:** completeness → WebP magic sniff → byte count vs declared size → SHA-256 of assembled bytes vs declared hash. Any failure → ticket `aborted` + temp chunks purged (never a half-committed screenshot).
- **Atomic final placement:** final file written to `{root}/{yyyy}/{mm}/{dd}/{id}.webp` via random temp name + `rename` (same volume); the Screenshot row is deleted on file failure. DB stores only relative posix paths; client ids/names never reach the filesystem.
- **Dedup (ADR-014):** at initiate — same sha256 + stored twin → `{duplicate:true, existingId}`, no ticket; at complete/single-shot — dedup row with `dedupRef → twin`, `storagePath` null, `sha256` null (the unique content address exists exactly once, on the twin). Bytes are never duplicated.
- **Privacy mode:** rows only (storagePath null, bytes discarded, dedup skipped) — contract §5.6.

## 3. Server-authoritative mission gates

| Gate | Value | Enforced at |
|---|---|---|
| Format | WebP only (magic sniff `RIFF..WEBP`) | initiate + single-shot + complete (422) |
| Max size | 5 MB (`AGENT_MAX_SCREENSHOT_BYTES`) | initiate + single-shot (413) |
| Chunk size | 256 KB (`AGENT_SCREENSHOT_CHUNK_BYTES`) | chunk PUT + per-write (413) |
| Ticket TTL | 10 min (`AGENT_SCREENSHOT_TICKET_TTL_MS`) | ticket expiry (410) |
| Metadata body | ≤ 64 KB | initiate route (413) |
| Clock tolerance | ± 24 h (`AGENT_EVENT_CLOCK_TOLERANCE_MS`, route-local) | initiate + single-shot (422) |
| Rate limit | screenshots rule: capacity 16, refill 125 ms (2 MB/s aggregate) | all three routes (429 + Retry-After) |

The zod schema (`screenshotInitiateSchema`) still allows png/10 MB per the contract; the routes tighten to the mission defaults after parse (format !== webp → 422; > 5 MB → 413). sha256 is lowercased once at entry (schema accepts uppercase).

## 4. Ticket lifecycle

```
initiate → open ──chunks──▶ complete → completed (row + file + temp purged)
                │              └─ dedup hit → dedup (row + dedupRef, temp purged)
                ├─ failure at complete → aborted (temp purged)
                ├─ expiry touch → expired (410, temp purged)
                └─ 409 on any duplicate/invalid/out-of-range chunk, non-open ticket
```

Errors: `AGENT_UPLOAD_NOT_FOUND` 404 (unknown OR foreign ticket — no existence leak), `AGENT_UPLOAD_EXPIRED` 410 (marks + purges), `AGENT_UPLOAD_CONFLICT` 409 (duplicate chunk, invalid index, not-open ticket, incomplete upload, byte-count mismatch).

## 5. Schema changes

- **`Screenshot`:** `deviceId` now **required** (`device` onDelete Restrict — all 146 legacy rows carry a deviceId, verified pre-migration), `user` SetNull; new `sha256 String? @unique`, `storagePath`, `size`, `format @default("WebP")`, `width/height`, `monitorId @default(0)`, `uploadId String? @unique` FK→UploadTicket SetNull, `privacyMode @default(false)`, `dedupRef` self-relation (Screenshot_dedupRef) SetNull, `sessionId` FK→LoginSession SetNull; indexes on `[userId, timestamp desc]`, `[deviceId, timestamp desc]`, `flagged`, `sensitiveDataDetected`.
- **`UploadTicket`:** deviceId (Restrict), sha256, size, chunkSize 262144, totalChunks, privacyMode, `capturedAt` (meta.ts survives to completion), width/height/multiMonitor/monitorId/blurSensitive/sessionId, receivedBitmap, receivedBytes, status (open|completed|expired|aborted|dedup), expiresAt; indexes `[deviceId, status]`, `[expiresAt]`.
- Migration #3 (`m007_stage1_uploadticket_metadata`) was added during verification: width/height were silently lost on the chunked path (complete only saw the ticket). Capture metadata now rides the ticket to completion.

## 6. Verification

**`scripts/verify-e6.mjs` 113/113 live** (against `next dev -p 3107`):

- **Setup (6):** E1 register 201 → E2 activate + DeviceAssignment → E3 heartbeat, status Online.
- **Initiate (19):** 201 + DTO audit (chunkSize/chunks/expiresAt) · ticket row audit · size 0 / bad sha256 / png / oversized (413) / stale clock / malformed JSON / bad signature (401) / non-integer ts → all rejected.
- **Chunk valid (6) / rejections (7):** 200 + nextIndex · bitmap + receivedBytes + temp file bytes on disk · duplicate index 409 · out-of-range 409 · negative/non-integer/missing index 422 · oversized chunk 413 · unknown ticket 404.
- **Complete valid (14):** 201 · row audit (sha256, size, WebP, **width/height from ticket**, monitorId, uploadId provenance, storagePath pattern, userId = assigned employee) · file bytes identical · ticket completed · **temp dir purged** · complete-on-completed 409 · chunk-on-completed 409.
- **Dedup (7):** initiate hit → `{duplicate, existingId}` no ticket · single-shot hit → dedup row (`dedupRef → twin`, storagePath null) · byte count on disk unchanged.
- **Single-shot (10):** stored path + row/file · wrong sha256 422 · size mismatch 422 · **non-WebP magic → 422** · > 5 MB 413 · invalid ts 422 · privacyMode stored=false, no file.
- **Rollback (9):** wrong declared hash → ticket → chunk ok → complete 422 + **aborted** + temp purged + no row · declared size 100 vs 300 bytes → complete 409 + aborted.
- **Resumability (13):** 2-chunk image (256 KB + 8 KB) zero/partial/full completes · missing-chunk 409 + abort · reassembly byte-equal · **out-of-order chunk 1 first → nextIndex 0 → hole-fill → nextIndex 2 → complete stored**.
- **Expired (3):** shifted `expiresAt` → chunk/complete 410 + status expired.
- **Foreign/assignment (6):** unassigned device → 403 AGENT_DEVICE_UNASSIGNED (auth first) · assigned foreign device on A's ticket → 404 (no leak) · foreign device own upload works · complete with 0 chunks 409.
- **Rate limiting (4):** rule registered · unit 16-token bucket, 17th throws · live burst → 429 AGENT_RATE_LIMITED + Retry-After.
- **Final integrity (6):** every stored row has a real file · dedup rows point at real twins · completed tickets ⇔ rows 1:1 · 4 rollback scenarios left `aborted` tickets · temp dirs exist only for open (resumable) tickets · count = 6 (4 stored + 1 dedup + 1 privacy) · X-Server-Time.

**Full live regression:** E1 **23/23** · E2 **53/53** · E3 **32/32** · E5 **46/46** · E16 **63/63** · E0 **107/107** (register/activate/heartbeat paths exercised by every run). `prisma validate` ✅ · `tsc` 0 new errors (4 pre-existing baseline) · `eslint` clean · **`npm run build` ✅** (all three `/api/agent/v1/screenshots*` routes in manifest; standalone assets copied). DB clean post-run (10 demo devices / 146 legacy screenshots / 0 test rows).

**Notable bugs found & fixed during verification:** undici sends `[object Object]` for plain-object fetch bodies (script signed the JSON but the wire carried the literal string — fixed helper) · `cleanupTicketDir` used `unlink` on a directory (silent no-op on Windows → `rm recursive`) · dedup rows inserted the twin's sha256 into the UNIQUE column (dedup rows now write `sha256: null` + dedupRef) · privacy rows collided the same way (null sha256) · single-shot/complete routes lacked the `WebpFormatError → 422` mapping · chunked-path width/height loss (ticket metadata migration) · script rate-limit flake (requests spaced ≥150 ms; burst opts out) · script dedup-hit misuse of already-stored fixtures.

## 7. Security review

- **No existence leak** — foreign/unknown tickets are indistinguishable (404); completed/dedup/expired state machines stay behind their own codes.
- **Client input never reaches the filesystem** — paths derive from server-generated ticket/screenshot ids; DB stores relative posix paths only; format server-sniffed.
- **Integrity end-to-end** — size + WebP + sha256 verified at completion; partial/incorrect uploads abort atomically (row deleted on file failure; temp purged).
- **Auth before cost** — signature + assignment + rate limit precede every mutation; metadata body capped at 64 KB; chunk/full-body size gates run pre-auth (cheap rejections).
- **No secret exposure** — token/hash/signature values never logged (route logs device/size/hash-prefix only).

## 8. Risks

- **Rate-limit burst vs batch uploaders:** 16-token bucket / 125 ms refill throttles large backlogs of single-shot uploads (2 MB/s aggregate) — agents must pace or chunk; contract §3 is honored.
- **Ticket GC:** `expiresAt` is enforced lazily (touch → 410 + purge); hourly GC sweep over open/expired tickets is future work (index `[expiresAt]` ready).
- **Dedup row `sha256: null`** means dedup rows don't carry their content address — dedupRef traversal is the only path to the twin; fine for dedup, but a projected `screenshot.sha256` index would need to COALESCE through dedupRef (no consumer exists yet — Stage-2).
- **`ts` on chunked rows** = `capturedAt` (ticket) — preserved only for tickets created after migration #3.
- **WebP sniff** is magic-bytes only (not a decode) — sufficient for the pipe; full decode validation belongs to the OCR/viewer stage.
