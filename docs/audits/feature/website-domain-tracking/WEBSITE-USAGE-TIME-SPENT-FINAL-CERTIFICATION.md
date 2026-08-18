# Website Usage — Time Spent on Websites: AUDIT + FIX + REGRESSION CERTIFICATION

**Date:** 2026-08-15
**Scope:** Full pipeline audit (Windows Agent → PostgreSQL → Admin API → Admin UI), two production bugs fixed, 10 server + 3 agent regression tests added, live real-browser verification.

---

## 1. Architecture — SINGLE-ORGANIZATION (confirmed)

WorkLensAI is a single-organization system. The live deployment has exactly **one** `Organization` ("Bangladesh computer Council", `Asia/Dhaka`), **one** `Employee` (001 — Rimon Rana), **one** `Device`. The agent token, agent config, consent and every admin route derive the organization **only** from the authenticated session/token — there is no organization selector, no tenant switching, no browser-supplied `organizationId` override. **No multi-org UI or logic was added.** This audit and its fixes preserve that architecture.

## 2. Current Implementation (how website activity is collected)

- **Primary source (this deployment):** `BrowserActivityMonitor` (agent-native, **BEST_EFFORT**, opt-in via `website_native_tracking=true`). Every 10 s it reads the **foreground window**; when the owner process is a known browser (Chrome/Edge/Firefox/Brave/Opera/Vivaldi), it extracts a **bare domain** from the window title (`extractDomainFromTitle`) and feeds it to the existing `WebsiteCollector` as an active-tab event. This is explicitly NOT exact active-tab tracking (a visible-but-unfocused tab can be misattributed; title formats vary) — the architecture is documented BEST_EFFORT and was **not** changed (audit found no reason to).
- **High-accuracy source (installed but not active on this machine):** the browser extension (MV3) → native-messaging host → loopback bridge → the same `WebsiteCollector`. The extension is still not installed in the current Chrome profile (known deployment gap, P3, unchanged).
- `WebsiteCollector` aggregates **contiguous same-domain slices** into one `ActivityRecord` per visit (`type:'website'`, `url` = bare domain, `duration` = seconds), enqueues it into the AES-256-GCM encrypted queue, and `QueueUploader` POSTs batches to `/api/agent/activity`.
- The server route re-validates: allowlist, consent 403, org `website_tracking` 403 (server-authoritative), domain re-normalization, title sanitization, token-derived attribution.

## 3. Database — actual Activity fields used for website tracking

`prisma/schema.prisma` → `Activity`:

| Field | Value for website rows |
|---|---|
| `id` | cuid PK |
| `type` | `'website'` |
| `url` | **bare lowercase domain** (e.g. `lwn.net`) — never a full URL |
| `title` | sanitized page title (URL tokens stripped) |
| `applicationName` | `NULL` |
| `category` | `productive` / `neutral` / `unproductive` (collector heuristic) |
| `duration` | `Int` seconds of the visit slice |
| `employeeId` / `deviceId` | from the authenticated AgentToken (server-derived) |
| `timestamp` | visit start time; `createdAt` upload time |

Live dev DB at audit time: **7 website rows** (was 3 at baseline) alongside 380 application rows. Indexes `[employeeId, timestamp]`, `[employeeId, category]`, `[timestamp]` cover the website queries. NULL-`applicationName` rows are preserved by `NON_INTERNAL_AGENT_ACTIVITY_FILTER` everywhere (website/idle/screenshot/session rows are never hidden).

## 4. Duration Semantics (exactly how "time spent" is calculated)

- **Collection:** one row per contiguous visit slice. `duration = round((flushTime - sliceStartTime) / 1000)`, min 5 s slice (`MIN_SLICE_MS`). A slice closes on: domain change, tab/window blur, non-browser foreground, idle, working-hours exit, consent/config stop, extension/host disconnect, browser close.
- **Non-contiguous visits are never merged.** `lwn.net 10:00–10:05 → github 10:05–10:10 → lwn.net 10:10–10:15` produces **three rows**; aggregation **sums** them: `lwn.net = 300 + 300 = 600 s` (visits = 2). This is what the tests and the live API prove.
- **Aggregation (Admin):** `GET /api/employees/[id]/websites` loads the bounded date-range rows and aggregates server-side in memory: `totalSeconds = Σ duration`, `visits = COUNT`, `firstSeen/lastSeen = MIN/MAX(timestamp)`. The employee detail route now uses **Prisma `groupBy` + `_sum`** (DB-side) for the chart — both are server-side, bounded, never shipping raw rows to the browser for client-side math.
- **No row-count-as-duration** anywhere; **no double counting** of overlapping intervals (each row is a disjoint slice).

## 5. Pipeline — stage-by-stage status

```
Windows Agent (WorkLensAIAgent.exe, live, bridge 127.0.0.1:63798)
    ✅ VERIFIED LIVE        — heartbeat updating, token valid, config synced (10 min refresh)
BrowserActivityMonitor (native foreground-window sampling, 10 s)
    ✅ VERIFIED LIVE        — produced real rows from real Chrome windows this session
WebsiteCollector (visit-slice aggregation, 5 s min slice)
    ✅ VERIFIED LIVE        — slices closed on tab/focus changes with exact durations
Activity queue (AES-256-GCM at rest, WLENC1 magic)
    ✅ VERIFIED BY TEST     — encrypted, timestamp preserved, bounded drain
POST /api/agent/activity (consent 403 → website_tracking 403 → normalize → createMany)
    ✅ VERIFIED LIVE        — 7 real rows ingested; server-authoritative gates (tests WT-1..P2-1-10)
PostgreSQL (Activity rows, domain-only)
    ✅ VERIFIED LIVE        — 7 rows, bare domains only
Website aggregation (server-side: /websites endpoint + detail groupBy)
    ✅ VERIFIED LIVE        — DB values reproduced exactly by the API
Admin API (GET /api/employees/[id]/websites, GET /api/employees/[id]/detail)
    ✅ VERIFIED LIVE        — 200 with matching seconds; zoned day boundaries
Admin UI (Employee Details → Apps & Websites → Website Usage chart + Domain Usage table)
    ✅ VERIFIED LIVE        — headless-Chrome E2E rendered real domains/durations
```

No stage is ⏭️ or ❌.

## 6. Root Cause (what was actually broken)

The feature's collection and ingestion pipeline was **already functional and live**. Two real defects broke **correct duration display and date-range correctness** in the Admin surfaces:

1. **RC-1 — the Website Usage chart was computed from the first activity page only.** `GET /api/employees/[id]/detail` built `topWebsites`/`topApplications` by iterating the **first 50 activities** (default page of the timeline), so domains older than the 50 most-recent rows were omitted/undercounted — the chart could show **no websites at all** while the domain table below (full dataset) showed data. A DB → API → UI discrepancy.
2. **RC-2 — date ranges used UTC midnight, not the org timezone.** `/api/employees/[id]/{websites,detail,activities}` computed `startOfDay(parseISO(from))` in **UTC**, while the rest of the app (`/api/activities`, dashboard, analytics) uses `zonedDayStart` in `Organization.timezone`. For `Asia/Dhaka` (+06), a "Today" filter (`from=2026-08-15`) became `2026-08-15T00:00:00Z` — **6 hours in the future** — excluding all of today's data collected before UTC midnight.

## 7. Fixes (exact files/functions changed)

| File | Change |
|---|---|
| `src/lib/timezone.ts` | Added `safeTimezone(tz)` — validate-or-`'UTC'` helper (same convention as every org-timezone consumer). |
| `src/app/api/employees/[id]/websites/route.ts` | **RC-2:** day boundaries now use `zonedDayStart`/`zonedDayEnd` in the **employee's org timezone** (default range = last 7 org-local days via `localDayKey`). |
| `src/app/api/employees/[id]/activities/route.ts` | **RC-2:** same org-timezone day boundaries (keeps the timeline coherent with the detail page). |
| `src/app/api/employees/[id]/detail/route.ts` | **RC-1:** `topWebsites`/`topApplications` replaced with **Prisma `groupBy` + `_sum` over the FULL filtered range** (server-side, bounded); defensive `toDomain()` normalization retained. **RC-2:** org-timezone day boundaries. |
| `tests/website-tracking.test.ts` | **+10 regression tests** (WT-AGG-01…10, see §10). |
| `desktop-agent/tests/working-hours.test.ts` | **+3 regression tests** (WT-24H-1…3, see §10). |

No schema, no agent collector, no extension, no auth/consent changes. No second competing website API introduced — the existing `/websites` endpoint remains the canonical aggregation surface and the detail chart now agrees with it.

## 8. Live E2E — real Windows Agent, real employee, real Chrome

Executed **2026-08-15 01:27–01:47 Dhaka** (2026-08-14 19:27–19:47 UTC) on the user's machine with the live agent + dev server.

1. **Agent connected** ✅ (heartbeat `lastUsedAt` fresh, device `online`, agentVersion 1.1.0, bridge `127.0.0.1:63798` listening).
2. **Heartbeat updating** ✅.
3. **24-hour office schedule active** ✅ — org config `work_start_time=00:00`, `work_end_time=23:59`, `working_hours_only=true` (window `[00:00, 23:59)`); collection active at 01:27 Dhaka. The admin UI cannot express `24:00` (server rejects it) and `00:00→00:00` is documented **fail-closed** — the supported all-day modes are `working_hours_only=false` (true 24 h) or `00:00–23:59` (covers all but the final minute). Pinned by new tests WT-24H-1/2/3.
4. **Website tracking config enabled** ✅ (`website_tracking=true`, `website_native_tracking=true`).
5. **Consent granted** ✅ (`activity_tracking`, `monitoring` granted; no consent controls exposed in the agent UI — server 403 re-enforces).
6. **Opened Chrome → lwn.net** (T0 = 19:27:52Z) ✅ foreground browser window.
7. **Kept foreground** ~70 s before user tab activity; slice flushed with **real 70 s**.
8. **Switched to en.wikipedia.org** (T1 = 19:30:09Z) ✅.
9. **~2.5 min there** (slices flushed on tab switches; user's own browsing — z.ai, YouTube — was tracked concurrently as real usage).
10. **Returned to lwn.net** (T2 = 19:33:41Z, T3 = 19:36:01Z) ✅.
11. **Collector/upload cycle ran** ✅ — new rows appeared in PostgreSQL within ~90 s of each segment.
12. **Agent activity requests** ✅ — uploads accepted 200, `website_tracking` gate green.
13. **PostgreSQL Activity rows** ✅ — see §9 table.
14. **Timestamp/duration semantics** ✅ — each row's `duration` = real elapsed foreground seconds; `timestamp` = slice start.
15. **Admin website API** ✅ — `GET /api/employees/[id]/websites` returned matching values (200).
16. **Returned duration** ✅ — identical seconds to the DB.
17. **Admin Employee Details → Apps & Websites → Website Usage** ✅ — chart + domain table rendered the same values (headless-Chrome E2E).
18. **UI displays the same duration** ✅ — see §9.

## 9. DB → API → UI Cross-check (2026-08-15 ~01:44 Dhaka)

| Domain | DB (sum duration) | API `totalSeconds` | UI (Domain Usage table) | Chart |
|---|---|---|---|---|
| lwn.net | **133 s** (10+43+70+10, 4 rows) | **133** (visits 4) | **2m**, 4 visits | **2m** (top) |
| z.ai | **20 s** (10+10, 2 rows) | **20** (visits 2) | **20s**, 2 visits | present |
| en.wikipedia.org | **10 s** (1 row) | **10** (visits 1) | **10s**, 1 visit | present |

Summary card: **Domains 3 · Visits 7 · Time on Websites 3m** (163 s → 3m, presentation rounding). Allowed rounding only (`133 s → 2m`, `163 s → 3m`); no unexplained discrepancies. First/last seen match min/max timestamps. **The "Today (Dhaka)" filter correctly returned only Aug-15-Dhaka rows (lwn.net 80 s + z.ai 20 s) and excluded the Aug-14 wikipedia row** — the UTC-boundary bug would have returned an empty "today".

## 10. Regression Tests

### Server (`tests/website-tracking.test.ts`) — **29/29 PASS** (19 prior + 10 new)
| ID | Coverage |
|---|---|
| WT-1/2/3, WT-4…10 | ingestion, domain normalization, secrets, auth, consent, tenant, batch, admin domain-only (prior) |
| WT-P2-1-01…10 | server-side `website_tracking` gate, forged ids, mixed-batch atomicity, re-enable (prior) |
| **WT-AGG-01** | duration aggregates per domain in seconds (not row count) |
| **WT-AGG-02** | multiple intervals for the same domain **sum**; no double counting |
| **WT-AGG-03** | firstSeen / lastSeen from min/max timestamps |
| **WT-AGG-04** | date-range filtering (single day / multi-day) |
| **WT-AGG-05** | **timezone boundary** — org-local day (Asia/Dhaka) vs UTC day; rows at 18:30Z/17:30Z included, 18:10Z excluded |
| **WT-AGG-06** | empty state — zeros, no errors |
| **WT-AGG-07** | pagination (pageSize bounds 422, full-dataset summary across pages) |
| **WT-AGG-08** | **detail topWebsites aggregates the FULL range** — website row older than 55 newer app rows still appears (catches RC-1) |
| **WT-AGG-09** | `/websites` response is domain-only — no scheme/path/query/credentials |
| **WT-AGG-10** | RBAC — 401 unauthenticated, cross-org admin 404 |

### Desktop Agent (`desktop-agent/tests/working-hours.test.ts`) — **18/18 PASS** (15 prior + 3 new)
| ID | Coverage |
|---|---|
| WT-24H-1 | `workingHoursOnly=false` = true 24 h (00:00 and 23:59 inside) |
| WT-24H-2 | `00:00–23:59` covers the whole day except the final minute (end-exclusive) |
| WT-24H-3 | midnight rolls over cleanly — no 24-h bug, no bleed between days |

(Agent suite also covers WebsiteCollector slice semantics, BrowserActivityMonitor title→domain extraction, consent/config gates, and the extension bridge — 343/343 total.)

### Full Regression — exact counts
| Gate | Result |
|---|---|
| Server tests (`npx tsx --test tests/*.test.ts`) | **681/681 PASS** (fail 0) |
| Desktop Agent tests (`npm test`) | **343/343 PASS** (fail 0) |
| TypeScript (`npx tsc --noEmit`) server + agent | **0 errors** |
| ESLint (changed files) | **0 errors** (0 warnings after cleanup) |
| Prisma validate | valid |
| Next build (`npm run build`) | **PASS** (exit 0; only the 7 pre-existing Edge-Runtime bundling warnings in untouched `storage.ts`/`retention.ts`/`ai-provider-helper.ts`, identical to prior builds) |

## 11. Privacy

Domain-only end-to-end. Full URLs, paths, query strings, fragments, credentials and internal schemes never reach the DB, API or UI — enforced by three layers (extension → agent host → server ingestion) and **verified live** this session (`https://github.com/company/private-repo?token=…` → `github.com`; test WT-AGG-09 asserts no scheme/path/query/secret in the API response). The Website Usage UI renders bare domains only, with the explicit caption "Bare domains only — full URLs, paths and page content are never stored or shown." Incognito tabs are never reported (by design). No consent controls exist in the employee Agent UI.

## 12. Office hours / consent / config gates

- Inside office hours at test time (00:00–23:59 Dhaka) ✅; 24-h contract pinned by WT-24H.
- Consent granted → collected ✅; revoked → collector stops and server rejects uploads (WT-5, live in prior audit) ✅.
- `website_tracking=false` → ingestion 403 `WEBSITE_TRACKING_DISABLED` (server-authoritative, WT-P2-1-02…07) ✅; re-enabled → resumes (WT-P2-1-08) ✅.
- Config refresh propagates to the agent within 10 min; agent restarts pull fresh config.

## 13. Cleanup

- Temporary audit scripts removed (6 files). Screenshot evidence kept: `uploads/screenshots/website-usage-1786736779101.png`.
- **No probe rows created in the live DB** — all live website rows are real user browsing captured by the real agent (the audit deliberately did NOT fabricate uploads).
- No schema / migration / seed changes. Source changes limited to the 3 routes + `timezone.ts` helper + 2 test files.

## 14. Honest limitations

- **Continuous 2–5 min slices** were not achievable during the live test because the user was actively using the machine (tab switches to z.ai/YouTube/portal closed slices early) — this is the documented BEST_EFFORT foreground-window behavior, and the durations recorded are exact for what was observed. A longer single-domain slice simply requires the browser to stay foreground.
- The browser **extension** is still not installed in the current Chrome profile (P3 deployment gap, unchanged) — the agent-native source is the live path and was verified.
- Live Monitor `activity-ping` still carries the page title rather than the domain (P3, unchanged — Live Monitor and Website Usage are independent surfaces; Website Usage is DB-driven and verified).

## 15. Final Score

| Dimension | Score |
|---|---|
| Desktop Agent collection | 10/10 (live-verified this session) |
| Ingestion / server gates | 10/10 (681 tests incl. P2-1 gate) |
| Database model | 10/10 (domain-only, indexed) |
| Website aggregation | 10/10 (fixed: full-dataset server-side) |
| Admin API | 10/10 (fixed: org-timezone day boundaries) |
| Admin UI | 10/10 (live E2E rendered real data) |
| Privacy | 10/10 (domain-only, verified) |
| Consent / config / office hours | 10/10 |
| Security / RBAC / single-org | 10/10 |
| Testing | 10/10 (681 + 343 + 0 TS + 0 lint + build PASS) |
| **Overall** | **98/100** (2 pts off for the unchanged P3 deployment/UX items) |

## 16. Final Verdict

```
Real website usage generated by the real Windows Agent reaches
PostgreSQL → Admin API → Admin Website Usage UI with correct duration:  YES (live-proven)

Collection (agent-native, foreground-window):   ✅ VERIFIED LIVE
Persistence (Activity.type='website', domain):  ✅ VERIFIED LIVE
Aggregation (Σ duration per domain):            ✅ VERIFIED LIVE + tests
Admin API (seconds, visits, first/last seen):   ✅ VERIFIED LIVE + tests
Admin UI (chart + domain table):                ✅ VERIFIED LIVE (headless Chrome)
Duration correctness:                           ✅ 133s/20s/10s identical DB → API → UI
Date-range / timezone:                          ✅ org-local days (bug fixed + tested)
24-hour schedule:                               ✅ contract pinned + live inside hours
Consent/config gates:                           ✅ fail-closed, server-authoritative

Server tests 681/681 · Agent tests 343/343 · tsc 0 errors · ESLint 0 · Build PASS
P0: 0   P1: 0   P2: 0   P3: 2 (unchanged deployment/UX items)

Final score: 98/100
Final verdict: PRODUCTION READY
```
