# ADMIN ACTIVE TRACKING PROJECT — UI VISIBILITY AUDIT (FINAL)

**Final status: FUNCTIONAL — UI was already correct; the controls were hidden by the
onboarding-tour overlay on fresh browser profiles (and are absent from any deployment
built from the stale pre-feature `.next` production build).**

Verified in a real browser against the real running application, real PostgreSQL,
real admin account (`admin@worklens.ai`, super_admin, org-bound), and real employee
Rimon Rana (001) on project "ok". The button is **visibly available** and the full
real-agent E2E passes **31/31** — including dismissing the tour with its real control.

---

## 1. Exact reason the control appeared "not visible"

Two verified causes — neither is a defect in the Active Tracking Project feature:

### Cause 1 — Onboarding tour overlay blocks the entire app (fresh browser)
`src/components/onboarding/tour-overlay.tsx` renders a full-screen layer:

```
motion.div  className="fixed inset-0 z-[100]"  style={{ pointerEvents: 'auto' }}
```

- On any browser profile where `localStorage['worklens-tour-completed']` is not `"true"`,
  the tour appears ~600 ms after mount and covers the **whole admin UI** (verified live:
  overlay 1440×900, `z-index:100`, transparent backdrop, `pointer-events:auto`).
- Every click is intercepted; the **first click anywhere outside the tour card simply
  dismisses the tour** (`handleBackdropClick` → `handleSkip`) — so a first-time admin
  clicking "Projects" sees *nothing happen* (the click is consumed by dismissal).
- Until the tour is dismissed, **no page in the app — including Projects → Team → Set as
  Active — is reachable**.
- Dismissal works and persists (verified: `Skip tour` → `worklens-tour-completed=true` →
  never re-shows after reload / fresh goto). Escape does NOT dismiss it.

### Cause 2 — Stale production build contains none of the feature
The checked-in production artifact `.next` (BUILD_ID `JxvJUdvbclSXeuHAbb8bc`, built
**2026-08-15 01:56**, before the feature) has **zero** occurrences of `Set as Active` or
`Active Tracking Project` in its chunks. Any deployment running `next start` from that
build shows no controls at all. (No production server is currently listening; the live
:3000 dev server and the :81 Caddy proxy both serve the current code.)

## 2. Exact files inspected

| Concern | File |
|---|---|
| Team tab member-row UI + Set/Clear + dialogs | `src/components/projects/projects-page.tsx` (member rows, `setActiveProjectMutation`, confirmation dialogs) |
| Members API (isActiveTracking) | `src/app/api/projects/[id]/members/route.ts` |
| Active-project API | `src/app/api/employees/[id]/active-project/route.ts` |
| Sync attribution | `src/lib/project-time/sync.ts` |
| Auto-clear on removal/archive | `src/app/api/projects/[id]/members/[memberId]/route.ts`, `src/app/api/employees/[id]/projects/route.ts`, `src/app/api/projects/[id]/route.ts` |
| Tour overlay (the blocker) | `src/components/onboarding/tour-overlay.tsx`, `src/lib/store.ts` (`getInitialTourState`/`setTourCompleted`), `src/app/page.tsx` |
| Audit scripts (new) | `scripts/active-project-ui-audit.mjs`, `scripts/overlay-probe.mjs`, `scripts/tour-persistence-test.mjs`, `scripts/active-project-e2e.mjs` |

Search hits for `activeTrackingProjectId` / `isActiveTracking` / `Set as Active` /
`Clear Active` / `Active Tracking Project` / `active-project`: all in the files above;
the API route, sync engine, members API, and projects page are the only producers/consumers.

## 3. API response — before / after

`GET /api/projects/{ok}/members` (real login, real project, real employee):

```
BEFORE (no active project):  isActiveTracking: false,  activeTrackingProjectId: null
AFTER  (set "ok" via API):   isActiveTracking: true,   activeTrackingProjectId: <ok id>
```

`PUT /api/employees/{rimon}/active-project` — `{ projectId: <ok> }` → **200**;
`{ projectId: null }` → **200**. All authorization/validation paths covered by
`tests/active-project.test.ts` (25/25): non-admin 403, cross-org 404, non-member 409,
soft-removed 409, cancelled 409, invalid payload 400, audit SET/CHANGED/CLEARED.

## 4. Role / permission findings

- Logged-in admin is `role=super_admin`, org-bound (`organizationId` set) → satisfies
  `requireAdminOrg` (hierarchy: super_admin 50 ≥ admin 30) and the UI gate
  `hasRolePermission(role,'admin')`.
- Controls are correctly hidden for manager/viewer (both the API and the UI gate on
  admin-or-above). Not a cause here.
- The API is the enforcement point; the UI gate is parity only.

## 5. UI rendering findings (real browser, real data)

Desktop (1440×900) — Team tab member row DOM:

```
Rimon Rana · CEO | ○ Assigned | Member | 1.5h | 40h/wk target | [Set as Active]
buttons: { text: "Set as Active", aria: "Set Rimon Rana's active tracking project",
           w:95 h:32 visible:true }
```

- A. Team tab visible: YES   B. Employee visible: YES   C. Indicator: ○ Assigned
  (● Active Tracking Project appears once a project is active — E2E-verified)
- D. **"Set as Active" visible: YES**   E. "Clear Active": 0 while nothing is active
  (appears for the active row — E2E-verified)   F/G/H/I/J: none hidden by role/state/CSS
- Mobile (390×844): "Set as Active" still renders (count 1).
- Screenshots: `active-project-audit-desktop.png`, `active-project-audit-mobile.png`.
- K. UI fetches state: YES — `GET /api/projects/{id}/members` 200 returns
  `isActiveTracking`/`activeTrackingProjectId`, consumed by the member row.

## 6. Root cause

The Active Tracking Project feature is fully implemented and renders. The controls are
unreachable/undiscoverable only when (a) the onboarding-tour overlay covers the app on a
fresh browser profile (first click is swallowed by tour dismissal), or (b) the admin
views a deployment built from the stale pre-feature `.next` artifact. The previous E2E
pass was real but masked this by deleting the tour's DOM nodes (which also produced a
React `removeChild` console error) — that masking is now removed.

## 7. Code changes made

- **Feature code: none required** — already correct and spec-conformant (verified, not assumed).
- Audit tooling added: `scripts/active-project-ui-audit.mjs` (renders + DOM evidence),
  `scripts/overlay-probe.mjs` (overlay identification), `scripts/tour-persistence-test.mjs`
  (dismissal persistence), and `scripts/active-project-e2e.mjs` updated to dismiss the
  tour via its **real** control instead of mutating DOM.

## 8. Browser verification

Real Chrome, real login, real project "ok", real Rimon: tour shows on fresh profile
(`fixed inset-0 z-[100]`, blocks clicks) → dismissed via real "Skip tour" → Projects →
project "ok" → Team tab → `Set as Active` **present and visible** (95×32), `○ Assigned`
shown, works on desktop and mobile. No React errors when the tour is dismissed properly.

## 9. Real Rimon activity verification (full E2E, no mocks, no DOM hacks)

`node scripts/active-project-e2e.mjs` — **31/31 PASS**:

1. Admin login → Projects → "ok" → Team tab; Rimon confirmed assigned
2. Set "ok" as Active via UI + confirmation dialog → ● Active Tracking Project + DB set
3. **Real agent activity** (`POST /api/agent/activity`, real agent token) →
   sync loop → `ACTIVITY_AUTO` TimeEntry on "ok" → project hours increased (+0.03h)
4. Time Log shows "Activity Tracking" source **without reload**
5. Second project added → active project **unchanged**
6. Switch active → new real activity goes **only** to the new project;
   historical "ok" entry **frozen** across two 25 s windows (even live agent activity)
7. Browser refresh → active project **persists**
8. Remove member → active project **auto-cleared** → no auto time to removed project
9. Cleanup: test project/members/activities removed; `activeTrackingProjectId` restored
   to `null`; zero leftovers in PostgreSQL.

## 10. Test results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| ESLint (feature files + new audit/E2E scripts) | ✅ 0 errors |
| `tests/active-project.test.ts` (API/RBAC/org/membership/audit/sync) | ✅ 25/25 |
| `tests/project-time-sync.test.ts` (existing sync regression) | ✅ 13/13 |
| Real browser E2E (`active-project-e2e.mjs`, tour dismissed properly) | ✅ 31/31 |

## 11. Final status

**FUNCTIONAL.** The Active Tracking Project controls exist and are visible in the real
Admin UI for an authorized admin (desktop + mobile), the API contract is correct, and the
real browser E2E with real Rimon agent activity succeeds. If the controls appear missing:

1. **Fresh browser → dismiss the onboarding tour** ("Skip tour" / ✕ / click outside the
   card; it persists across reloads), then re-check Projects → project → **Team tab** →
   the member row shows **○ Assigned** + **[ Set as Active ]**.
2. **Stale deployment** → the controls only exist in builds produced after the feature
   was added; rebuild (`npm run build`) or use the dev server, which serves the current
   code. The checked-in `.next` artifact predates the feature and contains none of it.
