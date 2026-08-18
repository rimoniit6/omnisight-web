# WorkLensAI — Production Operations Manual

## 1. How to Deploy

Follow `workload/47-Production-Deployment-Runbook.md`. Summary:

```bash
cd /e/Workslens/workai
git pull origin main
npm ci
npx prisma generate
npx prisma migrate deploy   # NEVER db push in production
npm run build
NODE_ENV=production npx next start -p 3000
```

---

## 2. How to Backup

See `workload/46-Database-Backup-Restore-Runbook.md`. Summary (SQLite):

```bash
sqlite3 db/custom.db ".backup 'backups/custom-$(date +%Y%m%d-%H%M).db'"
```

Also back up `uploads/screenshots/` (files referenced by the DB).

---

## 3. How to Restore

1. Stop the app.
2. `cp backups/custom-<timestamp>.db db/custom.db` (or `pg_restore` for PostgreSQL).
3. `chmod 600 db/custom.db`.
4. Start the app.
5. Verify `/api/health` + `/api/health/database` + `PRAGMA foreign_key_check;`.

---

## 4. How to Add an Employee

1. Admin → Employees → Add Employee.
2. Fill name, Employee ID, email, department, designation, status.
3. Save. The employee can now be assigned to devices and projects.

---

## 5. How to Approve a Device

1. Admin → Agent Approvals → Zero-Touch Devices tab.
2. Locate the **Pending** device (hostname shown; discovered automatically).
3. Click **Approve & Activate**.
4. Select the employee (department auto-derives from the employee).
5. Optionally select project(s).
6. Confirm. The device activates and the agent auto-authenticates within ~20s.
7. **Approval does NOT grant consent** — consent is managed separately.

---

## 6. How to Revoke a Device

1. Admin → Agent Approvals → Zero-Touch Devices.
2. Find the device in the **Active** filter.
3. Click **Revoke Access**, optionally add a reason.
4. The device is deactivated: its token fails closed, heartbeat/uploads stop, collectors stop.

---

## 7. How to Revoke Consent

1. Admin → Consent management page.
2. Find the employee, select the consent type (activity_tracking, screenshot, etc.).
3. Revoke. The agent stops collection within ~60s (consent sync) and the server rejects uploads with 403 immediately.

---

## 8. How to Troubleshoot an Offline Agent

1. Check device status in Admin → Devices / Zero-Touch Devices (is it `online` or `offline`? last heartbeat?).
2. On the employee PC: check the agent tray icon. Right-click → Open Agent → see Connection / Last Heartbeat.
3. Verify the server is reachable: `curl -s https://your.server/api/health`.
4. Verify `WORKLENSAI_SERVER_URL` on the agent points at the correct server (default `localhost:3000` is dev-only).
5. Check the agent log (userData `state/` logs) for heartbeat failures or 401s.
6. If the token expired: the agent auto-reauthenticates (device credential) — no manual action needed.
7. If the device was revoked: the agent shows "Device access has been revoked" — re-approve from Admin.

---

## 9. How to Replace a Device

1. Admin → Agent Approvals → revoke the old device.
2. Install the agent on the new machine.
3. The new machine appears as **Pending** → approve it and assign the employee.
4. The old device stays in history as revoked/inactive; the new one becomes the sole active device (one-active-device-per-employee rule).

---

## 10. How to Reinstall an Agent

1. Uninstall the old agent (start-menu uninstaller).
2. **The device identity (`device-identity.json`) lives in `%APPDATA%\worklensai-agent\state`** — it survives uninstall if `deleteAppDataOnUninstall: false` (the current installer keeps it). This preserves the device binding so the same machine keeps its identity.
3. Install the new EXE. The agent restores its claim/token from encrypted storage and reconnects.

---

## 11. How to Rotate Credentials

- **JWT_SECRET:** change in `.env`, restart. All admin sessions invalidate (users re-login).
- **ENCRYPTION_KEY:** rotate carefully — it invalidates previously encrypted values (AI provider keys must be re-entered).
- **Agent device secret:** not stored server-side in plaintext (SHA-256 hash only). Re-approval issues a fresh claim secret. There is no self-service rotation endpoint — revoke + re-approve the device.
- **Super admin password:** update via the users management UI.

---

## 12. How to Update the Application

1. Backup the DB (workload/46).
2. Follow workload/47 (§2 Deploy): pull, `npm ci`, `prisma generate`, `prisma migrate deploy`, build, restart.
3. Verify health checks + login + a zero-touch discovery.

---

## 13. How to Rollback

### Application
```bash
git checkout <previous-release-tag>
npm ci && npx prisma generate && npm run build
NODE_ENV=production npx next start -p 3000
```

### Database
1. Restore the pre-deployment backup (workload/46).
2. **Never blindly `prisma migrate rollback`.** The migrations are additive (e.g. the zero-touch migration adds `Device.agentKey` + `DeviceClaim` table — both non-destructive). Rolling back code to before the migration is safe WITHOUT reverting the migration, because the old code ignores the extra column/table. Only if you must revert the schema, drop the new table/column manually after restoring data — never via `migrate rollback` on a shared production DB.
3. **Zero-touch migration rollback implications:** `20260810120000_zero_touch_device_claims` is additive-only (`ALTER TABLE "Device" ADD COLUMN "agentKey"` + `CREATE TABLE "DeviceClaim"`). Reverting the application to a pre-zero-touch build does not require reverting this migration — the old code never queries `agentKey` or `DeviceClaim`. Keep the migration applied; roll back only the code.

### Agent
1. Downgrade by installing the previous EXE (upgrade/downgrade preserves `%APPDATA%` identity + credentials).
2. Ensure the previous version's server URL is still valid.

---

## 14. Emergency Procedures

### Application down
1. Check process: `pm2 status` / `tasklist | grep node`.
2. Check logs: `pm2 logs` / server stdout.
3. Restart: `pm2 restart worklensai`.
4. Escalate to DB check if `/api/health/database` returns 503.

### Database unavailable
1. Check `/api/health/database` → 503.
2. Verify the DB file/process is healthy; check disk space (`df -h`).
3. Restore from the latest backup if corruption is suspected.
4. If disk is near-full: purge old backups, run retention cleanup (`npm run jobs`), and stop screenshot intake until space is freed.

### Disk almost full
1. `df -h` on the uploads volume.
2. Run retention: `npm run jobs` (purges screenshots/activities past retention).
3. Clean `backups/` older than retention.
4. Screenshot uploads are capped at 5MB each and spooled client-side; the server does not crash on disk-full — writes fail and the client retries with backoff.

### Heartbeat failure spike
1. Check Admin → Devices for a wave of `offline` devices.
2. Check the server health + load (is it the server or the agents?).
3. Check the agent API rate limit (600/min/token) — a fleet-wide restart could trip it; backoff handles recovery.

### Security incident (revoked device still uploading)
1. This should be impossible — `validateAgentToken` checks device status on every request. If observed, verify the device row's `status` was set to `inactive` by the revoke transaction.
2. If an employee was deleted but uploads continue, check `employee.status` — archiving/deleting cascades and `validateAgentToken` rejects non-active employees.
3. Immediately rotate `JWT_SECRET` if the admin side is suspected.

---

## 15. Scheduled Jobs

Run hourly by default (`JOBS_INTERVAL_SECONDS=3600`) via `src/instrumentation.ts`:

| Job | What it does |
|-----|-------------|
| Consent expiry | Marks `Granted → Expired` when `expiresAt` lapses |
| Retention cleanup | Purges screenshots/activities/reports/AI insights past retention; anonymizes audit/consent logs |

Manual run: `npm run jobs`.

---

## 16. Key Files

| Path | Purpose |
|------|---------|
| `.env` | Production secrets (never committed) |
| `db/custom.db` | SQLite database |
| `uploads/screenshots/` | Screenshot files |
| `src/lib/jobs/` | Background jobs (expiry, retention) |
| `src/instrumentation.ts` | Job scheduler bootstrap |
| `Caddyfile` | Reverse proxy / TLS |
| `desktop-agent/out/` | Built agent + installer |
| `%APPDATA%\worklensai-agent\state` | Agent identity, credentials (DPAPI-encrypted), queue |