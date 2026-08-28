# GUESTS FEATURE REMOVAL READINESS AUDIT — 2026-08-28

**Audit Type:** Read-only, production-grade  
**Repository:** omnisight-web  
**Date:** 2026-08-28  
**Auditor:** Buffy (AI Agent)

---

## 1. Executive Verdict

### **SAFE TO REMOVE WITH REDESIGN**

The separate **Guests menu** (UI page + navigation entry) can be removed **if and only if** the Guest lifecycle operations (suspend, revoke, reactivate, convert, list/search, settings) are **redesigned into existing surfaces** — primarily Agent Approvals and/or a consolidated Employee management view.

**The Guest Prisma model CANNOT be removed.** It is a structural dependency of the current enrollment architecture. Removing the Guest model would break:
- Guest approval (DeviceClaim → Guest creation)
- Guest suspend/revoke/reactivate lifecycle
- Guest → Employee conversion
- Agent authentication (Guest fail-closed check)
- Database referential integrity (FK constraints on Employee.guestId, Device.guests, Organization.guests)

**The Guest API routes CANNOT be simply deleted** — they must be relocated to alternative surfaces before the Guests page is removed.

---

## 2. Current Guest Architecture

```
Agent / Device
      ↓
Zero-Touch Discovery → DeviceClaim
      ↓
Agent Approvals
      ↓
 ┌───────────────┐
 │               │
 ▼               ▼
Employee        Guest ←── Guests Page (separate management UI)
                  │
                  │ Convert anytime
                  ▼
               Employee
```

### Guest Entity Lifecycle
```
DeviceClaim (pending) 
  → Admin "Approve as Guest" 
  → Guest (ACTIVE) + Employee (type='guest') + Device (bound)
  → SUSPENDED (reversible) / REVOKED (terminal) / ACTIVE (normal)
  → Convert to Employee → Guest row deleted, Employee.type = 'employee'
```

### Guest Entity Components
- **Guest model** (Prisma): status tracking, audit timestamps, org/device/employee relations
- **Employee model**: `type='guest'`, `guestId` foreign key
- **Device model**: `guests` relation (1:many)
- **Guests API** (5 routes): list, convert, suspend, revoke, reactivate
- **Guests UI** (`guests-page.tsx`): list, search, filter, suspend/revoke/reactivate/convert actions
- **Guests helpers** (`src/lib/guests.ts`): identity synthesis, consent auto-grant, write guard
- **Realtime**: `guest` WebSocket event type + invalidation mapping

---

## 3. Agent Approvals Relationship

### How They Interact

The **Agent Approvals** page (`agent-approvals-page.tsx`) contains the **"Approve as Guest"** button in its approval dialog. When clicked:

1. Sends `POST /api/device-claims/{id}/approve` with `{ mode: "guest" }`
2. The route calls `createGuestBackedEmployee()` from `src/lib/guests.ts`
3. Creates: Guest row + Employee (type='guest') + Device binding
4. Auto-grants monitoring consent via `grantGuestMonitoringConsents()`
5. Writes audit log + notification

**Critical finding:** Agent Approvals already depends on `src/lib/guests.ts` for guest-mode approval. The dependency is:
- `createGuestBackedEmployee()` — creates Guest + Employee
- `grantGuestMonitoringConsents()` — auto-grants monitoring consent
- `resolveGuestPendingLimit()` — enforces per-org guest cap

### Can Agent Approvals Support "Approve as Guest" Without the Guests Page?

**Yes.** Agent Approvals already creates Guests. The approval flow is independent of the Guests management page. Removing the Guests page does NOT affect the "Approve as Guest" button functionality.

---

## 4. Guest → Employee Relationship

### Conversion Flow
```
POST /api/guests/{id}/convert
  → requireGuestWriteScope (admin/manager, org-scoped, rate-limited)
  → findOrgGuest (cross-org concealment → 404)
  → Validate email, employeeId, department collisions
  → Transaction:
    → Employee.type → 'employee'
    → Employee.identity fields updated
    → Employee.guestId → null
    → Guest row deleted
    → Audit log (guest_converted)
```

### What Conversion Depends On
- **`src/lib/guests.ts`**: `findOrgGuest()`, `requireGuestWriteScope()` — both used ONLY by Guest-specific routes
- **`src/app/api/guests/[id]/convert/route.ts`**: the conversion endpoint itself
- **Prisma Guest model**: the row that gets deleted
- **Employee.guestId**: set to null during conversion

### Where Could "Convert Guest → Employee" Live After Guests Removal?

**Option 1: Agent Approvals page** — Add a "Convert to Employee" action on approved guest device claims. The claim already has the employee reference.

**Option 2: Employee details page** — Show guest-backed employees with a "Convert to Employee" action.

**Option 3: Devices page** — Show guest-backed devices with lifecycle actions.

**Recommendation:** Option 1 (Agent Approvals) is the natural fit because admins already manage guest approvals there.

---

## 5. Feature Dependency Map

### A. Guest-Specific Functionality (can be removed/redesigned)

| Component | File(s) | Purpose | Can Remove? |
|-----------|---------|---------|-------------|
| Guests Page UI | `src/components/guests/guests-page.tsx` | Guest list, search, filter, lifecycle actions | **YES** (with redesign) |
| Guests Page Route | `src/lib/store.ts` (PageType) | `'guests'` page type | **YES** (with redesign) |
| Guests Navigation | `src/components/layout/app-sidebar.tsx` | Sidebar nav item | **YES** |
| Guests Navigation Role | `src/lib/navigation.ts` | `'guests': 'manager'` min role | **YES** |
| Guests Page Component | `src/app/page.tsx` | Dynamic import + pageComponents mapping | **YES** |
| Guests API: List | `src/app/api/guests/route.ts` (GET) | List guests, search, summary | **Relocate** to Employee or Device list |
| Guests API: Settings | `src/app/api/guests/route.ts` (PUT) | Guest enrollment limit setting | **Relocate** to Settings page |
| Guests API: Convert | `src/app/api/guests/[id]/convert/route.ts` | Guest → Employee conversion | **Relocate** to Agent Approvals |
| Guests API: Suspend | `src/app/api/guests/[id]/suspend/route.ts` | Suspend active guest | **Relocate** to Agent Approvals |
| Guests API: Revoke | `src/app/api/guests/[id]/revoke/route.ts` | Revoke guest (terminal) | **Relocate** to Agent Approvals |
| Guests API: Reactivate | `src/app/api/guests/[id]/reactivate/route.ts` | Reactivate suspended guest | **Relocate** to Agent Approvals |
| Guests Helpers | `src/lib/guests.ts` | `requireGuestWriteScope`, `findOrgGuest` | **Keep** (used by relocated routes) |
| Guests Helpers | `src/lib/guests.ts` | `createGuestBackedEmployee`, `grantGuestMonitoringConsents` | **Keep** (used by DeviceClaim approve) |
| Guests WS Event | `src/components/providers/websocket-provider.tsx` | `GuestEvent` type, `lastGuest` state | **Keep** (used by Live Monitor) |
| Guests WS Invalidation | `src/lib/ws-invalidation.ts` | `guestInvalidation()` function | **Keep** (used by WS provider) |
| Guests Live Monitor | `src/components/live-monitor/live-monitor-page.tsx` | Guest event type mapping | **Keep** (Live Monitor feature) |
| Guests Event Stats | `src/app/api/live-monitor/event-stats/route.ts` | Guest count in event stats | **Keep** (Live Monitor feature) |
| Guests Mini-service | `mini-services/live-updates/index.ts` | Guest poll + broadcast | **Keep** (Live Monitor feature) |
| Guests Mini-service | `mini-services/live-updates/notify-triggers.ts` | Guest in BROADCAST_TABLES | **Keep** (Live Monitor feature) |
| Guests Proxy RBAC | `src/proxy.ts` | `{ prefix: '/api/guests', minRole: 'admin' }` | **Keep** (needed if API routes relocated) |

### B. Shared Functionality (MUST NOT be removed)

| Component | File(s) | Purpose | Can Remove? |
|-----------|---------|---------|-------------|
| Guest Model | `prisma/schema.prisma` | Guest entity (status, audit, relations) | **NO** — structurally required |
| Employee.type | `prisma/schema.prisma` | `type: 'guest'` discriminator | **NO** — required by auth |
| Employee.guestId | `prisma/schema.prisma` | FK to Guest | **NO** — required by conversion |
| Guest Identity Synthesis | `src/lib/guests.ts` | `synthesizeGuestIdentity()` | **NO** — used by approve flow |
| Guest Pending Limit | `src/lib/guests.ts` | `resolveGuestPendingLimit()` | **NO** — used by approve flow |
| Guest Write Guard | `src/lib/guests.ts` | `requireGuestWriteScope()` | **NO** — used by relocated routes |
| Guest Find Helper | `src/lib/guests.ts` | `findOrgGuest()` | **NO** — used by relocated routes |
| Guest Auto-Consent | `src/lib/guests.ts` | `grantGuestMonitoringConsents()` | **NO** — used by approve flow |

### C. Agent Approvals Dependencies (MUST NOT be removed)

| Component | File(s) | Purpose |
|-----------|---------|---------|
| Approve as Guest button | `agent-approvals-page.tsx` | UI mode selection in approval dialog |
| Guest mode in approve API | `device-claims/[id]/approve/route.ts` | `{ mode: "guest" }` handling |
| Guest creation functions | `src/lib/guests.ts` | `createGuestBackedEmployee`, `grantGuestMonitoringConsents`, `resolveGuestPendingLimit` |

### D. Authentication Dependencies (MUST NOT be removed)

| Component | File(s) | Purpose |
|-----------|---------|---------|
| Guest fail-closed check | `src/app/api/agent/authenticate/route.ts` | Lines 129-136: checks `employee.type === 'guest'` → verifies Guest status is ACTIVE |

### E. Device/Telemetry Dependencies (MUST NOT be removed)

| Component | File(s) | Purpose |
|-----------|---------|---------|
| Device.guests relation | `prisma/schema.prisma` | FK relation from Device to Guest |
| Guest-backed Employee telemetry | All Activity/Screenshot/etc. | Telemetry uses Employee (not Guest) |

### F. Live Event/WebSocket Dependencies (MUST NOT be removed)

| Component | File(s) | Purpose |
|-----------|---------|---------|
| `guest` event type | `websocket-provider.tsx` | Live Monitor displays guest events |
| `guestInvalidation()` | `ws-invalidation.ts` | React Query cache invalidation |
| Guest poll in mini-service | `mini-services/live-updates/index.ts` | Real-time guest event broadcast |
| Guest in BROADCAST_TABLES | `mini-services/live-updates/notify-triggers.ts` | pg_notify trigger |
| Guest count in event stats | `event-stats/route.ts` | Live Monitor stats card |

### G. Audit/Logging Dependencies

| Component | File(s) | Purpose |
|-----------|---------|---------|
| Guest audit actions | `device-claims/[id]/approve/route.ts` | `guest_approved` audit entry |
| Guest lifecycle audits | Guest API routes | `guest_suspended`, `guest_revoked`, `guest_reactivated`, `guest_converted` |
| Historical audit records | AuditLog table | MUST NOT be deleted |

### H. Permission/RBAC Dependencies

| Permission | Role | Used By | Can Remove? |
|------------|------|---------|-------------|
| `guests.read` | manager+ | Guest page access, `requireGuestWriteScope` | **Keep** (relocated routes) |
| `guests.manage` | manager+ | Guest lifecycle mutations | **Keep** (relocated routes) |

---

## 6. Production Usage

**Production database usage could not be directly verified.** No direct database access is available during this audit.

The Guest model is actively used by the current enrollment architecture:
- DeviceClaims approved in GUEST mode create Guest rows
- Guest rows track ACTIVE/SUSPENDED/REVOKED status
- Guest → Employee conversion deletes Guest rows
- Historical Guest rows may exist from previous enrollments

---

## 7. Removal Risks

| Risk | Severity | Description |
|------|----------|-------------|
| Guest model removal | **CRITICAL** | Would break FK constraints on Employee.guestId, Device.guests, Organization.guests; would break Agent authentication; would break DeviceClaim guest-mode approval |
| Guest API route deletion | **HIGH** | Would break any code calling these routes; would lose guest lifecycle management |
| Guest page removal | **LOW** | Pure UI change — no backend impact |
| Guest permission removal | **MEDIUM** | Would break `requireGuestWriteScope()` — shared guard for guest lifecycle |
| Guest WS event removal | **MEDIUM** | Would break Live Monitor guest event display |
| Guest mini-service removal | **MEDIUM** | Would break real-time guest event broadcast |
| Guest event stats removal | **LOW** | Would reduce Live Monitor stats accuracy |
| Guest sidebar removal | **LOW** | Pure navigation change |
| Guest store PageType removal | **LOW** | Pure routing change |

---

## 8. What CAN Be Removed (Safely)

### Files that can be deleted outright:
- `src/components/guests/guests-page.tsx` (after functionality is relocated)

### UI elements that can be removed:
- Sidebar navigation item `{ page: 'guests', label: 'Guests', icon: UserPlus, showBadge: true }`
- Navigation permission `'guests': 'manager'` in `PAGE_MIN_ROLE`
- Store page type `'guests'` from `PageType`
- Page component mapping `guests: GuestsPage` in `page.tsx`
- Dynamic import of `GuestsPage` in `page.tsx`

### Files that need to be relocated (not deleted):
- Guest lifecycle API routes need to be moved to Agent Approvals or Employee management
- Guest settings (enrollment limit) need to be moved to Settings page

---

## 9. What MUST Remain

### Prisma Model (NON-NEGOTIABLE)
```prisma
model Guest {
  // ... full model must remain ...
}
```

### Employee Relations (NON-NEGOTIABLE)
```prisma
// In Employee model:
type            String   @default("employee") // employee, guest
guestId         String?  @unique
guest          Guest?
```

### Device Relations (NON-NEGOTIABLE)
```prisma
// In Device model:
guests         Guest[]
```

### Organization Relations (NON-NEGOTIABLE)
```prisma
// In Organization model:
guests             Guest[]
```

### Core Guest Functions (NON-NEGOTIABLE)
- `createGuestBackedEmployee()` — used by DeviceClaim approve route
- `grantGuestMonitoringConsents()` — used by DeviceClaim approve route
- `resolveGuestPendingLimit()` — used by DeviceClaim approve route
- `synthesizeGuestIdentity()` — used by createGuestBackedEmployee
- `requireGuestWriteScope()` — used by all guest lifecycle routes
- `findOrgGuest()` — used by all guest lifecycle routes

### Agent Authentication (NON-NEGOTIABLE)
```typescript
// In src/app/api/agent/authenticate/route.ts:
if (employee.type === 'guest') {
  const guest = await db.guest.findFirst({
    where: { deviceId, employeeId: employee.id },
    select: { status: true },
  });
  if (!guest || guest.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'Guest access is not active' }, { status: 403 });
  }
}
```

### Live Monitor/Realtime (NON-NEGOTIABLE)
- `guest` WebSocket event type
- `guestInvalidation()` function
- Guest in Live Monitor event types
- Guest count in event stats
- Guest poll in mini-service
- Guest in BROADCAST_TABLES

### Permissions (NON-NEGOTIABLE)
- `guests.read` permission (used by `requireGuestWriteScope`)
- `guests.manage` permission (used by `requireGuestWriteScope`)

### Proxy RBAC (NON-NEGOTIABLE)
```typescript
{ prefix: '/api/guests', minRole: 'admin' }
```
(Still needed if lifecycle routes are relocated to /api/guests/*)

---

## 10. Recommended Final Architecture

```
                     Agent / Device
                           │
                           ▼
                    Agent Approvals
                    ┌───────┴───────┐
                    │ Approve       │
                    │ as Employee   │
                    │ or Guest      │
                    └───────┬───────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
                 ▼                   ▼
             Employee              Guest
                                       │
                              ┌────────┴────────┐
                              │ Agent Approvals │
                              │ "Guest Actions" │
                              │ - Suspend       │
                              │ - Revoke        │
                              │ - Reactivate    │
                              │ - Convert       │
                              └────────┬────────┘
                                       │ Convert anytime
                                       ▼
                                    Employee
```

### Key Design Decisions:
1. **Agent Approvals** becomes the single surface for ALL enrollment decisions AND guest lifecycle management
2. **Guest model remains** as a structural entity (not just a UI concept)
3. **Guest lifecycle actions** move from the separate Guests page to contextual actions within Agent Approvals (or a "Guest Details" drawer/panel)
4. **Guest list** can be shown as a filter/view within Agent Approvals (approved guest claims) or within the Employee list (filtered by `type='guest'`)
5. **Guest settings** (enrollment limit) move to the Settings page
6. **Live Monitor** continues showing guest events as a separate event type

---

## 11. Migration Requirements

### If removing the Guest menu ONLY (Option A):
**No database migration required.** Guest model, API routes, and all backend logic remain.

### If removing the Guest model (Option B — NOT RECOMMENDED):
This would require:
1. **Flatten Guest status into Employee** — add `guestStatus`, `guestApprovedAt`, `guestApprovedBy`, etc. fields to Employee
2. **Remove `Employee.guestId`** FK
3. **Remove `Device.guests`** relation
4. **Remove `Organization.guests`** relation
5. **Remove Guest model**
6. **Migrate data** — move all Guest status/timestamp data into Employee fields
7. **Update all queries** — every `db.guest.*` call must be rewritten
8. **Update authentication** — guest fail-closed check must use Employee fields
9. **Update DeviceClaim approve** — guest creation must only create Employee (no Guest row)
10. **Update conversion** — no Guest row to delete; just flip Employee.type
11. **Update all tests** — every guest test references the Guest model

**Risk: HIGH** — This is a major refactor with many opportunities for regression.

---

## 12. Test Requirements

### Tests that MUST remain (regression coverage):

| Test File | Tests | Why Must Remain |
|-----------|-------|-----------------|
| `tests/guests.test.ts` | 17 tests | Full guest lifecycle + tenant isolation + RBAC |
| `tests/guest-approval-rbac.test.ts` | RBAC tests | Permission model for guest lifecycle |
| `tests/guest-convert-rbac.test.ts` | Conversion RBAC | Ensures conversion is workforce-only (no AppUser) |
| `tests/guest-join-discover.test.ts` | Guest join flow | Desktop Agent guest join → discover → approve → auth |
| `tests/guest-activity.test.ts` | Activity pipeline | Consent-gated telemetry for guests |

### Tests that validate critical invariants:
- **No web account for guests**: guest-convert-rbac.test.ts proves no AppUser/OrganizationMembership created
- **Cross-org isolation**: guests.test.ts and guest-approval-rbac.test.ts prove org A cannot see org B's guests
- **Auth fail-closed**: guests.test.ts proves suspended/revoked guests cannot authenticate
- **Tenant isolation**: guest-join-discover.test.ts proves foreign admin cannot approve

---

## 13. Implementation Plan

### Phase 1: Relocate Guest Lifecycle (SAFE, non-breaking)
1. Create new endpoints under `/api/device-claims/[id]/guest-*` for guest lifecycle:
   - `POST /api/device-claims/{id}/guest/suspend`
   - `POST /api/device-claims/{id}/guest/revoke`
   - `POST /api/device-claims/{id}/guest/reactivate`
   - `POST /api/device-claims/{id}/guest/convert`
2. Add "Guest Actions" UI to Agent Approvals page (contextual menu on approved guest claims)
3. Add guest enrollment limit setting to the Settings page
4. Verify all actions work from Agent Approvals

### Phase 2: Remove Guests Page (SAFE, after Phase 1)
1. Remove `guests` nav item from sidebar
2. Remove `guests` PageType from store
3. Remove `GuestsPage` import and mapping from page.tsx
4. Delete `src/components/guests/guests-page.tsx`
5. Remove `guests` from `PAGE_MIN_ROLE` in navigation.ts

### Phase 3: Remove Old API Routes (SAFE, after Phase 1)
1. Remove `src/app/api/guests/[id]/suspend/route.ts`
2. Remove `src/app/api/guests/[id]/revoke/route.ts`
3. Remove `src/app/api/guests/[id]/reactivate/route.ts`
4. Remove `src/app/api/guests/[id]/convert/route.ts`
5. Update or remove `src/app/api/guests/route.ts` (keep GET if still needed for listing)
6. Update proxy RBAC if routes changed

### Phase 4: Update Tests
1. Update test files that reference the old Guests page routes
2. Add regression tests for new Agent Approvals guest actions
3. Verify all 5 guest test files still pass

### Phase 5: Verification
1. `npx tsc --noEmit` — TypeScript clean
2. `npm run lint` — ESLint clean
3. Run all 5 guest test suites
4. Run full regression test suite
5. `npx next build` — production build
6. Runtime smoke test: Agent Approvals guest actions work

---

## 14. Rollback Plan

If a production regression occurs after removing the Guests page:

### Immediate (< 5 minutes):
1. Restore `src/components/guests/guests-page.tsx` from git
2. Restore sidebar nav item
3. Restore `page.tsx` dynamic import + mapping
4. Restore `navigation.ts` and `store.ts` PageType entries
5. Restore API route files if deleted
6. Deploy hotfix

### Git rollback:
```bash
git revert HEAD  # revert the Guests removal commit
```

### Full rollback:
```bash
git log --oneline  # find the commit before Guests removal
git revert <commit-hash>
```

**Key insight:** Since the Guest model and all backend logic remain untouched, rollback is a simple UI restoration — no data migration rollback needed.

---

## 15. Final Production Recommendation

### Question 1: Can the separate Guests menu/system be removed?

**Answer: YES — with redesign.**

The Guests page is a **duplicate management surface** for Guest lifecycle operations. Agent Approvals already creates Guests. The Guest lifecycle operations (suspend, revoke, reactivate, convert) can be relocated to Agent Approvals as contextual actions on approved guest device claims. The Guest list can be shown as a filter within Agent Approvals or the Employee list.

### Question 2: Can the Guest database model be removed?

**Answer: NO — not without major refactoring and significant regression risk.**

The Guest model is a structural dependency of the current architecture:
- Agent authentication checks `Guest.status === 'ACTIVE'`
- DeviceClaim guest-mode approval creates Guest rows
- Guest → Employee conversion deletes Guest rows
- Employee.guestId FK points to Guest
- Live Monitor broadcasts guest events
- 5 comprehensive test suites validate guest behavior

Removing the Guest model would require flattening Guest data into Employee fields, updating authentication, updating DeviceClaim approval, rewriting all guest queries, and updating all tests. This is a **MEDIUM-HIGH risk refactor** that should only be attempted with thorough regression testing and a dedicated migration plan.

---

## ══════════════════════════════════════════════════════════════
## GUESTS REMOVAL READINESS
## ══════════════════════════════════════════════════════════════

**Separate Guests Menu:**  
SAFE TO REMOVE (with redesign — relocate lifecycle actions to Agent Approvals)

**Guest API (List/Settings):**  
SAFE TO REMOVE (relocate to Employee list or Settings page)

**Guest API (Suspend/Revoke/Reactivate/Convert):**  
SAFE TO REMOVE (relocate to Agent Approvals contextual actions)

**Guest Model:**  
NOT SAFE TO REMOVE (structurally required by auth, DeviceClaim, Employee, Live Monitor)

**Guest Approval:**  
MUST REMAIN (DeviceClaim approve mode = guest creates Guest + Employee)

**Guest → Employee:**  
MUST REMAIN (core product feature — relocate UI only)

**Agent Approvals:**  
SAFE (already depends on Guest functions; removing Guests page does not affect it)

**Employee System:**  
SAFE (Guest employees are Employees with type='guest'; no change needed)

**Authentication:**  
SAFE (Guest fail-closed check uses Guest model; model stays)

**Telemetry:**  
SAFE (Telemetry uses Employee, not Guest; no dependency on Guest page)

**Live Event Stream:**  
SAFE (Guest events are a separate event type; unaffected by Guests page removal)

**Multi-Org Security:**  
SAFE (Guest queries are org-scoped; no isolation change)

**Production Data:**  
NOT VERIFIED (no direct database access)

**Final Verdict:**  
SAFE TO REMOVE WITH REDESIGN

**Implementation Required:**  
YES — relocate guest lifecycle operations to Agent Approvals before removing Guests page

## ══════════════════════════════════════════════════════════════

---

### Files Reference Summary

**Guest-specific files (candidates for removal/relocation):**
- `src/components/guests/guests-page.tsx` — DELETE (after functionality relocated)
- `src/app/api/guests/[id]/suspend/route.ts` — RELOCATE to Agent Approvals
- `src/app/api/guests/[id]/revoke/route.ts` — RELOCATE to Agent Approvals
- `src/app/api/guests/[id]/reactivate/route.ts` — RELOCATE to Agent Approvals
- `src/app/api/guests/[id]/convert/route.ts` — RELOCATE to Agent Approvals
- `src/app/api/guests/route.ts` — KEEP (GET for listing, PUT for settings)

**Files with Guest references to update:**
- `src/components/layout/app-sidebar.tsx` — remove Guests nav item
- `src/lib/navigation.ts` — remove `'guests': 'manager'` entry
- `src/lib/store.ts` — remove `'guests'` from PageType
- `src/app/page.tsx` — remove GuestsPage import + mapping
- `src/lib/permissions.ts` — KEEP `guests.read`/`guests.manage` (used by relocated routes)

**Files that MUST NOT be modified:**
- `prisma/schema.prisma` — Guest model + Employee.guestId + Device.guests + Organization.guests
- `src/lib/guests.ts` — ALL functions (used by DeviceClaim approve + relocated routes)
- `src/app/api/agent/authenticate/route.ts` — Guest fail-closed check
- `src/app/api/device-claims/[id]/approve/route.ts` — Guest mode approval
- `src/components/providers/websocket-provider.tsx` — GuestEvent type + handler
- `src/lib/ws-invalidation.ts` — guestInvalidation() function
- `src/components/live-monitor/live-monitor-page.tsx` — Guest event type mapping
- `src/app/api/live-monitor/event-stats/route.ts` — Guest count
- `mini-services/live-updates/index.ts` — Guest poll + broadcast
- `mini-services/live-updates/notify-triggers.ts` — Guest in BROADCAST_TABLES
- `src/proxy.ts` — Guest RBAC rule
- `tests/guests.test.ts` — Full lifecycle regression
- `tests/guest-approval-rbac.test.ts` — RBAC regression
- `tests/guest-convert-rbac.test.ts` — Conversion RBAC regression
- `tests/guest-join-discover.test.ts` — Guest join flow regression
- `tests/guest-activity.test.ts` — Activity pipeline regression
