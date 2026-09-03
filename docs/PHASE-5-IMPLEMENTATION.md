# PHASE 5 IMPLEMENTATION — Alerts, Detection Rules & Notification Pipeline

Phase 0–4 are GREEN. This phase adds **admin-configurable server-side alert rules**
on top of the existing `Alert` / `Notification` / `Anomaly` infrastructure. It
introduces **no new collectors** and changes **no agent behavior**.

---

## 1. Architecture Before

OmniSight already had:

- `Alert` (org-scoped, status lifecycle `pending|acknowledged|resolved|archived`,
  severity `info|warning|error|critical`, free-form `source`, JSON `metadata`).
- `Notification` (org-scoped, type/priority/status enums, `entityType/entityId`
  deep links, structured `employeeId/deviceId` linkage).
- `NotificationPreference` (org-level enable/disable per type; absent row = enabled).
- `Anomaly` + a fixed-heuristic anomaly engine (job `anomaly_detection`) that
  creates anomalies via the shared services.
- Shared transactional producers `createOrgAlert` / `createOrgNotification`
  (org preference honored; never bypassed) in `src/lib/notifications/service.ts`.
- Crash-safe `JobRun` lease infra (`claimJob`/`finishJob` in `src/lib/jobs/run.ts`).
- An org-scoped settings registry (`MONITORING_KEYS` in `src/lib/jobs/settings.ts`)
  where Phase 1 (`activity_dedupe`, `agent_min_version`) and Phase 3
  (`server_classification`) server-side flags live.

**Missing:** any user-configurable detection-rule layer. Alerts could only come
from fixed engines. Phase 5 adds the rule layer and wires it into the existing
Alert/Notification/lease infrastructure.

## 2. Architecture After

```
Admin UI (Settings → Monitoring → Alert Rules)        Agent (unchanged)
        │                                                       │
        ▼                                                       ▼
POST/PATCH/DELETE /api/alert-rules            …raw telemetry ingestion unchanged…
        │
        ▼
AlertRule (org-scoped, one STRUCTURED condition)
        │
        ▼
Hourly scheduler / npm run jobs
   runAlertRulesJob   (JobRun lease: alert_rule_evaluation)
        │  per org: master flag ON?  enabled rules?  (else skip — fail closed)
        ▼
evaluateAlertRulesForOrg(orgId, now)
   ├─ employee rules  ← ONE bounded org×org-local-day Activity load, grouped per employee
   └─ device rules    ← org devices (online + employee active + monitoring consent)
        │   pure evaluators (no code exec, no regex)
        ▼
persistFiring (ONE transaction)
   ├─ Alert      (source='alert_rule', type='security', metadata = rule/condition/measured)
   ├─ Notification (type='security', priority derived from severity; org preference honored)
   └─ AlertRuleFiring upsert — unique (ruleId, entityType, entityId) = cooldown boundary
```

### Deliverables

- **`AlertRule`** — org-scoped rule row: one bounded structured condition type,
  JSON params (validated against the registry), severity, cooldown minutes,
  enabled. Max 50 per org.
- **`AlertRuleFiring`** — one state row per `(ruleId, entityType, entityId)`
  recording `lastFiredAt` (+ the alert it produced). The DB unique constraint is
  the concurrency boundary: a replayed or concurrent evaluation that would
  create a second state row for the same entity violates the constraint and is
  treated as a **dedupe, never a failure**. Rows cascade-delete with their rule,
  so nothing grows forever.
- **Condition registry** (`src/lib/alerts/conditions.ts`) — four structured
  conditions, each backed by REAL existing telemetry:

  | Condition | Source | Param |
  |---|---|---|
  | `device_offline` | `Device.lastHeartbeat` older than N min (online, employee-linked, monitoring-consented) | `thresholdMinutes` 5–1440 |
  | `excessive_idle` | Activity `idle` rows today (org-local day), canonical exclusions | `thresholdMinutes` 5–1440 |
  | `excessive_unproductive` | Activity with stored `category='unproductive'` (server-authoritative verdict) today | `thresholdMinutes` 5–1440 |
  | `outside_hours_activity` | Application activity rows today outside the org work window (overnight windows supported) | `thresholdCount` 1–1000 |

  **No arbitrary code, SQL, regex or expressions exist anywhere in the rule
  path.** Params are whole numbers validated at the API boundary and re-validated
  at evaluation time; a corrupt stored row resolves to safe defaults and can
  never crash the job.
- **Pure evaluators** (`src/lib/alerts/evaluate.ts`) — deterministic for fixed
  input. Same conventions as the rest of the product: org-local day boundaries
  come from the caller, internal-agent process rows and break-mirror rows are
  excluded, idle = the canonical `category==='idle' || type==='idle'` predicate.
- **Lease-guarded job** (`src/lib/jobs/alert-rules.ts`) — claims
  `alert_rule_evaluation`, iterates active orgs (continue-on-error per org),
  skips orgs whose `alert_rules_enabled` flag is OFF, evaluates enabled rules,
  persists firings, records a result summary on the JobRun row.
- **Master flag** `alert_rules_enabled` (default **false**) added to the shared
  `MONITORING_KEYS` registry — same safe-rollout semantics as every other
  server-side flag; never shipped to agents (agent config route selects fields).
- **Admin API** — `GET/POST /api/alert-rules`, `PATCH/DELETE
  /api/alert-rules/[id]`; manager+ RBAC; org identity derived from the verified
  session; cross-org ids 404 (existence concealed).
- **Admin UI** — `AlertRulesCard` mounted in Settings → Monitoring under the
  server-side flags, alongside Category Rules. Create/edit/toggle/delete, per-
  condition threshold fields, severity + cooldown inputs, firing history
  (count, last fired) per rule.

## 3. Database Changes

Migration `prisma/migrations/20260903040000_alert_rules/migration.sql`
(additive only — no existing table/row touched):

```sql
CREATE TABLE "AlertRule" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "conditionType" TEXT NOT NULL, "params" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'warning',
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, PRIMARY KEY ("id")
);
CREATE INDEX "AlertRule_organizationId_idx" ON "AlertRule"("organizationId");
CREATE INDEX "AlertRule_organizationId_enabled_idx" ON "AlertRule"("organizationId","enabled");

CREATE TABLE "AlertRuleFiring" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "ruleId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL,
  "lastFiredAt" TIMESTAMP(3) NOT NULL, "alertId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AlertRuleFiring_ruleId_entityType_entityId_key" ON "AlertRuleFiring"("ruleId","entityType","entityId");
CREATE INDEX "AlertRuleFiring_organizationId_idx" ON "AlertRuleFiring"("organizationId");
CREATE INDEX "AlertRuleFiring_ruleId_idx" ON "AlertRuleFiring"("ruleId");

-- FKs: Organization (CASCADE) on both; AlertRule (CASCADE) from AlertRuleFiring.
```

- Rule rows live only while the org exists (org delete cascades rules + firings).
- Firing rows exist only for rules that have fired; deleting a rule cascades
  them — no unbounded growth, no stale cooldown state.
- Verified on a scratch DB: `prisma migrate deploy` clean; `prisma migrate diff`
  (migrated scratch DB → schema) → **No difference detected.** Dev DB reconciled
  (`migrate status` up to date). `Activity` rows untouched.

## 4. Transaction Strategy

One interactive Prisma transaction per firing:

1. Read the existing `AlertRuleFiring` row for `(rule, entity)`.
2. Cooldown check **inside the transaction**: if `lastFiredAt` is within
   `cooldownMinutes`, return `cooldown` (no writes).
3. Create the `Alert` (source `alert_rule`, `metadata` carries ruleId,
   conditionType, entityType, measured, firedAt).
4. Create the `Notification` through `createOrgNotification` (org preference
   honored — disabled `security` type → skipped, never bypassed).
5. Upsert the `AlertRuleFiring` state row.

A crash can never leave an alert without its state row (alert creation and the
state write commit together), so a replay after a crash cannot double-fire.
If two evaluators race, the second blocks on the unique `(rule, entity)` index
until the first commits, then hits `P2002`, which the caller maps to a
suppressed duplicate (`cooldown`) — never a failed upload or a thrown error.

## 5. Concurrency & Retry Semantics

- **Replay within cooldown** (lost response / crash replay): re-evaluation
  reads the committed `lastFiredAt`, cooldown has not elapsed → suppressed,
  counted in `alertsSuppressedByCooldown`. Exactly one Alert.
- **Concurrent duplicate evaluations**: unique constraint arbitration — exactly
  one Alert + one firing row; the loser reports `cooldown` (verified by
  `Promise.all` in the test suite).
- **Cooldown expiry**: after `cooldownMinutes`, the same entity may fire again;
  the state row is updated in place (verified with a +61-minute replay).
- **Job concurrency**: the `alert_rule_evaluation` JobRun lease makes two
  overlapping scheduler invocations a safe no-op (`claimJob` atomic UPDATE).

## 6. Bounded Evaluation & Performance

- One org-local-day Activity load per org (indexed `employeeId, timestamp`
  path via `employee: { organizationId }`), grouped per employee in memory —
  no per-rule N+1.
- Device rules: one org-scoped Device load; consent/status filters in SQL.
- Rule table capped at **50 per org**; params validated/clamped per condition.
- A condition can only fire for entities that actually have telemetry today;
  employees with zero rows are never even read.
- Cost accounting on the JobRun `lastResult` (orgsScanned/skipped/failed,
  rulesEvaluated, candidates, alertsCreated, alertsSuppressedByCooldown).

## 7. Security

- Tenant isolation: rules + firings org-scoped; evaluation queries include the
  org in every predicate; cross-org rule ids 404 on the admin API; org B's
  telemetry can never fire org A's rules (test AR-11/AR-21).
- RBAC: manager+ for read AND mutation (rule config affects alerting the same
  way category rules affect reporting); anon 401, viewer 403.
- Fail-closed master flag: default OFF — rules are never evaluated until an
  admin explicitly enables them (test AR-6).
- No client-supplied organization identity anywhere: org derives from the
  verified session; rule payloads carry no org field.
- Structured conditions only — no code execution, no regex, no SQL fragments.
- Device offline requires an active employee with granted monitoring consent —
  a consent-revoked device going silent is expected, not an alert (mirrors the
  device-integrity criteria).
- Notification preference is never bypassed: an org that disabled the
  `security` type receives the Alert row (observable record) but no
  Notification (test AR-13).

## 8. Privacy

- No new telemetry, no new collectors, no agent changes.
- Alerts reference only existing telemetry (activity durations/categories,
  heartbeat staleness) plus safe identifiers — never screenshot contents,
  keystrokes, message content or raw URLs.
- Raw telemetry is never modified or deleted by the alert engine (verified in
  AR-7: activity count unchanged after firing).

## 9. Feature Flag

`alert_rules_enabled` (OrganizationSetting, default **false**) in the shared
`MONITORING_KEYS` registry + `resolveAlertRulesEnabled()`. The evaluation job
refuses to run for an org unless the stored value is `'true'`; a missing or
corrupt value resolves to the safe default. The flag is server-side only —
the agent config route never exposes it.

## 10. Rollback

1. **Disable the flag** for the org (`alert_rules_enabled = false`) → rules are
   never evaluated; existing Alerts/Notifications remain (they are ordinary
   Alert/Notification rows, deletable via the normal UI/retention).
2. **Revert code**: remove the job from `run.ts`, delete the API routes + card,
   revert `settings.ts`/`schema.prisma` additions.
3. **Migration**: additive-only. Safe to leave in place (two empty tables) or
   roll back with `prisma migrate resolve` + dropping the two tables after
   confirming no code path references them. No existing data is touched in
   either direction; alerts/notifications created by rules are plain rows that
   follow normal alert/notification retention.

## 11. API Contract (new endpoints only — nothing existing changed)

- `GET /api/alert-rules` → `{ data: AlertRule[] }` with `params` decoded to an
  object plus `firingCount`, `lastFiredAt`, `recentFirings[]` (bounded 5).
- `POST /api/alert-rules` → 201 `{ data }`; 401/403 unauthenticated/viewer;
  422 invalid (name, conditionType, per-condition params incl. unknown keys,
  severity, cooldown, name length); 422 at the 50-rule org cap.
- `PATCH /api/alert-rules/[id]` → 200 `{ data }`; 404 for cross-org/missing.
- `DELETE /api/alert-rules/[id]` → 200 `{ success: true }`; cascades firing rows.
- Notification/Alert types reused (`security`) — **no new notification type**,
  so the `ACTIVE_NOTIFICATION_TYPES` registry (N-6 pinned) is untouched.
