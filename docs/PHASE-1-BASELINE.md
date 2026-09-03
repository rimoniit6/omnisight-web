# PHASE 1 BASELINE — ACTIVITY PIPELINE (AS-BUILT, PRE-DEDUPE)

Captured 2026-09-03 immediately before Phase 1 implementation, from source
inspection of `omnisight-agent` and `omnisight-web` (no behavior changed to
write this document). Companion to `docs/V1-IMPLEMENTATION-BASELINE.md`.

---

## 1. Slice creation (agent)

`omnisight-agent/src/collectors/activity-collector.ts`

- Polls the foreground window on a controlled interval (default **10 s**,
  `pollMs`), tracking the current app key (`app + title`).
- Produces **aggregated activity records** — one `ActivityRecord` per
  contiguous foreground-window slice (not one per poll). A slice is flushed
  when the window changes or on the configured cadence; sub-interval slices
  under a minimum contiguous duration are aggregated with neighbors.
- Fully gated agent-side by the `activity_tracking` consent snapshot
  (`consent-gate.ts`) and working-hours/config gates; a revoked/stale consent
  stops the collector immediately (the server re-enforces on upload).
- The website pipeline (`website-collector.ts` / browser-extension native
  messaging host, plus the native BEST_EFFORT monitor) feeds the SAME queue
  with `type: 'website'` records (domain-only).

## 2. Queuing (agent)

`omnisight-agent/src/storage/activity-queue.ts`

- `ActivityQueue.enqueue(record)` assigns each queued item a **stable UUID
  `id`** (generated once at enqueue), an ISO `enqueuedAt`, an `attempts`
  counter, and the record itself. Items are appended FIFO.
- The whole queue is **persistent and bounded**: an AES-256-GCM-encrypted
  JSONL file (plaintext only in test/headless mode), bounded by
  `maxBytes` (32 MB default; oldest entries trimmed first), crash-safe via
  atomic tmp+rename rewrites, and fail-closed (an undecryptable/tampered file
  is quarantined, never parsed, never silently lost).

## 3. Offline persistence / spool semantics

- Queued records survive agent restarts (the file is the spool). Records stay
  in the file until the server confirms an upload (`ack` deletes them), or a
  permanent 4xx drop path removes them; `markFailed` increments `attempts`
  and keeps them.

## 4. Batch construction (agent)

`omnisight-agent/src/services/queue-uploader.ts`

- `QueueUploader.drain()` loops: `queue.peekBatch(maxBatch)` (default **100**,
  matching the server cap) → upload → ack on success. A drain therefore
  produces one HTTP request per ≤100-item head slice of the queue.
- There was **no batch identity** in the payload: each upload was
  `{ activities: [...] }` (see `src/api/activity.ts`).

## 5. Retry behavior (agent)

- Failed batches are marked (`attempts + 1`) and retained; a 4xx other than
  429 aborts until the next scheduled drain (it cannot succeed by retrying);
  5xx/network are retried by later scheduled drains with backoff.
- **401 is never a permanent failure** (F-01): the batch is retained, auth
  recovery runs (latched, shared with heartbeat), and the SAME batch is
  retried with the fresh token. A repeated 401 stops the drain for the next
  tick — no infinite loop, no data loss.

## 6. Lost HTTP response (agent)

- Delivery is **at-least-once** (documented F-13): the batch is acked only
  after the server responds. If the response is lost after a successful
  server commit, the next drain re-uploads the same head items → duplicate
  Activity rows were possible. Data was never lost, but duplicates could
  occur.

## 7. Agent crash (agent)

- A crash between the server write and the local ack leaves the items at the
  head of the persistent queue (their enqueue-time UUID ids intact); on
  restart the next drain re-uploads them → same duplicate risk as §6.

## 8. Server insertion (web)

`omnisight-web/src/app/api/agent/activity/route.ts` (pre-Phase-1)

- Validates the agent token → derives employee/device; enforces consent
  (`activity_tracking`, fail-closed), a 1 MB body cap, ≤100 items, per-item
  allowlist validation (**all-or-nothing**: first invalid item rejects the
  whole batch 422 — no partial writes), internal-process exclusion, and the
  org `website_tracking` gate for mixed website batches (whole batch atomic).
- Then a single `db.activity.createMany(...)` insert (no transaction wrapper;
  a single statement is atomic by itself, but there was no idempotency key).

## 9. Transaction boundaries (web, pre-Phase-1)

- Validation happened before any write; the insert was one `createMany`
  (single-statement atomicity). There was no cross-table transaction because
  no receipt/idempotency record existed. Retries after a lost response or
  crash could duplicate rows; nothing detected or recorded the replay.

## 10. Organization and employee identity (web, pre-Phase-1)

- Never taken from the client. `validateAgentToken(req)` resolves the
  `AgentToken` → bound `Device` + `Employee`; the route uses
  `authResult.employee.id` and `authResult.employee.organizationId`
  (server-authoritative). `DeviceClaim`/`AgentSession`/consent/working-hours
  flows were untouched and remain so.
- Client-supplied `organizationId`/`employeeId` in the body are ignored by
  the activity route.

---

## Known consequence (the Phase 1 problem)

At-least-once delivery + no idempotency key = **duplicate Activity rows on
retry/crash-replay** (documented, accepted pre-Phase-1; F-13). Phase 1 adds a
tenant-scoped batch receipt so a replayed batch behaves as one logical
ingestion — see `docs/PHASE-1-IMPLEMENTATION.md` and
`docs/PHASE-1-REPORT.md`.
