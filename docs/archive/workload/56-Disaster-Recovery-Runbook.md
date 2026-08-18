# Disaster Recovery Runbook

> Date: 2026-08-10
> Applies to: single-instance WorkLensAI deployment (Next.js Admin + PostgreSQL + Desktop Agents)
> Target RPO: last nightly backup (default); Target RTO: < 15 min for DB restore + app restart

---

## 1. Failure Scenarios & Recovery Paths

### D1. Database failure (PostgreSQL down / corrupt)
1. Detect: `/api/health/database` returns 503; app queries fail.
2. Restore latest verified backup:
   ```bash
   createdb -T template0 workai_recovery
   pg_restore --dbname="$PGURL/workai_recovery" --no-owner backups/pg/workai-<latest>.dump
   # verify: node scripts/pg-backup-restore-certification.mjs  (or row-count compare)
   ```
3. Point `DATABASE_URL` at the recovered DB and restart the app.
4. Verify: `/api/health/database` 200; login; spot-check devices/claims/consent counts.
5. **If the primary DB is later repaired**, do NOT switch back silently — re-sync forward or keep the restored instance authoritative.

### D2. Application failure (Next.js crash / corrupt deploy)
1. Restart the process (systemd/pm2/service).
2. If it fails to boot, redeploy the previous known-good build (see rollback in §5).
3. Verify `/api/health` and login.
4. In-flight agent uploads retry with bounded backoff (no data loss by design).

### D3. Server restart / maintenance window
- Agents reconnect automatically (bounded backoff); offline queues drain on reconnect.
- No employee action required.

### D4. Disk failure / full disk
- Screenshot uploads fail gracefully (5 MB cap; storage errors logged, no crash).
- Free space → run retention cleanup (`runRetentionForOrg` purges DB rows + physical files per policy).
- Monitor disk in ops dashboard; alert at >85%.

### D5. Failed agent update
- Update is HTTPS-feed only and no-op when unset today. If a bad build ships:
  - Reinstall the previous installer over it (same device identity — `deleteAppDataOnUninstall: false` preserves userData; `Device.agentKey` persists).
  - Device re-authenticates on next boot; no new DeviceClaim created.

### D6. Lost / replaced agent machine
- Admin: revoke the old device (`/api/device-claims/[id]/revoke` or device deactivate) → old token/secret fail closed immediately.
- New machine installs → zero-touch discover → **new** DeviceClaim → admin approves with same employee (one-active-device rule deactivates any leftover).

### D7. Compromised device
1. **Revoke the device** (admin) — authentication, heartbeat, and uploads all fail closed server-side (token validation rejects non-online devices).
2. **Revoke consent** for that employee's sensitive types if the account is suspect.
3. Audit: check audit log entries, recent screenshots/activity for that device.
4. If the device is recovered: re-approve via a fresh claim (device must re-discover).

### D8. Database backup lost / never taken (worst case)
- Current-state fallback: the live DB is the only copy. **Immediate action:** take a backup now.
- Learn: enable scheduled nightly backup + run the certification script weekly as an RTO drill.

## 2. RPO / RTO Summary

| Metric | Value | How to improve |
|---|---|---|
| RPO | ≤ 24 h (nightly backup) | WAL archiving / more frequent dumps → minutes |
| RTO | < 15 min (0.2 MB dump, ~seconds restore + verify) | Pre-staged restore procedure; automated failover for larger data |

## 3. Recovery Verification Checklist

- [ ] `/api/health` = 200
- [ ] `/api/health/database` = 200 (DB reachable)
- [ ] Login works (super admin)
- [ ] Device/claim/consent row counts match pre-disaster (or backup manifest)
- [ ] Zero-touch discover returns 201 (agent connectivity path)
- [ ] One active device per employee still holds (concurrency intact)

## 4. Notes

- This runbook assumes a single instance. Horizontal scaling (multi-instance admin) would require a shared/central rate-limiter and is out of scope today (documented P3).
- The archived SQLite migrations + `db/custom.db` remain as a Phase-G rollback source until the first successful production PG restore is demonstrated.
