# PHASE 4 — FINAL CERTIFICATION REPORT

**Scope:** Operational data plane — screenshots, object storage, retention/reconciliation,
live activity/realtime, audio/stream, activity & location data planes, lifecycle
enforcement, exports, AI data plane.
**Repositories:** `omnisight-web`, `omnisight-agent`.
**Date:** 2026-09-04.

---

## A. Executive Summary

```
PHASE 4 STATUS: PASS
```

All certification gates below pass against actual source, actual endpoint/storage
behavior, actual builds, actual packaged-artifact inspection and actual security
tests. Gate 11 (Performance) is certified as **PASS with DOCUMENTED LIMITATION**
(bounded operational design verified; load testing infrastructure is not available —
exactly what was and was not measured is stated in Q).

### Final security checklist (all verified)
```
[✓] Agent has no DB access / DB credentials / AI credentials / storage master credentials
[✓] Server remains deployment-mode authority; Agent organizationId cannot escalate
[✓] Screenshot upload is server-authorized (token→consent→org policy→interval→payload)
[✓] screenshotInterval=0 blocks upload (Phase 4 §11 — gap closed)
[✓] screenshot_enabled blocks upload (server policy wins)
[✓] Screenshot storage is tenant-safe (org-prefixed keys, DB-derived, never client paths)
[✓] Screenshot viewer is tenant-safe (org-scoped row lookup, traversal-safe, nosniff)
[✓] Screenshot retention removes DB metadata AND storage object (no orphan, no ghost row)
[✓] Activity ingestion tenant-safe + idempotent (batch receipts, dedupe suites)
[✓] Offline queue bounded (agent suites)
[✓] Location tenant-safe (policy + consent + closed schema)
[✓] Live activity uses real data (DB poll + pg_notify wake; org-room broadcast)
[✓] Realtime subscriptions tenant-safe (JWT + org rooms; suite group 80/80)
[✓] Audio stream authorized at the boundary (new /api/audio/[id]/stream — was missing)
[✓] Employee offboarding / device revocation / org suspension enforced (P4A-33/34/35)
[✓] Exports tenant-safe + mode-aware (Phase 2 privacy suites)
[✓] AI credentials tenant-safe, encrypted, server-only (never Agent/browser/API/logs)
[✓] Super Admin privacy matrix enforced at API level (CUSTOMER_DB/PRIVATE → control-plane only)
[✓] No fake/random production analytics (Math.random: zero runtime occurrences)
[✓] No unbounded operational queries (bounded/paginated; retention batches capped)
[✓] Payloads validated; secrets redacted; artifact clean; no tests weakened
[✓] Typecheck / lint / build pass; required regression passes
```

---

## B. Scope

Operational-data pipeline certification: Agent → authenticated API → server-authoritative
tenant resolution → tenant-scoped DB + object storage → retention/lifecycle → realtime
admin visibility. Non-goals respected: no unrelated product/UI redesign; SaaS architecture,
deployment modes and one-Agent model preserved.

## C. Architecture

```
Agent → OmniSight API (only) → tenant resolution (token→employee→org)
  → screenshots/activity/location ingestion (server-authoritative gates)
  → DB metadata + object storage (tenant-prefixed keys, driver abstraction)
  → retention_cleanup (two-phase purge + orphan sweep + reconciliation)
  → pg_notify wake → socket.io org-room broadcast → Admin console
```

## D. Implementation Summary

Forensic audit (matrix in working notes) confirmed the Phase 4 surface was largely
present in the tree and secure: object-storage drivers (local/Supabase), retention
engine (`src/lib/jobs/retention.ts`), screenshot viewer routes, socket.io realtime
daemon (`mini-services/live-updates`), audio routes, Phase 2 access-matrix/control-plane
guards. The audit found three real defects, all fixed in this phase:

1. **Screenshot `screenshotInterval=0` parity gap (§11)** — the upload endpoint now
   independently re-checks the effective interval and rejects with
   `SCREENSHOT_INTERVAL_DISABLED` (403). Previously only agent-side config suppressed
   capture; a direct upload could still be accepted. Verified P4A-03.
2. **Missing `/api/audio/[id]/stream`** — the download endpoint referenced a local-storage
   stream endpoint that did not exist (dead path under local storage). Implemented an
   authenticated, org-scoped stream route that re-derives ownership from the session +
   DB metadata and reads the object through the storage driver (404 concealment for
   cross-org/guessed ids, role gate admin+, nosniff). Verified P4A-21/22.
3. **Stale realtime wake test** — `realtime-wakeup.test.ts` RW-2 inserted `Activity`
   without the mandatory direct tenant-ownership column (`organizationId` NOT NULL, Phase 1
   Step 10), so the insert failed silently and `pg_notify` never fired. Test corrected to
   the real tenant-owned insert — it now verifies the actual DB→notify path (82 ms).

## E. Files Changed

### omnisight-web
| File | Change | Reason | Security impact | Migration |
| --- | --- | --- | --- | --- |
| `src/app/api/agent/screenshot/route.ts` | org-policy gate extended with effective-interval check (`SCREENSHOT_INTERVAL_DISABLED`) | Close §11 parity gap: interval ≤ 0 must block ingestion, not just agent config | Prevents uploads while capture disabled | none |
| `src/app/api/audio/[id]/stream/route.ts` (NEW) | Tenant-scoped, role-gated audio streaming route | Local-storage download referenced a nonexistent endpoint | Stream boundary authorized from session + DB metadata; no public object URL | none |
| `tests/agent-phase4-data-plane.test.ts` (NEW) | 7 P4A attack tests | Certify the data-plane boundaries | Evidence for gates | none |
| `tests/realtime-wakeup.test.ts` | RW-2 insert adds mandatory `organizationId` | Test was broken by Phase 1 tenant-ownership column; real notify path now verified | no | none |

### omnisight-agent
No changes in Phase 4 (agent-side requirements — bounded queue, config-driven collector
gating, no DB/AI credentials — were certified in Phase 3 and re-verified this phase).

## F. Database Changes

```
NO DATABASE SCHEMA CHANGES IN PHASE 4
```
No migration added; existing operational indexes (organizationId/employeeId/deviceId/
capturedAt/createdAt/status/receipt-batchId) reviewed against query patterns and kept.

## G. API Changes

New:
```
GET /api/audio/[id]/stream
Auth: session JWT + org-bound ADMIN role (requireAdminOrg)
Tenant source: session → organization; row lookup WHERE id AND organizationId
Response: audio bytes (Content-Type from stored allowlisted MIME; nosniff)
Errors: 401 unauthenticated · 403 wrong role / org-less super_admin /
        suspended org · 404 unknown id / cross-org / missing object
```
Audited (unchanged, verified by suites): compat, login, discover, authenticate, config,
heartbeat, activity, screenshot, location, commands, screenshots list/image/thumbnail,
audio upload/download/status/retry, live-monitor event-stats, exports, AI settings.

## H. Storage Architecture

- Provider abstraction (`src/lib/storage`): local filesystem (self-hosted/dev/test) and
  Supabase Storage. Keys: `screenshots/<orgId>/<uuid>.<ext>`, `audio/<orgId>/<uuid>.<ext>`,
  derived server-side from DB metadata (basename) — never from client input.
- Retrieval model: user → OmniSight authorization → DB-metadata ownership → authorized
  object read. Signed URLs (Supabase) are short-TTL (1 h), issued only after authorization;
  the new stream route serves local storage through the same authorization chain. Object
  storage is never itself the tenant-authorization layer.
- Cleanup: `retention_cleanup` deletes physical objects BEFORE DB rows (two-phase, keeps
  row on unlink failure → retryable), bounded batches per org, plus an age-guarded global
  orphan-file sweep (reconciliation: object without DB row) and fileErrors accounting
  (DB-without-object handled by not deleting the row on failure). Verified P4A-07 (both
  layers removed; no orphan).

## I. Screenshot Lifecycle

Agent capture → consent/capability gate → API auth (token→employee→org) → server policy
(screenshot_enabled AND effective interval > 0) → payload/file validation (magic bytes,
5 MB cap, sanitized names) → tenant-scoped object storage + metadata → admin viewer
(org-scoped, paginated list; thumbnail then full image; nosniff, magic-byte MIME) →
retention purge (metadata + object). Frequency and retention remain independent settings.

## J. Activity Data Plane

Tenant ownership on every Activity row (organizationId direct column), allowlisted
types/categories, bounded payloads, future-timestamp rejection, website/domain
normalization + `WEBSITE_TRACKING_DISABLED` server gate, batch receipt idempotency
(unique organization+employee+batchId), server-authoritative classification opt-in.
Existing suites: activity-dedupe, activities-hardening, admin-prod-monitoring,
agent-cross-org, Phase 3 activity tests — all green.

## K. Location Data Plane

Agent geolocation → auth → consent → org `location_tracking` gate → closed schema
(coordinates/accuracy/timestamp only) → movement-threshold storage. Cross-org/spoofed
keys rejected. Location history reads org-scoped; retention window governed by the
registry defaults. Verified P3C-08 and suite group.

## L. Live Activity / Realtime

Transport: socket.io daemon (`mini-services/live-updates`, port 3010) — JWT (handshake or
httpOnly cookie) required per connection; each socket joins `org:<organizationId>`;
broadcasts are room-scoped (no cross-org channel). Data is real: daemon polls the DB on a
durable cursor and is woken by `pg_notify` triggers on broadcast tables (debounced); it
never writes and never emits fabricated events. Heartbeat/online state derives from
server records. Realtime suite group (event stream, event stats, ticker, cursors,
presence + hardening, pg_notify wake): **80/80 PASS** after fixing the stale RW-2 insert.

## M. Audio / Stream Security

Audio recording rows org-scoped; download/status/retry/stream all derive organization
from the verified session (never URL ids). New stream route: admin role gate, org-scoped
row lookup, cross-org/guessed-id → 404 concealment, org-less super_admin → 403,
suspended org → 403, stored MIME served with nosniff. Transcription callback is
internal. Verified P4A-21/22; retention purges completed recordings + files past window.

## N. Employee / Device / Organization Lifecycle

Offboarded employee (status inactive) → validateAgentToken fails (401) on heartbeat/
screenshot/activity/location/commands; reactivation resumes. Revoked/inactive device →
401 across all ops. Suspended org → agent ops 401 AND org-scoped admin operational reads
403; restore resumes. Web sessions/memberships revoked independently (Phase 2 model).
Verified P4A-33/34/35 (each with resume-after-restore assertion).

## O. AI Data Plane

Organization-owned AI provider config lives in `OrganizationSettings` (aiApiKey encrypted
at rest via the existing AES-GCM secret layer); read/write only through org-scoped,
admin-gated settings endpoints; keys never returned by any API, never reach the Agent
artifact or browser, never logged. Org B cannot read Org A's key/config (Phase 2 privacy
suites). AI insights/screenshot-analysis are org-scoped rows with retention. Usage
tracking table: NOT implemented — per §40 this phase records no fake cost/billing; the
boundary is documented (no per-request cost accounting exists; product decision pending).

## P. Security Test Results

| Attack (P4A) | Result | Evidence |
| --- | --- | --- |
| P4A-01 cross-org screenshot upload | PASS | spoofed org/employee fields ignored; row under token tenant |
| P4A-02 upload after org disable | PASS | 403 `SCREENSHOT_TRACKING_DISABLED` |
| P4A-03 upload with interval=0 | PASS | 403 `SCREENSHOT_INTERVAL_DISABLED` |
| P4A-04 object-path traversal | PASS | traversal/garbage ids → 404 |
| P4A-06 viewer cross-org access | PASS | cross-org 404; org-less super_admin 403; own 200 |
| P4A-07 expired screenshot + retention | PASS | metadata AND object purged; viewer 404 |
| P4A-21/22 audio stream cross-org/guessed id | PASS | cross-org/guess 404; viewer-role 403 |
| P4A-33/34/35 offboarding/revocation/suspension | PASS | instant 401/403; resumes after restore |
| Cross-org activity/location/dedupe (P4A-08…15 equivalents) | PASS | Phase 3 suites + activity-dedupe + P3C-06/08 |
| Realtime (P4A-16…20 equivalents) | PASS | presence/event-stream suites, org rooms |
| AI isolation (P4A-26…29 equivalents) | PASS | org-scoped AI settings + Phase 2 privacy suites |
| Export privacy (P4A-30/31/32 equivalents) | PASS | super-admin-privacy + control-plane suites |

## Q. Performance Results

Measured (real, functional-scale): screenshot upload round-trip, retention purge of
metadata+object (single org, batched), viewer pagination and org-scoped queries, realtime
event propagation (pg_notify delivery 82 ms in-suite), list pagination bounded to 100.
DOCUMENTED LIMITATION: no load-testing infrastructure is available in this environment, so
100/500-employee throughput, deletion throughput and export memory profiles were NOT
measured. Operational design is bounded end-to-end (capped batch sizes, paginated list
queries, indexed org/employee/device/time predicates, no full-table scans in hot paths),
but scale numbers must not be claimed.

## R. Exact Test Results

```
WEB (omnisight-web)
Typecheck:      PASS — 0 errors
Lint:           PASS — 0 errors, 443 warnings (pre-existing baseline; no new error class)
Build:          PASS (next build)
Phase 4 suite (agent-phase4-data-plane):           7/7 PASS
Phase 3 + screenshots group
  (phase4, phase3-contract, phase3-attack, compat,
   cross-org-attack, screenshots):                 77/77 PASS
Security suites (deployment-mode-switch, super-admin-privacy,
  control-plane-lifecycle, multi-org-isolation, activities-hardening,
  rbac-hardening, create-user-flow-integration, admin-prod-monitoring):  162/162 PASS
Agent regression suites (agent-discover, agent-existing-device-security,
  agent-hardening, agent-active-device-backend, agent-auth-login,
  agent-process-exclusion, activity-dedupe, claim-cancel):              141/141 PASS
Realtime group (live-event-stream, live-monitor-event-stats, live-ticker,
  live-updates-cursor, live-updates-durable-cursor, presence,
  presence-hardening, realtime-wakeup):                                  80/80 PASS
Total executed this phase: 460 test executions across 30 suites — 0 failures.
```

```
AGENT (omnisight-agent)
Typecheck:  PASS — 0 errors (Phase 3 state; no Phase 4 code change)
Tests:      641/641 PASS (re-run this phase)
Package:    PASS (package:dir artifact current; pack-gate verified)
Artifact scan: PASS — 0 real credential/database-runtime leaks
```

## S. Build Results

Web `npm run build` PASS (includes the new dynamic route). Agent production package
(`package:dir` + native host + pack-gate 17/17 exports) verified in Phase 3 and unchanged
in Phase 4; `npm test` re-run 641/641.

## T. Artifact Security Scan

Extracted `out/win-unpacked/resources/app.asar` and scanned for DATABASE_URL,
postgres(ql)://, mysql://, PrismaClient, @prisma/client, supabase, PGHOST/PGUSER/PGPASSWORD,
private keys, AWS_SECRET_ACCESS_KEY, aiApiKey/OPENAI/ANTHROPIC keys. Result: **0 real
leaks**. One false positive documented: `electron-updater/…/publishOptions.js.map` contains
the literal option-key name `AWS_SECRET_ACCESS_KEY` (a dependency source map of publish
config option names — no value, no credential).

## U. Remaining Risks

| Severity | Item |
| --- | --- |
| BLOCKER | None |
| HIGH | None |
| MEDIUM | None |
| LOW | 1. §55 load-testing not measurable here (documented limitation — see Q). 2. The complete historical 132-file web suite was not executed end-to-end; every suite relevant to Phase 1–4 operational/security surfaces was run (30 suites, 460 executions, 0 failures) — run the full set in CI before release. 3. AI usage/cost tracking not implemented (no invented billing; product decision pending). 4. Supabase signed audio URLs (1 h TTL, issued post-authorization) are standard, but local-storage deployments now have the streaming path verified. |

## V. Migration

```
NO DATABASE SCHEMA CHANGES IN PHASE 4
```
No migration steps, backfills, or deployment ordering requirements beyond deploying the
updated web code (two route changes + one new route) and re-running the retention job
schedule unchanged.

## W. Rollback

- Web: revert `screenshot/route.ts` (removes the interval gate only), delete
  `audio/[id]/stream/route.ts`, and revert the two test files. No DB impact. The stream
  route is additive — removing it restores the pre-Phase-4 state (local-storage download
  returning a dead path), so revert of GAP-B is the earlier behavior, not a security hole.
- Agent: no changes in Phase 4 — nothing to roll back.

## X. Phase 5 Readiness

```
READY FOR PHASE 5
```

All mandatory gates pass (Gate 11 as PASS with DOCUMENTED LIMITATION). The LOW items in U
are tracking notes, not blockers.
