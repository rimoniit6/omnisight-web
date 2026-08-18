# Database Backup & Restore Certification (PostgreSQL)

> Date: 2026-08-10
> Verdict: **PASS — executed with real pg_dump → pg_restore → verification**
> Script: `scripts/pg-backup-restore-certification.mjs` (repeatable)

---

## 1. Backup

- **Tool:** PostgreSQL 18.4 `pg_dump` (custom format, `--compress=9`)
- **Command (as executed):**
  ```
  pg_dump "postgresql://postgres:***@localhost:5432/workai" --format=custom --compress=9 --no-owner
  ```
- **Result:** exit 0, no warnings.
- **Artifacts:** `backups/pg/workai-<timestamp>.dump` (212,504 bytes ≈ 0.20 MB compressed). Retention keeps the 5 most recent dumps (verified: 4 on disk after the certification runs, all timestamped).

## 2. Restore (into a disposable database)

- **Tool:** `pg_restore` (custom format)
- **Target:** fresh disposable `workai_restore_cert_*` (created from `template0`), dropped afterward.
- **Result:** exit 0, **zero `pg_restore: error` lines**.

## 3. Verification Results

### 3.1 Row-count parity — **29/29 tables match**

| Table | Source → Restored | | Table | Source → Restored |
|---|---|---|---|---|
| organization | 2 → 2 | | consentLog | 303 → 303 |
| appUser | 4 → 4 | | activity | 2300 → 2300 |
| employee | 42 → 42 | | screenshot | 28 → 28 |
| department | 9 → 9 | | auditLog | 109 → 109 |
| project | 11 → 11 | | timeEntry | 435 → 435 |
| projectMember | 47 → 47 | | notification | 29 → 29 |
| device | 30 → 30 | | systemSetting | 36 → 36 |
| deviceClaim | 1 → 1 | | monitoringPolicy | 3 → 3 |
| agentToken | 0 → 0 | | organizationSetting | 6 → 6 |
| consent | 248 → 248 | | alert | 22 → 22 |
| consentPolicy | 8 → 8 | | sentimentRecord | 36 → 36 |
| | | | aiInsight | 15 → 15 |
| | | | report | 35 → 35 |
| | | | jobRun | 2 → 2 |
| | | | agentRegistration | 4 → 4 |
| | | | appListEntry / usbEvent / anomaly | 0/0/22 → 0/0/22 |

### 3.2 Foreign-key integrity — **6/6 checks clean (0 orphans)**

Employee.organizationId, Device.organizationId, ProjectMember.organizationId, Device.employeeId, ConsentLog.consentId, Activity.employeeId — all orphan scans = 0.

### 3.3 Unique constraints — **verified**

Note: Prisma emits `CREATE UNIQUE INDEX` for `@unique` on PostgreSQL (they appear in `pg_index`, NOT as `pg_constraint contype='u'`). Verified present on the restored DB and rejecting real duplicates:

- `Organization_slug_key` ✅ rejects duplicate slug
- `Device_agentKey_key` ✅
- `DeviceClaim_deviceId_key` ✅
- `Consent_employeeId_consentType_key` ✅
- `ConsentPolicy_organizationId_consentType_version_key` ✅
- `ProjectMember_projectId_employeeId_key` ✅
- `AgentToken_token_key` ✅
- `Employee_employeeId_key` ✅ rejects duplicate employeeId

### 3.4 Application connectivity

- Prisma client connected to the **restored** DB and read data: ✅ (2 orgs, 42 employees, 2300 activities reachable through the ORM).

## 4. Acceptance

```
BACKUP → RESET/TEST DB → RESTORE → APPLICATION WORKS
BACKUP-RESTORE-CERTIFICATION: PASSED
```

## 5. Production Procedure (pg_dump-based)

**Scheduled backup (e.g. nightly):**
```bash
mkdir -p backups/pg
pg_dump "$DATABASE_URL" --format=custom --compress=9 --no-owner -f "backups/pg/workai-$(date +%F-%H%M).dump"
# retention: keep last N (script keeps 5)
```

**Restore:**
```bash
createdb -T template0 workai_restore
pg_restore --dbname="$PGURL/workai_restore" --no-owner backups/pg/workai-<latest>.dump
# verify row parity with scripts/pg-backup-restore-certification.mjs or migration-verify.mjs
```

**Backup verification:** run the certification script (it backs up, restores, and compares). A periodic run doubles as an RTO drill.

## 6. RPO / RTO

- **RPO:** last nightly backup (default). Reduce to 1h or use WAL archiving for tighter RPO.
- **RTO:** restore time is ~seconds for this dataset (0.2 MB); full verification adds ~2s. Target < 15 min including verification.
