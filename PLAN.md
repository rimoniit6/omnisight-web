# Organization Database & Data Transfer System — Implementation Plan

**Date:** 2026-09-08
**Scope:** omnisight-web repository
**Status:** Draft for review

---

## 1. Overview

This plan implements the Organization Database & Data Transfer system, enabling controlled MANAGED → CUSTOMER_DB data migration with full tenant isolation, audit logging, Super Admin notifications, and verification.

### 1.1 What This Feature Does

- Org Admin can view their deployment mode (read-only)
- Org Admin can request a data transfer to their own customer database
- Super Admin is notified and must approve before any data leaves the managed platform
- Data is exported in chunks via background jobs, transferred to the target database, and verified with checksums
- Every step is audit-logged; failures trigger rollback and notification

### 1.2 What This Feature Does NOT Do

- Does NOT change the deployment mode automatically (PRD Rule M: no silent service-model changes)
- Does NOT give Super Admin new data-plane access to CUSTOMER_DB/PRIVATE orgs (PRD: DATA_PLANE_MODELS restriction)
- Does NOT break existing MANAGED organizations
- Does NOT implement the actual per-tenant database pool infrastructure (that is a separate Phase)

---

## 2. Architecture Design

### 2.1 Data Flow

```
Org Admin triggers transfer request
        ↓
Request saved (state: REQUESTED)
        ↓
Super Admin notified (in-app notification)
        ↓
Super Admin approves (state: APPROVED)
        ↓
Background job picks up approved transfer
        ↓
Export data in chunks (state: EXPORTING)
        ↓
Transfer chunks to target DB (state: TRANSFERRING)
        ↓
Verify row counts + checksums (state: VERIFYING)
        ↓
Update deployment mode (state: COMPLETED) — requires confirmDataResidency
        ↓
Notify Org Admin of completion
```

### 2.2 State Machine

```
REQUESTED → APPROVED → EXPORTING → TRANSFERRING → VERIFYING → COMPLETED
    ↓          ↓          ↓            ↓             ↓
  DENIED    DENIED     FAILED       FAILED        FAILED
              ↓          ↓            ↓             ↓
          CANCELLED   ROLLED_BACK  ROLLED_BACK  ROLLED_BACK
```

Allowed transitions:
- `REQUESTED` → `APPROVED` (Super Admin action)
- `REQUESTED` → `DENIED` (Super Admin action)
- `REQUESTED` → `CANCELLED` (Org Admin action, before approval)
- `APPROVED` → `EXPORTING` (background job picks up)
- `EXPORTING` → `TRANSFERRING` (job phase transition)
- `EXPORTING` → `FAILED` (error)
- `TRANSFERRING` → `VERIFYING` (job phase transition)
- `TRANSFERRING` → `FAILED` (error)
- `VERIFYING` → `COMPLETED` (verification passes)
- `VERIFYING` → `FAILED` (verification fails)
- `FAILED` → `ROLLED_BACK` (cleanup job)

### 2.3 Tenant Isolation Rules

1. Org Admin can only view/request transfers for their OWN organization
2. Super Admin can approve/deny but CANNOT trigger the transfer directly
3. Data export reads from managed DB using existing `getTenantDb()` pattern
4. Target DB connection comes from Org Admin's configured `OrganizationSettings` (encrypted credentials)
5. No cross-tenant data access at any point

---

## 3. Schema Changes

### 3.1 New Model: `OrganizationDataTransfer`

```prisma
model OrganizationDataTransfer {
  id            String   @id @default(cuid())
  organizationId String
  organization  Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  // State machine
  status        DataTransferStatus @default(REQUESTED)
  // REQUESTED | APPROVED | DENIED | CANCELLED | EXPORTING | TRANSFERRING | VERIFYING | COMPLETED | FAILED | ROLLED_BACK

  // Transfer configuration
  targetDbHost  String
  targetDbPort  Int      @default(5432)
  targetDbName  String
  targetDbUser  String
  targetDbPassword String // Encrypted at rest (same AES-256-GCM as AI keys)
  targetDbSsl   Boolean  @default(true)

  // Progress tracking
  totalTables   Int      @default(0)
  completedTables Int    @default(0)
  totalRows     Int      @default(0)
  transferredRows Int   @default(0)
  currentTable  String?  // Name of table being processed

  // Verification
  preTransferChecksum  String?  // SHA-256 of row counts
  postTransferChecksum String? // SHA-256 of row counts after transfer
  verificationPassed   Boolean?
  verificationDetails  String?  // JSON with per-table row counts

  // Actor tracking
  requestedById String    // Org Admin who requested
  requestedBy   User      @relation("TransferRequestedBy", fields: [requestedById], references: [id])
  approvedById  String?   // Super Admin who approved
  approvedBy    User?     @relation("TransferApprovedBy", fields: [approvedById], references: [id])
  approvedAt    DateTime?

  // Timestamps
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  startedAt     DateTime? // When background job started
  completedAt   DateTime? // When transfer completed/failed

  // Error tracking
  errorMessage  String?
  errorDetails  String?   // JSON with full error context

  // Metadata
  notes         String?   // Super Admin can add notes when approving/denying

  @@index([organizationId, status])
  @@index([status, createdAt])
  @@map("organization_data_transfers")
}

enum DataTransferStatus {
  REQUESTED
  APPROVED
  DENIED
  CANCELLED
  EXPORTING
  TRANSFERRING
  VERIFYING
  COMPLETED
  FAILED
  ROLLED_BACK
}
```

### 3.2 Schema Changes to Existing Models

**Organization** — no changes needed (already has `deploymentMode`)

**OrganizationSettings** — no changes needed (already has `useOwnDb`, `dbHost`, `dbPort`, `dbName`, `dbUser`, `dbPassword`, `dbSsl`)

**NotificationType** — add `'data_transfer_request'`, `'data_transfer_approved'`, `'data_transfer_completed'`, `'data_transfer_failed'` to the canonical types (extend `NOTIFICATION_TYPES` array in `constants.ts`)

### 3.3 Migration

Create a Prisma migration: `prisma/migrations/YYYYMMDD_add_data_transfer/migration.sql`

The migration adds:
1. `DataTransferStatus` enum
2. `organization_data_transfers` table
3. Indexes on `[organizationId, status]` and `[status, createdAt]`

---

## 4. Tables eligible for transfer

Only tenant-owned tables with `organizationId` field are eligible. The transfer system will discover these dynamically using Prisma schema introspection, but the canonical list (from schema analysis) includes:

### 4.1 Priority Tier 1 (Core Business Data)
- Employee
- Department
- Project
- Device
- Agent
- Membership (org-scoped users)
- OrganizationSettings

### 4.2 Priority Tier 2 (Monitoring Data)
- Activity
- Screenshot (metadata only — binary in storage)
- LocationEvent
- KeyboardActivity
- WebcamSession
- AudioRecording

### 4.3 Priority Tier 3 (Analytics & Reporting)
- Report
- AiInsight
- Alert
- WorkdaySummary
- Anomaly

### 4.4 Excluded from transfer
- Organization (the org record stays in managed DB)
- User (platform-level auth, stays in managed DB)
- Subscription, Payment, Invoice (commercial records, stay in managed DB)
- Package (platform-level, stays in managed DB)
- AuditLog (platform-level, stays in managed DB)
- JobRun (platform-level, stays in managed DB)
- NotificationPreference (platform-level config, stays in managed DB)
- Notification (platform-level, stays in managed DB)
- * (any table without `organizationId`)

---

## 5. API Design

### 5.1 Org Admin APIs

#### `GET /api/organizations/[orgId]/settings/data-transfer`
**Purpose:** View transfer status and history
**Auth:** `requireOrgAdmin`
**Response:** Current active transfer (if any) + list of past transfers

#### `POST /api/organizations/[orgId]/settings/data-transfer`
**Purpose:** Request a new data transfer
**Auth:** `requireOrgAdmin`
**Body:**
```json
{
  "targetDbHost": "customer-db.example.com",
  "targetDbPort": 5432,
  "targetDbName": "omnisight_org_abc",
  "targetDbUser": "transfer_user",
  "targetDbPassword": "plaintext_password",
  "targetDbSsl": true,
  "notes": "Optional notes"
}
```
**Validation:**
- Org must be MANAGED (cannot transfer from CUSTOMER_DB/PRIVATE)
- No active transfer already in progress for this org
- Target DB credentials must be provided (not placeholder)
- Password is encrypted before storage

#### `DELETE /api/organizations/[orgId]/settings/data-transfer`
**Purpose:** Cancel a pending transfer (only when status = REQUESTED)
**Auth:** `requireOrgAdmin`

#### `POST /api/organizations/[orgId]/settings/data-transfer/test-target`
**Purpose:** Test connection to target database
**Auth:** `requireOrgAdmin`
**Body:** Same as POST (target DB credentials)
**Response:** `{ status: 'connected' | 'error', message: string }`

### 5.2 Super Admin APIs

#### `GET /api/super-admin/data-transfers`
**Purpose:** List all pending/approved transfers across organizations
**Auth:** `requireSuperAdmin`
**Query:** `?status=REQUESTED` (filterable)

#### `GET /api/super-admin/data-transfers/[id]`
**Purpose:** View detailed transfer status for a specific transfer
**Auth:** `requireSuperAdmin`

#### `POST /api/super-admin/data-transfers/[id]/approve`
**Purpose:** Approve a transfer request
**Auth:** `requireSuperAdmin`
**Body:**
```json
{
  "notes": "Optional approval notes"
}
```
**Validation:**
- Transfer must be in REQUESTED status
- Org must be MANAGED
- Target DB must be configured and tested

#### `POST /api/super-admin/data-transfers/[id]/deny`
**Purpose:** Deny a transfer request
**Auth:** `requireSuperAdmin`
**Body:**
```json
{
  "reason": "Required denial reason"
}
```

#### `POST /api/super-admin/data-transfers/[id]/cancel`
**Purpose:** Force-cancel a transfer (even if in progress)
**Auth:** `requireSuperAdmin`
**Body:**
```json
{
  "reason": "Required cancellation reason"
}
```

---

## 6. Background Job Design

### 6.1 New Job: `data_transfer`

Register a new job in the existing job system (`src/lib/jobs/run.ts`).

**Job name:** `data_transfer`

**Behavior:**
1. `claimJob('data_transfer')` — lease-guarded, 5-minute lease
2. Find all transfers with `status = 'APPROVED'`
3. For each approved transfer:
   a. Update status to `EXPORTING`
   b. Connect to target DB (using decrypted credentials from `OrganizationSettings`)
   c. Discover tenant-owned tables dynamically
   d. For each table:
      - Query row count from source (managed DB)
      - Export in chunks of 1000 rows
      - Insert into target DB
      - Update progress (`completedTables`, `transferredRows`, `currentTable`)
   e. Update status to `VERIFYING`
   f. Verify row counts match between source and target
   g. Compute checksums (SHA-256 of row counts per table)
   h. If verification passes:
      - Update status to `COMPLETED`
      - Record `completedAt`, `postTransferChecksum`
      - Create audit log entry
      - Notify Org Admin
      - Notify Super Admin
   i. If verification fails:
      - Update status to `FAILED`
      - Record error details
      - Attempt rollback (truncate target tables)
      - Update status to `ROLLED_BACK`
      - Create audit log entry
      - Notify Org Admin
      - Notify Super Admin

### 6.2 Chunked Export Logic

```typescript
async function exportTableInChunks(
  sourceDb: PrismaClient,
  targetDb: PrismaClient,
  tableName: string,
  organizationId: string,
  transferId: string,
  chunkSize: number = 1000
): Promise<{ rowsTransferred: number; checksum: string }> {
  let offset = 0;
  let totalRows = 0;
  const hasher = createHash('sha256');

  while (true) {
    // Read chunk from source
    const chunk = await sourceDb.$queryRawUnsafe(
      `SELECT * FROM "${tableName}" WHERE "organizationId" = $1 ORDER BY "id" LIMIT $2 OFFSET $3`,
      organizationId, chunkSize, offset
    );

    if (chunk.length === 0) break;

    // Insert chunk into target
    await targetDb.$executeRawUnsafe(
      `INSERT INTO "${tableName}" SELECT * FROM json_populate_recordset(null::"${tableName}", $1)`,
      JSON.stringify(chunk)
    );

    totalRows += chunk.length;
    offset += chunkSize;

    // Update progress
    await updateTransferProgress(transferId, {
      transferredRows: totalRows,
      currentTable: tableName,
    });

    // Yield to other jobs
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Compute checksum of row count
  hasher.update(`${tableName}:${totalRows}`);
  return { rowsTransferred: totalRows, checksum: hasher.digest('hex') };
}
```

### 6.3 Verification Logic

```typescript
async function verifyTransfer(
  sourceDb: PrismaClient,
  targetDb: PrismaClient,
  organizationId: string,
  tables: string[]
): Promise<{ passed: boolean; details: Record<string, { source: number; target: number; match: boolean }> }> {
  const details: Record<string, { source: number; target: number; match: boolean }> = {};
  let allMatch = true;

  for (const table of tables) {
    const sourceCount = await sourceDb.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM "${table}" WHERE "organizationId" = $1`,
      organizationId
    );
    const targetCount = await targetDb.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM "${table}" WHERE "organizationId" = $1`,
      organizationId
    );

    const source = Number(sourceCount[0].count);
    const target = Number(targetCount[0].count);
    const match = source === target;

    details[table] = { source, target, match };
    if (!match) allMatch = false;
  }

  return { passed: allMatch, details };
}
```

### 6.4 Rollback Logic

```typescript
async function rollbackTransfer(
  targetDb: PrismaClient,
  organizationId: string,
  tables: string[]
): Promise<void> {
  // Delete transferred data in reverse dependency order
  for (const table of [...tables].reverse()) {
    await targetDb.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE "organizationId" = $1`,
      organizationId
    );
  }
}
```

---

## 7. UI Design

### 7.1 Org Admin: Data Transfer Panel

**Location:** Settings → "Data Transfer" section (new nav item in `ALL_SECTIONS`)

**Component:** `src/components/settings/data-transfer-card.tsx`

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ Data Transfer                                   │
│                                                 │
│ Current Deployment: MANAGED                     │
│ Status: [Active Transfer Status Badge]          │
│                                                 │
│ ┌─ Active Transfer ──────────────────────────┐  │
│ │ Status: EXPORTING (3/12 tables)            │  │
│ │ Progress: ████████░░░░ 25%                 │  │
│ │ Current: employee_activity                 │  │
│ │ Rows: 15,234 / 60,000                      │  │
│ │ Started: Sep 8, 2026 14:30                 │  │
│ │ [Cancel]                                   │  │
│ └───────────────────────────────────────────┘  │
│                                                 │
│ ── or ──                                        │
│                                                 │
│ No active transfer.                             │
│                                                 │
│ [Request Data Transfer]                         │
│                                                 │
│ ┌─ Transfer History ────────────────────────┐   │
│ │ Sep 5, 2026 — COMPLETED — 45 tables       │   │
│ │ Sep 1, 2026 — DENIED — "Insufficient..."  │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Request Transfer Modal:**
```
┌─────────────────────────────────────────────────┐
│ Request Data Transfer                           │
│                                                 │
│ Target Database                                 │
│ Host: [________________________]                │
│ Port: [5432____]                                │
│ Database: [________________________]            │
│ User: [________________________]                │
│ Password: [________________________]            │
│ SSL: [✓]                                        │
│                                                 │
│ [Test Connection]                               │
│                                                 │
│ Notes (optional):                               │
│ [________________________________]              │
│                                                 │
│ ⚠️ This will request approval from Super Admin. │
│ No data will be transferred until approved.     │
│                                                 │
│ [Cancel]  [Submit Request]                      │
└─────────────────────────────────────────────────┘
```

### 7.2 Super Admin: Transfer Management

**Location:** Super Admin → Organizations → [Org Detail] → "Data Transfers" section

**Component:** `src/components/super-admin/data-transfer-panel.tsx`

**Layout (in Org Detail page):**
```
┌─────────────────────────────────────────────────┐
│ Data Transfers                                  │
│                                                 │
│ Pending Requests (2)                            │
│ ┌─────────────────────────────────────────────┐ │
│ │ Acme Corp — REQUESTED                       │ │
│ │ Target: db.acme.com:5432/acme_prod          │ │
│ │ Requested: Sep 8, 2026 10:00                │ │
│ │ Notes: "Migrating to dedicated server"      │ │
│ │ [Approve] [Deny]                            │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Recent Transfers                                │
│ ┌─────────────────────────────────────────────┐ │
│ │ Acme Corp — COMPLETED — Sep 5, 2026         │ │
│ │ 45 tables, 120,000 rows, verified ✓         │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Approve Modal:**
```
┌─────────────────────────────────────────────────┐
│ Approve Data Transfer                           │
│                                                 │
│ Organization: Acme Corp                         │
│ Target: db.acme.com:5432/acme_prod              │
│                                                 │
│ ⚠️ This will transfer all organization data     │
│ to the customer's database.                     │
│                                                 │
│ Notes (optional):                               │
│ [________________________________]              │
│                                                 │
│ [Cancel]  [Approve Transfer]                    │
└─────────────────────────────────────────────────┘
```

### 7.3 Super Admin: All Transfers View

**Location:** Super Admin → "Data Transfers" page (new nav item in control-center group)

**Component:** `src/components/super-admin/all-data-transfers-page.tsx`

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ Data Transfers                                  │
│                                                 │
│ Filter: [All ▼] [Requested ▼] [Completed ▼]    │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ Organization | Status | Progress | Date     │ │
│ │─────────────────────────────────────────────│ │
│ │ Acme Corp    | COMPLETED | 100% | Sep 5     │ │
│ │ Beta Inc     | REQUESTED | —    | Sep 8     │ │
│ │ Gamma LLC    | FAILED    | 45%  | Sep 7     │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Pagination: < 1 2 3 >                          │
└─────────────────────────────────────────────────┘
```

---

## 8. Notification Design

### 8.1 New Notification Types

Add to `NOTIFICATION_TYPES` array in `src/lib/notifications/constants.ts`:

```typescript
'data_transfer_request',    // Sent to Super Admin when Org Admin requests transfer
'data_transfer_approved',   // Sent to Org Admin when Super Admin approves
'data_transfer_completed',  // Sent to both when transfer completes
'data_transfer_failed',     // Sent to both when transfer fails
```

### 8.2 Notification Messages

**Transfer Requested (to Super Admin):**
- Title: "Data Transfer Requested"
- Message: "[OrgName] has requested a data transfer to their customer database."
- Type: `data_transfer_request`
- Priority: `high`
- Action URL: `/admin/organizations/[orgId]` (or data transfer detail)

**Transfer Approved (to Org Admin):**
- Title: "Data Transfer Approved"
- Message: "Your data transfer request has been approved and is now processing."
- Type: `data_transfer_approved`
- Priority: `high`

**Transfer Completed (to Org Admin + Super Admin):**
- Title: "Data Transfer Completed"
- Message: "[OrgName] data transfer completed successfully. [X] tables, [Y] rows transferred."
- Type: `data_transfer_completed`
- Priority: `medium`

**Transfer Failed (to Org Admin + Super Admin):**
- Title: "Data Transfer Failed"
- Message: "[OrgName] data transfer failed: [error]. Data has been rolled back."
- Type: `data_transfer_failed`
- Priority: `critical`

---

## 9. Audit Log Design

### 9.1 New Audit Actions

```typescript
// Transfer lifecycle
'data_transfer_requested'   // Org Admin requests transfer
'data_transfer_approved'    // Super Admin approves
'data_transfer_denied'      // Super Admin denies
'data_transfer_cancelled'   // Org Admin cancels (before approval)
'data_transfer_started'     // Background job starts processing
'data_transfer_completed'   // Transfer verified and completed
'data_transfer_failed'      // Transfer failed
'data_transfer_rolled_back' // Rollback completed
```

### 9.2 Audit Log Format

```typescript
await db.auditLog.create({
  data: {
    action: 'data_transfer_requested',
    resource: 'data_transfer',
    resourceId: transfer.id,
    description: `Data transfer requested to ${targetDbHost}:${targetDbPort}/${targetDbName} by ${auth.email}`,
    userId: auth.userId,
    organizationId: orgId,
  },
});
```

---

## 10. Implementation Order

### Phase 1: Schema & Foundation (Steps 1-3)
1. Create Prisma migration for `OrganizationDataTransfer` model
2. Extend `NOTIFICATION_TYPES` with data transfer types
3. Create `src/lib/data-transfer/types.ts` — shared types and constants

### Phase 2: Core Library (Steps 4-7)
4. Create `src/lib/data-transfer/service.ts` — transfer orchestration logic
5. Create `src/lib/data-transfer/export.ts` — chunked data export
6. Create `src/lib/data-transfer/import.ts` — data import to target DB
7. Create `src/lib/data-transfer/verify.ts` — verification logic

### Phase 3: API Routes (Steps 8-13)
8. `GET /api/organizations/[orgId]/settings/data-transfer` — Org Admin view
9. `POST /api/organizations/[orgId]/settings/data-transfer` — Org Admin request
10. `DELETE /api/organizations/[orgId]/settings/data-transfer` — Org Admin cancel
11. `POST /api/organizations/[orgId]/settings/data-transfer/test-target` — test connection
12. `GET /api/super-admin/data-transfers` — Super Admin list
13. `POST /api/super-admin/data-transfers/[id]/approve` + `/deny` + `/cancel` — Super Admin actions

### Phase 4: Background Job (Steps 14-15)
14. Create `src/lib/jobs/data-transfer.ts` — job processor
15. Register job in `src/lib/jobs/run.ts` and `src/instrumentation.ts`

### Phase 5: UI (Steps 16-20)
16. Create `src/components/settings/data-transfer-card.tsx` — Org Admin panel
17. Create `src/components/super-admin/data-transfer-panel.tsx` — Super Admin detail panel
18. Create `src/components/super-admin/all-data-transfers-page.tsx` — Super Admin list
19. Add "Data Transfer" to Org Admin settings nav (`ALL_SECTIONS`)
20. Add "Data Transfers" to Super Admin control-center nav

### Phase 6: Verification & Polish (Steps 21-25)
21. Write unit tests for transfer service logic
22. Write integration tests for API routes
23. Run typecheck and lint
24. Manual verification of full flow
25. Update documentation

---

## 11. Testing Strategy

### 11.1 Unit Tests

- `src/lib/data-transfer/service.test.ts` — state machine transitions, validation
- `src/lib/data-transfer/export.test.ts` — chunked export logic
- `src/lib/data-transfer/import.test.ts` — import logic
- `src/lib/data-transfer/verify.test.ts` — verification logic

### 11.2 Integration Tests

- `src/app/api/organizations/[orgId]/settings/data-transfer/route.test.ts`
- `src/app/api/super-admin/data-transfers/route.test.ts`
- `src/app/api/super-admin/data-transfers/[id]/approve/route.test.ts`

### 11.3 Key Test Cases

1. **Happy path:** Request → Approve → Export → Transfer → Verify → Complete
2. **Denial:** Request → Deny (verify notification + audit)
3. **Cancellation:** Request → Cancel (before approval)
4. **Export failure:** Verify rollback + notification
5. **Verification failure:** Verify rollback + notification
6. **Tenant isolation:** Org A cannot see Org B's transfers
7. **RBAC:** Non-admin cannot request; non-super-admin cannot approve
8. **Concurrent transfers:** Only one active transfer per org
9. **Target DB test:** Connection test before approval
10. **Large dataset:** Verify chunked processing works

---

## 12. Risk Mitigation

### 12.1 Data Integrity
- Checksum verification before marking complete
- Rollback on any failure
- No silent state changes (PRD Rule M)

### 12.2 Performance
- Chunked processing (1000 rows per chunk)
- Lease-guarded job system (no duplicate processing)
- Progress tracking for UI feedback

### 12.3 Security
- Target DB credentials encrypted at rest (same AES-256-GCM)
- Credentials never returned in API responses
- All actions audit-logged

### 12.4 Rollback
- Full rollback capability on failure
- Target data deleted in reverse dependency order
- Status tracked through ROLLED_BACK state

---

## 13. Open Questions

1. **Should the transfer include file storage (screenshots, audio)?** The plan currently transfers only database rows. Screenshots/binary data are in storage (local/Supabase). Including them would require downloading and re-uploading files, which is significantly more complex.

2. **Should the deployment mode change automatically after transfer?** The plan currently does NOT change deployment mode — that requires a separate Super Admin action with `confirmDataResidency`. This aligns with PRD Rule M.

3. **What happens to the org's data in the managed DB after transfer?** The plan does NOT delete data from the managed DB. The org can continue using both databases until the Super Admin explicitly changes the deployment mode.

4. **Should there be a "dry run" mode?** A dry run could count rows without actually transferring, giving the Super Admin confidence before approving.

---

## 14. Files to Create

### New Files
- `src/lib/data-transfer/types.ts` — shared types, constants, enums
- `src/lib/data-transfer/service.ts` — transfer orchestration
- `src/lib/data-transfer/export.ts` — chunked export logic
- `src/lib/data-transfer/import.ts` — import to target DB
- `src/lib/data-transfer/verify.ts` — verification logic
- `src/lib/jobs/data-transfer.ts` — background job processor
- `src/components/settings/data-transfer-card.tsx` — Org Admin UI
- `src/components/super-admin/data-transfer-panel.tsx` — Super Admin detail panel
- `src/components/super-admin/all-data-transfers-page.tsx` — Super Admin list
- `src/app/api/organizations/[orgId]/settings/data-transfer/route.ts`
- `src/app/api/organizations/[orgId]/settings/data-transfer/test-target/route.ts`
- `src/app/api/super-admin/data-transfers/route.ts`
- `src/app/api/super-admin/data-transfers/[id]/route.ts`
- `src/app/api/super-admin/data-transfers/[id]/approve/route.ts`
- `src/app/api/super-admin/data-transfers/[id]/deny/route.ts`
- `src/app/api/super-admin/data-transfers/[id]/cancel/route.ts`
- `prisma/migrations/YYYYMMDD_add_data_transfer/migration.sql`

### Files to Modify
- `prisma/schema.prisma` — add `DataTransferStatus` enum + `OrganizationDataTransfer` model
- `src/lib/notifications/constants.ts` — add data transfer notification types
- `src/lib/jobs/run.ts` — register `data_transfer` job
- `src/instrumentation.ts` — add `data_transfer` to job scheduler
- `src/lib/sidebar-nav.ts` — add nav items
- `src/lib/navigation.ts` — add permission entries
- `src/lib/store.ts` — add PageType entries
- `src/app/page.tsx` — add component mappings
- `src/components/settings/settings-page.tsx` — add Data Transfer section
- `src/components/super-admin/super-admin-organization-detail-page.tsx` — add Data Transfer panel

---

# OMNISIGHT V1 — COMMON AGENT UI + ACTIVITY END-TO-END ADDENDUM

**Status:** Mandatory extension to the V1 implementation plan (not a replacement for Phase 0/1)

This addendum adds the implementation work to satisfy addenda A–V. It does not modify the data-transfer plan above; it is an additional, product-critical layer that must be completed and verified before Phase 1 is complete.

---

## 1. FORENSIC FINDINGS (Current State — Verified by Code Inspection)

### 1.1 Addendum B — Infrastructure exposure in the Agent UI (PROBLEMS FOUND)

The employee-facing Agent UI currently exposes two infrastructure details that must be removed:

| Detail | File | Mechanism |
|---|---|---|
| **Server URL** | `src/renderer/index.html:45` (`#login-server-url`) | `renderer.ts:192-198` and `renderer.ts:626-631` call `bridge.getServerUrl()` and set the element text |
| **Deployment mode** | `src/renderer/index.html:206` (`#deployment-mode`) | `renderer.ts:351-356` maps `MANAGED`→"Managed", `CUSTOMER_DB`→"Customer DB", `PRIVATE`→"Private" |

**Already clean (no change needed):**
- **Database type/host/name**: NEVER displayed anywhere in the Agent UI. Agent only talks to the API server via HTTP.
- **IP address**: only in `DeviceInfo` sent to the server; never rendered.
- **API URL**: single `baseUrl`, same as server URL (removed along with it).

### 1.2 Addendum D — Connection state model (PROBLEM FOUND)

The current connection state has a **latent contradiction defect**:

- `connected` is defined in `agent-orchestrator.ts:168` as `this.deps.heartbeat.getState().lastOkAt !== null`.
- In `heartbeat-service.ts`, `lastOkAt` is set on success but **NEVER cleared on failure**. `consecutiveFailures` and `lastError` are tracked, but the device remains "connected" forever after one success.
- The renderer shows **two independent labels**: the header pill (`renderer.ts:162-165`) derives "Online"/"Offline" from the same `status.connected` flag, while the `offline-view` (shown for `unregistered`/`network`/`server`/`creds` errors) can display a whole "Offline" screen while the header pill simultaneously says "Online".

This is exactly the contradictory-state scenario Addendum D forbids. The fix must be at the state source (heartbeat/orchestrator), not by hiding labels.

### 1.3 Addendum A/R — One common Agent (ALREADY SATISFIED)

The Agent is already a single binary/UI; there are no separate MANAGED/CUSTOMER_DB/PRIVATE binaries. The deployment mode is carried internally (`config-service.ts` → `server context`) and only affects internal behavior. The UI already renders the same interface regardless of mode (the only mode leak is the `#deployment-mode` label being removed per 1.1). No separate employee-facing UIs need to be created or merged.

### 1.4 Addendum F/G — Activity pipeline (FULLY IMPLEMENTED, needs E2E proof)

The complete pipeline already exists with real production code (no mocks):

```
ActivityCollector (10s poll, ForegroundWindow)           ─┐
WebsiteCollector (extension events + BrowserActivity)     ─┼─► ActivityQueue (activity-queue.jsonl, AES-256-GCM)
                                                           │        ↓
QueueUploader.drain() every 20s (exclusive) ──► peekBatch(100)
                                                           │
deriveBatchId (UUIDv5 over item ids) + batchSeq            │
                                                           ↓
ActivityApi.upload() ──► POST /api/agent/activity (Bearer)
                                                           ↓
server: validateAgentToken ─► validateActivity ─► consent ─► normalize ─► server-derived org/employee/device
                                                           ↓
db.activity.createMany  /  ActivityBatchReceipt (dedupe)
                                                           ↓
GET /api/activities  ─► ActivitiesPage + ActivityTimeline
```

**Key file index (all verified):**
- Capture: `agent/src/collectors/activity-collector.ts`, `website-collector.ts`
- Native boundary: `agent/src/collectors/native-bridge.ts`
- Queue: `agent/src/storage/activity-queue.ts`
- Drain: `agent/src/services/queue-uploader.ts`
- Upload client: `agent/src/api/activity.ts`, `agent/src/api/client.ts`
- Ingest route: `web/src/app/api/agent/activity/route.ts` (409 lines)
- Read routes: `web/src/app/api/activities/route.ts`, `daily`, `employees/[id]/activities`, `self/activities`
- UI: `web/src/components/activities/activities-page.tsx`, `activity-timeline.tsx`, `activity-stats.tsx`
- Prisma: `Activity` (schema.prisma:483-519), `ActivityBatchReceipt` (531-547)
- Auth: `web/src/lib/agent/auth.ts` (`validateAgentToken`)

### 1.5 Addendum I — Database mismatch (NONE FOUND — verified consistent)

`.env` (web):
- `DATABASE_URL` = `postgresql://postgres:123456@localhost:5432/workai_test_e2e?schema=public`
- `DIRECT_URL` = `postgresql://postgres:123456@localhost:5432/workai_test_e2e?schema=public`

Both point to the SAME local database. The Agent never touches PostgreSQL (it only talks to the API via HTTP), so there is **no** Agent-writes-to-DB-A / UI-reads-DB-B mismatch. Verified: single `db` client (`src/lib/db.ts` global singleton) used by all activity read/write paths.

**No `.env.local` exists** in either repo. No fix required; verification test will re-confirm.

### 1.6 Addendum J — Localhost networking (VERIFIED)

- **Agent base URL**: `DEFAULT_SERVER_URL = 'http://localhost:3000'` (`agent/src/config/server-url.ts:25`). Resolution: `OMNISIGHT_SERVER_URL` → `WORKLENSAI_SERVER_URL` → default. Overridable at runtime env and at build time (baked by `build-prod.mjs`).
- **CSRF**: `web/src/proxy.ts:280-298` — for non-GET requests, `Origin` host must match `Host`; cross-origin rejected 403. SameSite=Lax cookies. Agent sends **Bearer token** (not cookies), so CSRF origin-check does not block agent uploads.
- **CORS**: no standard middleware; only the live-updates WebSocket service has explicit `ALLOWED_ORIGIN` (default `http://localhost:3000`).
- **Builder origin**: binds `127.0.0.1`, loopback-only origin validation.
- No disabling of CSRF/auth/origin checks found. **No intervention required** — only the E2E localhost test below.

### 1.7 Addendum K — Activity authentication (VERIFIED SECURE)

`validateAgentToken` (`web/src/lib/agent/auth.ts:62-198`) does a 10-step validation; org/employee/device are ALL server-derived from the token, never client-supplied:
1. Bearer extraction
2. Token lookup (DB)
3. Token expiry (deletes expired)
4. `agentApproved`
5. Employee `status === 'active'`
6. AgentAccount status (fail closed)
7. Device-bound token active
8. Organization active
9. Cross-org integrity (`token.organizationId === employee.organizationId`)
10. Subscription entitlement

Malicious cases (wrong org/employee/device, expired/invalid token, another org's device) all fail safely. The activity route derives `organizationId`, `employeeId`, `deviceId` from the auth result — never from the request body. **Already compliant.** Malicious-case tests (Addendum Q) must still be added and run.

### 1.8 Addendum L — Queue correctness (VERIFIED, minor gap)

- `QueueUploader.attemptUpload` acks (`queue.ack(batch)`) **only after** `ActivityApi.upload()` resolves successfully — confirms server persistence before removal. ✅
- On 401 → `recoverAuth()` and retry same batch (never dropped). ✅
- On transient (429/network/5xx) → mark failed, stop drain, retry next tick. ✅
- On permanent 4xx (400/403/409) → drop batch so it cannot wedge the queue. ✅
- **`Pending uploads: 0`** reads `queueLength()` from the actual queue. ✅

**Outcome:** `Pending uploads: 0` is truthful; `Captured → Queued → Uploaded → Server Acknowledged → Removed` is fully implemented. Compliance confirmed; requires E2E proof.

### 1.9 Addendum M — Batch deduplication (IMPLEMENTED, opt-in; needs testing)

- Agent ALWAYS sends `batchId` (UUIDv5 over item ids — stable across retries) and `batchSeq`.
- Server dedupe is **org-scoped opt-in, default OFF** (`resolveActivityDedupeEnabled`, `activity_dedupe` setting).
- When ON + valid batchId: receipt + rows in one transaction; on `P2002` unique conflict `(organizationId, employeeId, batchId)`, re-reads winner's receipt and returns `deduplicated: existing.rowCount`.
- Old agents without batchId → plain `createMany`, legacy behavior preserved, request still accepted. ✅ (compatibility requirement in addendum M)

**Gap:** dedupe is opt-in. Need to confirm an org-level toggle path and run the real-DB dedupe test (first upload → retry → no duplicates → correct count).

### 1.10 Addendum N — Activity UI (VERIFIED, needs cache-invalidation check)

`ActivitiesPage` queries real server data with filters (type, category, employee, search, date range), pagination, sorting, loading/empty/error states. `ActivityTimeline` groups by day. Uses React Query. **Gap to verify:** React Query cache invalidation after upload/new activity so a refresh shows the record even without realtime.

### 1.11 Addendum O — Realtime (NOT required for acceptance) — confirmed; WebSocket is Phase 4 scope.

---

## 2. IMPLEMENTATION WORK

### 2.1 Addendum B — Remove infrastructure exposure from Agent UI (omnisight-agent)

**Files to change:**
- `agent/src/renderer/index.html` — remove the Server URL line from the login view (lines 43-46) and remove the Deployment Mode row from the status view (lines 205-207).
- `agent/src/renderer/renderer.ts` — remove `renderLoginView` server-url population (192-198), remove boot server-url population (626-631), remove deployment-mode label mapping (351-356) and the corresponding `set('deployment-mode', ...)`.

**Keep internal:** `bridge.getServerUrl()` IPC, `resolveServerUrl()`, the `deploymentMode` field in `getStatusForRenderer()` (runtime still uses it) — only the RENDERING is removed.

**Files to verify (server URL stays internal):** `agent/src/main/ipc.ts:55-58` (keep the IPC handler; renderer just no longer calls it), `agent/src/main/main.ts:97-104`, `agent/src/config/server-url.ts`, `agent/scripts/build-prod.mjs`.

### 2.2 Addendum D — Authoritative connection state model (omnisight-agent)

**Problem:** `lastOkAt` never cleared → stale "connected"; two independent labels can contradict.

**Fix (state source, not label hiding):**
1. In `heartbeat-service.ts`, track connection state explicitly. On success set `lastOkAt`; on failure increment `consecutiveFailures`. Add a derived authoritative connection state.
2. Define ONE canonical connection state on the orchestrator:
   ```
   CONNECTING | CONNECTED | OFFLINE | AUTH_REQUIRED | SYNCING | ERROR
   ```
   - `CONNECTED` requires a recent `lastOkAt` (within a stale threshold, e.g. `HEARTBEAT_STALE_MS`), NOT merely `!= null`.
   - `STALE`/`OFFLINE` when last heartbeat exceeds the threshold or `consecutiveFailures >= n`.
3. In `agent-orchestrator.ts:getStatusForRenderer()`, derive a single authoritative `connectionState` and remove the boolean-only `connected` (or keep `connected` as a strict true/false derived FROM the state so the two labels can never disagree).
4. In `renderer.ts`, render the header pill AND the offline view from the SAME `connectionState`. Map `OFFLINE`/`ERROR` → offline view + offline pill; `CONNECTED`/`SYNCING` → online pill. This removes the contradiction.

**Explicit semantics:** `SYNCING` = connected + queue draining/active upload. `CONNECTING` = no connection yet. `AUTH_REQUIRED` = needs login (401).

### 2.3 Addendum C — Employee-facing status UI (verify/adjust)

The recommended fields already exist. Confirm after removing infra details that the status view shows only:
- Service `Active`
- Employee (from `auth.employeeName`)
- Device (`deviceName`)
- Organization (`organizationName`)
- Last Sync (`lastSyncAt`)
- Heartbeat / Connection (`connectionState`)
- Pending Uploads (`queueLength`)

Ensure the UI reads like an operational panel, not a technical console. Add an explicit `Service: Active` line if not already present.

### 2.4 Addendum E/R/S/B — Server URL discipline (verify only)

- No hard-coded localhost in **production** builds: verified — build-prod bakes the real URL and restores dev defaults in `finally`.
- Agent remains one common agent, config arrives server-side (Addendum R). No per-org UI.
- Deployment mode stays internal to runtime; not shown in employee UI (removed in 2.1).
- No change required beyond 2.1; these are verification gates.

### 2.5 Addendum L — Confirm queue "no premature removal" (minor)

Already compliant (acked only after server confirmation). Add a test asserting that on a simulated lost response (server commits but response never arrives) the retry re-sends the same `batchId` and the server's `P2002` path returns `deduplicated: N` and inserts zero duplicate rows. See test matrix.

### 2.6 Addendum M — Dedupe verification + optional toggle

Add/confirm an org-level toggle (`activity_dedupe` setting) and ensure a friendly UI/API to enable it (or document it). Then run the real-DB dedupe test.

---

## 3. REQUIRED E2E TEST (Addendum H) — LOCALHOST ACTIVITY PIPELINE

This is a **mandatory acceptance gate**. It must run against real production code paths. No mocks.

| # | Step | Action | Verify |
|---|------|--------|--------|
| 1 | Web start | `npm run dev` in `omnisight-web` | `http://localhost:3000` loads; health/API endpoint responds |
| 2 | Agent start | Launch the actual Agent configured for `http://localhost:3000` (dev E2E env) | Window opens; login view shows (no server URL shown after 2.1) |
| 3 | Enrollment | Sign in / register the device | Agent associated with Organization + Employee + Device; org/employee/device visible in status view |
| 4 | Activity | Generate real, supported activity on the machine (e.g. use an application covered by `ActivityCollector`) | — (real capture, not fake insert) |
| 5 | Queue | Inspect `activity-queue.jsonl` | Row present with `type`, `duration`, `timestamp`, `id`, `enqueuedAt` |
| 6 | Upload | Observe the 20s drain | `POST /api/agent/activity` sent with `Authorization: Bearer <token>`, `batchId`, `batchSeq` |
| 7 | Response | Capture the actual HTTP response | Status code, body shape (`success/count/message`), `deduplicated` (if enabled), `batchId` |
| 8 | Database | Query `workai_test_e2e` `Activity` table | Row exists with correct server-derived `organizationId/employeeId/deviceId/timestamp` |
| 9 | Activity API | `GET /api/activities` (authenticated org session) | Same activity returned |
| 10 | UI | Open `Organization → Activity` | Real activity appears; after a refresh new records show |

**Verification labelling (required by addendum V):** every step must be marked CODE VERIFIED / TEST VERIFIED / RUNTIME VERIFIED / END-TO-END VERIFIED. A code-inspection-only step must NEVER be labelled E2E.

---

## 4. REQUIRED TEST MATRIX (Addendum U/V)

Add automated tests (agent `vitest` / web `vitest`, and API integration tests) covering:

| Area | Test |
|---|---|
| Agent startup | Boot sequence reaches login/status without crash |
| Common Agent | Same binary portable across org configs (Addendum R) |
| Server URL hidden | UI DOM does not render `#login-server-url` / any URL string |
| Deployment hidden | UI DOM does not render `deployment-mode` / "Managed" |
| Connection state | `CONNECTED` requires fresh `lastOkAt`; stale → `OFFLINE`; no contradiction between pill + view |
| Activity capture | `ActivityCollector` produces a record |
| Activity queue | `enqueue` → `peekBatch` → `ack`; `Pending uploads: 0` ⇔ queue empty |
| Activity upload | `POST /api/agent/activity` with Bearer + batchId |
| Activity DB persistence | Row in `Activity` with server-derived ids |
| Activity UI | API returns activity; UI renders it; refresh after upload shows record |
| Batch dedupe | First upload inserts; retry same batchId → no dup; `deduplicated: N` |
| Old Agent compat | No batchId → still accepted, legacy insert |
| Tenant isolation | Org A page shows only A; Org B only B (Addendum Q) |
| Invalid token | 401; activity rejected |
| Wrong org/employee/device | Server-derived; client-specified ids ignored; fails safely |
| Localhost E2E | Full addendum-H walkthrough |
| Database consistency | Single `DATABASE_URL`; no A/B split (Addendum I) |

---

## 5. FINAL IMPLEMENTATION REPORT — ACTIVITY E2E PROOF SECTION

The final report MUST include a dedicated block:

```
Agent capture timestamp: <ISO>
Batch ID:                <batchId>
Upload HTTP status:      <200>
Organization ID:         <id>
Employee ID:             <id>
Device ID:               <id>
Database record ID:      <activity.id>
Activity API response:   <success/count>
Organization Activity UI: <rendered / count visible>
```

Plus, for each pipeline stage a verification label chosen from:
`CODE VERIFIED` / `TEST VERIFIED` / `RUNTIME VERIFIED` / `END-TO-END VERIFIED`.

Redact secrets. Never label a code-only inspection as E2E.

---

## 6. DECISIONS (APPROVED 2026-09-08)

1. **Dedupe default: ON.** `activity_dedupe` defaults to enabled for new organizations. Old agents without `batchId` still work (server accepts them via the legacy `createMany` path). Implement by changing the default in `resolveActivityDedupeEnabled` (`src/lib/jobs/settings.ts`) from `'false'` to `'true'`, keeping the org-level setting key so admins can turn it off.
2. **Stale threshold: 3× heartbeat interval.** `HEARTBEAT_STALE_MS = 3 × HEARTBEAT_INTERVAL_MS`. `CONNECTED` requires a fresh `lastOkAt` (within the threshold); otherwise the authoritative state becomes `OFFLINE`/`ERROR` and all labels derive from that single state.
3. **`Service: Active` line: Approved.** Add an explicit `Service: Active` row to the status view (rendered from connection state: Active when `CONNECTED`/`SYNCING`, with a descriptive paused/unavailable label otherwise).

---

## 7. FILES TO CREATE / CHANGE (ADDENDUM)

### omnisight-agent
- `src/renderer/index.html` — MODIFY (remove server URL + deployment mode)
- `src/renderer/renderer.ts` — MODIFY (remove infra renders; render single authoritative connection state)
- `src/services/heartbeat-service.ts` — MODIFY (authoritative connection state; clear stale)
- `src/services/agent-orchestrator.ts` — MODIFY (single `connectionState`, derive `connected` from it)
- `tests/*` — NEW (addendum U matrix)
- (verify, no change) `src/main/ipc.ts`, `src/main/main.ts`, `src/config/*`, `scripts/build-prod.mjs`

### omnisight-web
- `src/app/api/agent/activity/route.ts` — VERIFY (no change unless dedupe default toggle)
- `src/lib/jobs/settings.ts` — possible MODIFY (dedupe default)
- Activity UI — VERIFY React Query cache invalidation (no change unless gap found)
- `tests/*` — NEW (tenant isolation, dedupe, old-agent, malicious auth)
