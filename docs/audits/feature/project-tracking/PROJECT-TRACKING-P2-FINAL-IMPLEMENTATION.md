# Project Tracking — P2 Functional Completion & Production Hardening

## Final Implementation Report

### 1. Files changed

| File | Change |
|---|---|
| `src/app/api/projects/[id]/time-entries/[entryId]/route.ts` | **NEW** — `PUT` (edit) + `DELETE` (hard delete) a single time entry. Admin-only, org-scoped, closed request schema, audited. |
| `src/app/api/projects/[id]/restore/route.ts` | **NEW** — `POST` restores an archived (cancelled) project to `active` using the existing status enum. Admin-only, org-scoped, audited. |
| `src/app/api/projects/route.ts` | **GET** — archive filter: default list now hides `cancelled` projects; `includeArchived=true` brings them back; an explicit `status=` filter always wins. |
| `src/app/api/projects/search/route.ts` | **GET** — same archive default semantics for project selectors/comboboxes (mirrors the list route). |
| `src/components/projects/projects-page.tsx` | Time Log tab: **Edit** + **Delete** actions per entry row, Edit Time Entry dialog (pre-populated, validated, stays open on failure), Delete confirmation dialog. **Include Archived** toggle in the filter bar (resets to page 1). **Archived** badge on cancelled projects (cards + table). **Restore** button in the detail header for cancelled projects. React Query invalidation on add/edit/delete/restore. |
| `tests/projects-tracking.test.ts` | **NEW** — 11 focused route-level tests (PTR-1…PTR-11). |
| `scripts/projects-tracking-e2e.mjs` | **NEW** — real-browser E2E against the running app + real DB (39 checks). |

### 2. Files intentionally not changed

- Sentiment AI (`/api/projects/[id]/sentiment`, `/analyze`) — verified correct (auth, org scope, manager+ RBAC, consent gate, real AI call with rules fallback, atomic period replace). No rewrite.
- PDF export (`/api/reports/pdf/project`) — verified working in a real browser (200, valid download with real data). No rewrite.
- Project list/detail/members/time-entry POST — preserved untouched.
- `prisma/schema.prisma` — no schema changes needed (TimeEntry already has all fields + `organizationId`).
- Employee↔project surface (`/api/employees/[id]/projects`) — intentionally shows membership history incl. status; not the archived-project list surface.

### 3. API endpoints added/changed

- `PUT /api/projects/[projectId]/time-entries/[entryId]` — edit; only `employeeId, date, hours, description, category, billable` accepted (unknown fields → 422); hours `(0, 24]`, valid category enum, valid date, `billable` boolean, employee must be an active same-org member; 401/403/404/422 semantics; audit log `time_entry/update`.
- `DELETE /api/projects/[projectId]/time-entries/[entryId]` — hard delete (schema has no dependent rows; relations point *from* the entry); deletes only that entry; 401/403/404; audit log `time_entry/delete`.
- `POST /api/projects/[id]/restore` — `cancelled → active`; 409 when not cancelled; preserves members/time entries/history; audit log.
- `GET /api/projects` and `GET /api/projects/search` — new `includeArchived=true` param; default hides cancelled; explicit status filter wins.

### 4. DB/schema changes

None. No soft-delete column was introduced (hard delete is safe: TimeEntry has no children). Aggregates (progress, actual cost, analytics) continue to derive from live `TimeEntry` rows — verified by PTR-11.

### 5. UI changes

- Time Log rows: edit (pencil) + delete (trash) icon actions (admin only).
- Edit Time Entry dialog: pre-populated employee/date/hours/category/billable/description; validation before submit; loading state; success toast; error toast with dialog kept open.
- Delete confirmation dialog: identifies the entry (member, hours, date); loading state; success/error toast.
- Include Archived toggle in the projects filter bar; toggling resets to page 1.
- Archived badge (cards + table) for cancelled projects.
- Restore button in the project detail header for cancelled projects.

### 6. RBAC changes

None — all new endpoints reuse `requireAdminOrg` (admin+) for mutations, matching the existing time-entry/member/project mutation convention. Reads stay `requireSessionOrg`.

### 7. React Query changes

After time-entry create/edit/delete and project restore, invalidate:
- `['project-time-entries', projectId]`
- `['project-detail', projectId]`
- `['projects']`
- `['employee-projects']`

The archive toggle is part of the projects query key so the list refetches server-side on toggle.

### 8. Tests executed + exact results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` (root) | PASS (0 errors) |
| `npx eslint` (all changed files) | PASS (0 errors) |
| `tests/projects-tracking.test.ts` (NEW) | **11/11 pass** |
| `tests/projects.test.ts` (existing regression) | **17/17 pass** |
| `tests/project-sentiment.test.ts` | **11/11 pass** |
| `tests/sentiment-fixes.test.ts` | **19/19 pass** |
| `tests/hardening.test.ts` | **24/24 pass** |
| `tests/security.test.ts` | **28/28 pass** |
| Full backend suite `tests/*.test.ts` | **692/692 pass** |

### 9. Browser E2E results (real app + real DB, `scripts/projects-tracking-e2e.mjs`)

**39/39 checks passed**, including:
- Login → Projects → list renders, default hides archived.
- Create project via UI (real DB row).
- Add member via Team tab (server-side employee search).
- Add time entry (4h) → visible in Time Log.
- Edit entry (4h → 6h) → `PUT 200` → **6h persists after browser refresh**.
- Delete entry → confirmation dialog → `DELETE 200` → entry gone → **still gone after refresh**.
- Archive project → hidden from default list.
- Include Archived toggle → cancelled project appears with **Archived** badge.
- Restore → project back in the default active list (members/time entries preserved).
- Sentiment tab renders (browser-exercised).
- Export PDF → request sent, `200`, real PDF download produced (`project-report-…pdf`).
- No console errors, no failed requests, no 5xx API responses.

All E2E test projects were cleaned from the real DB afterwards (DB restored to its original 1-project state).

### 10. Security test results

- A. valid admin → success (PTR-1, PTR-5, PTR-9)
- B. unauthenticated → 401 (PTR-4, PTR-6, PTR-10)
- C. non-admin role → 403 (PTR-4, PTR-6, PTR-10)
- D. nonexistent project → 404 (PTR-4, PTR-6, PTR-10)
- E. nonexistent entry → 404 (PTR-4, PTR-6)
- F. entry from another project → 404 (PTR-4, PTR-6)
- G. cross-org project/entry → 404 / 403 (PTR-2, PTR-4, PTR-6, PTR-10)
- H. invalid hours → 422 (PTR-3)
- I. invalid category → 422 (PTR-3)
- J. malformed date → 422 (PTR-3)
- K. unknown request fields (incl. `projectId`/`organizationId` hijack attempts) → 422 (PTR-3)

### 11. Data integrity verification

- Before: 4h × $100 = $400. Edit 4h → 6h: `totalHours=6`, `progress=30%`, actual cost = 6×100 = **$600** (PTR-1, PTR-11).
- Delete: entry row gone, `totalHours=0`, `progress=0`, no orphan rows (PTR-5, PTR-11).
- Aggregates (`totalHours`, `billableHours`, `byCategory`, `byDate`, progress, cost) all recompute from real `TimeEntry` rows — no stored aggregates, no manual writes (PTR-11).

### 12. Remaining issues

None functional. Minor notes:
- The Sentiment **analyze** action was verified to render and is covered by 30 passing route-level tests; executing a live AI analysis was not performed (no provider key configured in this environment) — the rules-based fallback is covered by tests.
- Category change during UI edit is covered by API tests (PTR-1); the E2E changed hours only (the radix select interaction is flaky in headless), the `PUT 200` and persistence are verified.

### 13. Final Project Tracking score

| Priority | Count |
|---|---|
| P0 (critical) | **0** |
| P1 (major) | **0** |
| P2 (important functional gap) | **0** |

All three identified P2 gaps (P2-1 time-entry edit/delete, P2-2 archived-in-list, P2-3 restore) are implemented, tested, and browser-verified end-to-end against real data.
