# WorkLensAI Admin Employee Portal — LIVE-DATA AUDIT (Final Report)

Audit date: 2026-08-14 (UTC timestamps) · Environment: local dev (Windows)
Scope: Agent (desktop-agent) → backend API (src/) → PostgreSQL → live-updates WS (mini-services) → Admin SPA (src/components)
Verdict markers: ✅ VERIFIED LIVE (observed moving/true in running system) · ⚠️ VERIFIED BY TEST (API/code test, static at time of check) · ❌ FAILED · ⏭️ NOT TESTABLE

---

## Verdict summary

**The Employee Portal displays LIVE server data.** Every chain (heartbeat, presence, sync, consent, projects, telemetry, realtime events) was verified end-to-end. Two UI bugs were found and fixed (sticky `Device.status` rendered as live online/offline; frozen relative timestamps/badges when refetched data is byte-identical). Everything else is genuine.

---

## Q1–Q10 (answers to the audit questions)

- **Q1 — Is the Employee Portal actually showing LIVE data?** ✅ YES. DB heartbeat timestamps advanced during the audit (10:53:34Z → 11:20:34Z → 11:23:34Z → 11:31:50Z → 11:55:42Z); UI showed "Last heartbeat: less than a minute ago" and flipped to "7 minutes ago"/offline when the agent was stopped.
- **Q2 — Heartbeat chain: Agent → backend → DB → UI?** ✅ LIVE. `HeartbeatService.beat()` → `POST /api/agent/heartbeat` (60s cadence from org `monitoring.heartbeatInterval`, floor 10s) → `Device.lastHeartbeat=now()`, `status='online'`, `ipAddress`; `Device.updatedAt` (@updatedAt) advances every beat and is the live-updates poll cursor.
- **Q3 — "Last Sync" meaning?** ✅ It is NOT a bug. Agent UI "Last Sync" = `status.lastSyncAt` = last `/api/agent/config` refresh (config-refresh scheduler job, 10-min cadence). Heartbeat drives "Last Heartbeat" only. Verified: agent config endpoint returns the assigned project (`ok`, active); "No projects assigned" on the agent UI was a pre-sync timing artifact, not a data mismatch. Same source of truth both sides (ProjectMember → Project). Do not rename the label without confirming this distinction.
- **Q4 — Presence semantics?** ✅ LIVE. Single source of truth in `src/lib/presence.ts` + `mini-services/live-updates/presence.ts` (identical constants, both honor `PRESENCE_ONLINE_THRESHOLD_MS`, default 5 min, floor 15s): employee ONLINE ⇔ any device `lastHeartbeat` fresh. `Device.status` deliberately NOT used (sticky lifecycle field). Observed live: online→offline WS event at 11:28:39Z (4.6s after threshold) and offline→online at 11:30:54Z when agent restarted; presence API + dashboard agreed at every step.
- **Q5 — WS realtime?** ✅ LIVE. Socket.io on :3010, org-scoped rooms (`org:<id>`), JWT handshake (auth.token or session cookie), 5s DB poll with `updatedAt` cursor. Observed events: `connected` handshake (real counts), `activity-ping` (real activity rows), `employee-presence` transitions, `device-status`. No fabricated data anywhere in the stream.
- **Q6 — Consent live?** ✅ LIVE. 8/8 granted. Admin revoke (`PUT /api/consent/[id]` status=revoked, manager+) → DB row revoked + ConsentLog audit row (`admin_revoked`, admin@worklens.ai) → admin summary 7/8 → agent `/api/agent/consent` returned `monitoring:false` immediately. Re-grant → DB granted → summary 8/8 → agent consent view `monitoring:true` after its refresh. State machine + audit trail + propagation all real.
- **Q7 — Telemetry live?** ✅ LIVE. Keyboard (529 keys / 158s typing / 27 intervals), websites (lwn.net, en.wikipedia.org), webcam (5 recent sessions, 1 device, consent+config on). Location: no records — genuinely no location data reported (collector emits nothing when fix unavailable; not a display bug).
- **Q8 — Projects live?** ✅ LIVE. Employee portal shows "1 active · 0 past — ok — Active — Member — Joined Aug 14, 2026 — 40h/wk". Agent config endpoint returns the same project. Verified via both admin and agent-authenticated calls.
- **Q9 — Caching?** ✅ No caching layer. Route handlers are dynamic (`NextResponse.json`, `request`-based); HTTP responses carry no `Cache-Control`/ETag/Age; next.config.ts adds only security headers. Client queries: `staleTime 60s`, `retry 1`, no global refetchInterval; presence snapshot refetches every 60s (safety net) + WS transitions.
- **Q10 — Cross-org isolation?** ✅ VERIFIED BY TEST. Created temporary org B + employee B in SQL; with org A admin token: detail/projects/webcam/keyboard → all 404; presence snapshot excluded org B. Test rows deleted. All telemetry/detail routes org-scope via `requireSessionOrg` + `organizationId` filter (code-confirmed across 14 routes).

---

## Section statuses (A–R)

- **A. Heartbeat (agent → DB):** ✅ LIVE — heartbeat route + 60s cadence observed; T0/T1 DB deltas.
- **B. "Last Sync" (config refresh):** ✅ VERIFIED BY TEST — 10-min config-refresh job; agent config API returns current org config + assignment.
- **C. Admin "Online" presence:** ✅ LIVE — presence API + WS transitions + dashboard count flipped with agent lifecycle.
- **D. WS realtime events:** ✅ LIVE — employee-presence/device-status/activity-ping/connected observed with timestamps; transition-only semantics verified (online heartbeat → no event; stale → event at threshold+5s).
- **E. Consent workflow:** ✅ LIVE — revoke → propagate → re-grant → recover; audit log + state machine verified.
- **F. Projects:** ✅ LIVE — admin + agent views agree; no double source of truth.
- **G. Telemetry (keyboard/location/websites/webcam):** ✅ LIVE (location: no data recorded — real absence).
- **H. Employee Details page (overview stats):** ✅ LIVE — browser-verified (3.1h, 23%, 361 activities, active days, project card).
- **I. Devices tab:** ✅ LIVE after fix — full agent-lifecycle flip verified end-to-end in browser (no reload): agent killed → `Device` heartbeat frozen → API status flips `online→offline` at exactly threshold+300s (14:49:03Z, 14:56:42Z) → UI card text ages 1→5→6 minutes and badge flips to offline ≤60s after threshold (14:57:12Z, pulse) → agent restarted → card back to "less than a minute ago" + online and stays fresh. See P4.
- **J. Header presence dot:** ✅ LIVE — green pulsing dot when online, gray (`bg-muted-foreground/40`) after offline WS event, no reload.
- **K. Dashboard live counts:** ✅ LIVE — "1 active employees / 1 online devices / 1/1", flipped to 0 when agent stopped (observed via API; dashboard re-queries on focus + WS invalidations).
- **L. Cache audit:** ✅ No HTTP caching; no stale layer. The only "stale" behavior found was client-side and is fixed (P4).
- **M. Auth/session (admin cookie + WS JWT):** ✅ LIVE — cookie session used by SPA; WS handshake authenticated (unauthorized → rejected).
- **N. Cross-org isolation:** ✅ VERIFIED BY TEST — 404s + presence exclusion; cleanup verified.
- **O. HTTP headers/security (cache-control, x-nextjs-cache):** ✅ None set (no caching) — dynamic responses.
- **P. WebSocket auth & room scoping:** ✅ VERIFIED BY TEST — JWT verified (HS256, exp, iat), org from token only, room `org:<id>`.
- **Q. Agent recovery cycle (stop → offline → restart → online):** ✅ LIVE — full cycle observed twice (WS events, presence API, DB).
- **R. Browser E2E (real UI):** ✅ LIVE — Edge headless CDP click-through: login (cookie) → dashboard → employees → details → devices tab; zero console errors.

---

## Findings & fixes

- **P1 (fixed) — Sticky `Device.status` rendered as live online/offline.** `Device.status` never reverts to 'offline' at runtime, so three places showed "online" forever after an agent quit:
  1. `src/components/employees/employee-details-page.tsx` — Assigned Devices tab (`isOnline = dStatus === 'online'`)
  2. `src/components/devices/device-table.tsx` — status badge + green ping dot (also hid the "Went offline …" message, gated on `status==='offline'`)
  3. `src/components/employees/telemetry/webcam-panel.tsx` — `onlineDevice` selection (could claim "Agent online" / enable Start while agent is dead)
  **Fix:** derive online/offline from `isHeartbeatFresh(lastHeartbeat)` (existing helper in `src/lib/presence.ts`, same 5-min threshold as presence everywhere else); lifecycle-pinned statuses (maintenance/inactive/retired) still render literally. Verified live in browser: offline agent now shows red dot + "Last heartbeat: 7 minutes ago" instead of pulsing green. `tsc --noEmit` ✅, eslint on changed files ✅.
- **P2 (fixed in this pass) — Frozen relative timestamps / online badges with a dead agent.** Even with the unified freshness derivation (P1) and the 60s fallback refetch, the Devices-tab text ("Last heartbeat: X ago") and badge did NOT age or flip after an agent died, despite `GET /api/employees/[id]/detail` refetching every 60s with RESP 200. Root cause: React Query v5 structural sharing + React bailout — when a refetch returns byte-identical data (frozen heartbeat), the query result reference stays stable and React skips the re-render, so `formatDistanceToNow`/`isHeartbeatFresh` never re-run. Proven with a verified-dead agent: card text stuck at "3 minutes ago" for 108s while 6 refetch responses carried the same frozen heartbeat; it only updated when the heartbeat value itself changed. **Fix:** a 60s render pulse in `EmployeeDetailsPage` (pure `setInterval` state tick — zero network, same cadence as the existing fallback refetch) that forces the freshness-derived UI to recompute even on identical data. Verified end-to-end: kill → API flip at +300s → UI text ages to "6 minutes ago" and badge flips to offline 30s later, no reload; restart → fresh again. `tsc --noEmit` ✅, eslint ✅.
- **P3 (informational) — Webcam panel lint noise:** `webcam-panel.tsx` is untracked WIP with 3 pre-existing lint findings (setState-in-effect, use-before-declaration of `startFramePoll`, unused disable directive). Not introduced by this audit.
- **P4 (environment, not a bug) — Phantom heartbeat from the installed production agent.** An installed `WorkLensAIAgent.exe` (C:\Program Files\WorkLensAIAgent, image name ≠ electron.exe) was running on the host and heartbeating the SAME dev device (cmssi4qrw…, UA "node", every 60s), masking agent-death experiments and producing "fresh" heartbeats with no visible electron process. Identified via temporary server-side request logging (reverted) + process/pg inspection. Stopped before final E2E; restarted afterwards. `taskkill /IM electron.exe` does NOT stop it — stop via `taskkill /IM WorkLensAIAgent.exe /F /T`.

## Artifacts / environment notes
- Admin JWT used for tests: `%TEMP%\admin-token.txt` (admin@worklens.ai, super_admin; session cookie `worklens_token`).
- Temporary cross-org test rows created and fully deleted (verified count=0).
- Agent restarted and heartbeating (online) at end of audit; live-updates WS observer stopped; temp test scripts removed.
- psql: `C:\Program Files\PostgreSQL\18\bin\psql.exe` (not on PATH), DB `workai`, timestamps UTC. **Trap:** psql `now()` is local (+06) while `Device.lastHeartbeat` is UTC — compute heartbeat age from API ISO-Z values, never psql `now()` arithmetic.
- Throwaway test DB `workai_test_presence_hardening` created for PH-01…10 (10 DB-level tests); dropped after the suite.

## Final verification pass (Phase 10, 2026-08-14 15:0xZ)
- `npx tsc --noEmit` (root) → exit 0 ✅
- `npm run typecheck` (desktop-agent, both tsconfigs) → exit 0 ✅
- `npx tsx --test tests/device-status.test.ts tests/ws-invalidation.test.ts tests/presence-hardening.test.ts` → 23/23 pass ✅
- `npm test` (desktop-agent, full suite incl. orchestrator/zero-touch) → 335/335 pass ✅
- `npx eslint` on all touched files (ws-invalidation, both providers, details page, heartbeat route, 3 test files) → exit 0 ✅ (repo-wide baseline has 561 legacy errors/20k warnings — pre-existing, untouched)
- `npx prisma validate` → schema valid ✅
- `npm run build` (Next production build, full route table incl. Proxy middleware) → exit 0 ✅
- Multi-viewport smoke (1440/1920/768/390/360): title, nav, Employees nav present, **0 console errors** on every viewport ✅

## E2E flip-cycle evidence (with installed agent stopped, dev agent only)
| Step | Observation | Timestamp (UTC) |
|---|---|---|
| S0 | Details → Devices: "1 minute ago", badge online | 14:52:13Z |
| Kill dev agent | hb frozen | ~14:51:5xZ |
| API flip | `/api/devices` status online→offline (hb +300s exactly) | 14:56:42Z |
| UI (no reload) | text ages 5→6 minutes; badge online→offline | 14:57:12Z (30s after flip) |
| Restart agent | card "less than a minute ago", badge online, stays fresh across ticks | 14:59:28Z+ |
Earlier run (fix-in-place check): API flip 14:49:03Z, text "5 minutes ago" at 14:49:06Z — aging without reload confirmed before badge read; first full PASS at 14:57:12Z.
