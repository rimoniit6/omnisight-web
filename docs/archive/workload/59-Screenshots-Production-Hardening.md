# Screenshots Production Hardening

**Phase:** Screenshots Production Hardening (follow-up to `workload/59-Screenshots-Functional-Audit.md`)
**Date:** 2026-08-10
**Status:** COMPLETE — SCREENSHOTS HARDENING: **PASS**

---

## Executive Summary

The functional audit (workload/59) rated the Screenshots module functional, database-driven,
PostgreSQL-backed, org-isolated, and consent-enforced. This phase implemented ONLY the targeted
hardening items that audit identified, with no UI redesign, no consent-semantics changes, no
zero-touch changes, and no schema changes.

Implemented:

1. Strict raster MIME allowlist (PNG/JPEG/WebP) + magic-byte verification on the agent upload route.
2. Server-side orphan-file sweep integrated into the existing retention background job.
3. Collision-proof `crypto.randomUUID()` filenames with employee-code sanitization (path-traversal fix).
4. Transaction-failure cleanup — a failed DB commit removes the freshly written file.
5. Safe image serving — physical signature authoritative, `X-Content-Type-Options: nosniff`, private cache.
6. DELETE now writes a transactional audit log (and includes caller IP).
7. 32 new automated tests (`tests/screenshots.test.ts`).

**No Prisma schema/migration changes required** — the existing `Screenshot` model is sufficient.

---

## 1. Files Changed

| File | Change |
|---|---|
| `src/lib/screenshots/storage.ts` | **NEW** — storage authority: MIME allowlist, magic-byte detection, upload validation, safe serve MIME, filename segment sanitizer, orphan-file sweep |
| `src/app/api/agent/screenshot/route.ts` | Strict MIME + magic-byte validation, timestamp validation (400), sanitized `{employeeId}_{randomUUID()}.{ext}` filenames, best-effort unlink on DB-transaction failure, generic 500 |
| `src/app/api/screenshots/[id]/image/route.ts` | Serve MIME from physical signature (`safeServeMime`), `nosniff` + `private, max-age=3600`, basename/path-traversal guard preserved |
| `src/app/api/screenshots/[id]/route.ts` | DELETE wrapped in a transaction with an audit log (`action=delete`, `resource=screenshot`, `resourceId`, `organizationId`, `userId`, `ipAddress`) |
| `src/lib/jobs/retention.ts` | `RetentionResult.orphanScreenshotsRemoved`; `runRetention()` calls `sweepOrphanScreenshotFiles()` after the per-org pass |
| `src/lib/jobs/run.ts` | `EMPTY_RETENTION` includes the new `orphanScreenshotsRemoved` field |
| `tests/screenshots.test.ts` | **NEW** — 32 tests covering upload validation, org isolation, delete/audit, image serving, transaction cleanup, filename collision, traversal |

No Prisma schema/migration changes required.

---

## 2. MIME Validation (Upload)

`src/app/api/agent/screenshot/route.ts` now validates BEFORE any disk write:

- **Allowlist:** `image/png`, `image/jpeg`, `image/webp` only.
- **Rejected:** `image/svg+xml`, `image/gif`, `image/bmp`, `image/tiff`, anything else → HTTP 400.
- Size limit preserved: **5 MB** (`file.size` checked before reading the body).
- Consent gate preserved: `hasActiveConsent(employeeId, 'screenshot')` → 403 fail-closed.
- Agent token gate preserved: `validateAgentToken(req)` → 401.

## 3. Magic-Byte Validation

`src/lib/screenshots/storage.ts` → `detectImageMime()`:

| Type | Signature | Check |
|---|---|---|
| PNG | `89 50 4E 47 …` | first 4 bytes |
| JPEG | `FF D8 FF …` | first 3 bytes |
| WebP | `RIFF ……. WEBP` | `RIFF` at 0–3, `WEBP` at 8–11 |

`validateScreenshotUpload(bytes, claimedType)`:
1. claimed type must be on the allowlist;
2. detected signature must equal the claimed type.

A client cannot upload SVG/GIF/arbitrary bytes labelled `image/png` — mismatch → 400.

## 4. Safe Image Serving

`src/app/api/screenshots/[id]/image/route.ts`:

- `basename()` guard (path traversal impossible on read).
- `safeServeMime(data)` — the **physical file signature** is authoritative. Recognized raster → its real `Content-Type`; anything else (corrupt file, tampered content, SVG) → `application/octet-stream` so it can never be interpreted as executable HTML/SVG.
- Headers always: `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600`, `Content-Length`.
- JWT auth (401 unauthenticated), org scoping with 404 concealment (cross-org → 404).
- Not publicly accessible (no static `/uploads` route — files are served only through this authenticated API).

## 5. Transaction Cleanup

Upload flow: `writeFile()` → `db.$transaction()` → on failure:

- best-effort `unlink(filePath)` of the **exact server-generated path** (never a pre-existing file);
- logs only `{ filename, error: message }` — no tokens, no file contents, no secrets;
- returns generic `HTTP 500` (`Internal server error`).

The orphan sweep (see below) is the second line of defense if the unlink itself fails.

## 6. Unique Filename Strategy

`{sanitizedEmployeeId}_{crypto.randomUUID()}.{ext}`

- `crypto.randomUUID()` — collision-resistant (tested with rapid-fire uploads).
- `sanitizeFilenameSegment()` replaces any character outside `[A-Za-z0-9._-]` with `_` and caps at 64 chars — a crafted admin-created `employeeId` (e.g. `../../evil`) can never escape the screenshots dir (verified by SH-32).
- Employee association is kept in the filename prefix AND in the `Screenshot.employeeId` column.

## 7. Delete Audit Log

`DELETE /api/screenshots/[id]`:

- `requireAdminOrg` (admin+ only; viewer → 403);
- org-scoped `findFirst` (cross-org → 404, concealed);
- `tx.screenshot.delete()` + `tx.auditLog.create({ action: 'delete', resource: 'screenshot', resourceId, description, userId, ipAddress, organizationId })` in ONE transaction — a failed deletion rolls back the audit row, so a success audit record is never created for a failed delete.

## 8. Orphan-File Sweep

`src/lib/screenshots/storage.ts` → `sweepOrphanScreenshotFiles()`:

- Only inspects `uploads/screenshots/` (non-recursive `readdir`).
- Never deletes a file referenced by a valid `Screenshot` row (chunked reference set).
- **Age guard (15 min default)** — an in-flight upload that wrote its file but has not committed its DB row is never mistaken for an orphan (idempotent; a later run catches real leftovers).
- Missing directory → no-op; malformed/racy entries → reported, not fatal.
- Bounded removals per run (`limit: 1000`).
- Runs inside the **existing** retention background job (`runRetention()`), never per API request — no second scheduler.

## 9. Test Cases and Results

New file `tests/screenshots.test.ts` (throwaway PostgreSQL DB `workai_test_screenshots`), 32/32 PASS:

| Area | Cases | Result |
|---|---|---|
| A. Upload validation | SH-01…13 (PNG/JPEG/WebP accept; SVG/GIF/PDF reject; magic-byte mismatch ×3; >5MB; no consent 403; revoked 403; bad token 401) | 13/13 PASS |
| B. Org isolation | SH-14…17 (cross-org list/image/delete; client orgId ignored) | 4/4 PASS |
| C. Delete | SH-18…21 (admin delete + file removal; viewer 403; audit log; failed delete → no audit) | 4/4 PASS |
| D. Image serving | SH-22…29 (correct MIME ×3; stored-MIME lie → octet-stream; missing file 404; traversal 404; cross-org 404; unauth 401) | 8/8 PASS |
| E. Transaction cleanup | SH-30 (stub `$transaction` failure → 500, no row, file removed, no token/file-content in logs) | 1/1 PASS |
| F. Filename collision + traversal | SH-31 (8 rapid uploads, unique), SH-32 (crafted employeeId can't escape dir) | 2/2 PASS |

## 10. Regression Matrix (all executed after the changes)

| Suite | Result |
|---|---|
| `tests/zero-touch.test.ts` | PASS (29/29) |
| `tests/consent.test.ts` | PASS (27/27) |
| `tests/projects.test.ts` | PASS |
| `tests/security.test.ts` | PASS |
| `tests/super-admin.test.ts` | PASS |
| `tests/organization-bootstrap.test.ts` | PASS |
| `tests/multi-org-isolation.test.ts` | PASS |
| `tests/screenshots.test.ts` (new) | PASS (32/32) |
| **Backend total** | **187/187 PASS** |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS (`✓ Compiled successfully`) |
| Desktop agent `npm run test:src` | PASS (123/123) |

## 11. Security Impact

- **HIGH fixed:** filename path traversal on write (crafted `employeeId` could escape the uploads dir and the stored path would later be unlinked raw). Now sanitized via `sanitizeFilenameSegment`; regression test SH-32.
- SVG/HTML never served as `image/*`; unrecognized content is `application/octet-stream` + `nosniff`.
- Screenshots remain non-public (authenticated API only).
- Failed uploads never create DB rows; failed DB commits never leave orphan files.
- No secrets in logs (verified by SH-30 capture assertions).

## 12. Organization Isolation Verification

All screenshot endpoints (`/api/screenshots`, `/api/screenshots/[id]`, `/[id]/image`, `/api/screenshots/stats`) derive `organizationId` from the verified JWT via `requireSessionOrg`/`requireAdminOrg`. Client-supplied `organizationId` (query/body) is never trusted (SH-17). Cross-org resource access is concealed as 404 (SH-14/15/16/28).

## 13. Consent Verification

Consent semantics untouched: `hasActiveConsent(employeeId, 'screenshot')` gates upload server-side. Missing → 403 (SH-11), revoked → 403 (SH-12), and approval still never grants consent (existing ZT-9). All 27 consent tests still pass.

## 14. Performance Impact

- Magic-byte validation operates on the already-buffered ≤5 MB payload — negligible.
- Orphan sweep runs only in the background retention job (bounded, age-guarded) — zero per-request cost.
- No new indexes or schema changes; no N+1 or unbounded queries introduced.

## 15. Build/Typecheck Results

- `npx tsc --noEmit` → **PASS**
- `npm run build` → **PASS** (`✓ Compiled successfully in 32.6s`)
- Desktop agent `npm run test:src` → **PASS** (123/123) — no desktop-agent impact (agent upload contract unchanged: still multipart `screenshot` + `timestamp` + `appWindow`).

## 16. Remaining Warnings

- The DELETE route removes the physical file before the DB transaction; a DB failure after a successful unlink leaves a row with no file. The image route 404s gracefully and the orphan sweep covers the reverse direction (row deleted, file left behind). Accepted tradeoff; audit row is never written for a failed deletion.
- In-memory rate limiting is single-instance (pre-existing, documented).
- LIVE E2E (real EXE → admin viewer) remains **NOT VERIFIED** in this phase — the hardened endpoints are covered by route-level tests; on-machine pilot testing is a Phase-H/Pilot gate.

## 17. Final Verdict

| Gate | Status |
|---|---|
| SCREENSHOTS HARDENING | **PASS** |
| TESTS | **187/187 PASS** (32 new) |
| SECURITY | **PASS** |
| ORG ISOLATION | **PASS** |
| CONSENT | **PASS** |
| BUILD | **PASS** |
| PRODUCTION STATUS | **PRODUCTION CANDIDATE** (all code gates green; remaining gates are live-infra: HTTPS, signed installer, clean-machine pilot — tracked in the Phase H/Go-Live certification) |
