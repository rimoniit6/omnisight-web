# LIVE MONITOR — EVENT STATS P2 HARDENING CERTIFICATION

**Date:** 2026-08-13
**Scope:** LM-P2-1 (stale mini-schema) + LM-P2-2 (DB-backed Event Stats) only. P3s untouched.

---

## Before

```
84/100   P0=0  P1=0  P2=2  P3=6
```

## After

```
94/100   P0=0  P1=0  P2=0  P3=6 (all six P3s deferred, unmodified — see below)
```

---

## P2-1 Result — Stale Prisma Schema / Deployment Risk: PASS

| Step | Result |
|---|---|
| Stale schema resolved | Deleted `mini-services/live-updates/prisma/schema.prisma` (16-model stale copy missing `UsbEvent` et al.) |
| Authoritative Prisma source | Mini-service now generates **only** from the root `prisma/schema.prisma` (30 models). `package.json` gains `generate`/`validate` scripts + `prisma.schema` pointer: `../../prisma/schema.prisma`. Runtime `@prisma/client` resolves to the single root client (verified: 30 models incl. `usbEvent`). |
| Clean generate result | `prisma validate` from mini dir → **valid 🚀**; `prisma generate --schema ../../prisma/schema.prisma` from a clean checkout of the schema → **Generated Prisma Client (v6.19.3)** with all required poll models present (device, activity, notification, screenshot, agentRegistration, usbEvent, employee, department). |
| Clean build result | TypeScript 0 errors; eslint 0 errors; `next build` PASS. |
| Runtime result | Mini-service restarted on :3010 — startup model smoke check (`assertPollModels`) passes, poll loop runs continuously. One transient P1001 (DB unavailable) at boot recovered next cycle; **0 poll errors across all subsequent cycles** (incl. the live 11/11 probe window). |
| Drift prevention | Startup now **fails loudly** (`[live-updates] Prisma client is missing required model …`) if a stale/partial client ever appears, instead of silently silencing the entire live stream (the 7 poll queries share one `Promise.all`). |

## P2-2 Result — DB-Backed Event Stats: PASS

### Authoritative statistics

New org-scoped endpoint **`GET /api/live-monitor/event-stats?range=today|24h|7d`**
(`src/app/api/live-monitor/event-stats/route.ts`):

- Organization identity always from the verified session JWT (`requireSessionOrg`) — never a client parameter. Org-less super_admin receives a valid EMPTY stat set (never global data).
- Time window validated: `today` (org-local calendar day via `zonedDayStart`/org timezone), `24h`, `7d`; invalid range → 400.
- Server-side **COUNT aggregations** (no row fetching, no JS aggregation): Device (updatedAt in window), Activity application/website (excludes Break Mode rows → each row counted once), Notification ("Alert"), Break, Screenshot, AgentRegistration, UsbEvent, plus Total.
- Break-mode rows are excluded from the activity count so **no double counting**.

### Client

`EventCountCards` in `live-monitor-page.tsx` now reads the API via React Query
(`queryKey ['event-stats', range]`, 15s refetch):

- Range toggle (Today / 24H / 7D) with truthful label: `Database window: today · Total N`.
- Loading skeleton, **error state with Retry (no fabricated numbers)**, honest 0s when empty.
- The live event log remains capped at 80 (display-only) — Event Stats and the log are now distinct concepts, as required.
- WebSocket provider invalidates `['event-stats']` on every event type (device-status, activity-ping, notification, break-status, screenshot, agent-registration, usb-event) → **new event → persisted → poll cycle → aggregation refresh → UI counter updates** (near-real-time, ≤15s, typically ~5s via invalidation).

### Required behaviors verified

| Requirement | Evidence |
|---|---|
| Reads from DB aggregation | Live: DB +1 → stats activity +1 (11/11 probe) |
| Organization-scoped | Unit ES-03/ES-04 + live forged-org probe (foreign org → 200, total 0) |
| Time range respected | Unit ES-05/ES-06 (10-day-old rows excluded from 7d; 24h == today) |
| Survives page reload | Unit ES-08 + live reload probe (same totals, no reset to 0) |
| Exceeds 80 events correctly | Unit ES-07 + live (86 counted, not 80; no decrease at 81st) |
| New events refresh stats | Unit ES-09 (total +1 after new notification) + WS invalidation wiring |
| API failure → no fabricated stats | Client `isError` state with Retry; no fallback numbers |
| Unauthorized rejected | Unit ES-01 (401), ES-11 viewer OK (page min role) |
| ORG A cannot read ORG B | Unit ES-04 + live forged-org probe |

---

## Security

- Authentication: `requireSessionOrg` — JWT-verified, session-derived (same helper as the devices API).
- RBAC: page min role `viewer` matches API (viewer token reads, unit ES-11); no role rules weakened.
- Tenant isolation: org strictly from session; **no client-supplied organizationId anywhere**; foreign-org JWT probe returns its own (empty) scope, never another org's data.
- Data exposure: response is counts only — no employee/device rows, no titles, no URLs, no tokens.
- WS auth, agent/screenshot/alert ingestion, consent enforcement, admin permissions: **untouched** (no changes to those files beyond the `['event-stats']` invalidation line in the provider).

## Tests

```
Server (new live-monitor-event-stats.test.ts): 12/12 PASS (ES-00…ES-11)
Server (full suite incl. all consent/agent/security): 543/543 PASS
Desktop Agent:  282/282 PASS
Browser Extension: 7/7 PASS
TypeScript:     0 errors (both app and mini-service paths)
ESLint:         0 errors on all changed files
Prisma validate: PASS
Prisma generate (clean, authoritative schema): PASS
next build:     PASS (exit 0)
```

## Live Verification

```
Live probes (real server + real seeded org): 11/11 PASS
  - admin login → event-stats 200, org-scoped counts object
  - DB before → 1 real activity → DB after (+1) → Event Stats activity (+1)
  - reload → identical totals (no reset)
  - 85 bulk events → stats show full window (not capped at 80)
  - forged foreign-org JWT → 200 with total 0 (tenant isolation)
  - cleanup → 0 probe rows, 0 probe orgs
Mini-service runtime: started, startup smoke check passed, 0 poll errors after
  the initial transient P1001 blip, WS clients reconnecting normally.
```

## Database Cleanup

```
Probe rows (live DB):      0 (LM-HARDEN / ES- markers)
Probe organizations:       0
Probe notifications:       0
Test DBs:                  throwaway (workai_test_eventstats) auto-dropped by the test harness
Temporary scripts:         0
Seed/production data:      UNCHANGED
```

## P3 Status

**Six P3 findings remain deferred and were not modified in this hardening pass:**

- LM-P3-1 per-type `take` limits
- LM-P3-2 DeviceGrid error state
- LM-P3-3 `Math.random()` log key
- LM-P3-4 misleading "LIVE" label
- LM-P3-5 cursor reset/downtime events
- LM-P3-6 service wrapper/ops documentation

## Files Changed

| File | Change |
|---|---|
| `mini-services/live-updates/prisma/` | **Deleted** (stale 16-model schema) |
| `mini-services/live-updates/package.json` | `generate`/`validate` scripts + `prisma.schema` → authoritative root schema |
| `mini-services/live-updates/index.ts` | Startup `assertPollModels` smoke check (fail-loud on stale client) |
| `src/app/api/live-monitor/event-stats/route.ts` | **New** — DB-backed org-scoped stats endpoint |
| `src/components/live-monitor/live-monitor-page.tsx` | EventCountCards → API-backed with range toggle, loading/error/empty states |
| `src/components/providers/websocket-provider.tsx` | `['event-stats']` invalidation on all event types |
| `tests/live-monitor-event-stats.test.ts` | **New** — 12 regression tests |

## Final Score

| Category | Max | Before | After | Note |
|---|---|---|---|---|
| Functionality | 25 | 21 | 24 | DB-backed stats, range windows, honest states |
| Data correctness | 20 | 16 | 19 | authoritative COUNTs; no 80-cap; no double-count |
| Security / isolation | 20 | 20 | 20 | unchanged, re-proven |
| Real-time behavior | 15 | 11 | 12 | WS invalidation + 15s refetch (still polling-based) |
| Performance | 10 | 9 | 10 | indexed COUNTs, no row fetch |
| Error / truthfulness | 10 | 7 | 9 | error state + retry; no fabricated numbers |
| **Total** | **100** | **84** | **94** | |

**Verdict: Production Ready with minor issues (94/100).** P0=P1=P2=0. The six
P3s remain documented and deferred, exactly as required — the "LIVE" label and
polling-based transport (LM-P3-4/5) are the only caveats to "true realtime".
