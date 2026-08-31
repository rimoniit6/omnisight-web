# SUPER ADMIN — CREATE USER BUTTON FORENSIC FIX

**Date:** 2026-08-31  
**Status:** ✅ PASS — Production Safe

---

## Executive Summary

The Super Admin **Create User** button was not working because the `pageContext` (organization ID) was **empty** when the handler fired. The root cause was a **state management ordering bug** in the Zustand store: `setCurrentPage()` was overwriting the `pageContext` that had just been set by `setPageContext()`.

## Reproduction

Before the fix, clicking Create User produced this console output:

```
[SA-CREATE-USER] Button clicked, addMode=new
[SA-CREATE-USER] Handler fired {orgId: '', addRole: manager, ...}
[SA-CREATE-USER] BLOCKED: missing fields {orgId: false, ...}
```

The handler silently returned because `!orgId` was `true` — the organization ID was empty string.

## Root Cause

In `src/components/super-admin/super-admin-organizations-page.tsx`, the `openManage` function:

```typescript
// ❌ BEFORE (broken)
const openManage = (org: Organization) => {
  setPageContext(org.id);           // sets pageContext = org.id ✅
  setPageContextLabel(org.name);    // sets pageContextLabel = org.name ✅
  setCurrentPage('super-admin-organization-detail');  // CLEARS pageContext! ❌
};
```

The Zustand store's `setCurrentPage` is defined as:

```typescript
setCurrentPage: (page) => set({ currentPage: page, pageContext: '', pageContextLabel: '' }),
```

This **resets `pageContext` to `''`**, which overwrites the value set by `setPageContext(org.id)`.

Zustand's `set` does a shallow merge (`Object.assign`), so the last write to each key wins. Since `setCurrentPage` is called last, `pageContext: ''` overwrites `pageContext: org.id`.

## Fix

Reorder the calls so `setCurrentPage` runs first (clearing context), then set the context AFTER:

```typescript
// ✅ AFTER (fixed)
const openManage = (org: Organization) => {
  // setCurrentPage clears pageContext — set it AFTER to avoid the clear.
  setCurrentPage('super-admin-organization-detail');
  setPageContext(org.id);
  setPageContextLabel(org.name);
};
```

Now the state updates in this order:
1. `setCurrentPage(...)` → `pageContext: ''`
2. `setPageContext(org.id)` → `pageContext: org.id`
3. `setPageContextLabel(org.name)` → `pageContextLabel: org.name`

Final state: `{ currentPage: 'super-admin-organization-detail', pageContext: org.id, pageContextLabel: org.name }` ✅

## Files Changed

| File | Change |
|------|--------|
| `src/components/super-admin/super-admin-organizations-page.tsx` | Reordered `openManage` to call `setCurrentPage` before `setPageContext` |
| `src/components/super-admin/super-admin-organization-detail-page.tsx` | Removed diagnostic `console.log` statements added during debugging |

## Live Browser Verification

Used headless Chromium (browse) to trace the complete flow:

### Before Fix
```
Browser → Login → Super Admin → Organizations → Manage → Add Member → Create New User
→ Fill form → Click Create User
→ Console: BLOCKED: missing fields {orgId: false}
→ Dialog stays open. No API request. User not created.
```

### After Fix
```
Browser → Login → Super Admin → Organizations → Manage → Add Member → Create New User
→ Fill form (Name: "RR Test User Fixed", Email: rr-fixed-e2e@omnisight.local)
→ Click Create User
→ Console: orgId: cmthbk7z6000ffizco06e3r5i ✅
→ Console: Validation passed, sending request ✅
→ Console: Response received {status: 201, ok: true} ✅
→ Console: SUCCESS — closing dialog, refreshing members ✅
→ Dialog closes. Members list refreshes. User appears.
```

### Database Verification
```
AppUser: id=cmthdk53j000ufi1wucb6tzkm, email=rr-fixed-e2e@omnisight.local, role=user ✅
OrganizationMembership: orgId=cmthbk7z6000ffizco06e3r5i, role=manager, status=ACTIVE ✅
```

## Test Results

```
super-admin.test.ts:                    18/18 pass ✅
super-admin-hardening.test.ts:          21/21 pass ✅
super-admin-create-member-flow.test.ts: 20/20 pass ✅
super-admin-organization-context.test.ts: 12/12 pass ✅
TypeScript:                              0 errors  ✅
```

## Final Verdict

**PASS — Production Safe**

The Create User button now correctly passes the organization ID to the API, and the user is created with both `AppUser` and `OrganizationMembership` records.
