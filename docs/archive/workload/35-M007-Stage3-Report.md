# M007 Stage-3 — Screenshot Consumption Layer — Implementation Report

## 1. Files changed

**New:**
- `src/app/api/admin/screenshots/route.ts` — `GET /api/admin/screenshots` (gallery, keyset pagination, filters).
- `src/app/api/admin/screenshots/[id]/route.ts` — `GET` detail + `DELETE`.
- `src/app/api/admin/screenshots/[id]/file/route.ts` — streaming original / blurred variant.
- `src/app/api/admin/screenshots/retention/route.ts` — `POST` on-demand cleanup run.
- `src/app/api/admin/screenshots/integrity/route.ts` — `GET` read-only integrity report.
- `src/lib/screenshots/blur.ts` — server-side blur (`blurWebp`).
- `src/lib/screenshots/retention.ts` — `runRetentionCleanup` + policy constants.
- `src/lib/screenshots/integrity.ts` — `runIntegrityReport` (7 checks, no repair).
- `scripts/verify-e6-consumption.mjs` — live verification suite (**192 checks**).
- `scripts/fixtures/webp-a.webp` (640×400), `webp-b.webp` (320×240), `webp-c.webp` (800×300) — real WebP decode fixtures for the blur pass.

**Modified:**
- `src/lib/screenshots/storage.ts` — `resolveStoredFile`/`openStoredFile`/`readStoredFile`/`deleteStoredFile`/`walkStorageFiles`/`listTempDirs`; strict allowlist `^\d{4}/\d{2}/\d{2}/[a-z0-9]+\.webp$`, lstat + canonicalize (realpath) + root containment, symlink/junction rejection everywhere.
- `src/lib/auth.ts` — `requireSuperAdmin()` (`requireRole(SUPER_ADMIN_ROLE)`, role literal `'Admin'`).
- `src/lib/screenshots/index.ts` — exports for blur/retention/integrity.

## 2. Endpoint summary

| Endpoint | Method | Auth | Behavior |
|---|---|---|---|
| `/api/admin/screenshots` | GET | Super-admin | Metadata-only gallery — **one** DB query, never touches files |
| `/api/admin/screenshots/:id` | GET | Super-admin | Full metadata detail, no bytes, **never leaks `storagePath`** |
| `/api/admin/screenshots/:id/file` | GET | Super-admin | Streams original or blurred variant |
| `/api/admin/screenshots/:id` | DELETE | Super-admin | File-first-then-row two-phase delete |
| `/api/admin/screenshots/retention` | POST | Super-admin | On-demand `runRetentionCleanup` |
| `/api/admin/screenshots/integrity` | GET | Super-admin | Read-only integrity report |

Route-level `requireSuperAdmin` runs **on top of** the existing middleware JWT check; both employees and managers verified 403 on every endpoint (`?original=true` re-checks the role).

## 3. Gallery & pagination

- **One query, no bytes:** `findMany` with `device`/`user` includes only; `storagePath` is excluded from the select and never appears in the payload (asserted byte-level over the full JSON).
- **Keyset cursor** `(capturedAt DESC, id DESC)` — cursor is base64url-encoded JSON `{t, id}`; the next page filters with `OR (capturedAt < t) | (capturedAt = t AND id < ?)` — tiebreak deterministic even with identical millisecond timestamps (verified with two same-ms rows).
- **Filters:** `organizationId` (via `device.organizationId`), `userId`, `deviceId`, `monitorId`, `privacyMode` / `blurSensitive` (strict `true`/`false` else 400), `from`/`to` (ISO, invalid → 400), `limit` (1..100, default 50, >100 clamped, 0 → 400).
- **Response:** `{ screenshots[], hasMore, nextCursor }` — page walk over the full 150-row fixture+legacy DB returned every row exactly once.
- **Detail** returns the same row shape plus `image` (format/size/sha256/dims/`hasBytes`), `privacy`, `dedup` (with `twin`), `provenance` (uploadId/sessionId), `content` (ocrText). `hasBytes` resolves through the dedup twin when the row itself carries no file.

## 4. File streaming & blur

- **Never buffered:** served via `Readable.toWeb(createReadStream(...))`; `Content-Length`, `ETag` (`"sha256"`), `Last-Modified`, `Cache-Control: private`, `X-Content-Type-Options: nosniff`; `If-None-Match` → 304 with empty body.
- **Identity-based ETag:** the blurred variant reuses the original's ETag — byte-identity is not promised (transform re-runs), cache validity is (verified: 304 fires on the blurred response too).
- **Blur pipeline (`blurWebp`):** rotate → downscale to 480 px → `sharp blur(18)` → WebP q60; decode failure → 500 `BLUR_FAILED`, **never** silently degrades to original bytes.
- **Semantics:** default response blurs when `blurSensitive` is true; `?original=true` skips blur; `privacyMode` rows are 410 `SCREENSHOT_RETAINED` **before** any blur decision (privacy = metadata-only, not blur); dedup rows resolve the twin's file; missing file → 404 `SCREENSHOT_FILE_MISSING`; unknown/traversal ids → 404 without resolution.
- **Filesystem defense (every path — open, walk, delete):** strict relative allowlist → `lstat` (symlink rejected) → `realpath` canonicalization → root containment. Verified live: `../` traversal ids, `..\` traversal ids, and an NTFS **junction escape** all → 404; `walkStorageFiles` explicitly skips symlink/junction entries (never traverses outside the root — orphan detection deliberately cannot see junction content; the endpoint rejection is the defense).

## 5. Delete semantics

- File-first-then-row: `deleteStoredFile(storagePath)` (root-confined, symlink-rejected) before the row delete; a crash can never leave metadata pointing at bytes.
- Legacy metadata-only rows → 200 `{fileRemoved: false}`; privacy rows → `{retainedOnly: true}`; unknown id → 404; second delete → 404.
- Twin delete → dedup child's `dedupRef` goes NULL via FK `SetNull`; the orphaned child then serves 404 (verified).

## 6. Retention (contract §7.4)

`POST /retention` runs the full cleanup pass and returns `{runAt, ticketsExpired, ticketsPurged, tempDirsRemoved, filesRemoved, rowsRemoved}`:

| Data | Window | Action |
|---|---|---|
| Open tickets past TTL | 10 min | status → `expired`, chunk dir purged |
| Ticket rows (any status) | 24 h | row deleted (chunks already gone) |
| Orphan `.tmp` dirs | — | removed when no ticket row exists |
| Screenshot **files** | 90 d | file deleted → `storagePath` NULL (two-phase, row kept) |
| Screenshot **metadata** | 365 d | row deleted (files already gone) |

- **Referenced-file safety:** a twin's file is never deleted while any dedup child (`dedupRef → twin`) is still inside the 90-day window (verified: young child keeps the file; file removed on the next pass after the child is purged).
- Idempotent: a re-run with nothing due returns all-zero counters.

## 7. Integrity

`GET /integrity` — read-only, never mutates DB or disk:

- `missingFile` — row declares bytes, file absent/unsafe; `orphanDbRow` — E6 content row (sha256, no privacy/dedup) inside the 90-day window with no bytes (post-window rows are the expected post-retention state, not findings); `orphanFile` — pattern-valid file on disk referenced by no row; `brokenDedupRef` — dangling twin reference; `invalidDimensions` — ≤ 0 width/height (**checked for every row, including legacy metadata-only rows**); `duplicateHashes` — defense-in-depth (UNIQUE index makes it impossible); `invalidStoragePath` — fails the allowlist/root escape.
- Legacy rows (no sha256/storagePath/privacy/dedup) counted informatively in `summary.legacyMetadataOnly`, never flagged.
- Verified: every injected fault is detected, and a clean state reports all-zero findings (the report is actionable, not noisy).

## 8. Auth & security

- Middleware JWT-gates `/api/*` (web session cookie/Bearer) and the route layer re-verifies role via `requireSuperAdmin` — **no duplicated authorization logic**, single shared `requireRole` path. Employees/managers: 403 on all six endpoints; no-token: 401.
- `?original=true` re-runs the role check (verified: manager → 403).
- Filesystem: no DB path is ever trusted blindly — allowlist → lstat → canonicalize → containment on every entry point (read, delete, walk); temp-dir cleanup refuses symlinks.
- Retention/delete use the same safe helpers; `deleteStoredFile` verifies the target is a real file inside the root before unlinking (a junction/symlink at any component → no-op).
- Logging: no file paths in error bodies (a resolved path appears only as the allowlisted relative path in integrity findings).

## 9. Performance review

- Gallery: single query, keyset index-friendly walk — 150-row full walk ≈ 50 pages in the suite; page-100 request well under the 2500 ms budget (measured ~35 ms dev-server).
- File endpoint: zero full-file buffering (stream), blur is the only CPU cost and only for `blurSensitive` rows; ETag/304 short-circuits repeat downloads.
- Retention: bounded scans (`storagePath NOT NULL` rows due by timestamp; ticket scans filtered by status/expiry), one `count` per candidate for the dedup-child safety check — O(candidates), not O(rows).
- Integrity: single `findMany` over Screenshot + one GROUP BY + one directory walk.

## 10. Verification

- **`scripts/verify-e6-consumption.mjs`: 192/192 live, twice back-to-back, baseline stable** (144 legacy rows / 0 tickets after each run; the one legacy row consumed by the delete test is now a crafted stand-in so the baseline can never drift again).
  - auth matrix (13) — no-token 401, employee/manager 403 ×6 endpoints + `?original=true`, admin 200.
  - gallery (35 + 51 cursor pages) — every filter, boolean strictness, date ranges, limit rules, full keyset walk (every row, no dupes), same-ms tiebreak in DB order, malformed cursor 400.
  - detail (17) — shape, no `storagePath` leak, dedup twin resolution, privacy, legacy, 404.
  - file (24) — exact bytes, ETag/304, headers, blur default + `?original`, dedup twin bytes, 410 retained, missing-file 404, traversal ×2, junction escape.
  - delete (11) — two-phase, legacy, privacy, twin → SetNull → orphan 404.
  - retention (15) — expired ticket, 25 h purge, orphan temp dir, 100 d file (two-phase NULL), referenced-file survival, 365 d row, idempotency.
  - integrity (12) — all 7 finding types on injected faults + clean-state zero + legacy informational.
  - regression (9) — E1 register, E2 activate, E3 heartbeat, E5 activity, E6 single-shot stored, E16 rotate + re-auth, E7 health, E6 row visible in gallery.
  - performance (3) — latency budget, no bytes in payload, streamed content-length.
- **Build:** `prisma validate` ✅ · `eslint` clean (exit 0) on all changed files · `tsc --noEmit` = exactly the 4 pre-existing baseline errors (examples/websocket socket.io ×2, `src/components/admin/markdown.tsx` ES2018 regex ×2 — **zero new**) · `npm run build` ✅ with all five `/api/admin/screenshots*` routes in the manifest.
- Suite caveat surfaced during development: Prisma stores SQLite DateTime as **INTEGER (epoch ms)** — raw-SQL fixtures that write ISO strings are silently invisible to Prisma date filters (integer-vs-text comparison) — the script's raw insert helpers normalize to ms; this also caught nothing in production code, which uses Prisma end-to-end.

## 11. Risks

- **`storagePath` allowlist excludes hyphens** (`[a-z0-9]`): server-generated paths (`2026/08/03/<cuid>.webp`) never contain them — if a future writer deviates, the path is rejected loudly (404 + integrity finding) rather than served.
- **Blur is CPU-bound per request** on `blurSensitive` rows; a shared cache (e.g., blurred bytes keyed by sha256) is a future optimization — today correctness is verified, not speed of the transform itself.
- **No automated scheduler** for retention exists in-repo yet (same standing gap as Stage-1/2 jobs) — the pass is fully exercised on-demand; wiring it into an hourly job is a deploy concern, not a code one.
- **Junction content invisible to orphan detection** by design (walk never traverses outside the root); the file endpoint rejects such content, and the integrity report can't see it — acceptable, documented in code.
- **Middleware deprecation warning** (`middleware` → `proxy` convention) is pre-existing Next 16 noise, untouched by this stage.

## 12. Rollback

1. Delete the six admin routes (`src/app/api/admin/screenshots/`), `blur.ts`, `retention.ts`, `integrity.ts`, revert `storage.ts` additions, `requireSuperAdmin` in `auth.ts`, `scripts/verify-e6-consumption.mjs`, `scripts/fixtures/`.
2. No schema change in this stage — nothing to migrate; the new services are additive to the existing Screenshot/UploadTicket tables.
3. Storage files written by Stage-1/2 uploads are unaffected (consumption only reads/deletes per policy).

## 13. Git commit message

```
M007 Stage-3: screenshot consumption layer

- Admin API: gallery (metadata-only, keyset (ts,id) DESC pagination,
  org/user/device/monitor/privacy/blur/date filters), detail (no bytes,
  never leaks storagePath), file (streamed original / sharp blur(18)
  @480px for blurSensitive, identity ETag 304, 410 retained privacy rows),
  DELETE (file-first-then-row two-phase)
- Retention per contract 17 §7.4: ticket TTL expiry + 24h purge, orphan
  temp dirs, 90d files (storagePath NULL, dedup-child referenced-file
  safety), 365d rows; on-demand POST + stats
- Integrity: 7 read-only checks (missingFile, orphanDbRow within 90d
  window, orphanFile, brokenDedupRef, invalidDimensions for every row,
  duplicateHashes, invalidStoragePath) + legacy informational counts
- storage.ts hardening: strict path allowlist, lstat + canonicalize +
  root containment on every entry point, symlink/junction rejection,
  walk skips links
- requireSuperAdmin route gate over middleware JWT
- verify-e6-consumption.mjs: 192/192 live ×2 (auth matrix, filters,
  cursor walk, blur/304/410, traversal + junction attacks, retention
  safety, all 7 integrity findings, E1-E7/E16 regression, perf)
- prisma validate OK; tsc 0 new; eslint clean; build OK
```
