# OmniSight Desktop Agent — Installation & Release

## Installer

Build the Windows installer (x64, Windows 10/11):

```bash
npm --prefix omnisight-agent run package
```

Output goes to `omnisight-agent/dist/` (`*.exe` NSIS installer + `*.yml` update
metadata when publish is configured). For a quick unpacked build:

```bash
npm --prefix omnisight-agent run package:dir
```

The packaged app includes only the agent: Electron runtime, compiled `dist/`,
renderer assets, and the native addon. It does **not** package the Next.js
admin app, Prisma, or admin dependencies.

## First-run enrollment flow

1. **Admin side**: in the admin panel, generate/assign an employee
   `agentPassword` (employee is then `agentApproved` when a registration is
   approved).
2. **Employee side**: launch the installed agent, enter the employee ID +
   agent password, and the server URL.
3. Agent registers (`POST /api/agent/register`) → status `pending`.
4. **Admin approves** the registration in **Agent Approvals**.
5. Agent authenticates (token valid 24h), syncs configuration and consent.
6. Collectors start only for consent types granted by the **current published
   policy version**.

The agent stores the password encrypted (DPAPI) and re-authenticates
automatically after the 24h token expires — no repeated logins.

## Windows startup

The agent supports launching with Windows (taskbar tray + background window).
It is a visible, identifiable application — no stealth behavior. Consent
revocation stops the corresponding collector immediately, without restart.

## Server prerequisites

- The admin app must be reachable over HTTPS/HTTP from the device.
- **Scheduled jobs are not required for the agent**, but the admin's
  `JOBS_INTERVAL_SECONDS` cron drives server-side expiration/retention; the
  agent itself relies on its own timers (heartbeat, consent refresh, queue
  drain, screenshot interval).
- Screenshot retention is enforced server-side (physical files + DB rows); the
  agent only spools files temporarily and deletes them after upload.

## Configuration sources

Operational settings come from the server (`GET /api/agent/config`) and
override local defaults:

- `monitoring.screenshotEnabled`, `screenshotFrequency` (minutes),
  `screenshotRetentionDays`
- `monitoring.appTrackingEnabled`, `websiteTrackingEnabled`,
  `idleDetectionEnabled`, `idleTimeoutMinutes`
- `monitoring.workingHoursOnly`, `workStartTime`, `workEndTime`
- `monitoring.heartbeatInterval` (seconds)
- `features.breakModeEnabled` (true — break/privacy mode implemented; the agent pauses collectors while the server reports an active break), `tamperDetectionEnabled` (false — not implemented), `usbMonitoringEnabled`
- `break` — `{ active, startedAt }` canonical break state (server-authoritative)
- `limits.maxScreenshotSize`, `maxActivitiesPerRequest`, `maxBatchSize`

## Release process

1. Bump `omnisight-agent/package.json` `version`.
2. `npm --prefix omnisight-agent run package` (electron-builder).
3. **Sign the installer** (Windows code signing) before distribution.
4. Publish update artifacts for Electron's updater if auto-update is enabled;
   the agent verifies downloads before installing and rolls back on failure.
5. Smoke-test on a clean Windows 10/11 VM: enroll → approve → authenticate →
   consent-gated collection → revoke stops collection.

## Troubleshooting

| Symptom | Check |
|---|---|
| Status shows "Pending approval" | Admin must approve the registration in Agent Approvals |
| Status "Rejected" | Registration was rejected — re-register or contact admin |
| No data in admin | Consent not granted for that type, or policy version is not current (re-consent required) |
| "Expired" status | Token expired and no stored credentials — re-enter employee ID/password |
| Uploads stuck in queue | Server unreachable — check URL/network; queue drains when connectivity returns |
| Consent shows granted but no collection | `screenshotEnabled`/`appTrackingEnabled` config toggle off |

Logs are structured (`timestamp level service event errorCode`) under the
user-data directory; credentials and tokens are never logged.
