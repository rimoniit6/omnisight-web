# Backup/Restore Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| Actual backup performed | ✅ PASS |
| Actual restore performed into a disposable DB | ✅ PASS |
| Integrity verification | ✅ PASS |
| Row-count verification (every table) | ✅ PASS |
| Application-level (representative queries) verification | ✅ PASS |
| Zero-touch surface (DeviceClaim) verification | ✅ PASS |
| PostgreSQL backup/restore execution | 🔒 **BLOCKED — no PG server** (procedure documented in workload/46) |

---

## 1. What was executed

A real end-to-end **BACKUP → DELETE/RESET → RESTORE → VERIFY** cycle against the **live production database** (`db/custom.db`, the same file the running app uses) using `scripts/backup-restore-certification.mjs` (Node built-in `node:sqlite` — no external CLI).

| Step | Result |
|---|---|
| 1. BACKUP (SQLite online backup, consistent copy) | ✅ 129 ms, integrity `ok` |
| 2. RESET (simulate data-loss: delete/create empty test DB) | ✅ empty DB created |
| 3. RESTORE (copy backup into the test DB) | ✅ 9 ms, integrity `ok` |
| 4. Row counts live vs restored (30 tables) | ✅ **ALL TABLES MATCH** |
| 5. Representative app queries on restored DB | ✅ all present |
| 6. Zero-touch surface (DeviceClaim statuses) | ✅ pending=1 approved=0 (identical) |

## 2. Evidence numbers

- Backup size: **2,019,328 bytes** (98.6% of live 2,048,000 — compact VACUUM copy)
- Backup duration: **129 ms**
- Restore duration: **9 ms**
- Restore integrity: **ok**
- Table mismatches: **0 / 30**

## 3. Restored-table verification (live vs restored counts)

```
Activity 2300=2300  AgentRegistration 4=4  AgentToken 0=0  AiInsight 15=15
Alert 22=22  Anomaly 22=22  AppListEntry 0=0  AppUser 4=4  AuditLog 107=107
Consent 247=247  ConsentLog 302=302  ConsentPolicy 8=8  Department 9=9
Device 30=30  DeviceClaim 1=1  Employee 41=41  JobRun 2=2
MonitoringPolicy 3=3  Notification 28=28  Organization 1=1
OrganizationSetting 6=6  Project 11=11  ProjectMember 47=47  Report 35=35
Screenshot 28=28  SentimentRecord 36=36  SystemSetting 36=36
TimeEntry 435=435  UsbEvent 0=0
```

## 4. Application-level verification on the restored DB

- organizations=1, devices=30, claims=1, consents=247, consentLogs=302, policies=8
- activities=2300, screenshots=28, audit=107, projects=11, members=47
- Zero-touch: pending claims=1, approved=0 — identical to live

## 5. Missing data

**None.** Every table (30/30) restored with identical row counts; integrity check passed; representative queries return data.

## 6. PostgreSQL path (documented, not executed)

`pg_dump --format=custom` → `pg_restore --jobs=4` into a fresh DB → `ANALYZE` → app verification (per `workload/46` §Backup/restore). Execution requires a PostgreSQL server — **BLOCKED in this environment**.

## 7. Acceptance

> **BACKUP → DELETE/RESET TEST DB → RESTORE → APPLICATION WORKS** ✅ PASS (SQLite, the current production DB)

`scripts/backup-restore-certification.mjs` is kept as a repeatable regression tool. Artifacts: `db/cert-backup-g.sqlite3`, `db/cert-restore-test.sqlite3` (removable).
