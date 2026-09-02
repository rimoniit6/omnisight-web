# React Duplicate Key Forensic Audit — Final Report

**Date:** 2026-09-02
**Warning:** `Encountered two children with the same key, 'Customer Support'`

---

## Root Cause

```
File:       src/app/api/employees/statistics/route.ts (line 76-82)
            src/components/employees/employee-statistics.tsx (line 102)
Component:  EmployeeStatistics
Line:       employee-statistics.tsx:102 → key={dept.name}
Collection: departmentStats (byDepartment)
Original key: dept.name (display name string)
Why duplicate: Seed data creates identical department names
               (e.g., "Customer Support") across multiple organizations.
               The statistics API (when called by super_admin without org
               scope) returns departments from ALL organizations.
               The departmentStats response omitted departmentId, so the
               component had no unique identifier to use as a React key.
```

### Data Flow

1. **Seed** (`seed-mega.ts:350-352`): Creates `DEPT_NAMES` including "Customer Support" for each organization
2. **DB**: `Department` model has `@@unique([organizationId, name])` — same name allowed across orgs
3. **API** (`/api/employees/statistics`): Groups employees by `departmentId`, resolves names, but **dropped `departmentId` from the response**
4. **Component**: Used `key={dept.name}` — when two orgs both have "Customer Support", this produces duplicate keys

---

## Fixes Applied

### Fix 1: API — Include `departmentId` in response
**File:** `src/app/api/employees/statistics/route.ts:76-82`
```diff
  const departmentStats = byDepartment
    .map((d) => ({
+     departmentId: d.departmentId || null,
      name: d.departmentId ? (deptMap.get(d.departmentId) || 'Unknown') : 'Unassigned',
      count: d._count.id,
      activeCount: d.departmentId ? (activeDeptMap.get(d.departmentId) || 0) : 0,
    }))
```

### Fix 2: Component — Use `departmentId` as React key
**File:** `src/components/employees/employee-statistics.tsx`
```diff
  interface DepartmentStat {
+   departmentId: string | null;
    name: string;
    count: number;
    activeCount: number;
  }
  ...
- <div key={dept.name} className="space-y-1">
+ <div key={dept.departmentId ?? dept.name} className="space-y-1">
```

### Fix 3: Project member breakdown — Include `employeeId`
**File:** `src/components/projects/projects-page.tsx`
```diff
- const memberHours: Record<string, { name: string; hours: number }> = {};
+ const memberHours: Record<string, { employeeId: string; name: string; hours: number }> = {};
  ...
- memberHours[entry.employeeId] = { name: memberName, hours: 0 };
+ memberHours[entry.employeeId] = { employeeId: entry.employeeId, name: memberName, hours: 0 };
  ...
- <div key={m.name} className="flex items-center gap-3">
+ <div key={m.employeeId} className="flex items-center gap-3">
```

---

## Name-Based Key Audit

| Component | Current Key | Uniqueness Guarantee | Action |
|-----------|------------|---------------------|--------|
| `employee-statistics.tsx` | `dept.departmentId ?? dept.name` | ✅ DB ID (immutable) | **Fixed** |
| `projects-page.tsx` (members) | `m.employeeId` | ✅ DB ID (immutable) | **Fixed** |
| `comparison-tool.tsx` | `name` (Map key) | ✅ Map construction guarantees uniqueness | Safe |
| `headcount-chart.tsx` | `item.name` | ✅ Hardcoded: Active/Inactive/On Leave | Safe |
| `employee-details-page.tsx` | `item.name` | ✅ Hardcoded: Productive/Neutral/Unproductive | Safe |
| `employee-performance-profile.tsx` | `site.name` | ✅ Website URLs (unique per employee) | Safe |
| `daily-report.tsx` (dept) | `dept.dept` | ✅ Map key (unique by construction) | Safe |
| `daily-report.tsx` (apps) | `name` | ✅ Map entry key (unique by construction) | Safe |
| `break-status-page.tsx` | `dept.departmentName` | ⚠️ Org-scoped (safe today, fragile) | Low risk — org-scoped query |
| `employee-dialog.tsx` | `d.id` | ✅ DB ID | Safe |
| `employee-filters.tsx` | `dept.id` | ✅ DB ID | Safe |
| `organization-page.tsx` | `dept.id` | ✅ DB ID | Safe |
| `departments-page.tsx` | `dept.id` / `dept.departmentId` | ✅ DB ID | Safe |
| `department-table.tsx` | `dept.id` | ✅ DB ID | Safe |
| `reports-page.tsx` | `d.id` | ✅ DB ID | Safe |
| `insights-page.tsx` | `d.id` / `p.id` | ✅ DB ID | Safe |
| `sentiment-page.tsx` | `d.id` | ✅ DB ID | Safe |

---

## Database Integrity

```
Customer Support duplicate records were:
- VALID and PRESERVED

Explanation: Two different organizations each legitimately have a
"Customer Support" department. The Department model enforces
@@unique([organizationId, name]) — same name across orgs is by design.
The issue was purely a React key selection bug, not a data integrity problem.
```

---

## Validation

```
Duplicate-key warning:  FIXED (departmentId used as React key)
Regression test:        8/8 passing (tests/react-duplicate-key-regression.test.ts)
TypeScript:             Clean (no errors)
ESLint:                 Not configured (no script in package.json)
Tests:                  89/89 passing (all suites)
Production build:       Clean (127 pages generated)
```

---

## Files Modified

| File | Change |
|------|--------|
| `src/app/api/employees/statistics/route.ts` | Added `departmentId` to departmentStats response |
| `src/components/employees/employee-statistics.tsx` | Added `departmentId` to interface, used as React key |
| `src/components/projects/projects-page.tsx` | Added `employeeId` to memberBreakdown, used as React key |
| `tests/react-duplicate-key-regression.test.ts` | Created — 8 regression tests |

---

## Final Verdict

```
DUPLICATE KEY ISSUE: FIXED
```
