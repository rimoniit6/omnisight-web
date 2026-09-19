# OmniSight — UAT Support Kit

Deterministic test data + an acceptance checklist for validating the product
before release. Everything here is synthetic (`omnisight.example.com`,
throwaway UAT organization) — never real customer data.

## 1. Seed command

```sh
# Local/dev
SEED_ALLOWED=1 npm run seed:uat            # tsx wrapper (server-only shim baked in)

# Variants
SEED_ALLOWED=1 npm run seed:uat -- --wipe-only   # wipe UAT data only
```

- **`SEED_ALLOWED=1` is required** (same guard as `db:seed:dev`). Without it the
  script exits before touching anything.
- **Idempotent + safe to re-run:** re-running wipes and re-seeds ONLY the
  resolved UAT organization (`slug = 'uat'`, name must start with
  `OmniSight UAT`). The seeder fails closed if a non-UAT org ever lands on that
  slug, and every delete is org-scoped — `DELETE` is never unbounded.
- Re-running leaves the UAT **admin account unchanged** (password never
  overwritten) and only recreates org-scoped rows (employees, devices,
  activities, claims, consents, notifications, anomalies).

## 2. What the seed creates

| Item | Count | Notes |
| --- | --- | --- |
| UAT org | 1 | slug `uat`, timezone `Asia/Dhaka`, `MANAGED` deployment |
| Admin (AppUser) | 1 | owner membership, org-scoped |
| Departments | 3 | Engineering (24), Operations (14), Sales (12) |
| Employees | 50 | `UAT-E001`…`UAT-S012`; designations per dept; unique emails |
| Agent accounts | 50 | 1:1 `AgentAccount`, login = employeeId |
| Devices | 50 | 40 assigned workstations (28 online / 12 offline) + 10 unassigned |
| Pending device claims | 10 | created 3h–21h ago (>2h reminder threshold), expire in 72h |
| Activity rows | ~15–17k | 30 deterministic per-employee days, batched `createMany` |
| WorkDaySummary | ~1.5k+ | rollups per (employee, day) + today's partial |
| Consent policies | 6 | published `v1` for monitoring/screenshot/activity/keystroke/location/webcam |
| Consent grants | 300 | granted for all 50 × 6 types; **3 employees deny screenshot** (indices 10/20/30) |
| Notifications | 6 | mixed unread/read, incl. device_offline + pending-claim |
| Anomalies | 4 | productivity_drop, excessive_idle, device_missing, rapid_app_switch (`dedupeKey null`) |

**Test credentials (synthetic — documented here on purpose):**
- Admin login: `uat-admin@omnisight.example.com / Uat@Admin2026!`
- Agent login: `<employeeId> / UatAgent#2026` (all 50 accounts)
- Pending-claim secrets: `UAT-claim-secret-1` … `UAT-claim-secret-10`

Env overrides: `UAT_ADMIN_EMAIL`, `UAT_ADMIN_PASSWORD`, `UAT_AGENT_PASSWORD`.

## 3. Acceptance checklist

### A. Dashboard & reporting
- [ ] Dashboard shows 50 active employees, 40 assigned devices, recent alerts.
- [ ] Activity report for "last 30 days" loads with per-day totals and the
      productive/neutral/unproductive split.
- [ ] Workday summary for a past day renders (rollups seeded — no AI needed).
- [ ] PDF dashboard report (`/api/reports/pdf/dashboard`) and audit report
      download successfully for the UAT org.
- [ ] AI daily summary route responds for a past day (may be gated by AI key —
      verify graceful degradation when no provider is configured).
- [ ] AI services "down" transparency: put the org's AI settings on an
      unreachable base URL (or remove the key) and confirm the UI shows an
      explicit "AI unavailable / degraded" state (clear badge or empty insight
      block with a reason) instead of a crash or a blank screen.

### B. Device lifecycle & claims
- [ ] Devices page lists the 40 workstations + 10 unassigned ("New-Laptop-1"…).
- [ ] Pending claims show 10 items; claim approval works via the approve route
      (bind device → employee). Reject path surfaces the reason.
- [ ] Daily `device_claim_reminders` job notifies for claims > 2h (delete
      `reminderSentAt` on one claim first to force the reminder).
- [ ] `/api/health/ready` reports `deviceRouting: ok` and `jobs: ok` when the
      Device Index / JobRun tables are present.
- [ ] Device Routing lookup by agentKey resolves a UAT workstation
      (`uat-agentkey-0`…`uat-agentkey-39`).

### C. Consent
- [ ] Consent summary shows `granted` for most employees and surfaces the 3
      screenshot-`denied` employees (indices 10/20/30) as not-consented.
- [ ] Editing/renewing a policy bumps the version and the employee consent list
      reflects the new `v1` (all seeded grants are `v1`).

### D. Anomalies & grace period
- [ ] New hires (last 5 employees, joined 5–12 days ago) are inside the anomaly
      grace period — `anomalyGraceUntil` is set and the detector reports
      `in_grace_period` for them.
- [ ] Seeded anomalies appear in the anomaly list (4 items) and resolve cleanly.
- [ ] Anomaly accuracy vs static thresholds: each seeded anomaly carries
      `metadata.{baseline,current,threshold}` (e.g. productivity_drop
      baseline .62 / current .41 / threshold .5) — verify the detector's
      verdict and score match the seeded signal, and confirm the new-hire
      grace gate prevents false verdicts for the 5 recent joiners.
- [ ] Run `npm run jobs` — all JobRun lease rows complete (`status=completed`) and
      no `errors` in the JSON result.

### E. Agent login & auth
- [ ] Agent login with `<employeeId>` + `UatAgent#2026` succeeds (path B
      authenticated flow); wrong password increments `failedLoginCount` and the
      15-minute lockout engages after 5 failures.
- [ ] Agent password rotation works; `passwordChangedAt` updates.

### F. Operations resilience
- [ ] `/api/health` → 200 `ok`; `/api/health/database` → `bootstrap: complete`,
      `orgDatabases.checked` reflects activated BYODB orgs (0 here);
      `/api/health/ready` → 200 `ready`.
- [ ] Graceful shutdown: SIGTERM the web process — logs show scheduler drain and
      Prisma disconnect; no "connection already closed" crash; a running job
      completes or its lease rescues it on next run.
- [ ] `SEED_ALLOWED` unset → `npm run seed:uat` refuses to run.
- [ ] `npm run lint:projections` still passes (projection discipline gate).

## 4. Teardown

```sh
SEED_ALLOWED=1 npm run seed:uat -- --wipe-only   # removes UAT org-scoped rows
```

The UAT organization row itself is never deleted by the seeder (delete it via
the Super Admin orgs console if a full removal is required).