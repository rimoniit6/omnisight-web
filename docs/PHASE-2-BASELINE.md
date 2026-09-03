# PHASE 2 BASELINE — SCREENSHOT PIPELINE (AS-BUILT, PRE-HARDENING)

Status: forensic baseline, captured before Phase 2 changes. Web root: project root
(`omnisight-web`). Agent root: sibling `omnisight-agent`. No code was modified to
produce this document; every statement below was verified against the working
tree on 2026-09-03 (Phase 0/1 GREEN, uncommitted).

---

## 1. Web — screenshot data model

`model Screenshot` in `prisma/schema.prisma` (additive history: `filePath`
column, `mimeType` default `image/png`, optional `width`/`height` populated only
for PNG via IHDR parse).

Existing fields:

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | PK |
| `employeeId` | FK→Employee | `onDelete: Cascade` |
| `deviceId` | FK→Device? | `onDelete: Cascade` |
| `filePath` | String | display path `/uploads/screenshots/<uuid>.<ext>`; storage key derived server-side from org + basename |
| `fileName` | String | agent-supplied display name (sanitized server-side) |
| `fileSize` | Int | original bytes |
| `mimeType` | String | allowlisted PNG/JPEG/WebP, magic-byte verified |
| `width`/`height` | Int? | PNG only today (IHDR parse); JPEG/WebP stay NULL |
| `appWindow` | String? | active-window title at capture |
| `ocrText`, `aiAnalysis` | String? | manual/VLM results (on-demand analyze only — no auto pipeline) |
| `blurScore`, `flagged`, `flagReason` | | review metadata |
| `organizationId` | FK→Organization | tenant scope |
| `capturedAt`, `createdAt` | DateTime | `capturedAt` = agent capture time |

Indexes (existing): `organizationId`, `employeeId`, `deviceId`,
`[employeeId, capturedAt]`, `[organizationId, capturedAt]`, `capturedAt`,
`flagged`, `createdAt`. **No processing-status/thumbnail columns exist.**

## 2. Web — storage abstraction (PRESERVED, reused as-is)

`src/lib/storage/{index,local,supabase,types}.ts`. Drivers behind one interface
(`put`/`get`/`delete`/`getSignedUrl`/`getPublicUrl`); chosen once per process by
`STORAGE_DRIVER` (`local` | `supabase`). Fail-closed on placeholder/missing
Supabase credentials in production.

- Local driver key→path mapping: `screenshots/<org>/<file>` →
  `<cwd>/uploads/screenshots/<file>` (**flat layout** — org segment is dropped;
  the DB `filePath` basename is what matters). Keys are sanitized (`/`, `\`, `.`,
  `..` neutralized) so crafted keys cannot escape the root.
- Supabase driver: private `screenshots` bucket, objects at
  `screenshots/<orgId>/<name>`.
- Helpers in `src/lib/storage/index.ts`: `screenshotKey`, `putScreenshot`,
  `getScreenshot`, `deleteScreenshot`, `screenshotAiInput`, `removeArtifactByPath`,
  `isNotFound`.

There is exactly ONE storage system. Phase 2 must write thumbnails through these
same helpers/drivers (same bucket, org-prefixed key, deterministic filename).

## 3. Web — upload path (`POST /api/agent/screenshot`)

`src/app/api/agent/screenshot/route.ts`, authenticated by `validateAgentToken`
(DeviceClaim/AgentToken flow). Current synchronous sequence:

1. validate agent token (401 on failure)
2. `hasActiveConsent(employeeId, 'screenshot')` (403 fail-closed)
3. parse `formData()`: `screenshot` File, `timestamp`, `appWindow`
4. size cap **5 MB** before body read (400)
5. `validateScreenshotUpload(bytes, claimedMime)` — allowlist PNG/JPEG/WebP +
   magic-byte match (400)
6. PNG-only `parsePngDimensions` → `width`/`height` (server-parsed, never client)
7. timestamp validated client-side value → `capturedAt`
8. `putScreenshot(orgId, filename, bytes, mime)` — object written FIRST
9. `db.$transaction`: Screenshot row (UUID filename, sanitized display name) +
   device heartbeat + audit log
10. on transaction failure → best-effort `deleteScreenshot` of the new object
    (no orphan), generic 500, safe logging

No image decoding/resizing/OCR/AI runs in the request lifecycle today. JPEG/WebP
dimensions are not parsed. The upload API response contract is
`{ success, filename, path, size, timestamp, appWindow }`.

Working-hours / break-mode / screenshot-policy gating is enforced **agent-side**
(capture gate) — the agent does not capture outside consent/config/working
hours/break; the server enforces token + consent + org scope at the API. Server
does not re-derive working hours on this route (pre-existing contract).

## 4. Web — serving path

`src/app/api/screenshots/[id]/image/route.ts`:
`requireSessionOrg` (session cookie; org-less super_admin → 404) → org-scoped
`findFirst` by `id` → `getScreenshot(orgId, filePath)` → missing object = 404 →
`safeServeMime(data)` (magic bytes authoritative; unrecognized → octet-stream)
→ `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=3600`,
`X-Content-Type-Options: nosniff`.

Authorization is server-derived from the session org — cross-org reads conceal
404. **There is no thumbnail route today.**

Admin CRUD: `GET /api/screenshots` (OFFSET pagination page/pageSize ≤100,
filters employee/device/date/flagged/search), `GET /api/screenshots/[id]`,
`DELETE /api/screenshots/[id]` (admin+; object delete then transactional row
delete + audit), `GET /api/screenshots/stats` (total/today/flagged counts +
`totalStorage = _sum(fileSize)` + recent-by-employee groupBy).

## 5. Web — retention + orphan sweep (reused scheduler)

`src/lib/jobs/retention.ts` + `src/lib/screenshots/sweep.ts`, run inside
`runScheduledJobs()` under the `retention_cleanup` JobRun lease (hourly in
production; also `npm run jobs`).

- Org-scoped `runRetentionForOrg`: screenshots purged when
  `capturedAt < cutoff(screenshot_retention_days)` (default 30, 0 = never),
  org setting via OrganizationSetting (no SystemSetting fallback). Two-phase
  file-first purge: unlink physical object; only rows whose file is confirmed
  gone are deleted; failures keep the row and report `fileErrors`.
- Global `sweepOrphanScreenshotFiles` after per-org pass (local driver only;
  Supabase no-op by design): flat-dir scan, deletes files with no matching
  Screenshot row `filePath` basename, min-age 15 min guard, bounded 1000/run.

Retention does NOT know about thumbnails (none exist yet). Orphan sweep does NOT
know about thumbnail columns.

## 6. Web — background-job infrastructure (reused)

No external queue. Two mechanisms:

- **Lease-guarded periodic jobs**: `JobRun` rows + `claimJob(job)` atomic
  update with a 5-minute lease + `finishJob`; invoked from
  `runScheduledJobs()` (hourly in production via `src/instrumentation.ts`,
  min 60s cadence env `JOBS_INTERVAL_SECONDS`, also `scripts`/CLI `npm run
  jobs`). Also a second dev+prod realtime loop for project-time sync
  (60s cadence, its own lease).
- **Query-driven per-item workers** (established precedent:
  `src/lib/audio/transcribe-job.ts`): rows carry a `status` column +
  `retryCount` (`MAX_AUDIO_RETRIES = 3`); the job finds
  `status IN (uploaded, queued) AND retryCount < MAX`, processes each, advances
  status. Idempotent, restart-safe (a crashed run leaves rows in a claimable
  state), bounded per run.

No screenshot processing job exists. `sharp@0.34.3` is already a dependency and
is used in `src/app/api/upload/avatar/route.ts` (`.resize().png().toBuffer()`).

## 7. Web — admin screenshot viewer

`src/components/screenshots/screenshots-page.tsx` (grid/list, filters, viewer
modal, analyze/flag/delete). Image loads today:

- Grid card + list preview + modal: `src={/api/screenshots/${id}/image}` —
  **every grid/list cell fetches the FULL-RESOLUTION original**. No thumbnail
  stage; bandwidth/egress-heavy at 1 screenshot/min × employees.
- Modal viewer loads the original on demand (per-screenshot detail query) with
  zoom/pan, "open original" link, unavailable fallback div on image error.

`ScreenshotItem` client type mirrors the list API row (no thumbnail fields).

## 8. Web — cost / volume facts

- Per-org byte accounting exists only as `_sum(fileSize)` in the stats route —
  no thumbnail bytes, no counter tables, no quota (Phase 2 deliberately does
  not add billing; quota stays out of scope per the V1 plan's Phase 2 boundary
  for existing installs).
- Volume estimate used by the plan: 100 employees × 8 h × 22 d × 1/min ≈
  **1,056,000 screenshots/month**. Existing list/stats queries are org-scoped
  and index-backed but OFFSET-paginated; retention is org-scoped + bounded.
  No status/thumbnail query exists yet, so no status index is needed yet.

## 9. Agent (omnisight-agent) — screenshot capture

`src/collectors/screenshot-collector.ts` + `src/services/screenshot-spool.ts` +
queue/uploader:

- Capture gated by consent snapshot for `screenshot` AND config
  `monitoring.screenshotEnabled` (fail-closed), working-hours window from
  config `timezone`, and paused in break/privacy mode; native capture via the
  bridge; **encrypted at rest** in the bounded spool (AES-256-GCM).
- Upload cadence driven by server config (`screenshotFrequency` minutes);
  uploads go through the shared queue-uploader (batched, retried with backoff,
  spool persistence) to `POST /api/agent/screenshot` multipart:
  `screenshot` file, `timestamp`, `appWindow`. Agent deletes/acknowledges a
  spool item only after a successful HTTP response.

No agent change is required for Phase 2: the upload contract is unchanged and
thumbnail generation is entirely server-side. Capture semantics are sound
(consent+config+working-hours+break gates, bounded encrypted spool).

## 10. Cross-repo contract (unchanged by Phase 2)

Upload: multipart `screenshot` (PNG/JPEG/WebP ≤5 MB) + `timestamp` + `appWindow`;
response `{ success, filename, path, size, timestamp, appWindow }`. Serving:
`/api/screenshots/[id]/image` (session auth, org-scoped). Neither changes.

## 11. Gaps Phase 2 closes (evidence-backed)

1. No thumbnails: grid/list/modal all fetch full-resolution originals (§3/§7).
2. No async processing job for screenshots (only on-demand manual analyze).
3. JPEG/WebP width/height never parsed (minor metadata gap, safe to fill from
   the thumbnail worker's decode).
4. Retention + orphan sweep unaware of any derived artifact (must delete
   original+thumb together; sweep must reference thumbnail basenames).
5. Stats/byte accounting excludes derived thumbnails.
6. No status/attempt/error columns to distinguish uploaded → processed →
   processing_failed (prompt's required conceptual state machine is absent).
