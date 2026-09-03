# PHASE 5 BASELINE — Alerts, Detection Rules & Notification Pipeline

Status: audit complete (pre-implementation)
Date: 2026-09-03

## 1. Scope of this document

Forensic baseline of the EXISTING alert/notification/anomaly architecture in
`omnisight-web` before Phase 5 changes anything. Phase 5 adds a
**user-configurable, org-scoped server-side alert-rule layer** (conditions →
cooldown/dedupe → Alert + Notification records → admin config UI) on top of
this infrastructure. Nothing in this baseline was modified to write it.

## 2. Data models (prisma/schema.prisma)

### Alert
- Fields: id, title, description, type (open string:
  device_offline/policy_violation/high_inactivity/security/license/system…),
  severity (`info|warning|error|critical`, default warning), status
  (`pending|acknowledged|resolved|archived`, default pending), source
  (nullable), metadata (JSON string), employeeId?, deviceId?,
  organizationId (FK, Cascade), createdAt/updatedAt.
- Indexes: (org), (status), (createdAt), (org, createdAt),
  (org, status, createdAt), (employeeId), (deviceId).
- Producers today: agent tamper route, agent anomaly route, manual admin POST
  (/api/alerts), auto anomaly detection (high/critical only).

### Notification
- Fields: id, title, message, type (registry: security, anomaly_detected,
  policy_violation, device_offline, new_employee, high_inactivity,
  license_expiration, ai_recommendation, consent_update, project_deadline,
  overtime_alert, system), priority (`low|medium|high|critical`), status
  (`unread|read|archived`), actionUrl, entityType/entityId, readAt,
  employeeId?/deviceId?/organizationId, timestamps.
- Indexes: (org), (status), (org,status,createdAt), (employeeId),
  (deviceId), (createdAt).
- Org-broadcast (not per-recipient).

### NotificationPreference
- Org-level `enabled` per notificationType; absent row = enabled (default).
- @@unique([organizationId, notificationType]).

### Anomaly (auto-detected, NOT the same as a user rule)
- type registry (productivity_drop, excessive_idle, unusual_login [legacy key
  meaning off-hours activity], rapid_app_switch, overtime_work, policy_breach,
  unusual_screenshot, low_activity_spike, device_missing), severity
  (`low|medium|high|critical`), status
  (`detected|investigating|resolved|false_positive`), score/confidence,
  metadata, aiAnalysis, dedupeKey UNIQUE (nullable; deterministic
  `org:employee:type:utcDay`).
- Produced by the FIXED rule engine in src/lib/anomalies (not admin
  configurable) + agent anomaly reports + device-integrity job.

### Relevant relational rows for rule conditions
- Device: status (`online|offline|inactive|maintenance|retired`),
  lastHeartbeat, employeeId?, organizationId; agentVersion.
- Activity: type/title/applicationName/category/duration/timestamp +
  employeeId/deviceId (category carries the Phase 3 server-authoritative
  verdict: productive/neutral/unproductive/idle).
- UsbEvent: eventType (usb_insert/usb_remove/usb_blocked), employeeId?,
  deviceId?, dedupeKey UNIQUE (org+device+serial+type+5-min bucket).
- PolicyViolation: policyId, executableName, action ('blocked'), severity,
  dedupeKey UNIQUE (org+device+policy+executable+5-min bucket), occurredAt.
- BreakSession: startedAt/endedAt/employeeId (breaks suppress collection —
  never Activity durations).

## 3. Services / constants (src/lib/notifications)

- constants.ts — canonical registries + guards: NOTIFICATION_TYPES,
  NOTIFICATION_PRIORITIES, NOTIFICATION_STATUSES, ALERT_SEVERITIES
  (`info|warning|error|critical`), ALERT_STATUSES, ACTIVE_NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_REGISTRY (label/icon/color/active), is*() validators,
  priorityFromSeverity().
- validation.ts — length/URL/entity/metadata bounds (title ≤ 200, message ≤
  2000, description ≤ 2000, actionUrl ≤ 500, entityId ≤ 200, metadata ≤ 8 KB,
  batch ≤ 200).
- service.ts — createOrgNotification(tx, input) (validates, honors org
  NotificationPreference, returns null when the org disabled the type),
  createOrgAlert(tx, input) (validates severity/status). Both
  transaction-aware; NotificationValidationError → 4xx at API boundaries.

## 4. Existing API surfaces

- /api/alerts — GET org-scoped list (pagination, status/severity/search/type
  filters, DB-backed byStatus/bySeverity stats; session-org, empty for
  org-less super admin), POST admin manual create + audit, PUT admin
  status/severity update + audit (404 cross-org concealment).
- /api/notifications (+ count, batch, preferences, types) — org-scoped
  CRUD/preferences; viewer-appropriate RBAC.
- /api/anomalies (+ [id], detect, batch) — org-scoped list/manual
  create/status update; POST /detect runs the fixed engine on demand.
- /api/settings/monitoring — GET manager+ / PUT admin+; validates against the
  MONITORING_KEYS registry and persists org-scoped OrganizationSetting rows.
- /api/category-rules (+ [id], dry-run) — Phase 3 org rule CRUD precedent:
  manager+ GET/POST/PATCH/DELETE, 404 cross-org, 422 validation, org count
  bound.

## 5. Jobs (src/lib/jobs)

- run.ts — claimJob/finishJob atomic lease on JobRun (`running` +
  leaseExpiresAt 5 min); runScheduledJobs() runs every job under per-job
  try/catch, collects errors, records JobRun.lastResult. Job names:
  expire_consents, retention_cleanup, project_time_sync, anomaly_detection,
  agent_token_sweep, rate_limit_sweep, device_integrity, user_session_sweep,
  audio_transcription, screenshot_processing, workday_summary.
- detect-anomalies.ts — runAnomalyDetectionJob: self-claims the
  anomaly_detection lease, iterates ACTIVE orgs, honors each org's
  `ai_anomaly_detection` setting (fail-closed skip), per-org try/catch,
  finishJob with aggregated counts.
- detect-device-integrity.ts — runDeviceIntegrityJob: org loop over
  status='online' devices with heartbeat older than 15 min AND employee with
  ACTIVE monitoring consent → dedupe-keyed `device_missing` anomaly.
  Pattern reference for an org-level "device offline" rule condition.
- retention.ts — org-scoped purge; notification/alert retention keys exist
  (notification_retention_days, alert_retention_days; 0 = never purge;
  alerts purge only resolved/archived, never pending/acknowledged).
- settings.ts — MONITORING_KEYS typed registry + server-only keys
  (ai_anomaly_detection, activity_dedupe, agent_min_version,
  server_classification); getOrgSetting/resolveOrgMonitoring/
  resolveActivityDedupeEnabled/etc. SERVER_SIDE_KEYS list in the settings UI
  mirrors which keys render in the server-side card.

## 6. Admin UI (src/components/settings)

- SettingsPage (4 sections: general/security/monitoring/notification). The
  monitoring section mounts: DataRetentionCard, AgentMonitoringCard
  (agent-facing keys), ServerSideIntelligenceCard (SERVER_SIDE_KEYS +
  SERVER_SIDE_HELPERS), CategoryRulesCard (Phase 3 precedent card).
- category-rules-card.tsx — the self-contained rule-management card template
  (list/create/edit/toggle/delete + inline flag status).
- alerts-page.tsx / notifications-page.tsx — history surfaces that consume
  the Alert/Notification APIs and realtime invalidation.

## 7. Existing alert/notification tests

- notification-alerting-hardening.test.ts (16 tests, workai_test_notifalerting)
  — N-1…N-11: pagination, RBAC, canonical validation, retention boundaries,
  high/critical anomaly → Alert+Notification, org preferences, tamper
  severity, structured linkage, realtime invalidation, metadata bounds.
- anomaly-hardening.test.ts (workai_test_anomalyhardening) — engine + dedupe +
  tenant isolation for the fixed anomaly pipeline.

## 8. Gap analysis — what Phase 5 must add (all additive)

1. **AlertRule model** — org-scoped, admin-configurable:
   organizationId, name, conditionType (BOUNDED structured set), params
   (validated JSON), severity (existing enum), cooldownMinutes, enabled,
   timestamps. NO arbitrary code / SQL / regex in conditions.
2. **Rule evaluation** — reuse JobRun lease + org-loop pattern; conditions
   backed by real telemetry only (device offline/heartbeat, idle today,
   unproductive today, outside-hours activity, policy violations, USB
   events); bounded per-org queries; deterministic.
3. **Cooldown/dedupe** — same (rule, entity, condition) within cooldown →
   ONE alert; DB-enforced state so concurrent/replayed runs cannot double
   fire; restart-safe under the lease.
4. **Alert + Notification records** — created through createOrgAlert /
   createOrgNotification in the SAME transaction; org NotificationPreference
   honored (never bypassed); severity-derived priority; audit entry.
5. **Admin config API + UI** — /api/alert-rules CRUD mirroring the
   /api/category-rules precedent (manager+ reads, admin+ writes; 404
   cross-org; 422 validation; bounded rule count); management card mounted on
   the existing Settings → Monitoring surface; alert history = existing
   /api/alerts surface (source = rule firing).
6. **No new collectors / no agent changes / no telemetry semantics change.**

## 9. Acceptance gate (this phase)

- Web: typecheck PASS, lint 0 errors, production build PASS, full suite PASS
  (Phase 0 baseline 96/96 suites · 1561 subtests; Phase 3 baseline 100/100
  suites · 1606 tests; Phase 4 baseline 102/102 suites · 1627 tests; current
  tree 103 files incl. dashboard-consumer).
- Agent: unchanged — typecheck PASS, 628/628 tests, build PASS (evidence run).
- New tests: rule CRUD + validation + RBAC + tenant isolation; every
  condition fires correctly and does NOT fire below threshold; cooldown
  dedupe (incl. concurrent/replayed job runs); alerts + notifications created
  in one transaction; org preference honored; retention untouched.
