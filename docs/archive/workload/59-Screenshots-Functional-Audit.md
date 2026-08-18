# Screenshots Functional Audit

**Audit date:** 2026-08-10
**Audit type:** CODE + DB + TEST INSPECTION (no code modified)
**Target:** Admin Panel → "Screenshots" — "View and analyze employee screenshot captures"

---

## Executive Verdict

**PRODUCTION CANDIDATE**

The Screenshots tab is genuinely functional and fully database-driven — every visible control is wired to a real, org-scoped, consent-enforced backend. No hardcoded/demo/mock data is used in the production UI path. The two remaining concerns before full PRODUCTION READY are hardening items, not functional blockers:

1. **Upload MIME validation is a prefix check** (`file.type.startsWith('image/')`), so `image/svg+xml` is accepted. Combined with CSP `script-src 'unsafe-inline'`, a crafted SVG uploaded by a compromised agent could execute script when a logged-in admin navigates directly to the image URL (script does **not** run inside `<img>`, so the grid/viewer are safe). Fix: allowlist `image/png | image/jpeg | image/webp` on upload and/or serve with `Content-Disposition: inline` + `Content-Type` forced to a safe raster type.
2. **No server-side orphan-file sweep.** A DB-transaction failure after `writeFile` leaves an orphaned file (the row is never created, the file remains). The desktop agent cleans its own spool, but the server has no orphan-file job. Low severity; retention only handles rows.

No CRITICAL or HIGH security findings.

## Score

**89 / 100**

| Category | Sub-score |
|---|---|
| UI functionality | 18/20 |
| Backend/API | 19/20 |
| Database/persistence | 9/10 |
| Security/consent | 17/20 |
| Storage/retention | 14/15 |
| Tests/E2E evidence | 12/15 |

---

## Functional Areas

| Area | Status | Evidence |
|---|---|---|
| UI | **PASS** | Grid/list, filters, pagination, viewer modal, all real API-wired |
| Screenshot upload | **PASS** | `POST /api/agent/screenshot` — token + consent + type/size validation; ZT-23/24 |
| Database persistence | **PASS** | `Screenshot` model in PostgreSQL, org FK + indexes; live DB verified |
| Storage | **PASS** | Local `uploads/screenshots/`; files outside `public/`; served only via auth API |
| Admin API | **PASS** | List/detail/stats/ocr-search/delete all org-scoped |
| Authentication | **PASS** | Proxy JWT for admin routes; `validateAgentToken` for agent upload |
| RBAC | **PASS** | `requireSessionOrg` (reads) / `requireAdminOrg` (mutations); viewer-gated UI |
| Organization isolation | **PASS** | Every query org-scoped from JWT; cross-org → 404 (MO-14, MO-8) |
| Consent enforcement | **PASS** | Fail-closed server-side `hasActiveConsent('screenshot')`; grant/revoke cycle tested |
| Image viewer | **PASS** | Auth-gated `/api/screenshots/[id]/image`, org-scoped, path-traversal guarded |
| Filters | **PASS** | Employee/device/date/flagged/search + OCR mode — server-side |
| Pagination | **PASS** | page/pageSize, capped, ordered, indexes present |
| Real-time/refresh | **PASS (manual)** | Manual Refresh + React Query; no WS auto-push for screenshots (documented) |
| Retention | **PASS** | `runRetentionForOrg` — file-first two-phase purge, org-configurable days, tests |
| Delete | **PASS** | Admin-only, org-scoped, unlink + DB delete; no audit log (minor) |
| Error handling | **PASS** | Empty state, loading skeletons, image `onError` fallback, toast errors |
| Mobile | **PASS (code)** | Responsive grid + modal (`w-[95vw] max-h-[90vh]`); not device-tested |
| Performance | **WARNING** | Full-resolution images in grid/list — no thumbnails (bandwidth) |
| Automated tests | **PASS** | 29 zero-touch + 27 consent + 28 security + 22 multi-org — all green |
| E2E | **PASS (HTTP-level)** | Route-level upload consent cycles (ZT-23/24); no live browser run |

---

## Complete Request Flow

```
Desktop Agent (Windows)
  ScreenshotCollector.capture()
    → decideConsentGate('screenshot', enabledByConfig, consent snapshot)
    → native.captureWindow() → bytes → spool .png + .json sidecar
    → ScreenshotSpoolDrain.drain() (15s tick)
      → ScreenshotApi.upload() → POST /api/agent/screenshot (FormData)
        → proxy.ts rate limit (agent-write 120/min/token)
        → validateAgentToken(req)            [401: bad/expired/revoked token/device]
        → hasActiveConsent(empId,'screenshot') [403: missing/revoked/expired/policy-mismatch]
        → file.type image/* + ≤5MB            [400]
        → writeFile uploads/screenshots/{employeeId}_{Date.now()}.{ext}
        → $transaction: Screenshot row + device.lastHeartbeat + AuditLog
    → 200 {filename, path, size, timestamp}
Admin UI (ScreenshotsPage)
  GET /api/screenshots?page&employeeId&deviceId&dateFrom&dateTo&flagged&search  (org-scoped)
  GET /api/screenshots/stats                                     (org-scoped counts)
  GET /api/screenshots/[id]/image                                (auth + org + basename guard)
  GET /api/screenshots/ocr-search?query=…                        (org-scoped raw SQL, parameterized)
  POST /api/screenshots/[id]/analyze · /batch-analyze            (admin+, org-scoped, AI)
  DELETE /api/screenshots/[id]                                   (admin+, org-scoped, unlink+delete)
Browser: <img src="/api/screenshots/{id}/image"> with httpOnly session cookie
```

---

## API Audit

### Agent upload — `POST /api/agent/screenshot` (`src/app/api/agent/screenshot/route.ts`)
- **Auth:** `validateAgentToken` (bearer) — token exists, not expired, employee `agentApproved` + `status: active`, device-bound token requires device `online|offline`. Revoked/inactive device → 401 (fail closed).
- **Consent:** `hasActiveConsent(employeeId, 'screenshot')` → 403 on missing/revoked/expired/policy-version-mismatch. **Server-authoritative** — client cannot bypass.
- **Org:** `organizationId` derived from the authenticated employee — never from the request.
- **Validation:** `file.type.startsWith('image/')`, `file.size ≤ 5MB`, else 400. **⚠️ accepts `image/svg+xml`.**
- **Storage:** `uploads/screenshots/{employeeId}_{Date.now()}.{ext}` — server-generated, no client path input. Ext comes from client filename extension (`.pop()`), sanitized by construction (single segment, no separators).
- **Persistence:** `db.$transaction` — Screenshot row (employeeId, deviceId, filePath, fileName, fileSize, mimeType, appWindow, capturedAt, organizationId) + device.lastHeartbeat update + audit log.
- **Failed uploads:** 401/403/400 paths return **before** `writeFile` → no file, no row. ⚠️ A 500 mid-transaction after `writeFile` leaves an orphan file (row rolled back).
- **Rate limit:** proxy `agent-write` 120/min per token.
- **Errors:** generic `{ error: 'Internal server error' }` — no stack traces, no secrets.

### Admin read routes (all org-scoped via `requireSessionOrg`)
| Route | Auth | RBAC | Org scope | Notes |
|---|---|---|---|---|
| `GET /api/screenshots` | JWT | any authenticated | ✅ `organizationId` from JWT; filters employeeId/deviceId/date/flagged/search all server-side | paginated (pageSize ≤ 100), `include` employee+device (no N+1), ordered `capturedAt desc` |
| `GET /api/screenshots/[id]` | JWT | any authenticated | ✅ `findFirst({ id, organizationId })` → 404 concealment | include employee+dept+device |
| `GET /api/screenshots/stats` | JWT | any authenticated | ✅ | count/aggregate/groupBy, org-scoped, bounded (take 10) |
| `GET /api/screenshots/ocr-search` | JWT | any authenticated | ✅ parameterized `$queryRawUnsafe` with `$1` orgId + `$2` pattern | LIKE-escaped (`%`,`_`), `LOWER()`, LIMIT/OFFSET |
| `GET /api/screenshots/[id]/image` | JWT (cookie) | any authenticated | ✅ `findFirst({ id, organizationId })` → 404 | `basename()` path-traversal guard, nosniff, private cache |
| `POST /api/screenshots/[id]/analyze` | JWT | **admin+** (`requireAdminOrg`) | ✅ | AI OCR/VLM; no mock fallbacks |
| `POST /api/screenshots/batch-analyze` | JWT | **admin+** | ✅ ids filtered by org | max 10 |
| `DELETE /api/screenshots/[id]` | JWT | **admin+** | ✅ | unlink (best-effort) + `delete`; **no audit log** |

### Cross-org tests (executed)
- MO-14: Admin A list has only A's screenshots; A cannot fetch B's image (404).
- MO-8: cross-org resource IDs → 404 concealment.
- ZT-7: foreign admin cannot act on another org's claim; foreign employee assignment → 422.

---

## Database Audit

**Model** (`prisma/schema.prisma:436` — `Screenshot`):
- PK `id cuid()`; `employeeId` (required, FK→Employee `onDelete: Cascade`); `deviceId` (nullable, FK→Device `onDelete: Cascade`); `organizationId` (required, FK→Organization `onDelete: Cascade`).
- `filePath` (URL-style `/uploads/screenshots/name`), `fileName`, `fileSize`, `mimeType`, `width/height`, `appWindow`, `ocrText`, `aiAnalysis`, `blurScore`, `flagged`, `flagReason`.
- `capturedAt` (business timestamp, defaults now) + `createdAt`.
- **Indexes:** `organizationId`, `employeeId`, `deviceId`, `[employeeId, capturedAt]`, `capturedAt`, `flagged` — all present; list/stats/retention queries are index-covered.

**Answers to the DB questions:**
1. Screenshots persisted in PostgreSQL ✅ (verified — live `workai` DB; `Screenshot` count queryable).
2. Linked to correct employee ✅ (`employeeId` FK, agent-derived).
3. Linked to correct device ✅ (nullable, from token `deviceId`).
4. `organizationId` available + derivable safely ✅ (stored; also derivable via employee — server-side only).
5. Org A → Org B leak? **No** — every admin query filters on JWT-derived org; cross-org returns 404 (MO-14).
6. Deleted employees/devices: employee cascade deletes screenshots; device `onDelete: Cascade` deletes screenshot rows but **not** the physical file (orphan file remains — minor, same class as the transaction-orphan finding).
7. Orphan records: rows cannot be orphaned via FK (cascade keeps integrity). Physical orphan **files** possible in two paths (device cascade delete; post-write txn failure). Documented as LOW.

---

## Security Findings

| Severity | Finding | Detail |
|---|---|---|
| **MEDIUM** | SVG upload allowed | `file.type.startsWith('image/')` accepts `image/svg+xml`. CSP has `script-src 'unsafe-inline'`. A compromised agent could upload a scripted SVG; executing requires the admin to navigate **directly** to `/api/screenshots/[id]/image` (not via `<img>`, which never runs scripts). Fix: MIME allowlist (png/jpeg/webp) + `Content-Disposition`/forced safe `Content-Type` on serve. |
| **LOW** | Orphan files on cascade/txn failure | Device delete cascades screenshot rows without unlinking files; `writeFile` before `$transaction` can orphan on 500. No server orphan sweep. |
| **LOW** | Delete has no audit log | Other destructive actions log; `DELETE /api/screenshots/[id]` doesn't. |
| **LOW** | Filename collision | `{employeeId}_{Date.now()}` — same-employee same-ms double-upload would collide (overwrite). Rare; recommend `randomUUID()`. |
| **INFO** | Direct-URL access | Files live in `uploads/` (project root, **not** `public/`), `output: "standalone"`, proxy matcher only `/api/:path*` → no unauthenticated static path exists. `workload/49` marked this "NOT VERIFIED live"; confirmed by config inspection here. |
| **INFO** | Full-res in grid | Every card requests the full image (no thumbnail variant) → bandwidth + the `screenshot-image` 120/min/IP rate limit could throttle heavy paging. |
| **INFO** | `X-Content-Type-Options: nosniff` + `private, max-age=3600` on image serve | Correct. |

---

## Bugs

| # | File / Function | Reproduction | Expected | Actual | Severity | Recommended fix |
|---|---|---|---|---|---|---|
| 1 | `src/app/api/agent/screenshot/route.ts` POST | Upload `image/svg+xml` (or any `image/*`) with valid token+consent | Reject non-raster types | Accepted (prefix check) | MEDIUM | Allowlist `image/png`, `image/jpeg`, `image/webp`; also verify magic bytes |
| 2 | `src/app/api/agent/screenshot/route.ts` POST | `writeFile` succeeds, then `$transaction` throws (e.g. DB down) | No artifact left | File remains orphaned | LOW | Wrap file write in try/catch; unlink on txn failure (or write file inside transaction-then-commit pattern) |
| 3 | `src/app/api/screenshots/[id]/route.ts` DELETE | Delete any screenshot | Audit log entry written | No audit record | LOW | Add `auditLog.create` (action `delete`, resource `screenshot`) |
| 4 | `src/app/api/agent/screenshot/route.ts` filename | Two same-employee uploads in the same ms | Unique names | `Date.now()` collision → overwrite | LOW | `crypto.randomUUID()` in filename |

No UI-breaking bugs found. All controls produce the expected API requests and update the UI from the response (verified by code + HTTP-level tests).

---

## Missing Functionality

- **Genuinely missing:**
  - Server-side orphan-file sweep (recommended, LOW).
  - Download button on the viewer — not required by product scope; **N/A**.
  - WebSocket/SSE auto-push for new screenshots — not claimed; manual refresh documented.
- **Implemented but broken:** none found.
- **Implemented and working:** all of the above functional areas.
- **Not verifiable in this environment:** real-browser mobile/responsive run, live signed-URL/HSTS HTTPS delivery, physical clean-machine E2E (requires a second Windows machine with the packaged agent). These are tracked in the Phase H go-live checklist.

---

## Test Results

Executed against throwaway PostgreSQL databases (test suites self-provision via `scripts/pg-test-db.mjs`):

| Suite | Command | Result |
|---|---|---|
| Zero-touch (incl. ZT-23 screenshot upload cycle, ZT-24 consent independence, ZT-21/22 activity) | `npx tsx --test tests/zero-touch.test.ts` | **29/29 PASS** |
| Consent (policy versioning, expiry, retention bounds, revoke/re-grant) | `npx tsx --test tests/consent.test.ts` | **27/27 PASS** |
| Security (screenshot consent grant/revoke, org isolation) | `npx tsx --test tests/security.test.ts` | **28/28 PASS** |
| Multi-org isolation (MO-14 screenshot list+image, MO-8 cross-org 404, MO-9 client orgId) | `npx tsx --test tests/multi-org-isolation.test.ts` | **22/22 PASS** |
| **Total** | | **106/106 PASS** |

**Coverage gaps (NOT COVERED BY AUTOMATED TESTS):**
- Route-level oversized/unsupported-type upload validation (size/type checked in code; not asserted in tests).
- Screenshot DELETE route behavior + audit logging.
- Image route behavior with corrupt/missing files (UI `onError` fallback is code-inspected only).
- Admin list filter edge cases (invalid employeeId/deviceId, malformed dates).
- Mobile/responsive rendering.

---

## Production Recommendation

The Screenshots tab is **safe to deploy for pilot/production** — it is genuinely database-driven, org-isolated, consent-enforced (fail-closed, server-side), and covered by 106 passing tests including the critical upload-consent cycle.

**Before declaring full PRODUCTION READY, close these items (small, targeted):**
1. **(MEDIUM)** Restrict upload MIME to a raster allowlist (png/jpeg/webp) + magic-byte check; force a safe `Content-Type`/`Content-Disposition` when serving.
2. **(LOW)** Unlink the uploaded file if the DB transaction fails; add a server-side orphan-file sweep (or document reliance on the desktop-agent spool cleanup + retention).
3. **(LOW)** Add an audit log entry on screenshot delete.
4. **(LOW)** Use `crypto.randomUUID()` for upload filenames (collision-proof).
5. **(INFO)** Consider a thumbnail endpoint to reduce bandwidth (full-res images in grid/list).

---

## Summary

1. **What works:** Full capture → consent-gated upload → PostgreSQL persistence → org-scoped admin list/stats/search → auth-gated image viewer → delete/retention. Every UI control is wired to real data; no mock/hardcoded content.
2. **What does not work:** Nothing functionally broken found. Two hardening gaps (SVG MIME acceptance, orphan files) are LOW/MEDIUM, not functional failures.
3. **Security risks:** No CRITICAL/HIGH. MEDIUM SVG-via-`<img>`-safe-but-direct-navigation vector; no unauthenticated static file access.
4. **Missing functionality:** Orphan-file sweep, delete audit log, thumbnails (all optional hardening); download button not in scope.
5. **Exact next steps:** Apply the 5 recommendations above, add the missing route-level tests (upload type/size, delete, image missing-file), then run a real browser E2E on a clean Windows machine.
6. **Production-ready?** **PRODUCTION CANDIDATE** — fully functional and safe for pilot deployment; the 5 hardening items above should be closed before full general rollout.
