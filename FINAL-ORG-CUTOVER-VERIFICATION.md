# FINAL ORGANIZATION CUTOVER VERIFICATION — READ-ONLY

> Method: static trace of the actual DB operation (imports rejected as proof).
> No code modified. No schema modified. No migration run. No activation performed.
> No production data touched.
> Date (UTC): 2026-09-10. Repo: `omnisight-web`, branch `main`.
> Core files read in full: `src/lib/org-db.ts`, `src/lib/infra-connect.ts`,
> `src/lib/migration/runner.ts`, `src/lib/migration/db-migrate.ts`,
> `src/lib/migration/storage-migrate.ts`, `src/lib/migration/plan.ts`,
> `src/lib/org-storage.ts`, `src/lib/storage/index.ts`, `src/lib/audio/storage.ts`,
> `src/lib/jobs/run.ts`, `src/instrumentation.ts`, `prisma/schema.prisma` (§InfrastructureMigration).

---

## 1. Overall verdict

# `FULL ORGANIZATION CUTOVER INCOMPLETE`

The cutover *mechanism* (boundary flip + drain-to-fixpoint + verify + rollback) is
soundly designed, the agent ingest hot path and the session/auth boundary resolve
through `getPrismaForOrg()`, retention is per-org routed, and screenshot objects
route per-org. **But a large set of org-owned runtime workers and several live
agent/API write paths still use the platform `db` singleton directly**, so after
`OrganizationSettings.useOwnDb = true` they keep writing org-owned tables
(`Anomaly`, `Alert`, `Notification`, `WorkDaySummary`, `Activity`, `Screenshot`,
`AudioRecording`, `Consent`, `PolicyViolation`, `WebcamSession`, `AiInsight`,
`AiUsage`, `TimeEntry`, …) to the **platform DB** — permanently divergent,
never drained (the drain runs once, at activation). Raw-SQL analytics/search
paths also bypass routing. Audio objects never route per-org at all.

---

## 2. Background worker matrix

Legend: orgId source → resolver → actual client used → org-owned tables touched →
platform DB or org DB → verdict.

| # | Worker (file / entry fn) | organizationId source | Prisma resolver | Actual client used for org-table ops | Org-owned tables touched | Platform or org DB | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | retention — `src/lib/jobs/retention.ts` :: `runRetention` → `runRetentionForOrg` | `db.organization.findMany` (retention.ts:447), per-org loop | `getPrismaForOrg(org.id)` (retention.ts:456) → `orgData` | `orgData` (`data` param) for ALL org-table purges (retention.ts:166-431); platform `db` only for control-plane (`Organization.timezone` :223, `OrganizationSetting` via `resolveRetentionDays`) | Screenshot, Activity, ActivityBatchReceipt, WorkDaySummary, BreakSession, Report, AiInsight, AiUsage, SentimentRecord, AuditLog, ConsentLog, UsbEvent, PolicyViolation, Notification, Alert, AudioRecording(+Transcription cascade) | **org DB** (platform only for control-plane — correct) | **PASS** (2 caveats §9: orphan-sweep §2a, audio-legacy-delete §6) |
| 2 | workday summaries — `src/lib/jobs/workday-summary.ts` :: `runWorkDaySummaryJob` / `rebuildDaysForOrg` | `db.organization.findMany` (workday-summary.ts:294-295) | **none** — no `getPrismaForOrg` import or call | `db` directly: `db.employee` :116, `db.breakSession` :132, `db.activity` :164, `db.$transaction(db.workDaySummary.upsert)` :254-268 | Employee(R), BreakSession(R), Activity(R), WorkDaySummary(**W**) | platform | **FAIL** |
| 3 | anomaly detection — `src/lib/jobs/detect-anomalies.ts` :: `runAnomalyDetectionJob` → `src/lib/anomalies/service.ts` :: `runAnomalyDetection` / `persistAnomaly` | `db.organization.findMany` (detect-anomalies.ts:54) | **none** | `db` directly: `db.employee` (service.ts:152), `db.activity` (:180,184), `db.anomaly` (:222), `db.$transaction(tx.anomaly.create + Alert + Notification)` (:79-130) | Employee(R), Activity(R), Anomaly(**W**), Alert(**W**), Notification(**W**) | platform | **FAIL** |
| 4 | alert rules — `src/lib/jobs/alert-rules.ts` :: `runAlertRulesJob` / `evaluateAlertRulesForOrg` / `persistFiring` | `db.organization.findMany` (alert-rules.ts:329) | **none** | `db` directly incl. `db.$transaction` (alert-rules.ts:88): `db.alertRule` :185, `db.activity` :211, `db.device` :269, `tx.alertRuleFiring` :139-152, Alert+Notification via service on platform tx | AlertRule(R), Activity(R), Device(R), AlertRuleFiring(**W**), Alert(**W**), Notification(**W**) | platform | **FAIL** |
| 5 | device integrity — `src/lib/jobs/detect-device-integrity.ts` :: `runDeviceIntegrityJob` | `db.organization.findMany` (detect-device-integrity.ts:58) | **none** | `db` directly: `db.device.findMany` :64, `db.anomaly.findUnique` :90, `persistAnomaly` → platform `db.$transaction` | Device(R), Anomaly(**W** + Alert/Notification for high/critical) | platform | **FAIL** |
| 6 | project-time sync — `src/lib/project-time/sync.ts` :: `runProjectTimeSync` / `processBatch` (via `runProjectTimeSyncJob`, jobs/run.ts:149) | global-cursor scan, no per-org client | **none** | `db` directly: `db.projectMember` (sync.ts:148), `db.activity` (:172), `db.employee` (:190), `db.projectTimeSyncCursor` (:133-135,317), TimeEntry writes | ProjectMember(R), Activity(R), Employee(R), TimeEntry(**W**), ProjectTimeSyncCursor(W, platform-owned — correct) | platform | **FAIL** |
| 7 | screenshot processing — `src/lib/screenshots/processing.ts` :: `processPendingScreenshots` / `processScreenshotRow` (via `runScreenshotProcessingJob`, jobs/run.ts:182) | cross-tenant scan, no org scoping of client | **none** | `db` directly: `db.screenshot.findMany` (:253), `db.screenshot.update` (:203, :310) | Screenshot(**R+W**) | platform | **FAIL** (post-activation rows live in org DB → worker scans an empty/stale platform table; org rows never processed) |
| 8 | screenshot sweep — `src/lib/screenshots/sweep.ts` :: `sweepOrphanScreenshotFiles` (called from retention, retention.ts:465) | none (global scan) | **none** | `db.screenshot.findMany` (sweep.ts:39) + platform storage driver | Screenshot(R), storage objects | platform | **FAIL** (stale post-cutover: compares platform rows vs platform storage; org-DB rows / org-storage objects invisible) |
| 9 | webcam cleanup — `src/lib/webcam-session-cleanup.ts` :: `endWebcamSessionsOnRevoke` (called from consent routes) | `employeeId` arg, no org resolution | **none** | `db` directly: `db.webcamSession.findMany` (:14), `db.webcamSession.updateMany` (:20) | WebcamSession(**W**; in `MIGRATION_TABLES`, plan.ts:77) | platform | **FAIL** |
| 10 | audio transcription — `src/lib/audio/transcribe-job.ts` :: `processPendingTranscriptions` / `submitForTranscription` (via `audio_transcription` lease, jobs/run.ts:341) | cross-tenant scan by status | **none** | `db` directly: `db.audioRecording.findMany` (:113), `findUnique` (:22), `update` (:53, :85) | AudioRecording(**R+W**; copied table, plan.ts:78-79) | platform | **FAIL** (additionally: `getAudioSignedUrl` → platform `storage()` only, audio/storage.ts:50-56 — object path never org-routed, see §6) |
| 11 | AI insights — `src/lib/ai-insights/engine.ts` :: `runAiInsightsAnalysis`, `dataset.ts` :: `buildInsightDataset`, `filters.ts` :: `parseInsightFilters` | orgId arg | **none** | `db` directly: `db.employee` (dataset.ts:129), `db.activity` (:177), `db.employee/department/project` (filters.ts:90-98), AiInsight writes via engine on `db` | Employee(R), Activity(R), AiInsight(**W**), AiUsage(**W** via ai-metering.ts:44 `db.aiUsage.create`) | platform | **FAIL** |
| 12 | breaks — agent path `src/app/api/agent/break/route.ts` → `src/lib/breaks/service.ts` (`startBreak`/`endBreak`, tx-injectable, DbTx default `db`, breaks/service.ts:116) | `authResult.orgData` (break route :41, :50, :69) | `getPrismaForOrg` via `validateAgentToken` (auth.ts:111) | `orgData` passed as tx | BreakSession(**W**), Activity mirror rows(**W**) | **org DB** | **PASS** (agent path; default-param `db` is only a fallback when callers omit tx — admin toggle route `break-status/[id]/toggle` resolves `getPrismaForOrg` itself) |
| 13 | notifications — `src/lib/notifications/service.ts` :: `createOrgNotification` / `createOrgAlert` (tx-injected, no own client) | caller-supplied | **none (inherits caller tx)** | inherits: org DB when caller passes `orgData` tx (agent ingest routes); **platform** when caller is `db.$transaction` (tamper/anomaly/consent/policy-violation agent routes; alert-rules `persistFiring`; anomaly `persistAnomaly`) | Notification(**W**), Alert(**W**) | platform **in all worker + 4 agent-route call sites** | **FAIL as invoked** (service is correctly injectable; every scheduled-worker and 4/13 agent-route call sites inject the platform tx) |
| 14 | consent expiry — `src/lib/jobs/expire-consents.ts` | org loop on `db` | **none** | `db` (`import { db }`, expire-consents.ts:1; no org-db import) | Consent(**W**), ConsentLog(**W**; both copied, plan.ts:83-84) | platform | **FAIL** |
| 15 | data-expiry reminder — `src/lib/jobs/data-expiry-reminder.ts` | org loop on `db` | **none** | `db` (`db.aiInsight.aggregate`, data-expiry-reminder.ts:56) | AiInsight(R) | platform (stale post-cutover) | **FAIL** (read-staleness; sends reminders from pre-cutover data) |
| 16 | agent-token sweep — `sweep-agent-tokens.ts` | n/a (credential hygiene) | n/a | `db` | AgentToken, AgentSession | platform | **PASS — correctly platform** (deliberately excluded from copy, plan.ts:20-21; secrets stay platform-side) |
| 17 | user-session sweep — `sweep-user-sessions.ts` | n/a | n/a | `db` | UserSession | platform | **PASS — correctly platform** (excluded, plan.ts:20) |
| 18 | rate-limit sweep — `sweep-rate-limit-counters.ts` (`db.$executeRaw`) | n/a | n/a | `db` | RateLimitCounter (platform) | platform | **PASS — correctly platform** |
| 19 | subscription sweep — `subscription-sweep.ts` | n/a | n/a | `db` | Subscription, Organization, Invoice | platform | **PASS — correctly platform** (control-plane, never copied) |
| 20 | device-count sync — `sync-device-count.ts` | org loop on `db` | **none** | `db` (`db.device` reads, `Organization.activeDeviceCount` writes) | Device(R — org-owned read, stale post-cutover), Organization(W — control-plane, correct target) | mixed | **PARTIAL FAIL** (reads stale platform Device rows; writes the correct platform Organization row) |

Only **1 of 12** org-scoped workers (`retention`) routes through `getPrismaForOrg()`.
Note the asymmetry the report must not hide: `src/lib/org-db.ts:18-21` itself still
says *"As of Prompt 6, the analytics read/write paths still use the shared cloud
schema"* — the codebase documents the cutover as opt-in/incomplete.

---

## 3. Remaining direct platform-DB operational paths (org-owned tables)

Every row below was traced to the actual operation, not the import block.
"Intentionally platform" paths (control-plane: Organization, AppUser,
OrganizationMembership, UserSession, AgentToken/AgentSession, Subscription,
Invoice, LicenseKey, OrganizationSetting(s), JobRun, Infrastructure*,
SystemSetting, PlatformBranding, AuditLog NULL-org rows) are **excluded**.

### 3a. Background workers / services (writes land on platform post-activation)

- `src/lib/jobs/workday-summary.ts` :: `rebuildDaysForOrg` — `db.activity.findMany` (:164), `db.breakSession.findMany` (:132), `db.$transaction(db.workDaySummary.upsert…)` (:254-268) — tables WorkDaySummary/Activity/BreakSession — **reason: no org client resolution**.
- `src/lib/anomalies/service.ts` :: `persistAnomaly` — `db.$transaction(tx.anomaly.create…)` (:79-95) — Anomaly/Alert/Notification — no org client.
- `src/lib/anomalies/service.ts` :: `runAnomalyDetection` — `db.employee` (:152), `db.activity` (:180,184), `db.anomaly` (:222) — reads.
- `src/lib/jobs/detect-device-integrity.ts` :: `runDeviceIntegrityJob` — `db.device.findMany` (:64), `db.anomaly.findUnique` (:90) — reads + platform `persistAnomaly` writes.
- `src/lib/jobs/alert-rules.ts` :: `persistFiring` — `db.$transaction` (:88), `tx.alertRuleFiring.upsert` (:139) — AlertRuleFiring/Alert/Notification — no org client.
- `src/lib/jobs/alert-rules.ts` :: `evaluateAlertRulesForOrg` — `db.alertRule` (:185), `db.activity` (:211), `db.device` (:269) — reads.
- `src/lib/project-time/sync.ts` :: `processBatch`/`loadActiveMemberships` — `db.activity.findMany` (:172), `db.projectMember` (:148), `db.employee` (:190), TimeEntry create/update — no org client.
- `src/lib/screenshots/processing.ts` :: `processPendingScreenshots` — `db.screenshot.findMany` (:253); `processScreenshotRow`/`markRowFailed` — `db.screenshot.update` (:203,:310).
- `src/lib/screenshots/sweep.ts` :: `sweepOrphanScreenshotFiles` — `db.screenshot.findMany` (:39).
- `src/lib/webcam-session-cleanup.ts` :: `endWebcamSessionsOnRevoke` — `db.webcamSession.findMany/updateMany` (:14,:20).
- `src/lib/audio/transcribe-job.ts` :: `submitForTranscription`/`processPendingTranscriptions` — `db.audioRecording.{findUnique,update,findMany}` (:22,:53,:85,:113).
- `src/lib/ai-insights/dataset.ts` :: `buildInsightDataset` — `db.employee` (:129), `db.activity` (:177).
- `src/lib/ai-insights/filters.ts` :: `parseInsightFilters` — `db.employee/department/project.findFirst` (:90-98).
- `src/lib/ai-insights/engine.ts` :: `runAiInsightsAnalysis` — AiInsight writes on `db` (engine imports only platform `db`, :20).
- `src/lib/ai-metering.ts` :: `recordAiUsage` — `db.aiUsage.create` (:44).
- `src/lib/workday/consume.ts` :: `readOrgDayTotals` (dashboard read) — `db.workDaySummary.findMany` (:86), `db.activity.findMany` (:131).
- `src/lib/jobs/expire-consents.ts` :: `expireConsents` — Consent/ConsentLog writes on `db`.
- `src/lib/branding.ts` :: `getRawOrganizationBeanding` — `db.organizationBranding.findUnique` (:298) — OrganizationBranding **is** copied (plan.ts:61) → stale read post-cutover.
- `src/lib/agent-account.ts` :: `getDefaultAgentId` — `db.employee.findUnique` (:118) — Employee is copied → stale read post-cutover (account create/update correctly platform).

### 3b. Live agent/API routes (writes land on platform post-activation)

- `src/app/api/agent/tamper/route.ts` :: `POST` — `db.$transaction` (:62): `createOrgAlert`+`createOrgNotification`+`tx.auditLog.create` (:64-97) — Alert/Notification/AuditLog — **reason: ignores `authResult.orgData`, hardcodes `db`**.
- `src/app/api/agent/anomaly/route.ts` :: `POST` — `db.$transaction(tx.anomaly.create…)` (:99-115) + Alert/Notification (:119-144) — same reason.
- `src/app/api/agent/consent/route.ts` :: `POST` — `db.$transaction(tx.consent…/applyConsentTransition…)` (:89-119) — Consent/ConsentLog — same reason.
- `src/app/api/agent/policy-violations/route.ts` :: `POST` — `db.appListEntry.findFirst` (:62), `db.$transaction(tx.policyViolation.create + auditLog + notification)` (:80-131) — AppListEntry(R)/PolicyViolation/AuditLog/Notification — same reason.

### 3c. Raw SQL on the platform client over org-owned tables

- `src/app/api/analytics/route.ts` :: `GET` — `db.activity.groupBy` (:119,:134) + `db.$queryRaw` trend/app aggregates over `"Activity"⋈"Employee"` (:151,:264) — **reason: no `getPrismaForOrg`; raw SQL bound to `db`**.
- `src/app/api/analytics/compare/route.ts` — `db.$queryRaw` ×3 (:54,:67,:165) over org activity — same reason.
- `src/app/api/screenshots/ocr-search/route.ts` — `db.$queryRawUnsafe` count+search (:38,:44) over org screenshots — same reason (also `import { db }`, :2).
- `src/lib/rate-limit.ts` — `db.$queryRaw` (:64) — platform table, correctly platform (listed for completeness, not a failure).
- `src/lib/migration/db-migrate.ts` — all `$queryRawUnsafe/$executeRawUnsafe` target the **destination** client or allowlisted copy-plan tables — correctly routed (not failures).
- `db.$executeRaw` in `sweep-rate-limit-counters.ts:17` — platform table, not a failure.
- Prisma transactions: `db.$transaction` in the four agent routes above + `persistFiring` + `persistAnomaly` + workday upserts — all platform-bound (failures, see 3a/3b). `db.$transaction` in `runner.ts` (boundary/finalize/rollback, :257,:284,:376) and `activate`/`discover` routes operate on control-plane or already-resolved `orgData` — not failures.

### 3d. Paths verified PASS (traced to org client)

- Agent ingest: `heartbeat` (device.update :26, breakSession.findFirst :39 via `authResult.orgData ?? db`, heartbeat/route.ts:22 — `orgData` always present on valid auth, auth.ts:206-217, so the `?? db` fallback is unreachable on the valid path), `activity` (:167,:309,:336,:358), `screenshot` (:44-45,:169), `keystroke` (:116,:166), `usb` (:35,:79), `commands`+`ack`, `webcam/session`+`end`+`frame`, `location` (injects `orgData`, location/route.ts:54,113), `break` (:41,:50,:69), `discover` (per-org `getPrismaForOrg`, discover/route.ts:136,158 + cross-DB lookup `findDeviceAcrossActivatedOrgDbs`).
- Session/auth boundary: `validateAgentToken` (employee+device reads via `orgData`, auth.ts:111-160) and `validateAgentSession` (employee via `orgData`, session.ts:116-128); AgentSession/AgentToken/AgentAccount/Organization stay on `db` — correct (never copied).
- Storage objects (screenshots): `putScreenshot/getScreenshot/deleteScreenshot/screenshotAiInput` resolve `getOrgStorage(orgId)` per call (storage/index.ts:114-174) — **PASS for screenshots**.
- Transcription callback + audio/admin reads that call `getPrismaForOrg` (e.g. `internal/audio/transcription-callback`, `audio/[id]/retry`, `audio/route`) — PASS for metadata.
- The ~100 dashboard/admin routes that resolve `(await getPrismaForOrg(…)).client` per request (alerts, anomalies/[id], insights, sentiment, notifications, employees, devices, projects, screenshots analyze, etc.) — PASS for their CRUD operations.

---

## 4. Cutover race result

Implementation (runner.ts:237-319, db-migrate.ts:344-379, infra-connect.ts:276-313):

```
t0  activateMigration() — gate: status must be ready_to_activate (or resume cutover)
t1  BOUNDARY (one db.$transaction):  migration → 'cutover' + cutoverAt=new Date()
                                     + applyDatabaseSwitch(tx) → settings.useOwnDb=true
t2  drainDatabaseCutover(): per-table upsert sweeps until a full pass inserts 0
                            (≤50 passes) — ON CONFLICT(id) DO UPDATE reconciles values
t3  verifyCutoverDestination(): dst ⊇ src per table + zero foreign-org rows
t4  FINALIZE (one tx): migration → 'activated' + activatedAt=now, request → 'active'
FAIL anywhere in t2–t4 → revertDatabaseSwitch (useOwnDb=false, config KEPT) +
                         migration → 'failed'.  Crash between t1–t4 → stranded
                         'cutover' resumed by resumeStrandedCutovers().
```

A. **Write starts before `cutoverAt`, commits after:** its client was resolved
pre-flip → commits to the **platform source**. Captured **iff** the commit lands
before the drain's final zero-insert pass; reconciled by value via
`ON CONFLICT DO UPDATE` (upsertDestinationRow, db-migrate.ts:254-274). A slow
pre-flip transaction committing **after t3 (verify)** is **missed** — it sits in
the platform source, which is never read again. No write fence / advisory lock /
table lock is taken at t1, so this window is real (bounded by transaction
duration vs. drain+verify duration).

B. **Write starting during the final drain:** same as A — captured iff committed
before the final pass completes; otherwise missed. Non-converging sources
(continuous writes) fail closed after 50 passes (`drain.ok=false` → rollback),
which is correct but means hot orgs may be unable to activate.

C. **Write starting immediately after the routing switch:** resolves
`getPrismaForOrg` post-flip → **org DB directly** — safe. *Except* any caller
holding a pre-flip resolved client (in-flight request) or any caller that never
resolves per-request (all §3a workers, cached long-lived clients) — those keep
writing the platform source indefinitely (see D).

D. **Can any write commit to the platform DB after `useOwnDb=true`? YES —
deterministically, not just racily.** Every §3a/§3b path issues org-table writes
on the platform singleton forever after activation (workers have no flip
awareness at all). The design has no post-activation guard (no trigger, no
`useOwnDb` check inside workers, no periodic re-drain). Post-activation platform
writes are **silent divergence**, never reconciled.

E. **Can any row be missed between the final source scan and the routing flip?
For DATABASE cutover: NO by construction** — the flip (t1) precedes the drain
(t2), so there is no scan→flip gap; the drain *is* the post-flip scan, and the
pre-flip snapshot copy only needs snapshot-verification (which `ready_to_activate`
gating enforces via `isVerifiedComplete`, runner.ts:632-645). The residual gap is
**verify→finalize (t3→t4)**, not scan→flip.

F. **Can the same row exist with divergent values in both DBs? YES.** (i) A
pre-flip UPDATE committed after t3 leaves the old value in the destination and
the new value in the source. (ii) Permanently: any row both written by a routed
path (destination) and by an unrouted worker (source) diverges with no
reconciliation (e.g. `Device.lastHeartbeat` — heartbeat writes destination,
device-integrity/alert-rule reads source). (iii) The drain reconciles only
`MIGRATION_TABLES` rows by `id`; anything outside the allowlist is untouched.

**Timeline diagram:**

```
source writes │───■───■───■───│··············································│
              │  snapshot copy │ t1: flip+cutoverAt │ t2: drain (upsert sweeps) │
              │  (reconcile    │ useOwnDb=true      │ until zero-insert pass    │
              │   passes)      │                    │ t3: verify(dst⊇src)       │
live traffic ─┼────────────────┼── new writes ──▶ destination ───────────────┼──▶ destination
              │                │   (routed callers)  ▲ captured iff committed  │
in-flight txn ┼─── begin ──────┼─── commit to SOURCE ┘ before final pass ─────┼─── commit AFTER
              │                │                                               │   t3 ⇒ LOST (D)
unrouted      ┼────────────────┼─── platform writes continue FOREVER ──────────┼─── (D, permanent)
workers       │                │                                               │
              │  ready_to_activate                          t4: activatedAt / finalize
```

---

## 5. Ready→activation race

Scenario: migration `ready_to_activate` → new org data arrives on the source →
activation later.

1. **Guaranteed for DATABASE-table rows committed before t3**, by
`executeDatabaseCutover` → `drainDatabaseCutover` (runner.ts:275) →
`drainMissingTableRows` per `MIGRATION_TABLES` (db-migrate.ts:290-325) with
`assertOrg` isolation + `assertAllowlistedTable`, to fixpoint (≤50 passes), then
`verifyCutoverDestination` (db-migrate.ts:387-410). Post-flip new rows land in
the destination directly (routed callers). **Proving functions:**
`activateMigration` (:165), `executeDatabaseCutover` (:237),
`drainDatabaseCutover` (:344), `drainMissingTableRows` (:290),
`upsertDestinationRow` (:254), `verifyCutoverDestination` (:387).
2. **NOT guaranteed for:** (a) rows committed after t3 (see §4A); (b) rows
written by unrouted workers at any time after t1 (§4D — these are *new platform
writes*, invisible to all future drains); (c) non-allowlisted tables (nothing
outside `MIGRATION_TABLES` is ever drained).
3. After activation, new data goes to the destination **only for routed callers**;
unrouted workers permanently violate this (§3a/§3b).

---

## 6. Storage race result

- **Screenshots — SOUND.** `putScreenshot/getScreenshot/deleteScreenshot/
screenshotAiInput` resolve `getOrgStorage(orgId)` per call
(storage/index.ts:114-174); `getOrgStorage` returns the org driver iff
`storageDriver==='supabase'` + url + key (org-storage.ts:87-93), else platform.
`executeStorageCutover` (runner.ts:321-409) captures the pre-flip source driver
**before** the atomic flip (:337-350), reads refs from the org's current data DB
(`getPrismaForOrg`, :355), then `drainStorageCutover` re-collects
`collectOrgStorageRefs` every pass (storage-migrate.ts:258) until a zero-copy
pass (≤50), then verifies every referenced object resolves at the destination
(:284-291). DB-ref-first vs object-first orderings both converge via re-collection.
Post-flip objects go to the destination directly. Crash between flip and finalize
resumes with the reconstructible platform source (:358-366).
- **Audio — BROKEN (not a race, a missing route).** `putAudio/getAudio/
deleteAudio/getAudioSignedUrl` call platform `storage()` unconditionally
(audio/storage.ts:27-56); `getOrgStorage` is never consulted. After a STORAGE
cutover, audio objects still land in (and are served from) platform storage while
their DB rows live in the org DB. The storage migration *copies* audio refs
(`collectOrgStorageRefs` reads AudioRecording rows, storage-migrate.ts:86-93) but
the live path never follows.
- **Retention deletes — LEAK, not loss.** Audio retention calls
`removeArtifactByPath(orgId, filePath, 'legacy')` (retention.ts:417), whose
`'legacy'` branch deletes through platform `storage()` (storage/index.ts:224-228).
Post-storage-cutover the org audio object is never deleted (platform delete
misses/no-ops) → DB row is kept via `audioFileErrors` (retention.ts:420) →
**unbounded growth, retry every run**, never silent loss. Same for report PDFs.
- **Orphan sweep ordering** (`sweepOrphanScreenshotFiles`, sweep.ts:69): compares
platform rows vs platform storage; post-cutover both sides are frozen stale
copies, so it can neither discover org orphans nor (since source rows are never
deleted) falsely delete — dead weight, not a deleter. Flagged for correctness,
not data loss.

---

## 7. Fail-closed result

- **Resolution is fail-closed: PASS.** `getPrismaForOrg` with `useOwnDb=true` and
incomplete config **throws `OrgDbMisconfigurationError`** (org-db.ts:130-132) and
never falls back to `db`. Exactly **zero** `catch` sites reference
`OrgDbMisconfigurationError` (grep: only definition+throw sites) — no caller
converts it into a platform fallback. DB-unavailable / wrong-credentials /
timeout / connection-reset at request time surface as Prisma errors → route 500s;
no `catch → db` fallback exists anywhere in `src/`. Retention isolates the throw
per-org (`runRetention`, retention.ts:458-461: error recorded, other orgs
continue) — correct containment, still fail-closed for the affected org.
- **Destination-down at runtime ⇒ FAIL (expected).** Cached `PrismaClient` per
org (org-db.ts:46,134-156); queries against a dead destination throw — nothing
re-routes to platform.
- **Two fallback-shaped constructs audited and cleared:** (i) `authResult.orgData
?? db` in agent routes (heartbeat/route.ts:22 etc.) — `validateAgentToken`
returns `orgData` on **every** valid path (auth.ts:206-217) and `valid:false` on
throw (the `getPrismaForOrg` throw lands in the catch at auth.ts:218-221), so the
`?? db` arm is unreachable when authenticated; (ii)
`findDeviceAcrossActivatedOrgDbs` skips misconfigured orgs (org-db.ts:183) but is
only a lookup aid — the caller keeps its 422.
- **Rollback is fail-closed:** drain/verify failure → `revertDatabaseSwitch`
(`useOwnDb=false`, config preserved for retry, infra-connect.ts:323-333) +
migration `failed`, request back to `approved` (runner.ts:202-235). Stranded
`cutover` rows resume via `resumeStrandedCutovers` (runner.ts:417-451) on the
migration loop (instrumentation.ts:146-163).
- **Residual fail-closed hole (availability, not correctness):** `revertStorageSwitch`
and `revertDatabaseSwitch` run inside the rollback transaction; if the *platform*
DB itself is down, rollback cannot persist and the org stays routed at a possibly
unverified destination (runner.ts:311-314 explicitly surfaces this as manual-review).

---

## 8. Tenant isolation

- **Client cache: PASS by key.** `orgDbClients: Map<orgId, PrismaClient>`
(org-db.ts:46), `pruneCache` bounded at 100 with oldest-first eviction (:51-68),
`invalidateOrgDbCache(orgId)` disconnects + deletes on every settings switch
(`applyDatabaseSwitch` infra-connect.ts:312, `revertDatabaseSwitch` :332).
Connection strings are built per-org from individually decrypted passwords
(:139-146); nothing is shared between org clients. Storage drivers mirror this
(`orgStorageDrivers` keyed by orgId, org-storage.ts:24; `invalidateOrgStorageCache`
on switch, infra-connect.ts:379,398).
- **Stale-client window (acknowledged, bounded):** an in-flight request that
resolved its client pre-switch keeps using it for that request's lifetime; the
disconnect in `invalidateOrgDbCache` races those in-flight queries (best-effort).
No *cross-org* reuse is possible (keyed lookup), only *stale-own-org* use within
one request lifetime.
- **Cross-tenant probes (defence in depth):** `assertOrg` on every copied/drained
row (db-migrate.ts:44-51, asserted :314,:495), `assertAllowlistedTable` on every
dynamic identifier (:216-220), destination-wide `organizationId <> $1` probe at
both snapshot verify (:628-641) and cutover verify (:398-409), `assertOrg` on
drain upserts. `findDeviceAcrossActivatedOrgDbs` scans ≤25 activated orgs by
agentKey but returns only the matching device row (org-db.ts:170-197) — bounded
by design for anonymous re-discover.
- **Isolation broken in practice by §3, not by the cache:** unrouted workers read
*all* orgs' rows from the shared platform tables post-activation (e.g. anomaly
job iterating every org's telemetry on platform while live data accrues in org
DBs) — stale reads and platform writes, i.e. a *routing* isolation failure, not
a cache-key failure. Long-running jobs hold no org client at all, so worker
retries cannot cross tenants — but they also never reach the tenant DB.

---

## 9. Timestamp semantics

Source: `prisma/schema.prisma:756-795` + `runner.ts:507,260,343,287` +
`migration/[id]/activate` + status-card UI.

| Column | Set where (server-side `new Date()`) | Meaning |
|---|---|---|
| `startedAt` | `claimNext()` — atomic `queued→migrating` claim (runner.ts:505-508) | **Transfer start / claim time.** The worker lease instant the migration run began. NOT transfer completion. Schema comment (schema.prisma:752-755) explicitly forbids a separate `transferStartedAt`: "`startedAt` is the … time the transfer began." |
| `cutoverAt` | `executeDatabaseCutover` / `executeStorageCutover` boundary transaction (runner.ts:260,343) | **Deterministic cutover boundary.** The instant runtime routing flipped (`applyDatabaseSwitch`/`applyStorageSwitch` in the same tx). Set once; resume path skips re-setting (`if (status!=='cutover')`, :255,:337). Every org row written before it must be drained; after it lands directly (for routed callers). |
| `activatedAt` | Finalize transaction (runner.ts:283-287, storage :375-380) | **Switch landed.** Migration `activated` + request `active` + audit row, atomically. Pre-finalize failures roll back to `failed` with `activatedAt` untouched (NULL). |

- **Server-side: YES.** All three are `new Date()` evaluated in the server
process (claim/boundary/finalize), persisted via Prisma. (Precision note: the
schema comment calls them "database-clock" (schema.prisma:753,783-786); the code
actually stamps **app-server clock**. Server-side regardless — never browser
clock. No client supplies these values.)
- **UI display:** `migration-status-card.tsx` renders lifecycle *statuses*
(Transferring / Synchronizing / Ready-to-activate / Completed) and record/object
counters — it does **not** render `startedAt/cutoverAt/activatedAt` as labeled
event timestamps, and does **not** mislabel `startedAt` as "transfer completed"
(the pending card explicitly states the current infra "stays active … until the
migrated data is verified and the switch is activated", :197). The org migration
API returns the raw timestamps (`migration/route.ts:89-91`) for consumers.
`verifiedAt`/`finishedAt` are auxiliary (verification instant / terminal instant).

---

## 10. Exact remaining gaps (all must close for a COMPLETE verdict)

**GAP-1 — Scheduled workers write org tables on platform (10 workers).**
`workday-summary`, `detect-anomalies` (+`anomalies/service`), `alert-rules`,
`detect-device-integrity`, `project-time/sync`, `screenshots/processing`,
`screenshots/sweep`, `webcam-session-cleanup`, `audio/transcribe-job`,
`ai-insights/*` + `ai-metering`, `expire-consents`, `data-expiry-reminder`
(stale read), `sync-device-count` (stale Device read). Fix pattern exists:
`runRetention` (retention.ts:456-457). Each worker must resolve
`getPrismaForOrg(org.id)` per org (or accept an injected org client) for every
table in `MIGRATION_TABLES`, keeping control-plane reads on `db`.

**GAP-2 — Four live agent routes hardcode `db.$transaction` for org writes.**
`agent/tamper` (:62), `agent/anomaly` (:99), `agent/consent` (:89),
`agent/policy-violations` (:62,:80) — must use `authResult.orgData.$transaction`
(the resolved org client supports `$transaction`).

**GAP-3 — Raw-SQL reads bypass routing.**
`analytics/route.ts` (:119,:134,:151,:264), `analytics/compare` (:54,:67,:165),
`screenshots/ocr-search` (:38,:44) — must run group-bys and raw SQL against the
resolved org client (Prisma `$queryRaw` works on any client instance).

**GAP-4 — Dashboard/consumer reads on platform.**
`workday/consume.ts:readOrgDayTotals` (:86,:131), `ai-insights` dataset/filters,
`branding.ts:getRawOrganizationBranding` (:298), `agent-account.ts:getDefaultAgentId`
(:118) — stale reads post-cutover.

**GAP-5 — Audio storage never org-routes.**
`audio/storage.ts:27-56` must resolve `getOrgStorage(orgId)` like
`storage/index.ts:114-174` does for screenshots; retention's `'legacy'` audio
delete path then follows automatically.

**GAP-6 — No post-activation safety net.**
No write fence at the boundary (slow pre-flip transactions committing after
verify are missed, §4A), no periodic re-drain, no platform-side guard
(trigger/assert) catching post-activation org writes from unrouted callers.
Even after GAP-1–GAP-5 are fixed, consider a bounded post-activation re-drain or
an assertion that fails loudly if an org-owned row lands in the platform DB
while `useOwnDb=true`.

**GAP-7 — Doc precision (minor).**
`org-db.ts:18-21` still declares analytics paths on the shared schema, and the
schema comment claims "database-clock" timestamps while code stamps app-server
`new Date()`. Reconcile comments with the verified behavior; do not relabel
`startedAt`.

---

### Trace index (every material claim → exact location)

`src/lib/org-db.ts:97-157` (resolver), `:38-43` (fail-closed error), `:46-84`
(cache+invalidate), `:170-197` (cross-DB lookup) · `src/lib/infra-connect.ts:276-333`
(switch+rollback), `:355-399` (storage) · `src/lib/migration/runner.ts:165-195`
(activate gate), `:237-319` (DB cutover), `:321-409` (storage cutover),
`:417-451` (stranded resume), `:505-508` (claim/`startedAt`), `:603-655`
(reconcile→`ready_to_activate`) · `src/lib/migration/db-migrate.ts:254-274`
(upsert), `:290-379` (drain), `:387-410` (verify), `:420-432` (anchor) ·
`src/lib/migration/storage-migrate.ts:243-317` (storage drain) ·
`src/lib/migration/plan.ts:52-94` (table allowlist) · `src/lib/org-storage.ts:67-103`
· `src/lib/storage/index.ts:114-174` vs `src/lib/audio/storage.ts:27-56` ·
`src/lib/agent/auth.ts:111,206-221` · `src/lib/agent/session.ts:116-174` ·
workers/services/routes as cited in §§2–3 · `prisma/schema.prisma:744-795` ·
`src/components/data-infrastructure/migration-status-card.tsx` (UI labels).
