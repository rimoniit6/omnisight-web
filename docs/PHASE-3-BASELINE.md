# PHASE 3 BASELINE — Server-Authoritative Productivity Classification (as-built, pre-Phase-3)

Status: forensic baseline, captured 2026-09-03 before Phase 3 changes.
Phase scope (authoritative, re-sliced): classification + org rules + admin UI
ONLY. WorkDaySummary / daily aggregation is Phase 4; alerts Phase 5; realtime
hardening Phase 6. Nothing in this document covers those later phases except
to note reuse points.

## 1. Scope of Phase 3

1. **Server-authoritative classification**: the server — NOT the agent —
   decides `productive | neutral | unproductive` for application/website
   activity, using organization-controlled rules.
2. **CategoryRule**: org-scoped rules (application/executable/domain match
   types, ordered precedence, target category). Agent category is a *hint*.
3. **Admin UI** to manage rules (view/create/edit/enable/disable/delete).
4. Working-hours/break semantics respected and documented; no new telemetry.

Explicit non-goals (later phases): WorkDaySummary, daily aggregation,
alerts/rules engine, mobile, screenshot AI, sentiment expansion, new
collectors, realtime redesign.

## 2. Web repository facts (omnisight-web)

### 2.1 Framework / runtime
- Next.js App Router (Next 16), TypeScript strict, Bun canonical.
- PostgreSQL via Prisma. Tests run `node --import tsx --test` against
  throwaway DBs (`scripts/pg-test-db.mjs ensure <db>` + `prisma db push
  --force-reset`).
- Baselines: Phase 2 GREEN at 98/98 suites, 1591/1591 tests; typecheck PASS;
  lint 0 errors; production build PASS. Agent 628/628.

### 2.2 Activity model (current)
```prisma
model Activity {
  type            String   // application, website, idle, screenshot, work_session
  title           String?
  url             String?  // websites: bare domain only
  applicationName String?  // applications: process/exe name
  category        String?  // productive, neutral, unproductive, idle
  duration        Int      // seconds
  employeeId / deviceId / timestamp / createdAt
  @@index([employeeId, timestamp, category]) etc.
}
```
- `category` is allowlisted at ingestion (`productive|neutral|unproductive|
  idle`) and stored as-is — **no server re-classification today**.
- No unique constraint on rows; batch dedupe is `ActivityBatchReceipt`
  (Phase 1, `activity_dedupe` flag).

### 2.3 Activity ingestion — `src/app/api/agent/activity/route.ts`
- Auth `validateAgentToken` → 401; consent `activity_tracking` → 403
  (fail closed); 1 MB body cap; 100 activities max; optional `batchId`/
  `batchSeq` (Phase 1); internal-process exclusion; strict per-item
  validation (type/category allowlist, duration 0–86400, no future beyond
  5-min skew, field length caps); first invalid item rejects the whole batch
  (422).
- Website rows: org `website_tracking` gate (403), then domain-only
  normalization (`normalizeWebsiteDomain`, bare domain, dropped when null) +
  sanitized titles.
- Insert path: `createMany`, or receipt + rows in one transaction when
  `activity_dedupe` enabled + batchId present. Response `{ success, count,
  message }` (+ `deduplicated` on receipt path).

### 2.4 Monitoring settings registry — `src/lib/jobs/settings.ts`
- `MONITORING_KEYS`: single typed registry (boolean/number/time/text) —
  heartbeat, screenshot, app/website tracking, idle, **working_hours_only
  (default true)**, **work_start_time '09:00'**, **work_end_time '18:00'**,
  ai_anomaly_detection, location/keystroke/webcam/website-native (default
  false), usb_monitoring, tamper_detection, app_policy_enforcement/
  terminate, activity_dedupe (Phase 1), agent_min_version (Phase 1).
- `resolveOrgMonitoring(orgId)` returns typed resolved values with validated
  defaults; `SERVER_SIDE_KEYS` drives which rows render in the admin
  "Server-Side Monitoring & Intelligence" card and are excluded from the
  agent config payload (agent config route selects explicit fields).
- The agent config route sends to the agent only agent-relevant flags:
  app/website tracking, idle, working-hours window + timezone. The agent
  gates collection client-side on `working_hours_only`.

### 2.5 Timezone utilities — `src/lib/timezone.ts`
- `isValidTimezone`, `safeTimezone` (invalid → UTC), `localDayKey`,
  `lastNDayKeys`, `zonedDayStart/End`, `orgDayWindow`, `hourInTimezone`,
  `dayKeysBetween`, `addDaysToKey`, `zonedDayOfWeek` — DST-aware, single
  org-timezone system reused everywhere (dashboard, breaks, reports,
  anomalies). Phase 3 reuses these; no second timezone system.

### 2.6 Breaks — `src/lib/breaks/service.ts` + `BreakSession`
- Canonical break state; legacy "Break Mode …" Activity mirrors (type
  `idle`, category `idle`, duration 0) written in the same transaction.
- `BREAK_TITLES` constants; `sessionDurationSeconds` /
  `totalBreakSecondsInDay` (org-local day window math).
- Break retention purges only ENDED sessions past
  `break_session_retention_days`; mirrors purged with their sessions.
- **Break semantics for classification**: while break mode is active the
  agent pauses every collector (config `break` → collectors pause/resume), so
  break time never arrives as new productive/neutral/unproductive telemetry;
  mirrors are idle-typed. Classification must never flip idle rows.

### 2.7 Dashboard / analytics — `src/app/api/dashboard/route.ts` +
  `tests/admin-prod-dashboard.test.ts`
- Activity consolidated over the 7-day org-local window; daily buckets by
  `localDayKey`; productivity score = productive ÷ (p+n+u) over the same
  window.
- **The dashboard consumes `Activity.category`** — any Phase 3 change to
  stored categories changes it. Phase 3's "no sudden dashboard changes"
  guarantee = server_classification defaults OFF (agent value stored
  byte-for-byte) and, when enabled with no rules, the server's default
  heuristic mirrors the agent's own categorizer output (identical result).
- Verified: no `Math.random()` anywhere in productivity metrics
  (dashboard-productivity tests + source review).

### 2.8 Anomaly detection — `src/lib/anomalies/detect.ts`
- Consumes category: productivity-drop ratio, excessive idle, off-hours work.
  `isIdleActivity` = category idle or type idle. Rule engine is separate from
  Phase 5 alerts; unaffected here.

### 2.9 Existing category-like machinery (no Phase-3 schema reuse needed)
- `Activity.category` free-text column exists; allowlist enforced at API.
- No existing per-org rule table for classification (AppListEntry is the
  app whitelist/blacklist for POLICY enforcement — separate domain; do not
  overload it with productivity semantics).
- Agent heuristics (see §3) are the only "rules" today, and they live
  client-side.

## 3. Agent repository facts (omnisight-agent)

### 3.1 Activity collector — `src/collectors/activity-collector.ts`
- Samples foreground window (~10s), accumulates ≥5s slices, flushes
  `{ type:'application', applicationName (process name), title, category,
  duration, timestamp }` into the encrypted bounded queue.
- Working-hours gate `isWithinWorkingHours` (org timezone, minute-accurate,
  overnight windows, fail-closed on malformed).
- **Local heuristic `categorize(app)`** (lines ~179+):
  - productive: code|visual studio|intellij|sublime|notepad|terminal|cmd|
    powershell|vim|jetbrains
  - neutral: chrome|firefox|edge|slack|teams|outlook|zoom|excel|word|
    powerpoint|notion|figma|jira|github
  - unproductive: youtube|netflix|steam|game|spotify|twitch|facebook|
    instagram|tiktok|reddit
  - else neutral.
- Source comment: *"Local heuristic category; the server re-categorizes via
  its own logic."* — aspirational today; the server only allowlists.

### 3.2 Website collector — `src/collectors/website-collector.ts`
- `categorizeDomain(domain)`:
  - unproductive: youtube|netflix|twitch|hulu|spotify|steam|epicgames|
    facebook|instagram|tiktok|reddit|twitter|\bx\.com|discord|9gag|imgur|
    pinterest|snapchat|whatsapp
  - productive: github|gitlab|stackoverflow|stackexchange|bitbucket|jira|
    notion|confluence|linear\.app|figma|asana|trello|slack|docs\.google|
    lucidchart|code\.visualstudio|w3schools|geeksforgeeks|coursera|udemy|
    pluralsight|learn\.
  - else neutral.
- Server already normalizes websites domain-only; the agent's domain value is
  a hint.

### 3.3 Queue / uploader
- Encrypted spool, at-least-once uploader with Phase 1 batchId/batchSeq.
- Agents unchanged by Phase 3 (prefer ZERO agent changes — the agent remains
  a telemetry collector; classification is server-side).

## 4. Cross-repo contract facts

- Activity payload `{ activities, batchId?, batchSeq? }` unchanged; agent
  category is a *hint* the server will override only when org opts in.
- Old agents (no batch metadata) continue accepted; old agents sending any
  category are accepted; server never requires an agent upgrade.

## 5. Gaps Phase 3 must fill (verified)

1. No server-authoritative classification (allowlist only).
2. No CategoryRule model/API/UI.
3. No admin rule-management surface.
4. No documented working-hours/break interplay for classification decisions
   (today: agent gates collection; server stores whatever passes allowlist).
   Phase 3 documents + tests semantics: idle/break rows never reclassified;
   out-of-hours rows keep deterministic identity classification (uniform hour
   policy matching today's dashboard, which buckets all hours equally).
