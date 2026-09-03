# PHASE 1 REPORT — RELIABLE TELEMETRY

```
Status: GREEN
Date:   2026-09-03
```

---

## 1. Executive Summary

Activity uploads can no longer duplicate Activity rows when a logical batch is
retried, replayed after a crash, or submitted concurrently — while every old
agent, old server, and org with the feature flag off keeps today's exact
behavior. The agent attaches a **deterministic, retry-stable `batchId`** (one
per logical batch, plus a monotonic `batchSeq`) to each upload; the web backend
writes an **`ActivityBatchReceipt` in the same transaction as the rows** when
the org-scoped `activity_dedupe` flag is on, and answers replays with HTTP 200
plus an accurate `deduplicated` count. Dedupe identity is scoped to
`organizationId + employeeId + batchId` — never `batchId` alone. Receipts are
purged by the existing retention sweep on the activity window. No Phase 2+
feature was implemented.

## 2. Baseline

Phase 0 is GREEN (see `docs/PHASE-0-REPORT.md`): web 96/96 suites, 1561
subtests, typecheck/build/lint (0 errors) PASS; agent 625/625 tests, typecheck,
build PASS; no hardcoded credentials; bun-canonical lockfile; `.next/dev/types`
guarded. The pre-change activity pipeline is documented in
`docs/PHASE-1-BASELINE.md` (collector → encrypted persistent queue → at-least-
once uploader → single `createMany`, no idempotency key). Phase 0 behavior was
not modified during Phase 1.

## 3. Architecture Before

Agent: 10 s foreground-window polls → contiguous slices → one `ActivityRecord`
per slice → FIFO encrypted queue (bounded, crash-safe; each item carries a
stable UUID `id`) → `QueueUploader.drain()` uploads ≤100-item head slices as
`{ activities }` → acks only on server response. Server: token/consent/website
gates → all-or-nothing per-item validation → single `db.activity.createMany`.
At-least-once delivery with no idempotency key meant a lost response or crash
between server commit and local ack re-uploaded the same rows (duplicates
possible, data never lost).

## 4. Architecture After

Agent: `attemptUpload` derives `batchId = deriveBatchId(item ids)` (UUID v5
over the batch's sorted queued-item ids — stable for the same items, distinct
for different sets) plus monotonic `batchSeq`, and posts
`{ activities, batchId, batchSeq }`. Server: when `batchId` is present AND the
org's `activity_dedupe` flag is on, the receipt insert and the row insert run
in one `db.$transaction`; a P2002 on the unique key takes the replay path
(fresh read of the committed receipt → 200 + `deduplicated`). Flag off or no
`batchId` → legacy path unchanged.

## 5. Agent Changes

`omnisight-agent`:
- `src/api/activity.ts` — `upload(activities, meta?: ActivityUploadMeta)`;
  attaches `batchId`/`batchSeq` when meta is provided (new optional exported
  `ActivityUploadMeta`).
- `src/services/queue-uploader.ts` — exported `deriveBatchId(itemIds)` and a
  monotonic per-process `batchSeq`; every upload attempt (including
  401-recovery retries) sends meta. F-13 comment updated to the dedupe
  contract.
- `src/types/api.ts` — `ActivityUploadResponse.deduplicated?: number`
  (additive).
- `tests/queue-uploader.test.ts` — fake captures meta; +3 tests (deriveBatchId
  determinism; stable id + monotonic seq across a failed-then-successful
  drain; **crash replay: a NEW uploader instance over the same persisted queue
  derives the same batchId**).
- Collector/slice/queue formats untouched.

## 6. API Changes

`POST /api/agent/activity` (no rename; no field removed). Request fields
`batchId` (optional RFC-4122 UUID v1–v5; malformed → 422) and `batchSeq`
(optional non-negative safe integer; malformed → 422) added. When dedupe
applies, responses add a `deduplicated` key; otherwise the response shape is
identical to before. Full tables in `docs/PHASE-1-IMPLEMENTATION.md` §1.

## 7. Database Changes

New additive model `ActivityBatchReceipt` (`id`, `organizationId`, `employeeId`,
`batchId`, `receivedAt`, `rowCount`) with `@@unique([organizationId,
employeeId, batchId])` and indexes `(organizationId, receivedAt)`,
`(employeeId)`, `(receivedAt)`; back-relations added on `Organization` and
`Employee`. Migration `20260903000000_activity_batch_receipts` (new table +
unique + indexes + FKs only). No existing Activity row was modified or
backfilled; no destructive operations.

## 8. Transaction Strategy

Receipt + rows commit atomically in one interactive `db.$transaction`
(`tx.activityBatchReceipt.create` then `tx.activity.createMany`). This makes
"receipt without rows" and "rows without receipt" both impossible. Validation
happens before the transaction, so an invalid batch never creates a receipt.
`rowCount` = rows actually ingested after the existing deterministic filters
(= successful ingestion of the complete logical batch under the all-or-nothing
contract).

## 9. Concurrency Strategy

The DB unique constraint is the concurrency control. A loser's P2002 aborts
its whole transaction (no partial rows); the handler re-reads the winner's
receipt on a fresh statement and returns success. Tested with two simultaneous
identical uploads (one insert + one dedupe, one receipt, both clients 200) and
documented for retry-after-lost-response, crash replay, and mixed batches.

## 10. Backward Compatibility

- Old agents (no `batchId`): accepted; legacy insertion + legacy response
  shape; duplicate-on-replay semantics unchanged (proven by test P1-5).
- Old servers: ignore the new optional fields (agent keeps working).
- Orgs with the flag off: receipts never written/consulted (test P1-8).
- No forced agent update; Phase 1 works with zero agent upgrades (old payload
  is a first-class citizen).

## 11. Retention

`runRetentionForOrg` now purges receipts older than the org's
`activity_retention_days` window via indexed `(organizationId, receivedAt)`
delete — same sweep, same window, same 0 = never-purge rule as other keys.
Result field `activityBatchReceipts` added (interface + empty results).
Test P1-10: backdated receipt removed, fresh receipt kept.

## 12. Feature Flag

Org-scoped `OrganizationSetting` key `activity_dedupe`
(`ACTIVITY_DEDUPE_SETTING_KEY` in `src/lib/jobs/settings.ts`, resolved by
`resolveActivityDedupeEnabled`), default **OFF**. OFF = legacy ingestion
(available unchanged); ON = receipt dedupe for batches that carry a
`batchId`. Server-side only; never shipped in the agent config payload; cannot
bypass auth/isolation/validation/consent. Optional informational
`agent_min_version` capability marker added with `resolveAgentMinVersion`
(unset = no floor; nothing enforces it yet — future additive gating only).
Both keys are admin-configurable through Settings → Monitoring →
"Server-Side Monitoring & Intelligence" (dedupe = boolean toggle,
agent_min_version = validated text field) and mirrored read-only on the
Organization page.

## 13. Security Verification

- batchId cannot cross orgs/employees: server derives org+employee from the
  authenticated `AgentToken`; unique key is tenant+employee scoped (tests
  P1-6/P1-7).
- Unauthenticated requests are rejected by `validateAgentToken` before any
  receipt logic (no receipt possible without auth).
- Expired sessions/devices follow the existing token lifecycle — untouched.
- `DeviceClaim`/`AgentSession`/consent/working-hours/break enforcement,
  rate limiting, and client-`organizationId`-ignored semantics: unchanged
  (route edits sit strictly after the existing gates).
- Web full gate (incl. security/agent/org-isolation suites): green.

## 14. Privacy Verification

No new collection: receipts carry only id/tenant/employee/batch key/row count/
time — never titles, URLs, domains, or content. Consent gates and
break-mode/working-hours suppression untouched. Receipts age out under the
activity retention window. No raw keys, emails, or webcam content involved.

## 15. Performance / Index Review

- Receipt lookup/conflict: unique-index probe + one `findUnique` by the
  compound key — no table scan.
- Insert path: unchanged `createMany` on existing indexes.
- Retention: indexed org+receivedAt delete in the scheduled per-org sweep.
- Growth estimate (100 employees, ~1 activity/min × 8 h ≈ 48k activity
  rows/day/org): receipts = one per accepted batch (≤100 rows). With a
  realistic drain cadence this is roughly hundreds/day/org — on the order of
  ~45k receipts at 90-day retention vs ~4.3 M activity rows (~1%). Retention
  keeps it bounded; verified `prisma migrate diff` reports no drift.

## 16. Tests Executed

- Web new suite `tests/activity-dedupe.test.ts` (11 tests): basic; duplicate;
  concurrent duplicate (Promise.all); response-loss retry; legacy payload;
  tenant isolation; employee isolation; flag-off semantics; malformed
  batchId/batchSeq → 422; retention purge/keep; cross-repo static contract.
- Agent `tests/queue-uploader.test.ts` (+3): deriveBatchId determinism/shape;
  stable batchId + monotonic batchSeq across failed→successful drains;
  crash-replay across uploader instances.
- Targeted web regressions: website-tracking, website-100, agent-hardening,
  agent-cross-org-attack, consent-summary, super-admin, audio,
  anomaly-hardening, break-hardening, hardening (all exit 0).
- Full gates: web `npm run typecheck`, `npm run lint`, `npm run build`,
  97-suite runner; agent `npm run typecheck`, `npm test`, `npm run build`.

## 17. Exact Test Results

- `tests/activity-dedupe.test.ts`: **11/11 PASS** (exit 0).
- Web full suite (5 sequential chunks, per-file `node --import tsx --test`,
  identical to `scripts/run-tests.mjs`): **97/97 suites, 1573/1573 subtests
  pass, 0 fail** (Phase 0's 96 suites remain green; +1 new dedupe suite).
- Web `npm run typecheck`: PASS (exit 0). Web `npm run lint`: **0 errors**
  (439 warnings, unchanged class). Web `npm run build`: PASS (exit 0).
- Agent `npm test`: **628/628 PASS** (baseline 625 + 3 new). Agent typecheck:
  PASS. Agent build: PASS.

## 18. Files Changed

Web: `prisma/schema.prisma`, `prisma/migrations/20260903000000_activity_batch_receipts/migration.sql`,
`src/app/api/agent/activity/route.ts`, `src/lib/jobs/settings.ts`,
`src/lib/jobs/retention.ts`, `src/lib/jobs/run.ts`, `tests/activity-dedupe.test.ts`.
Agent: `src/api/activity.ts`, `src/services/queue-uploader.ts`,
`src/types/api.ts`, `tests/queue-uploader.test.ts`.
Docs: `docs/PHASE-1-BASELINE.md`, `docs/PHASE-1-IMPLEMENTATION.md`,
`docs/PHASE-1-REPORT.md` (this file).

## 19. Migration

`20260903000000_activity_batch_receipts` — additive `CREATE TABLE`
`ActivityBatchReceipt` + compound unique + 3 indexes + 2 cascading FKs.
Naming follows the repo's `YYYYMMDDHHMMSS_name` convention. Verified:
`prisma validate` PASS; `prisma migrate deploy` on a scratch DB PASS; all
migrations applied; `prisma migrate diff --from-migrations → schema` =
**No difference detected**; existing Activity rows untouched (no backfill, no
alterations).

## 20. Rollback

1. Flag OFF (delete/set `OrganizationSetting.activity_dedupe`) → legacy
   ingestion immediately; receipts inert and aged out by retention.
2. Revert additive code (route, retention, settings, agent files).
3. Migration rollback = `DROP TABLE "ActivityBatchReceipt"` (safe: new table,
   nothing references it once the flag is off; Activity data untouched).
Old agents/servers unaffected at every step.

## 21. Remaining Risks

- Dedupe is opt-in per org (default off). Orgs that don't enable it keep
  documented at-least-once semantics until enabled.
- `batchSeq` is per-process monotonic (resets on agent restart) — sufficient
  for its informational purpose; persistence would be needed for cross-restart
  ordering.
- `agent_min_version` is intentionally inert in Phase 1 (no feature needs it;
  enforcement would break the no-upgrade guarantee).
- Two log lines added per dedupe batch (`batch-received` /
  `batch-duplicate`) — bounded, no content, no per-row logging.

## 22. Final Verdict

> **GREEN** — all Phase 1 acceptance criteria verified with executable
> evidence: agent generates one retry-stable batchId per logical batch with a
> monotonic batchSeq and unchanged collection; old agents remain compatible;
> `POST /api/agent/activity` accepts optional batchId with server-authoritative
> org/employee scoping; `ActivityBatchReceipt` with composite uniqueness and
> appropriate indexes exists; ingestion is transactionally atomic; concurrent
> and replay duplicates produce zero duplicate rows with no error exposed;
> retention cleanup exists and is tested; tenant and employee isolation are
> proven; full web (97/97 suites, 1573 subtests, typecheck, lint 0 errors,
> build) and agent (628/628, typecheck, build) regression gates are green.
