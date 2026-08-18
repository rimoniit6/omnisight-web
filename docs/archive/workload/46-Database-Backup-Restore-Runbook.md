# WorkLensAI — Database Backup & Restore Runbook

## 1. Current Database State

- **Provider:** SQLite (`provider = "sqlite"`, `DATABASE_URL=file:./db/custom.db`)
- **PostgreSQL:** Intended production target, NOT yet implemented (schema provider change + migration regeneration required — see workload/45).
- **Both strategies are documented below.** For SQLite the running application holds a file lock; backups must be taken with the application stopped, or via SQLite's online backup API.

---

## 2. SQLite Backup (current)

### Scheduled backup (recommended — Windows Task Scheduler / cron)

```bash
# Stop the application first (or use sqlite3 .backup which handles concurrency)
# Option A — sqlite3 online backup (safe while running, no lock conflict):
sqlite3 db/custom.db ".backup 'backups/custom-YYYYMMDD-HHMM.db'"

# Option B — file copy (requires the app to be stopped or idle):
cp db/custom.db "backups/custom-$(date +%Y%m%d-%H%M).db"
```

### Retention policy
- Keep **7 daily** backups, **4 weekly**, **3 monthly**.
- Example cleanup:
```bash
find backups/ -name 'custom-*.db' -mtime +30 -delete
```

### Backup verification
```bash
# Verify the backup opens and counts key tables:
sqlite3 backups/custom-20260810.db "SELECT COUNT(*) FROM Organization;"
sqlite3 backups/custom-20260810.db "SELECT COUNT(*) FROM Consent;"
sqlite3 backups/custom-20260810.db "SELECT COUNT(*) FROM Device;"
sqlite3 backups/custom-20260810.db "SELECT COUNT(*) FROM DeviceClaim;"
```

---

## 3. SQLite Restore

```bash
# 1. Stop the application.
# 2. Replace the database:
cp backups/custom-20260810.db db/custom.db
# 3. Restore file permissions:
chmod 600 db/custom.db
# 4. Start the application.
# 5. Verify integrity:
npm run db:generate
# 6. Confirm data relationships via the API or sqlite3:
sqlite3 db/custom.db "PRAGMA foreign_key_check;"
```

---

## 4. PostgreSQL Backup (intended production)

> Requires the provider switch in `prisma/schema.prisma` + migration regeneration (release-blocking work item). Commands assume PostgreSQL 14+.

### Environment
```bash
export DATABASE_URL="postgresql://user:pass@host:5432/worklensai"
export PGPASSWORD="pass"
```

### Scheduled backup — `pg_dump`
```bash
pg_dump -h host -U user -d worklensai -F c -f "backups/worklensai-$(date +%Y%m%d-%H%M).dump"
```

### Retention
- Keep 7 daily / 4 weekly / 3 monthly (same as SQLite).

### Backup verification
```bash
# Check the dump is a valid PostgreSQL archive:
pg_restore --list "backups/worklensai-20260810.dump" | head -20
```

---

## 5. PostgreSQL Restore

```bash
# 1. Create a fresh database:
createdb -h host -U user worklensai_restore

# 2. Restore from the dump:
pg_restore -h host -U user -d worklensai_restore "backups/worklensai-20260810.dump"

# 3. Verify relationships + key records:
psql -h host -U user -d worklensai_restore -c "SELECT count(*) FROM \"Organization\";"
psql -h host -U user -d worklensai_restore -c "SELECT count(*) FROM \"Consent\";"
psql -h host -U user -d worklensai_restore -c "SELECT count(*) FROM \"Device\";"
psql -h host -U user -d worklensai_restore -c "SELECT count(*) FROM \"DeviceClaim\";"

# 4. Point the app at the restored DB, run migrations (should be a no-op if the
#    dump already contains the final schema), then start the app.
```

---

## 6. Restore Verification Checklist

After any restore, verify:

| Item | Command / Check |
|------|-----------------|
| Application starts | `/api/health` → `{"status":"ok"}` |
| Database reachable | `/api/health/database` → `{"status":"ok"}` |
| Organizations intact | `SELECT count(*) FROM "Organization"` |
| Consents intact | `SELECT count(*) FROM "Consent"` |
| Devices intact | `SELECT count(*) FROM "Device"` |
| DeviceClaims intact | `SELECT count(*) FROM "DeviceClaim"` |
| FK integrity | `PRAGMA foreign_key_check;` (SQLite) / `pg_dump --schema-only` diff (PG) |
| Login works | Admin login returns 200 |
| Consent enforcement | Activity/screenshot uploads still 403 without consent |

---

## 7. Restore Test (performed this phase)

**NOT VERIFIED** — no live database was restored in this environment (no PostgreSQL available; the SQLite dev DB was not disturbed). The procedure above is the documented runbook. It must be executed and evidenced during the production pilot (Phase F §23) before PRODUCTION READY.

---

## 8. Key Files & Tables

- **Database file:** `db/custom.db` (SQLite)
- **Schema:** `prisma/schema.prisma`
- **Migrations:** `prisma/migrations/` (28 migrations, additive; the zero-touch migration `20260810120000_zero_touch_device_claims` is additive-only: ALTER TABLE ADD COLUMN + CREATE TABLE — safe to back up/restore)
- **Uploads:** `uploads/screenshots/` — back these up together with the DB (a restored DB without the files yields 404s on screenshot image requests).