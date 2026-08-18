# M007 Stage-4 — OCR Pipeline & Search Index — Implementation Report

## 1. Files changed

**New:**
- `src/lib/ocr/errors.ts` — failure taxonomy (`OCR_FAILURE` map, 7 codes) + `sniffImageFormat` (magic-byte pre-check: webp/png/jpeg/corrupt/unknown — corrupt containers fail fast before the engine).
- `src/lib/ocr/provider.ts` — `OcrProvider` interface (engine, `recognize`, `dispose`), `OcrResult`, `OcrProviderError(code, message)`.
- `src/lib/ocr/tesseract.ts` — `TesseractProvider`: shared worker, offline `langPath` (`@tesseract.js-data/eng`), per-job timeout with hard engine reset, re-sniff guard, `extractKeywords`, registry `getOcrProvider(id)`.
- `src/lib/ocr/workflow.ts` — `OcrJobError`, `enqueueOcrJob`, `claimNextOcrJob` (atomic conditional `updateMany`), `processOcrJob`, `failInPlace` (retry budget), `reclaimStalledOcrJobs` (crash/restart recovery), `retryOcrJobs` (per-id disposition), `runWorkerCycle`.
- `src/lib/ocr/worker.ts` — background worker loop (single-instance guard, interval, stop-with-park, `getOcrWorkerStats`).
- `src/lib/ocr/search.ts` — `searchOcrText` full-text keyword search + filters + keyset pagination.
- `src/app/api/admin/screenshots/[id]/ocr/route.ts` — `GET` status + `POST` enqueue.
- `src/app/api/admin/screenshots/ocr/retry/route.ts` — `POST` retry batch (`MAX_IDS=200`).
- `src/app/api/admin/screenshots/search/route.ts` — `GET` search.
- `scripts/verify-ocr.mjs` — live verification suite (**92 checks**).
- `scripts/fixtures/ocr-hello.webp` / `ocr-code-review.webp` / `ocr-sales.webp` / `ocr-meeting.webp` (deterministic text readback: "HELLO WORLD 24680", "CODE REVIEW APP", "SALES QUARTER REPORT", "MEETING NOTES AGENDA"), `corrupt-webp.webp` (RIFF declared-size mismatch), `not-image.txt` (unsupported).

**Modified:**
- `prisma/schema.prisma` + `prisma/migrations/20260803081601_m007_stage4_ocr_pipeline/` — 14 OCR columns **on the Screenshot model itself** (no parallel schema), 2 indexes.
- `src/instrumentation.ts` — `validateServerConfig()` then `startOcrWorker()` in `register()` (node runtime only).
- `next.config.ts` — `serverExternalPackages: ["tesseract.js", "tesseract.js-core", "@tesseract.js-data/eng"]` (Turbopack wasm-require fix).
- `src/lib/config.ts` — comment fix only (OCR block + `getOcrConfig()` verified in dev).

## 2. Endpoint summary

| Endpoint | Method | Auth | Behavior |
|---|---|---|---|
| `/api/admin/screenshots/:id/ocr` | GET | Super-admin | Job status + result (text/confidence/engine/version/language/duration/processedAt) or failure code+detail |
| `/api/admin/screenshots/:id/ocr` | POST | Super-admin | Enqueue — 202 `pending`; 404 `OCR_ROW_NOT_FOUND`; 422 `OCR_NOT_ENQUEUEABLE` (privacy-mode, byte-less); 409 `OCR_ALREADY_QUEUED` (pending/processing); **409 `OCR_PERMANENT_FAILED` (failed+not-retryable — a direct enqueue must never re-arm a permanent failure with a fresh budget, added in the re-verification session)** |
| `/api/admin/screenshots/ocr/retry` | POST | Super-admin | Batch retry — `{retried[], ignored[], exceeded[]}` + counts; 400 malformed / `OCR_RETRY_TOO_MANY` (>200) |
| `/api/admin/screenshots/search` | GET | Super-admin | Keyword + filter + paginated search over completed OCR rows |

Route-level `requireSuperAdmin` runs on top of the middleware JWT check (same shared `requireRole` path as Stage-3); no-token → 401 verified.

## 3. Schema & migration

- **On-model, no parallel tables** (mission: "Do not invent parallel schemas" — OCR lives on Screenshot): `ocrStatus` (`none|pending|processing|completed|failed`, default `none`), `ocrQueuedAt`, `ocrLockedAt`, `ocrAttempts` (default 0), `ocrRetryable` (default true; false = permanent), `ocrLanguage` (default `eng`), `ocrEngine`, `ocrEngineVersion`, `ocrDuration` (ms), `ocrProcessedAt`, `ocrFailure` (stable code), `ocrFailureDetail` (JSON), plus Stage-3's `ocrText`/`ocrKeywords`/`ocrConfidence` (Int 0–100 — DB integer, `Math.round` on persist).
- Migration `20260803081601_m007_stage4_ocr_pipeline` applied to `db/custom.db`; `prisma migrate status` = up to date.
- Indexes: `@@index([ocrStatus, ocrQueuedAt])` (FIFO claim scan) and `@@index([ocrConfidence])` (search filter).
- Dependencies: `tesseract.js@7.0.0`, `@tesseract.js-data/eng@1.0.0` (offline, exports `code`/`langPath`/`gzip` verified).

## 4. Provider layer (tesseract)

- `sniffImageFormat` checks magic + header consistency before the engine: RIFF declared size ≠ actual → `corrupt`; PNG IHDR broken → `corrupt`; JPEG missing EOI → `corrupt`; else `unknown`. **Corrupt/unsupported bytes never reach the engine** — the workflow marks them failed **permanent immediately** (`permanent: true`, no retry budget spent).
- `TesseractProvider.recognize(buffer, languages, timeoutMs)`: shared worker (created once), re-sniff defense, per-job timeout → abort + **hard destroy of the wedged worker** (`OCR_TIMEOUT`), engine errors → `OCR_PROVIDER_CRASH`, empty text handled as a result (EMPTY_RESULT reserved for the future threshold policy).
- Registry `getOcrProvider(id)` — single place to add future engines; `dispose()` for teardown.
- Offline model data via `@tesseract.js-data/eng` `langPath` — no network at OCR time; `next.config` externalizes tesseract.js for the server bundle.

## 5. Workflow (queue semantics)

- **Enqueue:** queue-only decision, no filesystem access; privacy-mode and byte-less rows (no path, no dedup twin, no sha) → 422.
- **Claim (FIFO + atomicity):** scans `pending` ordered by `(ocrQueuedAt ASC, id ASC)` with a 25-row guard, then claims via conditional `updateMany` (`where id = ? AND ocrStatus = 'pending'` → `processing` + `ocrLockedAt`) — exactly one winner among concurrent workers; lost races scan to the next candidate.
- **Process:** resolves bytes through the safe-read funnel (own `storagePath`, else dedup twin's — `readStoredFile`), sniffs first (corrupt/unknown → permanent), else provider → persist text/keywords/confidence/engine/version/duration/processedAt, clears failure fields.
- **Failure (`failInPlace`):** bumps attempts; `ocrRetryable = !(attempts >= maxAttempts || permanent)`; JSON detail `{code, attempts, maxAttempts, ...meta}`; deleted-row → `{state:'deleted'}` and the route 404s.
- **Retry (`retryOcrJobs`):** per-id disposition — `retried` (failed retryable, or re-run completed), `ignored` (missing row, or in-flight pending/processing), `exceeded` (**any failed row with `ocrRetryable=false`** — permanent means permanent at any attempt count, fixed during verification when a corrupt job at attempts=1 was being re-queued). Never re-enqueues in-flight rows (conditional update). Re-enqueue clears `ocrFailure`/`ocrFailureDetail` so a pending job never surfaces a stale failure through GET `/ocr` (re-verification session).
- **Enqueue (re-verification fix):** `enqueueOcrJob` now refuses a `failed` row with `ocrRetryable=false` → `OCR_PERMANENT_FAILED` 409. The retry endpoint already refused permanent jobs (`exceeded`), but the direct enqueue path silently reset `ocrAttempts=0`/`ocrRetryable=true` — an admin could loop `POST /:id/ocr` on a corrupt/unsupported screenshot forever with a fresh 3-attempt budget each time, violating the mission's "never retry permanently failed jobs indefinitely." Permanent failures are now un-re-armable through both entry points.
- **Stall recovery:** `processing` rows older than `stallMs` → retryable → back to `pending`; exhausted → `failed` + permanent `OCR_STALLED_RECOVERED`. Runs at the top of every worker cycle.

## 6. Worker lifecycle

- Started from `instrumentation.ts` `register()` (server boot, node runtime only); honors `OCR_WORKER_ENABLED`; logs `[OCR-WORKER] started (interval=2000ms, provider=tesseract)`.
- One claim per cycle (jobs are small; never competes with the app), then sleeps `workerIntervalMs`; module-global single-instance guard survives dev hot-reload; `stopOcrWorker` parks until the in-flight cycle settles.
- `getOcrWorkerStats()` → `{running, guard, cycles, lastWorkedAt, lastError}`; `disposeOcrProvider()` for teardown.
- **Verification caught a stale-cache bug:** the long-running dev server had compiled the pre-repair `errors.ts` from Turbopack cache (sniff missing) — corrupt files reached the engine (`OCR_PROVIDER_CRASH`). A clean restart (cache cleared) made corrupt/unsupported classification pass; the source code itself was correct all along.

## 7. Search API

- `searchOcrText({keyword, deviceId, userId, organizationId, minConfidence, from, to, limit, cursor})` — single query with `ocrStatus: 'completed'` + `ocrText contains` (SQLite LIKE, case-insensitive) + optional filters; `minConfidence` 0–100 else 400.
- Keyset pagination `(timestamp ASC, id ASC)` — same cursor shape as the Stage-3 gallery (base64url `{t,id}`), `limit+1` peek for `hasMore`; exhausted page → `hasMore: false`, `nextCursor: null`.
- Response rows: `{id, capturedAt, device, user, ocr{status, text, keywords[], confidence, engine, engineVersion, language}}`; no file bytes, no storagePath.

## 8. Auth & security

- Middleware JWT + route-level `requireSuperAdmin` on all three endpoints (shared `requireRole`); no-token → 401 verified.
- Filesystem: OCR byte reads go through the same hardened `readStoredFile` (allowlist → lstat symlink-reject → realpath containment) as Stage-3 — a missing/unsafe file is a structured `OCR_MISSING_FILE`, never an exception.
- Failure taxonomy is stable API-facing codes with JSON diagnostics (no raw stack traces in responses; engine errors are trimmed to `message`).
- Size/time budgets: per-job timeout with engine hard-reset, bounded claim scan, `MAX_IDS=200` on retry.

## 9. Performance review

- FIFO claim = index-friendly `(ocrStatus, ocrQueuedAt)` scan + one atomic UPDATE; no table scans for queue work.
- Search = single `findMany` + `limit+1` peek; keyset pagination is O(page), not O(offset).
- Engine cost dominated by Tesseract itself (~350 ms warm on the 2400×420 fixtures); worker runs one job at a time at a 2 s cadence so OCR never competes with the API.
- Corrupt/unsupported files are rejected by a byte-sniff in microseconds — engine time is never spent on garbage.

## 10. Verification

- **`scripts/verify-ocr.mjs`: 96/96 live** (this session: dev server on port 3000, Turbopack cache cleared, fresh compile) — 92 original checks + 4 added during re-verification: enqueue-on-permanent-failed corrupt → 409 `OCR_PERMANENT_FAILED` + not re-armed (attempts stays 1), enqueue-on-permanent unsupported → 409, and failure metadata cleared while pending after retry re-enqueue.
  - enqueue (10) — 202/409/404/422 matrix (duplicate, unknown id, privacy-mode, byte-less row).
  - worker success (20) — hello job: text exactly `HELLO WORLD 24680`, confidence ∈ (0,100], engine `tesseract`, engineVersion, language `eng`, durationMs, processedAt, failure/lock cleared, keywords include hello/world; 3-way FIFO batch.
  - search (21) — shape, case-insensitive keyword, no-match empty, per-device exact matches, minConfidence 90/200/−1, deviceId filter, from/bad-date, limit 2 + distinct page 2 + exhausted walk (`hasMore:false`, `nextCursor:null`), malformed cursor/limit → 400.
  - failure handling (11) — corrupt → `OCR_CORRUPT_IMAGE` permanent at attempts=1 (retry → `exceeded`, stays failed); missing-file → `OCR_MISSING_FILE` retryable; unsupported → `OCR_UNSUPPORTED_FORMAT` permanent; worker healthy after failures.
  - retry budget (11) — attempts climb 1→2→3, `retryable=false` at budget, exceeded disposition, completed re-run completes again, malformed body 400, 201 ids 400, no-token 401.
  - stall recovery (4) — processing row older than stall → re-claimed; exhausted claim → permanent `OCR_STALLED_RECOVERED`.
  - delete-under-queue (4) — DELETE while queued → 200, OCR status 404, no orphan processing row, dedup-twin cleanup.
  - provider attribution (4) — every processed row engine `tesseract`, language `eng`, completed rows never carry a failure code, engineVersion recorded.
  - concurrency (2) — 4-job burst all complete; FIFO completion order preserved.
  - Regression: E1/E2 (register+activate through real signed API) exercised by the suite's device setup.
- **Build gates:** `prisma validate` ✅ · `prisma migrate status` = up to date ✅ · `tsc --noEmit` = exactly the 4 pre-existing baseline errors (zero new in ocr/config/instrumentation/screenshots) ✅ · `eslint` on `src/lib/ocr`, the three routes, `src/instrumentation.ts` = clean exit 0 ✅ · `npm run build` ✅ (standalone copied).
- **Verification findings fixed during the run:** (1) raw-SQL boolean reads return 1/0, not `true`/`false` — script normalizes; (2) Prisma stores DateTime as INTEGER epoch-ms — stall fixtures must write ms integers, not ISO strings, or `ocrLockedAt < cutoff` silently misses; (3) `STORED_PATH_PATTERN` is `[a-z0-9]+` — crafted fixture filenames must be alphanumeric (cuid-style `-`/`_` → path rejected → misleading `OCR_MISSING_FILE`); (4) deterministic fixture hashes collide with the UNIQUE sha256 index across runs — derived rows get a per-run random salt; (5) content dedup across runs returns `duplicate:true` for identical uploads — accepted, bytes resolve via the dedup twin; (6) **production bug caught:** `retryOcrJobs` only classified `exceeded` when `attempts >= maxAttempts`, letting permanent corrupt failures (attempts=1) be re-queued — fixed to `!ocrRetryable`.

## 11. Risks

- **Tesseract accuracy** is a function of image content; the fixtures are synthetic bold text on white. Real-world accuracy/thresholds (empty-result policy) are the Stage-4.5/5 concern — the pipeline, codes, and persistence are in place.
- **Worker cadence** (2 s) is tuned for dev; a production deploy may want a faster interval or a queue-length-triggered wake-up.
- **Engine memory:** the shared Tesseract worker holds the wasm+model in memory; `dispose()` is exposed but nothing schedules it yet (bounded, acceptable for a single-provider app).
- **No search ranking** — keyword search is containment-based (LIKE); FTS5 / ranking is a future enhancement (search shape is stable, so migration is additive).
- **Dev-server Turbopack cache** can serve stale compiled server modules after source edits — a clean restart (cache cleared) is required when instrumentation/worker behavior changes (caught live during verification; not a code defect).

## 12. Rollback

1. Delete: `src/lib/ocr/` (6 files), the three routes under `src/app/api/admin/screenshots/`, `scripts/verify-ocr.mjs`, `scripts/cleanup-ocr-fixtures.mjs` (dev-only DB/storage sweep helper), `scripts/fixtures/ocr-*.webp` + `corrupt-webp.webp` + `not-image.txt`.
2. Revert: `src/instrumentation.ts` (remove worker start), `next.config.ts` (serverExternalPackages), `src/lib/config.ts` comment.
3. Remove the migration `prisma/migrations/20260803081601_m007_stage4_ocr_pipeline` and re-run `prisma migrate deploy` (or keep it — the columns are additive `DEFAULT`-backed and harmless to Stage-3 consumers).
4. OCR columns on Screenshot are entirely independent of the Stage-1/2/3 data plane — no impact on uploads, gallery, file streaming, retention, or integrity.

## 13. Git commit message

```
M007 Stage-4: OCR pipeline & search index

- Schema: 14 OCR columns on Screenshot (no parallel tables),
  indexes (ocrStatus,ocrQueuedAt) + (ocrConfidence); migration
  20260803081601 applied
- Provider: sniffImageFormat (webp/png/jpeg/corrupt/unknown) fast
  pre-check; TesseractProvider with shared worker, offline
  @tesseract.js-data/eng langPath, per-job timeout + hard engine
  reset, OCR_TIMEOUT/OCR_PROVIDER_CRASH taxonomy
- Workflow: enqueue (404/422/409), atomic FIFO claim, process via
  safe-read funnel, failInPlace retry budget (maxAttempts=3),
  reclaimStalledOcrJobs (stallMs=10m, OCR_STALLED_RECOVERED),
  retryOcrJobs per-id disposition (exceeded = any !ocrRetryable)
- Worker: instrumentation-started loop, single-instance guard,
  stats + dispose; serverExternalPackages for tesseract.js
- Admin API: GET+POST /screenshots/:id/ocr, POST ocr/retry
  (MAX_IDS=200), GET ocr/search (keyword case-insensitive,
  device/user/org/minConfidence/date filters, keyset pagination
  {t,id} base64url, limit+1 hasMore)
- verify-ocr.mjs: 96/96 live (enqueue matrix incl. permanent-
  failed 409s, success path, search 21, failure handling, retry
  budget, stall recovery, delete-under-queue, provider
  attribution, burst FIFO)
- Bugfix: retryOcrJobs now treats any permanent failure
  (!ocrRetryable) as exceeded, not only budget-exhausted
- Bugfix (re-verification): enqueueOcrJob refuses permanent
  failures (OCR_PERMANENT_FAILED 409) — the retry endpoint
  refused them but direct enqueue reset the budget; retry
  re-enqueue clears stale ocrFailure/ocrFailureDetail
- prisma validate OK; migrate status up to date; tsc 0 new;
  eslint clean; build OK
```
