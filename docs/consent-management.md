# Consent Management — Technical Reference

OmniSight consent system: policy versioning, employee consent lifecycle,
enforcement, expiration and data retention. This document is the source of
truth for the behavior implemented by `src/lib/consent.ts`,
`src/app/api/consent/**`, `src/app/api/self/consents/**`,
`src/app/api/agent/consent/**`, `src/app/api/settings/retention/**` and
`src/lib/jobs/**`.

---

## 1. Consent state machine

```
Pending
├── Granted
├── Denied
└── Expired

Granted
├── Revoked
└── Expired

Denied
├── Granted      (re-consent where the policy allows)
├── Revoked
└── Pending      (back to a request state)

Revoked
└── Granted      (re-consent)

Expired
└── Granted      (re-consent)
```

- All transitions go through **one** audited service: `applyConsentTransition`
  in `src/lib/consent.ts`. Every route (admin, self-portal, bulk, agent,
  processor) uses it — there is no bypass.
- Illegal transitions are rejected server-side (`Invalid consent transition`,
  mapped to `409 Conflict`).
- `expired` is reserved for the background processor (and lazy checks); it is
  never settable directly by a user.

### Concurrency (P1 hardening)

The write boundary is an **optimistic conditional update**:

```
UPDATE Consent SET status = <new> ... WHERE id = ? AND status = <expected>
```

If the affected row count is 0 the record changed concurrently — the request
gets `409 Conflict` and **no audit event is written** for the losing
transition. This prevents last-write-wins on a privacy-sensitive state
machine without any application-level mutex.

### Idempotency

Repeating the same transition (same current state → same target, same policy
version) is a successful no-op that adds **no duplicate audit event**:
- `grant → grant` (same policy) → no-op
- `revoke → revoke` → no-op
- `deny → deny` → no-op
- expiration processor run twice → second run finds nothing
- retention processor run twice → second run purges nothing

A `granted → granted` with a **different** policy version is a real re-consent
and binds the new version.

---

## 2. Policy version lifecycle

```
Draft → Published → Archived
        (new version published ⇒ previous published is archived)
```

- `ConsentPolicy` is versioned per (organizationId, consentType) with a
  `@@unique([organizationId, consentType, version])` constraint.
- A published policy cannot be edited in a way that changes its historical
  meaning (the API returns 400 on `edit` of a published policy). Material
  changes require a new version.
- Publishing a new version archives the current published one.

### Re-consent rule

```
Current consent version != current published policy version  ⇒  RE-CONSENT REQUIRED
```

- Draft versions do **not** invalidate existing consent.
- If v2 is published and v3 is published before the employee re-consents,
  the employee must adopt **v3** (the newest published), not v2.
- If the current published policy is archived (or none exists), enforcement
  **fails closed**: no consent-dependent operation proceeds.

---

## 3. Enforcement

```
Operation
  → hasActiveConsent(employeeId, consentType)   [src/lib/consent.ts]
  → allow / 403 (FAIL CLOSED)
```

`hasActiveConsent` requires **all** of:

1. A consent record exists for the employee
2. The consent belongs to the correct employee (resolved server-side)
3. The consent belongs to the correct organization (defense in depth)
4. The consent type matches the operation
5. `status = granted`
6. Not expired (lazy expiration — `expiresAt` in the past ⇒ false)
7. A current **published** policy exists for the type
8. The consent's bound policy id == the current published policy id **and**
   `consentVersion` matches the current published version

Any failure ⇒ deny. `getConsentState` (used by the agent consent endpoint)
reproduces these exact semantics for all 8 consent types with a bounded query
pattern (2 queries) instead of up to ~16 per-poll lookups.

Screenshot uploads check `screenshot` consent; activity uploads check
`activity_tracking`; every agent-facing capture path runs the same check and
fails closed. A denied consent is never interpreted as granted.

---

## 4. Expiration (defense in depth)

Two independent mechanisms — **both** are active:

1. **Lazy expiration** — `hasActiveConsent` treats an expired `expiresAt` as
   not-granted at enforcement time (fail closed immediately, no processor
   needed).
2. **Background expiration processor** (`src/lib/jobs/expire-consents.ts`) —
   finds `status = granted AND expiresAt <= now`, transitions to `expired`,
   records `expiredAt`, and writes exactly one `ConsentLog` event
   (`performedBy = system`). Re-running it finds nothing (idempotent).

---

## 5. Retention

### Categories

| Category | Records | Behavior |
|---|---|---|
| Operational | Screenshots (+physical files), Activities, Reports, AI insights | **Deleted** after the retention window |
| Compliance/audit | `AuditLog`, `ConsentLog` | **Never deleted** — anonymized (PII scrubbed) after the window |

### Configuration

- Persisted org-scoped in `OrganizationSetting` via `PUT /api/settings/retention`
  (admin+ only), validated: non-negative whole days, max 3650, unknown keys → 400,
  invalid values → 422. Every change is audited.
- Resolution order: `OrganizationSetting` → `SystemSetting` → built-in default
  (`src/lib/jobs/settings.ts`). `0` = keep forever (default for compliance).
- Keys: `screenshot_retention_days` (30), `activity_retention_days` (90),
  `report_retention_days` (0), `ai_insight_retention_days` (0),
  `audit_log_retention_days` (0), `consent_log_retention_days` (0).

### Cutoff semantics

A record is eligible when its timestamp is **strictly older than** the cutoff
(`createdAt < now - days`). Records exactly at the cutoff or newer are kept.

### Processor (`src/lib/jobs/retention.ts`)

- Bounded batches (`limit = 500` per category per run).
- **Two-phase file/DB deletion**: the physical screenshot/report artifact is
  unlinked first; the DB row is deleted only when the artifact is confirmed
  gone (or already absent). A failed unlink keeps the row (retryable next
  run) and is reported in `fileErrors` — a purge is never reported while the
  physical artifact remains.
- **Per-org failure isolation**: one organization failing never blocks the
  others; per-org errors surface in `result.errors` so the job is marked
  failed without hiding the data.
- Idempotent: a second run finds nothing already purged/anonymized.

---

## 6. Background jobs

- Entry points: `src/instrumentation.ts` (in-process scheduler, production
  only) and `npm run jobs` (CLI for cron/systemd timers).
- `JOBS_INTERVAL_SECONDS` (default 3600, min 60) controls the cadence.
- Crash-safe leases in `JobRun` (`status`, `startedAt`, `finishedAt`,
  `lastRunAt`, `lastDurationMs`, `lastError`, `lastResult`, `leaseExpiresAt`):
  a live lease blocks a second worker; an expired lease (5 min) allows
  recovery. Affected counts are recorded in `lastResult` (JSON) for
  observability.
- Jobs: `expire_consents`, `retention_cleanup`.

### Server-only boundary

`src/lib/jobs/**` (especially `retention.ts` with `fs/promises` + `path`) is
server-only. It is imported only from `src/instrumentation.ts` (Next.js
server entry) and `src/lib/jobs/cli.ts` (Node CLI) — never from client
components, and never bundled into browser code. Do not import jobs from any
client component or shared client module.

---

## 7. Security model

- **Authentication**: session cookie (admin UI) / agent bearer token (agent
  API). Unauthenticated → 401.
- **RBAC**: viewer → read-only (403 on mutations); manager → consent
  transitions only; admin → policies, bulk ops, retention settings,
  deletion; super_admin → everything.
- **Tenant isolation**: every lookup is org-scoped server-side
  (`organizationId` from the session/token, never trusted from the client).
  Cross-org IDs → 404.
- **IDOR**: self-portal consent updates require the consent to belong to the
  caller's employee (403 otherwise); admin consent updates require the
  consent to belong to the caller's org.
- **Client-supplied ids** (`organizationId`, `employeeId`, `consentId`,
  `policyId`, `consentVersion`) are never trusted — ownership is resolved
  server-side.

## 8. Immutability of audit history

- `ConsentLog.consent` FK is `ON DELETE RESTRICT` (DB-level).
- The API refuses `DELETE /api/consent/[id]` with `409` when the consent owns
  history. Only consents with **zero** logs can be erased.
- GDPR-style erasure of personal data uses the retention processor's
  anonymization path (`performedBy`/`ipAddress`/`description` scrubbed, with
  `anonymizedAt` recorded) — the audit event structure survives.

---

## 9. Deployment requirements

1. **Migrations** — apply the additive migrations (see below); they are
   backward compatible and preserve existing consent records.
2. **Scheduled jobs** — the in-process scheduler starts automatically in
   production (`instrumentation.ts`). For external scheduling, run
   `npm run jobs` from cron (e.g. hourly). Set `JOBS_INTERVAL_SECONDS`.
3. **Storage/file cleanup** — retention deletes physical screenshot/report
   files under `uploads/`. Ensure the process has unlink permission on the
   uploads directory. Deleted-file failures are retried on the next run.
4. **Database backup** — take a backup before deploying migrations
   (e.g. copy `db/custom.db`). The migration files are additive and
   idempotent where possible.
5. **Fresh database** — `prisma migrate deploy` produces the full schema
   (verified end-to-end). The legacy `20260807151739_ok` snapshot was made
   deterministic (idempotent baseline) and the consent tables
   (`ConsentPolicy`, `OrganizationSetting`) plus `JobRun` are created by
   migrations so fresh deploys converge.

   > ⚠️ **`_ok` reconciliation:** `20260807151739_ok` is a full-schema
   > snapshot that historically **never applied successfully** on any
   > database (fresh deploys always failed at it; existing DBs are db-push
   > managed). It was prepended with idempotent `DROP TABLE IF EXISTS`
   > statements so fresh deploys converge. **Never run `migrate deploy`
   > against a database whose `_prisma_migrations` table already records
   > `_ok`** — the checksum will mismatch (P3005) and the drops would destroy
   > data on a partially-migrated DB. Such environments must restore from
   > backup or be reconciled manually.

### Migration history (consent-relevant)

| Migration | Purpose |
|---|---|
| `20260809120000_phase2b_consent_expiry_immutable_logs` | `Consent.expiredAt`; `ConsentLog` FK → RESTRICT |
| `20260809130000_phase3_jobrun_lastresult` | `JobRun.lastResult` (observability); ensures `JobRun` table exists |
| `20260809140000_phase3_consent_tables_reconcile` | Creates `ConsentPolicy` + `OrganizationSetting` on fresh DBs |
