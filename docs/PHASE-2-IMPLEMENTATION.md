# PHASE 2 IMPLEMENTATION — SCREENSHOT STORAGE, PROCESSING, THUMBNAIL & COST-CONTROL HARDENING

Status: implemented and verified (see `docs/PHASE-2-REPORT.md`). Additive only —
no Phase 0/1 behavior, API contract, storage abstraction, or agent protocol was
changed. Agent changes: **none**.

---

## 1. Architecture

```
Agent
  ↓  (unchanged: consent/config/working-hours/break gated capture → encrypted spool → upload)
POST /api/agent/screenshot            ← unchanged request/response contract
  ├─ auth + consent + size + magic-byte validation   (unchanged)
  ├─ putScreenshot(org, filename, bytes)             (unchanged — original = source of truth)
  └─ Screenshot row created with processingStatus='uploaded'   (NEW — the state IS the queue)
                                                                      ↓
Background worker — 'screenshot_processing' JobRun lease (existing scheduler)
  └─ processPendingScreenshots(limit=100): oldest 'uploaded' rows first
       ├─ read original object (unchanged driver)
       ├─ sharp decode+resize → ≤320px thumbnail, same format, never upscale
       ├─ putScreenshot(org, <name>.thumb.<ext>)      (deterministic key)
       └─ row → processingStatus='processed' (+ thumbnailPath/Size/processedAt,
            backfill width/height only when NULL)
Failure: bounded retries (3) → 'processing_failed' + sanitized reason; original always intact.
```

The upload request performs NO image work (no resize/OCR/AI). Enqueueing is a
column default on the row the request already writes.

## 2. Database changes (additive migration `20260903010000_screenshot_thumbnail_processing`)

Columns added to `Screenshot` (nothing dropped/renamed/rewritten):

| Column | Type | Meaning |
|---|---|---|
| `processingStatus` | TEXT NOT NULL DEFAULT 'uploaded' | `uploaded` → `processed` \| `processing_failed` |
| `processingAttempts` | INT NOT NULL DEFAULT 0 | failure bookkeeping |
| `processingError` | TEXT? | sanitized category (`decode_failed`, `original_missing`, `storage_write_failed`) |
| `processedAt` | TIMESTAMP? | when the thumbnail was written |
| `thumbnailPath` | TEXT? | display path `/uploads/screenshots/<name>.thumb.<ext>` |
| `thumbnailSize` | INT? | thumbnail bytes (cost accounting) |

Indexes (both added):
- `(processingStatus, capturedAt)` — the worker's bounded oldest-uploaded-first
  drain; highly selective (never scans the processed majority).
- `(organizationId, processingStatus)` — per-org status queries (observability,
  future per-org controls).

Existing rows default to `uploaded` via the migration's column default, so the
bounded worker backfills thumbnails for pre-Phase-2 screenshots automatically
(retention already bounds the universe to the org window). Existing `Activity` /
`Screenshot` rows are never rewritten. Migration verified from-scratch:
`migrate deploy` → `migrate diff` = **No difference detected**.

## 3. Worker behavior (`src/lib/screenshots/processing.ts`)

- Runs under the existing `JobRun` lease (`claimJob('screenshot_processing')`)
  from (a) instrumentation's dev+prod loop
  (`SCREENSHOT_PROCESSING_INTERVAL_SECONDS`, default 60s, min 15s) and
  (b) `runScheduledJobs` / `npm run jobs`. Overlapping invocations are a safe
  no-op (lease).
- Per run: `take = min(limit, 500)` — hard safety ceiling. Default
  `SCREENSHOT_PROCESSING_DEFAULT_LIMIT = 100`.
- Per row: reads original → generates → stores → updates. One row's failure
  never aborts the batch.
- Observability (existing logger; no binaries/tokens/paths): `batch_started` /
  `batch_completed` / `completed` / `failed` / `retry` events with
  `screenshotId`, org prefix, attempt, status, reason, durations.

### Retry policy
`MAX_SCREENSHOT_PROCESSING_ATTEMPTS = 3` (mirrors the audio transcription
worker's `MAX_AUDIO_RETRIES`). Decode/encode or storage-write failures below the
max keep the row `uploaded` with an incremented attempt count (next scheduler
run retries). At the max the row becomes `processing_failed` and is never picked
up again — one corrupt screenshot cannot consume worker resources forever.

### Idempotency / restart safety
The in-flight state is deliberately NOT persisted: a crash mid-row leaves the
row `uploaded`, and the next run simply re-processes it. The thumbnail object
key is deterministic (`<original-name>.thumb.<ext>`), so re-runs overwrite the
same object — **duplicate thumbnails are impossible by construction**. Rows
already `processed` are excluded from the drain query. Missing original objects
(`original_missing`) fail permanently on first contact (retrying cannot help).

### Failure handling
The original screenshot is never modified by processing. On any failure the
original object + DB row survive. `processingError` stores only sanitized
categories — never filesystem paths, stack traces, or storage credentials.

## 4. Thumbnail policy (`src/lib/screenshots/processing.ts` constants)

- `SCREENSHOT_THUMBNAIL_MAX_DIMENSION = 320` — longest edge, `fit: 'inside'`,
  aspect preserved, `withoutEnlargement: true` (never upscales small sources).
- `SCREENSHOT_THUMBNAIL_QUALITY = 80` (JPEG/WebP).
- Output format = input format (PNG/JPEG/WebP) — same magic-byte allowlist the
  upload path enforces applies to thumbnails when served.
- `limitInputPixels` (64 MP) — decompression-bomb guard; absurd dimensions fail
  fast instead of exhausting worker memory/CPU.
- EXIF orientation honored (`rotate()`) so thumbnails are never sideways.
- No client-controllable dimensions anywhere; the admin UI cannot request
  arbitrary sizes. Constants are centralized, not scattered.
- Corrupt/unsupported images throw a sanitized decode failure — original kept.

## 5. Storage behavior

Thumbnails go through the SAME storage abstraction and drivers (local
filesystem / Supabase Storage) as originals — `putScreenshot(org, filename,
bytes, mime)`. Key shape: `screenshots/<org>/<name>.thumb.<ext>`; local driver
maps it into the existing flat `uploads/screenshots/` directory exactly like
originals. No second storage system, no direct fs/S3 calls. Serving reads
through `getScreenshot(org, thumbnailPath)` and re-validates magic bytes.

## 6. Retention (`src/lib/jobs/retention.ts`, `src/lib/screenshots/sweep.ts`)

- Same scheduler (`retention_cleanup` lease → per-org pass → global orphan
  sweep). No second retention system.
- Screenshot purge now deletes **thumbnail first, then original**, and only
  deletes the DB row when BOTH physical artifacts are confirmed gone; a file
  that cannot be unlinked keeps the row and is reported (retry next run). An
  org's retention can never delete another org's assets (org-scoped queries
  unchanged).
- Orphan sweep now treats `thumbnailPath` basenames as referenced, so a
  processed screenshot's thumbnail is never swept. Orphaned thumbnails (row
  gone/partial write) are swept like orphaned originals (local driver; Supabase
  remains a documented no-op, as before — every Supabase write/delete already
  goes through the driver).
- Org timezone/`0 = never purge` semantics unchanged (screenshot retention is
  `capturedAt`-based via `screenshot_retention_days`).

## 7. Cost controls (no counters, no billing)

Per-org usage is derived from existing metadata — the row columns — so it can
never drift from reality:
- Originals: existing `_sum(fileSize)` (`totalStorage`, unchanged semantics).
- Thumbnails: new `_sum(thumbnailSize)` exposed additively as
  `thumbnailStorage` on `GET /api/screenshots/stats`.
- Counts (total/today/flagged/recent-by-employee) already existed.
A quota/billing layer was deliberately NOT added (Phase 2 scope; no existing
quota mechanism to extend safely).

## 8. Admin UI (`src/components/screenshots/screenshots-page.tsx`)

- Grid cards and list-view previews now load the **thumbnail first** via
  `GET /api/screenshots/[id]/thumbnail` when the row is `processed`; the
  full-resolution original is fetched only when the admin opens a screenshot
  (viewer modal) or clicks "open original".
- Fallback chain: thumbnail → authorized original → "Unavailable" placeholder —
  no repeated synchronous generation is ever triggered from the browser.
- Client `ScreenshotItem` type extended with the new nullable fields (additive).

## 9. Serving + security

New `GET /api/screenshots/[id]/thumbnail` mirrors the original image route's
authorization exactly (never weaker): session auth via
`requireSessionOrg`; org-scoped row lookup (cross-org → 404 concealment);
org-less super_admin → 404; missing object → 404; magic bytes authoritative for
Content-Type with `nosniff`; longer private cache (deterministic key ⇒
immutable ⇒ `private, max-age=86400`). No thumbnail → 404 (client falls back to
the original URL). RBAC/consent/working-hours/break-mode enforcement on the
upload path is untouched.

## 10. Compatibility

- Agent upload contract, capture semantics, spool, retries: **unchanged** —
  the agent repo was not modified.
- Upload API response: unchanged fields.
- Original image route, list/detail/analyze/delete routes: unchanged (rows gain
  additive JSON fields only).
- Feature flag: **none added by design.** The worker is backward compatible and
  safe (bounded, idempotent, cannot fail uploads or hide originals; the upload
  path never waits on it). Introducing an org-scoped kill switch would silently
  strand whole orgs without thumbnails for zero benefit — rollout = deploy +
  the worker's own bounded drain. Documented per Phase 2 §30.
- Thumbnails are served with the same auth as originals — org A can never read
  org B's thumbnail.

## 11. Observability

Safe identifiers only (`screenshotId`, org prefix, attempt, status, reason,
bytes, dimensions). No screenshot bytes, tokens, paths, or credentials are
logged.

## 12. Rollback

1. Stop the worker: set `SCREENSHOT_PROCESSING_INTERVAL_SECONDS` beyond the
   process lifetime or remove the instrumentation block (dev) — or simply
   deploy the previous build: new columns are inert unless the worker runs.
2. Originals and the original-image route are unaffected — admins keep full
   access.
3. Revert additive code (worker module, route handler, viewer changes, stats
   field) — the UI falls back to original images automatically.
4. The migration is additive; it is safe to keep (columns are null/defaulted
   and unused once the worker is gone). If removal is ever required:
   `DROP INDEX ...` + `ALTER TABLE "Screenshot" DROP COLUMN ...` — no existing
   data depends on it. Never delete original objects as part of rollback.
