# MULTI-ORG GA PRE-IMPLEMENTATION AUDIT

**Date:** August 26, 2026

## 1. Current OrganizationMembership Schema

**File:** `prisma/schema.prisma` (lines ~660-680)

```prisma
model OrganizationMembership {
  id             String   @id @default(cuid())
  userId         String
  organizationId String
  role           String   @default("viewer") // owner, admin, manager, viewer
  status         String   @default("ACTIVE") // ACTIVE, INVITED, SUSPENDED, REMOVED
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([userId, organizationId])
  @@index([userId])
  @@index([organizationId])
  @@index([status])
}
```

**Status:** ✅ IMPLEMENTED

## 2. UserSession.activeOrganizationId

**File:** `prisma/schema.prisma` (lines ~700-720)

```prisma
model UserSession {
  ...
  activeOrganizationId String?
  ...
  activeOrganization Organization? @relation("ActiveOrgSession", ...)
  ...
}
```

**Status:** ✅ IMPLEMENTED

## 3. AgentToken.organizationId

**File:** `prisma/schema.prisma` (lines ~766-790)

```prisma
model AgentToken {
  ...
  organizationId String?
  ...
  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: SetNull)
  ...
}
```

**Status:** ✅ IMPLEMENTED (nullable for migration)

## 4. Enrollment Code Flow

**Current Implementation:**
- **Generation:** `POST /api/organization/enrollment-code` generates code, stores SHA-256 hash
- **Revocation:** `DELETE /api/organization/enrollment-code` removes the setting
- **Status:** `GET /api/organization/enrollment-code` returns `{ exists, active, createdAt }`
- **Verification:** `resolveOrgFromEnrollmentCode()` in `src/app/api/agent/discover/route.ts`

**Missing:**
- ❌ No expiration field on enrollment codes
- ❌ No `expiresAt` in the response
- ❌ No expiration check in `resolveOrgFromEnrollmentCode()`

## 5. Agent Join/Guest UI

**File:** `E:\Live project\omnisight\omnisight-agent\src\renderer\index.html`

Current UX:
```html
<button type="button" id="btn-join-guest" class="ghost">Join as Guest</button>
```

**Missing:**
- ❌ No enrollment code input field
- ❌ No way for user to enter invitation code without editing .env

## 6. Admin Organization Switcher

**File:** `src/components/layout/app-sidebar.tsx`

Current UX: No organization switcher exists.

**APIs Available:**
- `GET /api/me/organizations` - lists user's memberships
- `POST /api/me/organization/switch` - switches active org

**Missing:**
- ❌ No org-switcher dropdown in the UI
- ❌ No visual indicator of current active org

## 7. Enrollment Code API Status

**GET /api/organization/enrollment-code** returns:
```json
{
  "exists": true,
  "active": true,
  "createdAt": "2026-08-26T..."
}
```

**Missing:**
- ❌ No `expiresAt` field
- ❌ No `revoked` field (redundant with `active`)

## 8. Agent Discover Error Contract

**Current errors:**
- 400: Missing/invalid deviceKey or hostname
- 409: Device already registered
- 422: Missing/invalid enrollment code
- 429: Rate limited
- 503: No organization configured

**Missing:**
- ❌ No distinct error for expired enrollment code (currently 422)
- ❌ No distinct error for suspended organization

## 9. Test Baseline

**Web:** 1158/1179 pass (14 pre-existing audio seed failures)
**Agent:** 623/623 pass
**TypeScript:** PASS (0 errors)
**ESLint:** PASS (0 errors, 240 warnings)
**Build:** PASS
**Prisma:** VALID

## Summary of GA Gaps

| Gap | Priority | Status |
|-----|----------|--------|
| Agent UI enrollment code input | P0 | NOT IMPLEMENTED |
| Admin organization switcher | P0 | NOT IMPLEMENTED |
| Enrollment code expiration | P1 | NOT IMPLEMENTED |
| Distinct error codes for agent | P2 | NOT IMPLEMENTED |
