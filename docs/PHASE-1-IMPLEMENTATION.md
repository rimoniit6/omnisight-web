# PHASE 1 IMPLEMENTATION — BATCH IDEMPOTENT ACTIVITY INGESTION

Reference implementation documentation for the Phase 1 dedupe contract.
Evidence/results in `docs/PHASE-1-REPORT.md`; as-built pre-change pipeline in
`docs/PHASE-1-BASELINE.md`.

---

## 1. API

### Old request format (unchanged, still accepted)

```json
{ "activities": [ { "type": "application", "applicationName": "Code.exe", "duration": 60, ... } ] }
```

### New request format (both fields OPTIONAL)

```json
{
  "activities": [ ... ],
  "batchId": "3f8a…-… (RFC-4122 UUID v1–v5)",
  "batchSeq": 1
}
```

### Compatibility

- No `batchId` (old agents) → the route runs **exactly today's path**: no
  receipt is consulted or written; response is the legacy shape
  `{ success, count, message }` (no `deduplicated` key).
- `batchId` present but the org flag off → same legacy path (key ignored).
- `batchId` malformed, or `batchSeq` not a non-negative safe integer → `422`
  before any write. Unknown/extra fields are ignored.
- No endpoint renamed or replaced; no existing response property removed or
  renamed.

### Response behavior

| Scenario | Status | Body |
|---|---|---|
| Legacy (no batchId) / flag off | 200 | `{ success, count, message }` |
| New batch, flag on | 200 | `{ success, count: N, deduplicated: 0, message }` |
| Duplicate batch, flag on | 200 | `{ success, count: 0, deduplicated: <rowCount>, message }` |
| Consent missing / website gate | 403 | unchanged, whole batch atomic |
| Validation failure | 422 | unchanged (all-or-nothing batch) |

`deduplicated` is added only on the dedupe path; existing consumers of
`success`/`count`/`message` are unaffected.

---

## 2. Database

`ActivityBatchReceipt` (additive model, `prisma/schema.prisma`):

| Column | Type | Notes |
|---|---|---|
| `id` | cuid PK | |
| `organizationId` | FK → Organization (Cascade) | own tenant column (unlike Activity) |
| `employeeId` | FK → Employee (Cascade) | |
| `batchId` | string | UUID from the agent |
| `receivedAt` | timestamptz, default now | |
| `rowCount` | int | rows actually ingested for the batch |

- **Unique:** `@@unique([organizationId, employeeId, batchId])` — the concurrency arbiter and the isolation boundary.
- **Indexes:** `(organizationId, receivedAt)` for org retention cleanup, `(employeeId)`, `(receivedAt)`.
- **Migration:** `prisma/migrations/20260903000000_activity_batch_receipts/migration.sql` — pure additive `CREATE TABLE` + unique + indexes + FKs. Verified drift-free (`prisma migrate diff` → "No difference detected") and applies cleanly (`migrate deploy` on scratch DB).
- **Retention:** receipts are purged by the EXISTING org retention sweep
  (`src/lib/jobs/retention.ts`, `runRetentionForOrg`) using the org's
  `activity_retention_days` window, keyed on `receivedAt` and indexed
  `(organizationId, receivedAt)`. 0 days (never purge) is honored like every
  other retention key. No second scheduler was created.

---

## 3. Agent

- **Batch generation:** `QueueUploader` derives ONE `batchId` per upload batch
  via `deriveBatchId(itemIds)` — a deterministic UUID v5 over the sorted UUIDs
  of the queued items in the batch. Never one per row. `batchSeq` is a
  monotonic per-process counter attached to each upload attempt.
- **Retry semantics:** the same queued items always derive the same
  `batchId`, so an HTTP retry (including the 401-recovery retry of the same
  batch) reuses the id automatically — no regeneration on retry.
- **Crash replay:** item ids persist in the queue file at enqueue, so a new
  process (restart) draining the same head items derives the SAME `batchId`.
  Proven by unit test P1-3 (new uploader instance over the same queue file).
- **Collection behavior is unchanged**: `activity-collector.ts`,
  `website-collector.ts`, consent/working-hours gating and slice aggregation
  were not modified. The queue/spool format is untouched (ids already existed).

---

## 4. Transactions

Exact atomicity strategy in `src/app/api/agent/activity/route.ts`:

```text
authenticate (token) → consent gate → body cap → per-item validation (whole
batch 422 on first invalid item) → internal-process filter → website gate +
domain normalization →  [flag ON + batchId]
db.$transaction(
  tx.activityBatchReceipt.create({ organizationId, employeeId, batchId, rowCount })
  tx.activity.createMany(rows)
)
```

Both writes commit or abort together, so neither of these can happen:

- receipt committed without its activity rows (would poison future retries), or
- activity rows committed without a receipt (would let a retry duplicate).

`rowCount` = the rows actually ingested (post existing deterministic
filters), so a receipt always represents successful ingestion of the complete
logical batch under the current all-or-nothing contract.

---

## 5. Concurrency

- The DB unique constraint is the concurrency control (not check-then-insert).
- Two simultaneous identical uploads: one transaction commits; the loser's
  `create` raises P2002 inside its transaction → the whole transaction aborts
  (Postgres: no partial rows) → the handler re-reads the winner's committed
  receipt on a fresh statement → `200 { deduplicated: rowCount }`.
- The client never sees a constraint failure — a valid retry is a success.
- Same `batchId` across orgs/employees is two independent keys (tests G/H).

---

## 6. Feature flag

- No new flag framework: reuses the existing org-scoped `OrganizationSetting`
  registry + `getOrgSetting` resolver (`src/lib/jobs/settings.ts`).
- Key `activity_dedupe` (`ACTIVITY_DEDUPE_SETTING_KEY`), **default OFF**.
  - OFF → legacy ingestion (receipts never consulted/written).
  - ON → receipt-based dedupe for uploads that carry a `batchId`.
- Server-side only: never shipped to agents (the agent config route selects
  keys explicitly). Admin-visible under Settings → Monitoring →
  "Server-Side Monitoring & Intelligence" (a boolean toggle for
  `activity_dedupe`, a text field for `agent_min_version`) and mirrored as a
  read-only note on the Organization page — never rendered as agent runtime
  toggles.
- The flag cannot bypass auth, org isolation, validation, or consent — it
  only wraps the final insert.
- `agent_min_version` (`AGENT_MIN_VERSION_SETTING_KEY`, optional org-scoped
  string, `resolveAgentMinVersion`): **informational capability marker only**.
  Version is obtained from `agentVersion` reported on `/api/agent/discover`
  and stored on `Device.agentVersion`. Nothing compares or enforces it in
  Phase 1 — unset/blank = no floor; older agents are never rejected. Future
  phases may gate additively against this floor.

---

## 7. Rollback

1. Turn the flag OFF (delete/set `OrganizationSetting.activity_dedupe`) →
   ingestion returns to legacy behavior immediately; existing receipts become
   inert and age out via retention.
2. Revert the additive code (route/retention/settings/agent).
3. If migration rollback is required: `DROP TABLE "ActivityBatchReceipt"` is
   safe — the table is new, no existing row references it, and no code path
   depends on it once the flag is off. Existing `Activity` rows are never
   touched by any step.
