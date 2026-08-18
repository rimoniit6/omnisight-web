# Break Monitor — Production Hardening Report

**Date:** 2026-08-16
**Scope:** Production-hardening pass over the Break Monitor / Privacy Break feature, driven strictly by the findings in `BREAK-MONITOR-PRODUCTION-AUDIT.md` (F-01 … F-19).
**Mode:** Implementation (all changes are code/schema/docs/tests — no production data was touched; the only DB writes were a verified local dev migration and throwaway test databases that were created and dropped by the test suites).

---

## 1. Executive Summary

The audit identified three P1 release blockers (F-01 agent end-break wrote nothing, F-02 privacy break never actually paused monitoring, F-03 self-service break route documented but nonexistent) plus a cluster of P2 issues (double-toggle race, "latest N activity" heuristics, server-local midnight day boundaries, audit-log-as-history, generic Activity retention destroying break history, missing audit actors, no dedicated break realtime events, break toggle bypassing consent).

All of these are now implemented and verified:

- **BreakSession** — a new canonical, DB-level-enforced break state model (one active break per employee, partial unique index, migration `20260816113703_add_break_session`). Legacy `Activity` mirror rows are still written transactionally so existing consumers keep working.
- **Canonical break service** (`src/lib/breaks/service.ts`) — one source of truth used by the admin toggle, agent endpoint, self-service endpoint, stats, history, reports, and retention. Idempotent, concurrency-safe, audit-aware, org-scoped.
- **Real privacy-break enforcement on the agent** — break state is fetched by the desktop agent on config sync **and** every heartbeat; while on break, all collectors (activity, website, keyboard, screenshot, webcam, location, USB, policy) pause; they resume automatically when the break ends. Fail-closed on unknown state.
- **Self-service break** — `POST/GET /api/self/break-status` implemented, Self Portal break card added, all 4 company-guide docs updated to match reality.
- **Statistics/history/reports** rebuilt on canonical state with org-timezone day boundaries (`orgDayWindow`), validated pagination, deterministic ordering — the "latest N activity rows" heuristic is gone.
- **Retention** now governs break history explicitly (`break_session_retention_days`), never deletes active breaks, and excludes break mirror rows from generic activity cleanup.
- **Realtime** — dedicated `break-started` / `break-ended` org-scoped events emitted by live-updates; the web client invalidates break caches.
- **Consent precedence** — break state and consent are independent; collectors only resume when BOTH break ended AND consent is still active (fail-closed).

**Score: 52/100 → 86/100** (all P1/P2 findings resolved; remaining items are P3 documentation/UX notes and the fact that the desktop agent's pause behavior was verified by unit tests plus an end-to-end server↔API check, not by a physical Windows agent run in this environment).

---

## 2. Before / After Score

| Category | Before | After | Notes |
|---|---|---|---|
| Functional completeness | 9/20 | 18/20 | Self-service, canonical history, error states, real pause |
| Break semantics correctness | 5/15 | 14/15 | Full lifecycle + DB-level single-active invariant |
| Security & RBAC | 12/15 | 15/15 | Server-derived identity everywhere, 401/403/404 discipline |
| Multi-tenant isolation | 10/10 | 10/10 | Unchanged — session-derived org, 404 concealment |
| Agent integration | 3/10 | 9/10 | Break enforcement wired; physical-run not verified here |
| Statistics correctness | 4/10 | 9/10 | Canonical queries; no heuristics |
| Realtime | 2/5 | 5/5 | Dedicated org-scoped events + invalidation |
| Database | 2/5 | 5/5 | BreakSession + unique index + indexes |
| Performance | 3/5 | 5/5 | GroupBy aggregations, pagination, bounded queries |
| Testing | 2/5 | 5/5 | 28 new root tests, 17 agent tests, 393+297 green |
| **Total** | **52/100** | **86/100** | |

---

## 3. Finding Status (F-01 … F-19)

| ID | Severity | Status | Evidence |
|---|---|---|---|
| F-01 | P1 | ✅ **RESOLVED** | Agent break endpoint now starts AND ends real sessions, idempotent, concurrency-safe (BH-01…BH-06, BH-10). |
| F-02 | P1 | ✅ **RESOLVED** | Agent fetches break state on config sync + every heartbeat; collectors pause/resume; fail-closed (`break-enforcement.test.ts`, agent `agent-orchestrator.ts`). |
| F-03 | P1 | ✅ **RESOLVED** | `POST/GET /api/self/break-status` implemented + Self Portal UI + all docs updated (BH-12…BH-14). |
| F-04 | P2 | ✅ **RESOLVED** | Single active break per employee enforced by DB partial unique index + transaction (BH-06, BH-18). |
| F-05 | P2 | ✅ **RESOLVED** | Privacy break actually pauses all collectors (agent orchestrator break gate). |
| F-06 | P2 | ✅ **RESOLVED** | `GET /api/break-status` uses canonical BreakSession state + DB groupBy, no `take: N×3` heuristic (BH-25…BH-28). |
| F-07 | P2 | ✅ **RESOLVED** | Break History now queries BreakSession (paginated, tz-aware, deterministic) — audit logs are audit-only (BH-22…BH-24). |
| F-08 | P2 | ✅ **RESOLVED** | `Organization.timezone` day boundaries via `orgDayWindow` across status/summary/history/daily report (BH-19…BH-21). |
| F-09 | P2 | ✅ **RESOLVED** | Canonical break history endpoint replaces the 50-row unfiltered audit-log fetch. |
| F-10 | P2 | ✅ **RESOLVED** | Retention governs break history (`break_session_retention_days`), never deletes active breaks, exempts break mirror rows from generic activity purge. |
| F-11 | P2 | ✅ **RESOLVED** | Audit logs record actor (`userId` from authenticated context), source, employee/device metadata; never client-supplied (BH-11). |
| F-12 | P2 | ✅ **RESOLVED** | Break toggle bypass no longer exists — the canonical service applies the same lifecycle everywhere. |
| F-13 | P2 | ✅ **RESOLVED** | Error semantics: 400 malformed input, 401 unauthenticated, 403 wrong role, 404 cross-org/nonexistent, 500 without Prisma leaks; UI distinguishes loading/empty/error/active/completed. |
| F-14 | P2 | ✅ **RESOLVED** | Dedicated `break-started` / `break-ended` org-scoped realtime events; web client invalidates break caches. |
| F-15 | P2 | ✅ **RESOLVED** | Daily report break minutes computed from canonical sessions (org-local day). |
| F-16 | P2 | ✅ **RESOLVED** | Toggle routes rate-limited via existing `rateLimit` in `src/proxy.ts`; validated pagination everywhere. |
| F-17 | P3 | ✅ **RESOLVED** | Live Monitor event stats still keyed off Activity mirror rows (written transactionally) — no break mislabeling. |
| F-18 | P3 | ✅ **RESOLVED** | Break semantics documented (sleep/offline/restart) in docs + code comments. |
| F-19 | P3 | ✅ **RESOLVED** | Backfill script for legitimate legacy mirror rows; retention + semantics documented. |

---

## 4. Files Changed

**Server (root):**
- `prisma/schema.prisma` — added `BreakSession` model (relations on Organization, Employee, Device).
- `prisma/migrations/20260816113703_add_break_session/migration.sql` — table + indexes + partial unique index `BreakSession_one_active_per_employee`.
- `src/lib/breaks/service.ts` — **new** canonical break lifecycle service (`getCurrentBreak`, `startBreak`, `endBreak`, `sessionDurationSeconds`, `BREAK_TITLES`).
- `src/lib/timezone.ts` — added `orgDayWindow` (org-local day window, DST-safe).
- `src/app/api/break-status/route.ts` — rewritten: canonical state, org-timezone day, groupBy last-activity, validated pagination, status filters.
- `src/app/api/break-status/summary/route.ts` — rewritten: canonical stats (currentlyOnBreak, activeNow, avg/total today, department breakdown), no heuristics.
- `src/app/api/break-status/history/route.ts` — **new** canonical, paginated, tz-aware break history.
- `src/app/api/break-status/[id]/toggle/route.ts` — uses canonical service; actor recorded; 404 concealment preserved.
- `src/app/api/agent/break/route.ts` — rewritten: idempotent start/end, server-derived identity, explicit state response.
- `src/app/api/self/break-status/route.ts` — **new** GET (current state) + POST (start/end), manager-or-above, org-scoped via `getScopedEmployee`.
- `src/app/api/agent/config/route.ts` — includes `breakModeEnabled` + current break state.
- `src/app/api/agent/heartbeat/route.ts` — includes current break state for fast agent propagation.
- `src/app/api/reports/daily/route.ts` — break minutes from canonical sessions, org-local day.
- `src/lib/jobs/settings.ts` — added `break_session_retention_days`.
- `src/lib/jobs/retention.ts` — break session retention (active breaks never purged); break mirror rows excluded from generic activity purge (incl. NULL-title fix).
- `src/lib/jobs/run.ts` — passes break retention setting through.
- `src/proxy.ts` — rate limits for break toggle + self break routes.
- `mini-services/live-updates/index.ts` — emits `break-started` / `break-ended` (org-scoped) alongside legacy `break-status`; raised break poll cap.
- `src/components/break-status/break-status-page.tsx` — canonical history, role-gated actions, error/empty states, pagination controls, page-reset without setState-in-effect.
- `src/components/self-portal/self-portal-page.tsx` — **Break card** (current state, Start/End Break, loading/error/success).
- `src/components/providers/websocket-provider.tsx` — handles `break-started` / `break-ended`, invalidates break caches.
- `src/components/live-monitor/live-monitor-page.tsx` — type fix for canonical summary payload.

**Desktop agent:**
- `desktop-agent/src/types/api.ts` — `HeartbeatResponse`/config types gain break state; `BreakInput`-style contract.
- `desktop-agent/src/services/config-service.ts` — parses + stores break state (`getBreakState`, `isOnBreak`).
- `desktop-agent/src/services/heartbeat-service.ts` — surfaces break state from heartbeats.
- `desktop-agent/src/services/agent-orchestrator.ts` — `applyBreakState` gates ALL collectors (activity, website, keyboard, screenshot, webcam, location, USB, policy) while on break; resumes on end; fail-closed; re-auth/resume respect break state.

**Tests:**
- `tests/break-hardening.test.ts` — **new**, 28 tests (lifecycle, idempotency, concurrency, cross-org, forged identity, timezone, history, RBAC, malformed input).
- `desktop-agent/tests/break-enforcement.test.ts` — **new**, 17 tests (collectors pause/resume, break state survives restart, offline, consent precedence, fail-closed).
- `desktop-agent/tests/{agent-active-device-conflict,onboarding,orphan-recovery,zero-touch,orchestrator-recover-retry}.test.ts` — config stub updated with `isOnBreak`.

**Docs / scripts:**
- `docs/company-guide/{06-activity-monitoring,17-company-operational-workflow,20-feature-matrix,FEATURE-INVENTORY,23-limitations-and-not-implemented}.md`, `docs/agent-api-contract.md`, `docs/agent-installation.md` — self-service break documented as implemented (matches reality).
- `scripts/backfill-break-sessions.ts` — **new**, one-shot migration of legitimate legacy "Break Mode …" mirror rows into BreakSession (does not fabricate history; run only if desired).

---

## 5. Database Changes

- **New model:** `BreakSession` — `id, organizationId, employeeId, deviceId?, startedAt, endedAt?, endReason?, source, startedBy?, endedBy?, createdAt, updatedAt` with indexes on org, employee, employee+startedAt, employee+endedAt, org+startedAt, org+endedAt, startedAt.
- **Partial unique index** `BreakSession_one_active_per_employee` on `(employeeId) WHERE endedAt IS NULL` — the DB-level invariant that makes concurrent double-starts impossible (the loser's transaction rolls back on the violation; the caller resolves to the winner's session).
- **Migration:** `20260816113703_add_break_session` — verified with `prisma migrate deploy`, `migrate status`, and `migrate diff` against two fresh throwaway databases; zero drift. Applied to the local dev DB (recorded in `_prisma_migrations`, table + indexes confirmed via `pg_indexes`).
- **No data migration performed** on existing records — BreakSession starts empty; legacy Activity mirror rows remain the event stream until/unless the backfill script is run deliberately.

---

## 6. API Changes

| Route | Method | Change |
|---|---|---|
| `/api/break-status` | GET | Canonical state, tz-aware day, validated pagination, deterministic groupBy |
| `/api/break-status/summary` | GET | Canonical stats, no heuristics |
| `/api/break-status/history` | GET | **New** — canonical sessions, paginated, tz-aware, employee/status filters |
| `/api/break-status/[id]/toggle` | POST | Canonical service, actor recorded, idempotent |
| `/api/agent/break` | POST | Idempotent start/end; returns `{breakMode, action, startedAt, endedAt}` |
| `/api/self/break-status` | GET/POST | **New** — self-service break state + toggle |
| `/api/agent/config` | GET | Includes `breakModeEnabled` + break state |
| `/api/agent/heartbeat` | POST | Includes break state |
| `/api/reports/daily` | POST | Break minutes from canonical sessions |

All mutations: organizationId/employeeId/deviceId derived exclusively from authenticated session/agent token; client-supplied identity ignored; cross-org → 404; wrong role → 403; unauthenticated → 401; malformed → 400; server errors → 500 without Prisma internals.

---

## 7. Desktop-Agent Changes

- Break state is now **server-authoritative**: the agent learns it from `/api/agent/config` (sync) and every heartbeat (fast path).
- `applyBreakState()` in the orchestrator gates every collector that constitutes employee monitoring — activity, website bridge, keyboard, screenshots, webcam, location, USB, and app-policy monitoring. During a break: collectors stop; on break end: collectors resume automatically (no agent restart).
- **Fail-closed:** if break state is unknown, the agent follows the existing privacy policy (does not assume "not on break"). Consent revocation independently stops collection even mid-break; collectors only resume when both conditions are satisfied.
- No queued pre-break data is dropped or fabricated; nothing is deleted.

---

## 8. Consent Behavior

- Break state and consent are **independent, both enforced**:
  - Consent granted + break → monitoring paused (break wins).
  - Consent revoked + break → monitoring stopped (both say stop).
  - Break ends + consent revoked → monitoring stays stopped (consent wins).
  - Consent re-granted + break inactive → monitoring resumes per policy.
- Starting a privacy break never requires granting monitoring consent.
- Server remains authoritative; the agent's consent gate (`consent-gate.ts`) is unchanged and still fail-closed.
- Verified by `break-enforcement.test.ts` scenarios (consent precedence).

---

## 9. Break Lifecycle Semantics (documented)

1. **What starts a break:** an admin force-toggle, an agent `POST /api/agent/break {breakMode:true}`, or self-service `POST /api/self/break-status {breakMode:true}`.
2. **What ends a break:** the matching end call (admin toggle when active, agent `breakMode:false`, self-service `breakMode:false`). Ended sessions are never reopened.
3. **Manual:** yes (admin + self-service). **Automatic (idle-derived):** no — break is NOT idle; it is an explicit, server-recorded privacy session. Idle/offline presence remains a separate status axis.
4. **Keyboard/mouse/activity:** do not end a break (only an explicit end call does).
5. **Heartbeat/disconnect/offline/restart:** break state lives in the DB and survives all of these; an offline agent simply can't send break toggles, and on reconnect it re-fetches the authoritative state. Device sleep/wake does not corrupt sessions (timestamps are DB-clock based).
6. **Midnight/timezone:** all "today" windows use `Organization.timezone` via `orgDayWindow`; a session overlapping the boundary is counted in each day it overlaps, with duration clamped to that day's window.
7. **Restart during break:** the agent resumes on break if the server says break is active — collectors stay paused (fail-closed).

---

## 10. Realtime Architecture

- `mini-services/live-updates` polls real `Activity` mirror rows (written in the same transaction as `BreakSession`) and emits:
  - legacy `break-status` (backward compatible),
  - dedicated `break-started` / `break-ended` events — all to the **org room only** (`io.to('org:' + employee.organizationId)`).
- The web client (`websocket-provider.tsx`) listens for the dedicated events and invalidates `break-summary`, `break-status`, `break-history`, dashboard, and live-monitor caches.
- Org isolation: event rooms are keyed by the employee's organizationId from the DB row — cross-org leakage is structurally impossible (verified by design + ws-invalidation tests).

---

## 11. Retention Behavior

- **BreakSession retention** (`break_session_retention_days`, default 0 = keep): only **ended** sessions older than the cutoff are purged. **Active breaks are never deleted** by retention.
- Break mirror `Activity` rows are **excluded** from generic `activity_retention_days` cleanup (they back the realtime/report event stream); they are purged only with their sessions in the BreakSession pass.
- Audit logs for break actions follow `audit_log_retention_days` (anonymized, never deleted).
- Documented in `src/lib/jobs/retention.ts` comments and this report.

---

## 12. Security / RBAC Verification

| Actor | Admin toggle | Agent break | Self break | History/Status |
|---|---|---|---|---|
| Unauthenticated | 401 | 401 | 401 | 401 |
| Viewer | 403 | — | 403 | 200 |
| Manager | 403 | — | 200 (own org) | 200 |
| Admin | 200 (own org) | — | 200 | 200 |
| Agent (token) | — | 200 (own employee/device) | — | — |
| Cross-org target | 404 | n/a (identity from token) | 404 | invisible |

- Forged `organizationId`/`employeeId`/`deviceId` in any request body are ignored — identity is server-derived (BH-14, BH-17, BH-26).
- Verified by `multi-org-isolation.test.ts` (MO-22…MO-27), `break-hardening.test.ts` (BH-13…BH-17, BH-26), and `agent-hardening.test.ts`.

---

## 13. Test Results

**Root suite (tsx --test, throwaway Postgres DBs):**
- `break-hardening.test.ts`: 28/28 ✅
- `multi-org-isolation.test.ts`: 48/48 ✅
- Combined break-relevant run (19 files): **297/297 ✅**

**Desktop agent suite (tsx --test):**
- `break-enforcement.test.ts`: 17/17 ✅
- Full agent suite: **393/393 ✅**

**Typecheck / build / lint:**
- `npx tsc --noEmit` (root): ✅ clean
- `npm --prefix desktop-agent run typecheck`: ✅ clean
- `npx next build`: ✅ success (new routes `/api/break-status/history`, `/api/self/break-status` registered)
- `npm --prefix desktop-agent run build`: ✅ success
- ESLint on all changed files: ✅ clean (0 errors)

**Migration verification:**
- `prisma migrate deploy` + `migrate status` + `migrate diff` on two fresh throwaway DBs: ✅ zero drift
- Applied to local dev DB: table + all indexes (incl. partial unique) confirmed via `pg_indexes`

---

## 14. Browser Verification (REAL, headless Chromium)

Performed with a real headless Chromium session against the local dev server (test admin created, exercised, and **fully cleaned up** — no test rows remain; verified org/employee count = 0 after cleanup):

1. ✅ Login as admin
2. ✅ Sidebar renders; Break Monitor nav item present
3. ✅ Break Monitor page renders: summary cards (On Break / Active Now / Avg Break Today / Offline Today / Department Breakdown), employee table, Auto-refresh toggle, Break History button
4. ✅ Test employee listed with correct status (Offline with no device → Active after a fresh-heartbeat device was added)
5. ✅ **Force Break** clicked → confirm dialog → break created (verified in DB: `BreakSession` row with `source=admin`, open)
6. ✅ UI flipped: employee shows **End Break**; summary "On Break" updated
7. ✅ **End Break** clicked → confirmed → toast **"Break ended for Test Employee"**; summary "On Break 0"; employee back to Active with tracked break time ("1m")
8. ✅ No 5xx responses, no page console errors (401s are the expected pre-login `/api/auth/me` probes)
9. ✅ History/duration semantics visible (break time column updated)

Cleanup: removed the org, admin user, employee, device, sessions, activity, and audit rows created for the check — verified `leftoverOrgs: 0, leftoverEmployees: 0`.

**Not verified here:** the desktop agent's physical collector pause on a real Windows host (this environment cannot run the agent EXE). That behavior is covered by 17 agent unit tests and the server↔agent contract is verified; a physical smoke test is listed as the one remaining limitation.

---

## 15. Build / Typecheck / Lint Results

See §13. All green.

---

## 16. Migration Verification

- Migration `20260816113703_add_break_session` created, hand-augmented with the partial unique index, then verified via `prisma migrate deploy` + `migrate status` + `migrate diff` on two fresh throwaway databases (no drift).
- Applied to the local dev DB (recorded + DDL present; pre-existing unrelated drift in the dev DB from earlier `db push` usage was left untouched).

---

## 17. Remaining Limitations (P3 / environment)

1. **Physical agent smoke test** — collector pause/resume was verified by unit tests and the API contract; a real Windows agent run against the dev server is the only remaining physical verification.
2. **Backfill is opt-in** — legacy mirror rows are not auto-migrated into `BreakSession`; run `scripts/backfill-break-sessions.ts` if historical session-based reporting is required.
3. **Self-service portal** uses the same manager-or-above gate as other `/api/self/*` routes (an admin manages an employee's break from the portal); a pure "employee clicks their own break" flow would need an employee-identity session, which does not exist in this product — docs now say exactly that.
4. The two pre-existing dev-DB migrations (`policy_management`, `notification_alerting_hardening`) are unrelated drift that predates this work.

---

## 18. Production Verdict

**PRODUCTION READY WITH LIMITATIONS.**

- No P1 or P2 finding remains unresolved.
- All critical behavior is implemented, tested (28 + 17 new tests), typechecked, built, migration-verified, and browser-verified end-to-end.
- Remaining items are P3 documentation/UX notes and the physical agent smoke test (environment-limited, not code-limited).

---

## 19. Verification Status

| Gate | Status |
|---|---|
| Root typecheck | ✅ |
| Agent typecheck | ✅ |
| Root tests (break-relevant, 297) | ✅ |
| Agent tests (393) | ✅ |
| `next build` | ✅ |
| Agent build | ✅ |
| ESLint (changed files) | ✅ |
| Migration deploy/status/diff (throwaway) | ✅ |
| Browser E2E (login → toggle → end → cleanup) | ✅ |
| Test data cleanup verified | ✅ |
| Production DB untouched | ✅ (dev DB only; migration + throwaway test DBs) |

---

## 20. Change Safety

- **No destructive commands run.** No production DB touched.
- Unrelated working-tree changes (the pre-existing rebrand + policy/notification work) were preserved; the only revert performed was restoring two native build artifacts (`launcher.obj`, `worklens-native-host.exe`) that a background build had rewritten — they are unchanged by this work.
- All temporary browser scripts and test DBs were removed.
- The migration is additive (new table), so a rollback is a single `DROP TABLE "BreakSession"` (migration history records it).
