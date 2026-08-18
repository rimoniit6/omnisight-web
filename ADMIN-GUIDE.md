# OmniSight — Admin Guide

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

Operational handbook for administrators and owners: users, employees, devices, settings, monitoring, consent, agent software, imports/exports, and maintenance.

Related docs: [USAGE.md](./USAGE.md) · [COMPANY-GUIDE.md](./COMPANY-GUIDE.md) · [SECURITY.md](./SECURITY.md) · [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## 1. User management (admin+)

- **Create users**: `Users` page → invite with role. Only `super_admin` can create `super_admin` users.
- **Roles**: `super_admin` (all), `owner` (org settings + user management), `admin` (org management, employees, devices, settings, AI, reports), `manager` (consent, notifications, anomalies, reports, self-portal), `viewer` (read-only).
- **Deactivate**: users can be deactivated (login → 401); passwords changed via profile; no self-service reset.
- **Users never see hashes** — `/api/auth/users` and `/api/auth/me` exclude password fields.

## 2. Employees

- **Create**: Employees page → New Employee (or import, see §7). Duplicate emails are rejected.
- **Fields**: first/last name, email, phone, designation, employee ID, department, join date, status.
- **Agent account**: per-employee Agent Account (ID defaults to employee ID; password ≥ 12 chars upper+lower+digit). Password resets invalidate the agent session/tokens.
- **Lifecycle**: active → archived (delete/bulk archive). Archiving keeps history; the employee no longer appears in active lists.
- **Presence**: computed from agent heartbeats; `online` = heartbeat within `PRESENCE_ONLINE_THRESHOLD_MS` (default 2 min) of `now`.

## 3. Devices & approvals

- **Device claims** (zero-touch path): Agents register → **Agent Approvals** page → approve as employee (bind) or **guest** (no Agent Account, **no consent** — guest devices are unmonitored by consent design) or reject.
- **Legacy registrations**: agent-registrations without claims; approve/reject with reason.
- **Revoke** a device → device inactive, tokens fail closed.
- **Active-device rule**: one device per employee at a time; a second approval or authenticate → 409 `ACTIVE_DEVICE_EXISTS`. Revoke/delete the conflicting device first.
- Devices show effective online/offline from heartbeat, not a stored boolean.

## 4. Monitoring settings (Settings → Monitoring)

| Setting (default) | Meaning |
|---|---|
| activity_tracking_enabled (true) | activity collection |
| screenshot_enabled (false) | screenshot cadence (off/1/2/5/10 min) |
| keystroke_logging_enabled (true) | keyboard aggregates |
| location_tracking_enabled (false) | location collection |
| website_tracking_enabled (true) | domain tracking (websites) |
| usb_monitoring_enabled (false) | USB insert/remove events |
| website_native_tracking_enabled (false) | allow browser-extension path |
| policy_enforcement_enabled (true) | app whitelist/blacklist enforcement |
| break_enabled (false) | break/privacy mode feature |
| webcam_relay_enabled (false) | allow webcam sessions |

**Rule of thumb:** collection happens only when **setting + consent + agent capability** all allow it. Changing settings pushes to agents on the 10-min config refresh (or next connect).

## 5. Consent operations (manager+)

- **Policies**: Consent → Policies → publish per consent type (Monitoring, Screenshot, Activity Tracking, Keystroke, USB Monitoring, Webcam Access, Location, Email Monitoring). Draft → published → archived (v2 archives v1 → employees on v1 must re-consent).
- **Employee rows**: Consent → Employees → search → Grant/Revoke (bulk available). Revocation is immediate server-side (403s).
- **Logs**: immutable `ConsentLog` — who/what/from/to/policy version.
- **Best practice**: publish policies before granting; re-consent after policy updates.

## 6. Agent software builds (admin+)

- **Settings → Agent Software** shows the build config (enrollment code enabled?, version, artifact URL).
- **Build**: generates a Windows installer; enrollment code (if enabled) is baked into the installer — codes are single-use and stored only SHA-256-hashed. **Important:** builds require a machine with the native toolchain (MSVC + SDK 10.0.26100 + node-gyp) and run a fixed command; concurrent builds are serialized.
- Downloads include SHA-256 checksums.

## 7. Imports & exports (admin+ / manager+)

- **Import** (`/api/import/*`): employees, activities, time-entries, projects from .csv/.xlsx/.xls; per-row errors reported; rate-limited (5/min).
- **Export** (`/api/export/*`): same types → CSV/Excel (manager+). Reports page: Generate Report + CSV/JSON/PDF; instant PDFs (Dashboard, Activity Log, Audit Log); Daily Report + AI summary.
- Audit log CSV export is manager+.

## 8. Anomalies & alerts

- **Manual**: Anomalies page → create (manager+); update status (resolvedBy = current actor).
- **Auto rules** (job `anomaly_detection`): `productivity_drop`, `excessive_idle`, `unusual_login`, `low_activity_spike` — daily/hourly per `JOBS_INTERVAL_SECONDS` (default 3600 s).
- **Run now**: `/api/anomalies/detect` (manager+, rate-limited).
- **Alerts**: severities info/warning/critical; Acknowledge / Escalate / Resolve; bulk acknowledge; agent security page shows security-scoped subset.

## 9. Projects & time (admin+)

- Projects: CRUD + soft-delete/restore; members; manual time entries; auto time from the sync engine (source `ACTIVITY_AUTO`) when one active tracking project.
- Time sync: org setting `project_time_sync` (default **off**) — nightly reconciliation to `ProjectTimeSync` + `TimeEntry`.

## 10. Data retention

Settings → Monitoring → Data Retention: per-class days (0 = keep forever; validation 0–3650). Enforced hourly by `retention_cleanup`. **Audit + consent logs are anonymized, never deleted.** Screenshot files are removed with their rows.

## 11. Maintenance & ops

- **Jobs**: `expire_consents` (expire pending beyond TTL), `retention_cleanup`, `project_time_sync`, `anomaly_detection` — hourly, `JobRun` tracked, fails recorded.
- **Backup**: `VACUUM INTO` or dump per your DB (see [DEPLOYMENT.md](./DEPLOYMENT.md)); `uploads/` (screenshots + agent builds) must be backed up too.
- **Logs**: structured JSON on stdout; secrets redacted. `LOG_LEVEL` controls verbosity.
- **Health**: `/api/health` + `/api/health/database`.
- **Production guardrail**: `db:production-clean` requires `CONFIRM_PRODUCTION_CLEANUP=exactly-this-string`; `db:reset` requires `CONFIRM_DEV_RESET`; seeding (`db:seed:dev`) is blocked when `SEED_ALLOWED=false`.

## 12. Common mistakes

| Mistake | Fix |
|---|---|
| Granting consent with no published policy | Publish the policy first |
| Approving a second device for an employee | Revoke/delete the first device, then approve |
| Expecting telemetry without consent | Grant consent (and enable the setting) |
| Rotating `JWT_SECRET` without re-login | All sessions invalidate (by design); users log in again |
| Losing `ENCRYPTION_KEY` | AI keys cannot be decrypted; re-enter provider keys |
| Changing `DATABASE_URL` to a new empty DB | Run `db:deploy` (migrations) + bootstrap the super admin |
