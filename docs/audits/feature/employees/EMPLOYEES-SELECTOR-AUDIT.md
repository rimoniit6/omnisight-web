# WorkLensAI — Searchable Employee Selector Audit

**Date:** 2026-08-10 · **Scope:** every employee/user selection control in the app converted to a searchable combobox
**Method:** full-codebase audit (grep + 2 parallel explorer agents), one shared `EmployeeCombobox` component, one shared search endpoint, static checks, API e2e suites

## Result: PASS — all employee selectors searchable; zero full-list dropdowns remain

---

## §12 — Employee Selector Audit (before → after)

| Page/Component | Line | Selector | Was searchable? | Now |
|---|---|---|---|---|
| Activities filter | `activities-page.tsx` ~317 | `Select` fed by `/api/employees/list` | No | `EmployeeCombobox` (server search, name+dept label, clear) |
| Screenshots filter | `screenshots-page.tsx` ~423 | `Select` fed by `/api/employees?pageSize=100` | No | `EmployeeCombobox` (server search, clear) |
| Reports — Generate Report dialog | `reports-page.tsx` ~789 | `Select` fed by `/api/employees?pageSize=200` | No | `EmployeeCombobox` (server search, name+ID label) |
| Reports — Custom PDF form | `reports-page.tsx` ~508 | `Select` (same 200-row list) | No | `EmployeeCombobox` (server search, name+ID label) |
| Projects — Add Team Member | `projects-page.tsx` ~1531 | `Select` fed by `/api/employees?pageSize=100` | No | `EmployeeCombobox` (server search, name+email label) |
| Projects — Add Time Entry | `projects-page.tsx` ~1606 | `Select` over project members | No | `EmployeeCombobox` (client-filtered via `options` — members already loaded) |
| Projects — Time-entry member filter | `projects-page.tsx` ~1308 | `Select` over project members | No | `EmployeeCombobox` (client-filtered, clear) |
| Devices — Assigned To | `device-dialog.tsx` ~106 | `Select` fed by `/api/employees?limit=100` | No | `EmployeeCombobox` (server search, name+email label) |
| Departments — Manager | `department-dialog.tsx` ~90 | `Select` fed by `/api/employees?limit=100` | No | `EmployeeCombobox` (server search, name+email label) |
| Agent Approvals — approve dialog | `agent-approvals-page.tsx` ~576 | `Select` fed by `/api/employees?status=active&pageSize=200` | No | `EmployeeCombobox` (server search, status=active, name+ID label) |
| Self Portal — employee switcher | `self-portal-page.tsx` ~1003 | `Select` fed by `/api/employees?status=active&pageSize=100` | No | `EmployeeCombobox` (server search, status=active, name·designation label) |
| Command palette (global search) | `command-palette.tsx` | cmdk combobox + `/api/search` (debounced) | **Yes** | Left unchanged |

Not selectors (correctly left): org avatar grid (`organization-page`), break-status table rows, sentiment in-memory search input, consent/audit/auth-user role selects, employees-page bulk-checkbox rows.

No multi-employee picker existed; the shared component supports `multiple` (chips + checkboxes) for future use.

**Bonus fix:** the `['employees-list']` query-key collision (3 components with different shapes/endpoints sharing one cache key — a real bug) is gone because per-site employee queries were removed.

---

## Architecture

- **One shared component:** `src/components/employees/employee-combobox.tsx` (`EmployeeCombobox`)
  - single / multi (`multiple`) modes
  - server-side search (debounced 250 ms) via `/api/employees/search`, or client-side filter when `options` is passed (small preloaded lists like project members)
  - label formats: name / name-id / name-dept / name-designation / name-email (spec §6)
  - states: loading ("Searching employees..."), empty ("No employees found — Try a different name, email, or employee ID."), error, disabled, clear (×)
  - "Showing N results — Load more" (20/page, spec §10)
  - selected-value hydration via `ids=` so edit dialogs always render a proper label
  - multi-select chips with per-chip remove; search never clears existing selections
- **One shared endpoint:** `src/app/api/employees/search/route.ts`
  - org-scoped (`requireSessionOrg`, `allowGlobal` for global super-admins; same tenant isolation as `/api/employees`)
  - `q` (multi-word tokens, AND across tokens / OR across firstName, lastName, email, employeeId; SQLite LIKE is ASCII case-insensitive — verified `RIMON` → Rimon)
  - `limit` (max 50) / `offset` (Load more), `status` filter, `ids` hydration, `organizationId` only for org-less global admins
  - returns only `id, employeeId, firstName, lastName, email, designation, avatar, departmentName` — no agentPassword/phone/status/joinDate
- **Removed:** all 8 per-site full-list employee fetches (`pageSize=100/200`, `/api/employees/list`)

---

## §14 — Final Verification Checklist

| # | Check | How | Result |
|---|---|---|---|
| 1 | Open selector → initial list | server returns first 20 (createdAt desc) | PASS (e2e) |
| 2 | Search by name | `q=rimon` → 1 | PASS (e2e) |
| 3 | Search by email | `q=mdrimonrana@gmail.com` → 1; domain `TECHVISION` → 39 | PASS (e2e) |
| 4 | Search by employee ID | `q=EMP-039` (and lowercase) → Marcus Reed | PASS (e2e) |
| 5 | Partial text | `q=ana`, multi-word `q=Rimon Ra` | PASS (e2e) |
| 6 | Case-insensitive | `q=RIMON`, `q=TECHVISION` | PASS (e2e) |
| 7 | Nonexistent | empty array + "No employees found" state | PASS (e2e) |
| 8 | Select | single-select wiring at all 11 sites | PASS (code; `onSelect`/`onValueChange` verified in tsc/eslint) |
| 9 | Clear selection | `allowClear` × button on all filter fields | PASS (code) |
| 10 | Multi-select support | `multiple` prop (chips, checkboxes) | PASS (implemented) |
| 11 | Select multiple | chip toggle + per-chip remove | PASS (implemented) |
| 12 | Search again after selecting | selections kept in `selectedIds`; hydration via `ids=` | PASS (code) |
| 13 | Selections persist | `ids=` hydration for values outside result page | PASS (e2e: ids= returns both) |
| 14 | Large dataset | never loads >50 rows per request; Load more pagination; no client-side filtering of full list | PASS (design + e2e) |
| 15 | No sensitive fields | field-set assertion + agentPassword scan | PASS (e2e) |
| 16 | Debounced | 250 ms debounce, stale-response guard (`requestSeq`) | PASS (code) |
| 17 | Server-side filtered | all search via Prisma `where` (LIKE), not in-browser | PASS (code + e2e) |

Static: `tsc` 0 errors · `eslint` 0 errors. API e2e: **35/35** (`tests/employee-search-e2e.ps1`), regression **46/46** (`tests/employee-api-e2e.ps1`). No Prisma schema changes.

---

## Notes / Limitations

- **Debounce = 250 ms; min search length = 1 char.** The dataset is small (~40 employees) and the server trims results to 20 with Load more, so 1-char search is safe at any size; the `minLength` behavior can be tuned later if the tenant grows.
- **Project member selects use client-side filtering** (members are already loaded per-project and small). The same combobox UI/UX applies.
- **Pre-existing finding (out of scope):** `/api/agent-registrations` returns employees via unchecked `include` and leaks `agentPassword`; `/api/search`, `/api/break-status`, `/api/dashboard`, `/api/usb-events` lack route-level org scoping. Not part of this task — flagged for follow-up.
