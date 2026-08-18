# Agent Approvals — Fix Implementation Report

**Date:** 2026-08-16 · **Supersedes:** `AUDIT-agent-approvals.md` (read-only audit, 83/100)
**Scope:** All 12 approved fix items for the admin Agent Approvals section (zero-touch Device Claims tab + legacy Agent Registrations tab).
**Baseline:** Audit verdict — "production-ready core; visibility/realtime gaps", 3 P2 + 5 P3 findings.

---

## 1. Executive Summary

Every finding from the audit has been implemented, verified, and regression-tested. The section now has **realtime updates for both approval paths**, a **sidebar badge that counts pending zero-touch claims**, **expired claims that actually expire** (lazy, no scheduler), **server-side summary counts + pagination + search** on both tabs, **rate-limited legacy writes**, **one-active-device enforcement at legacy-approve time (409, zero-mutation)**, and **org-less super-admin empty states** consistent with the rest of the app.

**Verification totals (all green):**

| Gate | Result |
|---|---|
| Route-level tests (new suites) | **zero-touch 39/39**, **agent-registrations-admin 7/7**, **ws-invalidation 8/8** |
| Regression suites | security+multi-org-isolation **76/76**, live-monitor-event-stats **12/12**, super-admin **18/18** |
| TypeScript | `npx tsc --noEmit` — clean |
| ESLint | clean on all changed files |
| Build | `npx next build` — compiled in 11.3s, 108 static pages, 3 benign fs-tracing warnings |
| Runtime | dev app :3000 serving 200; live-updates :3010 socket.io handshake OK |

---

## 2. The 12 Fix Items — Status

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Realtime WS invalidation for claims + registrations (mini-service polls, transition-only events, badge/stat invalidation) | ✅ Done | `mini-services/live-updates/index.ts`, `src/lib/ws-invalidation.ts`, `src/components/providers/websocket-provider.tsx` |
| 2 | Sidebar pending-count badge for both paths (React Query, invalidated by the same events) | ✅ Done | `src/components/layout/app-sidebar.tsx` |
| 3 | Expired claims actually expire (lazy transition on list GET; approve stays 422 pre-flip / 400 post-flip) | ✅ Done | `src/app/api/device-claims/route.ts` |
| 4 | Org-less super-admin → EMPTY lists (never all-orgs data; consistent with MO-10) | ✅ Done | both list routes |
| 5 | Server-side summary counts (`?summary=true`, groupBy) for both tabs | ✅ Done | both list routes |
| 6 | pageSize clamp 1..100 (and NaN-safe page/pageSize parsing — NaN previously fell through to Prisma and 500'd) | ✅ Done | both list routes |
| 7 | Legacy approve/reject rate-limited (new `agentRegistrationWrite` key, 30/min) | ✅ Done | `[id]/approve|reject/route.ts`, `src/lib/rate-limit.ts` |
| 8 | Legacy approve enforces one-active-device — 409 `ACTIVE_DEVICE_EXISTS`, zero mutation | ✅ Done | `[id]/approve/route.ts` (reuses `src/lib/agent/activation.ts`) |
| 9 | Server-side search (`?q=`) on both tabs (hostname/device + employee names) | ✅ Done | both list routes |
| 10 | UI: expired filter + expiry info/banner + actionable-only pending (no more 422-on-click) | ✅ Done | `src/components/agent-approvals/agent-approvals-page.tsx` |
| 11 | UI: pagination controls + server-side stats tiles (5 claims stats incl. Expired; 4 registration stats) | ✅ Done | same page |
| 12 | Legacy deprecation banner + badge; notification entity link for legacy approve | ✅ Done | same page; `[id]/approve/route.ts` |

**Bonus fixes found by the new tests:**
- NaN page/pageSize on both list routes crashed Prisma with a 500 (found by LRA-5 / PS-1).
- `live-monitor/event-stats` gained the `deviceClaim` count (the union grew with the new event type).

---

## 3. Realtime Design (Item 1)

- **Mini-service** (`mini-services/live-updates/index.ts`, :3010):
  - Registrations poll now runs on `updatedAt` (fires on create **and** approve/reject) with `organizationId/status` + device/employee attribution.
  - New **DeviceClaim poll** mirrors it: pending + approved rows, org/device names/hostname + employee names.
  - In-memory `registrationStatus` / `claimStatus` maps (same pattern as the existing `deviceStatus` map) make emission **transition-only**: the first poll after a restart emits each current row once, thereafter only real transitions.
  - Cursor advance includes the registrations/claims `updatedAt` so changes are not skipped.
  - Events: `agent-registration` (status: pending/approved/rejected) and `device-claim` (status: pending/approved/rejected/expired).
- **Invalidation** (`src/lib/ws-invalidation.ts`): `agentRegistrationInvalidation()` → `[['agent-registrations'],['dashboard'],['event-stats']]`; `deviceClaimInvalidation()` → `[['device-claims'],['dashboard'],['event-stats']]`. Both prefix-match the real parametrized React Query keys (`['device-claims', filter, search, page]`, `['device-claims','badge-count']`, `['device-claims','summary']`, …).
- **Provider** (`websocket-provider.tsx`): `device-claim` added to `LiveEventType`; `lastDeviceClaim` context; status-aware toast titles for both events; both handlers use the centralized mapping functions.
- **Mini-service pool hardening (incident)**: during verification, Postgres hit `max_connections` (100). Root cause: `bun --hot` re-evaluates the mini-service module on every file edit, orphaning a full Prisma pool (~17 conns) per reload. Fixed by capping the mini-service pool to 5 via `connection_limit` in `resolveDbUrl()` (it never needs more than a handful of parallel poll queries). PG is back to ~23/100 with both services running. App-side Prisma is unaffected (globalThis singleton, empirically stable).

---

## 4. Lifecycle & Backend Changes

### Expiry (Item 3)
- `GET /api/device-claims` performs a lazy transition before querying: `updateMany` where `organizationId` = session org, `status = 'pending'`, `expiresAt < now` → `expired`. No background job, no write amplification (the update is zero-row when nothing is stale).
- Approved/rejected/revoked/cancelled claims are **never** flipped (guard includes `status: 'pending'`).

### Legacy approve (Items 7-8)
- Rate limit key `` `agent-registration:${clientIp}` `` → `RATE_LIMITS.agentRegistrationWrite = { limit: 30, windowMs: 60_000 }`.
- One-active-device check runs **inside the `$transaction`**: `Employee … FOR UPDATE` lock first, then `findFirst` an eligible device (`DEVICE_ELIGIBLE_STATUSES` from `activation.ts`); if one exists → `ActiveDeviceConflictError` → **409 `{ error: "ACTIVE_DEVICE_EXISTS" }`** and the whole transaction rolls back — registration stays pending, no Device row, no notification, `agentApproved` untouched (LRA-2 asserts all four).
- The approval notification now carries `entityType: 'device'` / `entityId: <created device id>` (parity with zero-touch claims).

### Lists (Items 4-6, 9)
- Both GETs: org-less super-admin → empty page (+ zero summary), never business data.
- `?summary=true` → server-side `groupBy` per status; claims: pending/approved/rejected/revoked/cancelled/expired; registrations: pending/approved/rejected/expired (+ `total` = sum).
- `pageSize` clamped 1..100 (registrations default 10; claims default 20) and page/pageSize are **NaN-safe** (`Number.isFinite` fallback) — malformed input can no longer 500.
- `?q=` org-scoped, case-insensitive, over device name/hostname (claims) and hostname/deviceName (registrations) plus bound employee firstName/lastName/employeeId, capped at 100 chars.

---

## 5. UI Changes (`agent-approvals-page.tsx`)

**Device Claims tab:**
- 5 QuickStat tiles from the `['device-claims','summary']` query: Pending, Active (approved), Rejected+Revoked, Cancelled, **Expired**.
- Status filter now includes **Expired**; filter/page changes reset pagination in `onValueChange` (lint rule `react-hooks/set-state-in-effect` respected).
- Search input (300ms debounce, server-side `?q=`).
- Claim cards: `isPending` = pending && (no `expiresAt` or future); expired rows show "Expired <date>" + grey banner; actionable pending rows show "Expires <date>". The 422-on-stale-click path is no longer reachable from the UI.
- `PaginationControls` (pageSize 10).

**Agent Registrations tab:**
- **Legacy badge** on the TabsTrigger + info banner: *"Legacy enrollment path — kept for existing agents; new enrollments use Zero-Touch Devices"* (audit §12 disposition: deprecate, don't remove).
- Same debounce/search/pagination pattern (`['agent-registrations', …]` keys, pageSize 10).
- 4 QuickStat tiles: Pending/Approved/Rejected/Total from `['agent-registrations','summary']`.

**Sidebar:** two React Query badge queries (`['device-claims','badge-count']`, `['agent-registrations','badge-count']`, `pageSize=1` → `.total`), summed for the nav badge; notifications useEffect retained.

**Live Monitor compensation:** new `device-claim` entry in `ALL_EVENT_TYPES` (label "Claim", Laptop icon, indigo) and `deviceClaim` in `event-stats` counts.

---

## 6. Tests

### New: `tests/agent-registrations-admin.test.ts` (7/7)
| Test | Asserts |
|---|---|
| LRA-1 | approve creates the Device from registration system info, `agentApproved=true`, notification linked (`entityType='device'`, `entityId=device.id`) |
| LRA-2 | existing eligible device → 409 `ACTIVE_DEVICE_EXISTS` with **zero mutation** (status pending, device count unchanged, no notification, employee untouched) |
| LRA-3 | 31st admin write from one IP → 429; first stays 200; middle attempts keep existing 400 semantics |
| LRA-4 | reject persists reason + notification |
| LRA-5 | pageSize 999→100 / 0→1 / `abc`→1, `banana`→10; summary equals DB ground truth; `summary.total` = 4-status sum; `q` hostname + employeeId + no-match |
| LRA-6 | org-less super-admin → empty page + zero summary |
| LRA-7 | cross-org registration approve → 404, foreign row untouched |

### Extended: `tests/zero-touch.test.ts` (32 → 39)
EXP-1 (expired flips on GET; approve 422 pre-flip / 400 after; visible under expired filter; re-discover → fresh claim), EXP-2 (finalized claims never flip), STATS-1 (summary = DB groupBy ground truth, ≥25 rows beyond first page), PS-1 (clamps), Q-1 (hostname + employee search), SA-1 (org-less empty). Also fixed two syntax-corruption spots left by an earlier PowerShell heredoc append (unquoted `discover(...)` and `url:` literals) and the STATS-1 key collision (25 distinct device keys — same-key rediscovery is replay-guarded by design, ZT-32).

### Extended: `tests/ws-invalidation.test.ts` (6 → 8)
device-claim + agent-registration invalidate approvals list, badge count and global aggregates.

### Regression
security, multi-org-isolation, live-monitor-event-stats, super-admin — all pass untouched.

---

## 7. Verification

- **Static:** `tsc --noEmit` clean; ESLint clean on all 12 changed source files.
- **Build:** `next build` succeeds (Turbopack, 11.3s compile; 3 warnings are pre-existing dynamic-fs-tracing notices).
- **Runtime:** dev app on :3000 healthy; live-updates :3010 healthy (engine.io handshake 200); Postgres connections ~23/100.
- **Constraint compliance:** zero-touch behavior preserved (39/39 incl. all original 32); no scheduler; no schema changes; `src/instrumentation.ts` untouched (pre-existing fix, still uncommitted); real DB `workai` never written by tests; no bulk approval added.

## 8. Known Remaining Limitations

- **No live admin UI verification** — no admin session credentials available, so approve/reject were verified at route level (LRA-1..7) and by boot smoke only.
- Registrations `expired` status remains dormant (nothing sets it — same as before; the filter just isn't offered since it can't occur).
- Legacy devices have no revoke path in this section (audit P3, out of scope) — they remain manageable via the Devices page.
- Mini-service emits each current row once on startup (accepted; matches the existing device-status behavior).

---

## 9. Files Changed

| File | Change |
|---|---|
| `mini-services/live-updates/index.ts` | claim poll + registration `updatedAt` poll + transition maps + pool cap |
| `src/lib/ws-invalidation.ts` | `deviceClaimInvalidation` / `agentRegistrationInvalidation` |
| `src/components/providers/websocket-provider.tsx` | `device-claim` event type, handlers, context |
| `src/components/layout/app-sidebar.tsx` | dual badge queries |
| `src/app/api/device-claims/route.ts` | lazy expiry, org-less empty, summary, search, NaN-safe clamps |
| `src/app/api/agent-registrations/route.ts` | rewritten: clamps, org-less empty, summary, search |
| `src/app/api/agent-registrations/[id]/approve/route.ts` | rate limit, one-active-device 409 zero-mutation, entity-linked notification |
| `src/app/api/agent-registrations/[id]/reject/route.ts` | rate limit |
| `src/app/api/live-monitor/event-stats/route.ts` | `deviceClaim` count |
| `src/components/agent-approvals/agent-approvals-page.tsx` | expired filter/banner/expiry meta, search, pagination, summary tiles, legacy badge/banner |
| `src/components/live-monitor/live-monitor-page.tsx` | `device-claim` event mapping |
| `src/lib/rate-limit.ts` | `agentRegistrationWrite` |
| `tests/agent-registrations-admin.test.ts` | **new** — 7 tests |
| `tests/zero-touch.test.ts` | +7 tests (39 total) |
| `tests/ws-invalidation.test.ts` | +2 tests (8 total) |

*Unrelated pre-existing uncommitted changes observed (not touched): `src/components/employees/employee-combobox.tsx`, `src/instrumentation.ts`.*

---

## 10. Post-Implementation Score Estimate

| Dimension | Before | After | Δ |
|---|---|---|---|
| Functional completeness | 9.5 | 10 | +0.5 |
| Backend correctness & security | 9.5 | 9.5 | — |
| UI/UX | 7.0 | 9.0 | +2.0 |
| Realtime | 3.0 | 9.5 | +6.5 |
| Test coverage | 9.5 | 10 | +0.5 |
| Documentation | 5.0 | 6.0 | +1.0 |
| Performance | 8.5 | 9.5 | +1.0 |
| **Weighted total** | **83/100** | **~94/100** | **+11** |

Remaining deductions: dormant `expired` status for registrations, legacy revoke gap, untyped status enums (repo-wide convention), no live-admin UI verification.
