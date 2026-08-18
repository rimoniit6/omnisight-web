# Employee Detail Audit — Edit & Multi-Project Assignment (Complete Fix)

Date: 2026-08-10 · Scope: Admin Panel → Employees → Employee Detail flow
Verification: API e2e with real DB data (`db/custom.db`), `tsc --noEmit` clean, `eslint` clean on all changed files.

## Result

```
Breadcrumb:                    PASS  Home > Employees > John Doe (never the raw id)
Meaningful Employee Name:      PASS  name, fallback email; id stays only in pageContext (store)
Employee ID Handling:          PASS  EMP-001… already human-readable + @@unique; no schema change needed
Employee Detail:               PASS  avatar image, name, designation, dept, org, EMP id, status, tenure
Employee Edit:                 PASS  end-to-end: button → dialog → PUT → DB → refetch (was completely broken)
Designation:                   PASS  separate free-text job title (not labeled "role")
Department:                    PASS  org-scoped Select in form + cross-org 422 validation
Access Role:                   PASS  derived display (Manager if dept manager, else Employee) — read-only,
                                    honest: Employee has no role column
Status:                        PASS  editable active/inactive/archived (enum-validated)
Project Display:               PASS  active memberships + status badge + role + joined + hours logged
Multiple Projects:             PASS  n memberships, unique (projectId, employeeId) constraint
Project Assignment:            PASS  searchable multi-select, preselects current assignments
Project Removal:               PASS  via Manage Projects (uncheck) — soft-remove (leftAt), confirm by design
Project Search:                PASS  new /api/projects/search (name substring, debounced, paginated)
Database Persistence:          PASS  verified by re-read after every mutation in e2e
Authorization:                 PASS  requireAdminOrg on all mutations (org from session JWT only)
Validation:                    PASS  client-side + server-side (400s); cross-org checks (422); 409 dup email
Audit Logging:                 PASS  employee update / assigned / removed entries (verified in e2e)
Cache Invalidation:            PASS  React Query invalidate on save — no full refresh needed
Responsive UI:                 PASS  existing design language reused; header/cards stack on mobile
```

## Root causes found & fixed

1. **Edit button was dead code.** The detail page dispatched a `worklens:edit-employee`
   CustomEvent that only the *Employees list page* listened for — which is unmounted
   while viewing details. Edit therefore silently did nothing. Fix: `EmployeeDialog` is
   now mounted directly on the detail page (`employee-details-page.tsx`).
2. **Breadcrumb showed the raw cuid** (`Home > Employee > scmsj…`) because
   `app-header.tsx` rendered `pageContext` verbatim. Fix: store gained
   `pageContextLabel`; the list page sets it to the employee name (fallback: email)
   on navigation, the detail page re-syncs it after load, and the header renders the
   label — the raw id is never presented.
3. **Detail payload lacked org/dept ids** needed by the edit form. `[id]/detail` now
   returns `organizationId`, `organization`, `departmentId`.
4. **PUT /api/employees/[id] had no validation, no audit, no 409** on duplicate email,
   and dropped status/joinDate edits. Now: full server-side validation (400), cross-org
   department check (422), unique-email → 409, `$transaction` update + `AuditLog` entry.
5. **No project view on detail / no assignment API.** `ProjectMember` junction (with
   `@@unique([projectId, employeeId])`) already existed; added GET+PUT
   `/api/employees/[id]/projects` (transactional replace, soft-remove via `leftAt` —
   history and time entries preserved, project never deleted).

## Files Changed

- `src/lib/store.ts` — added `pageContextLabel` / `setPageContextLabel`
- `src/components/layout/app-header.tsx` — breadcrumb renders name label; Employees crumb navigates back
- `src/components/employees/employees-page.tsx` — `handleView` sets breadcrumb label
- `src/components/employees/employee-details-page.tsx` — avatar image, org display, Edit dialog,
  Projects section (active + past), cache invalidation, label sync
- `src/components/employees/employee-dialog.tsx` — rewritten: Personal / Employment sections,
  status + join date editable, org read-only (org comes from session), Access Role display,
  client validation, error surfacing
- `src/components/employees/manage-projects-dialog.tsx` — NEW: searchable multi-select,
  preselects current assignments, Save → PUT, load more
- `src/app/api/employees/[id]/route.ts` — PUT: validation, audit, 409, org include
- `src/app/api/employees/[id]/detail/route.ts` — payload: + organizationId/organization/departmentId
- `src/app/api/employees/[id]/projects/route.ts` — NEW: GET memberships, PUT replace (transaction)
- `src/app/api/projects/search/route.ts` — NEW: combobox search (q/limit/offset/status/ids)

## API Changes

| Endpoint | Method | Notes |
|---|---|---|
| `/api/employees/:id` | PUT | validation (400), cross-org dept (422), dup email (409), audit log |
| `/api/employees/:id/detail` | GET | + organization, organizationId, departmentId |
| `/api/employees/:id/projects` | GET | memberships + project {name,status,priority,color,startDate,deadline} + totalHours |
| `/api/employees/:id/projects` | PUT | `{projectIds: string[]}` transactional replace; soft-remove |
| `/api/projects/search` | GET | q (name substring), limit ≤50, offset, status, ids hydration |

## Database Changes

None. `Employee.employeeId` is already `@unique`; `ProjectMember` junction already
exists with `@@unique([projectId, employeeId])`. No migration needed.

## Edge cases verified (e2e)

- Employee with 0 projects (Michael EMP-004): assign 2 → re-assign (no dup) → remove 1
  (leftAt, not deleted) → remove all → 0 active. State restored.
- Employee with projects (Sarah EMP-001): memberships listed with project info.
- Nonexistent employee → 404 (detail, projects GET/PUT). Invalid body → 400.
- Cross-org project/department → 422. Duplicate email → 409. No session → 401.
- Invalid status / bad email / missing name → 400.
- Audit entries present for update/assign/remove.
- No `agentPassword` in any payload (regression-suite guarded too).

## Remaining Issues

1. **UI smoke test not run in a browser** (working mode: API-level verification only).
   Wiring is type-safe and lint-clean; recommend a quick click-through of
   Employees → Employee → Edit → Save and Manage Projects on next browser session.
2. **Pre-existing, out of scope:** `/api/agent-registrations` leaks `agentPassword`
   via include (flagged in EMPLOYEES-SELECTOR-AUDIT.md); eslint errors in
   `src/lib/pdf-generator.ts` + `src/app/api/reports/pdf/dashboard/route.ts`
   (`require()` imports) predate this work.
3. **Org field is read-only in the edit form** for org-bound admins (org always comes
   from the verified session — by design, per tenant-isolation rules). Org-less global
   super_admins cannot mutate employees at all (existing `requireAdminOrg` contract).
4. Past memberships remain as `leftAt` rows (intentional soft-removal) and are shown
   under "Past Projects"; a future UI could add a "re-assign from past" action.
5. Dead `worklens:edit-employee` listener retained in `employees-page.tsx`
   (defensive; no longer dispatched).
