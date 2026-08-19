# OmniSight — Company Operational Guide

> Previously branded as **WorkLensAI** — technical identifiers from that era (cookie names, environment variables, native module names) are intentionally preserved for compatibility.

This is an internal operational guide: how a company uses OmniSight from first login to day-to-day monitoring. It describes **actual software behavior** — everything here was verified against the codebase. Where a step describes *recommended policy* rather than enforced behavior, it is explicitly marked.

Related docs: [FEATURES.md](./FEATURES.md) · [USAGE.md](./USAGE.md) · [ADMIN-GUIDE.md](./ADMIN-GUIDE.md) · [EMPLOYEE-GUIDE.md](./EMPLOYEE-GUIDE.md) · [PRIVACY.md](./PRIVACY.md) · [SECURITY.md](./SECURITY.md)

---

## 1. Organization setup

### 1.1 Initial administrator

1. The platform is installed and the Super Admin is created by the deployment process (`npm run bootstrap:super-admin` with `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`). The Super Admin is an instance-level account with **no organization** until one is created.
2. On first login the app shows the **Create Organization** screen (only an org-less Super Admin sees it). Enter an organization name.
3. After creation the Super Admin is bound to that organization and receives a fresh session cookie.

**Actual behavior:**

- Only `super_admin` can create an organization, and only while org-less (an org-bound super admin gets 403).
- The bootstrap creates **no demo data** — no employees, devices, or consents.
- Only `super_admin` can create/update other `super_admin` users. Owners/admins can create `owner`, `admin`, `manager`, `viewer` users.

### 1.2 Company configuration

Recommended setup order (Software behavior noted where relevant):

| Step | Where in UI | Software behavior |
|---|---|---|
| Create additional admins/managers/viewers | **Settings → Users** | Admin+ can create users with any role below super_admin |
| Set organization timezone | **Organization** page | IANA timezone select; drives work-hour windows, day boundaries, break summaries |
| Configure monitoring | **Settings → Monitoring** (org-scoped) | Heartbeat interval, screenshots, app/website tracking, idle detection, work hours, telemetry toggles (all fail closed: `false` by default for sensitive types) |
| Configure retention | **Settings → Monitoring → Data Retention** | Per-org retention days per data class; `0` = keep forever; audit/consent logs are anonymized, never deleted |
| Generate enrollment code (optional) | **Organization → (enrollment code action)** | Code shown exactly once; only SHA-256 hash stored |
| Publish consent policies | **Consent** page | Draft → publish per type; publishing v2 archives v1 and invalidates v1-bound consents until re-consent |
| Build the agent installer | CLI: `AGENT_SERVER_URL=... node omnisight-agent/scripts/build-prod.mjs` | Builds NSIS installer with server URL baked in (https required in production) |

### 1.3 Roles, departments, teams

- **Roles** (web users): `super_admin` > `owner` > `admin` > `manager` > `viewer`. Only super_admin is instance-global; every other role is bound to one organization.
- **Departments**: an organization contains departments; each department may have a manager (an employee). Departments are used in analytics, performance views, and project assignment. **There is no separate Teams entity** — departments serve that purpose.
- **Projects**: work projects with members (roles `lead|member|reviewer|stakeholder`), time entries, and sentiment. Employees can be assigned to one or more projects; time is auto-attributed when exactly one membership is active (or an admin-selected active tracking project).

## 2. Employee lifecycle

### 2.1 Employee creation

1. **Employees** page → create employee (first name, last name, email, employee ID, department, designation, join date, status).
2. Bulk import is available (**Import** button, .csv/.xlsx/.xls template), plus bulk archive and CSV/Excel export.

### 2.2 Device registration and agent installation — two supported paths

**Path A — Zero-touch (recommended):**

1. Admin generates an enrollment code (Organization page) **or** bakes it into the installer.
2. Admin creates (or has created) the employee record and an **Agent Account** (Employees → employee → Agent Account → create; `agentId` defaults to the employee ID).
3. The employee installs the **OmniSight Agent** on their Windows machine. The agent:
   - reaches the server (`AGENT_SERVER_URL` baked at build time, or `OMNISIGHT_SERVER_URL` / `WORKLENSAI_SERVER_URL` env),
   - logs in with the Agent Account (`POST /api/agent/login`), then **discovers** itself (`POST /api/agent/discover`), creating a pending **device claim** on the server.
4. Admin approves the claim in **Agent Approvals** (mode: Employee — select the employee; mode: Guest — creates a guest record without credentials).

**Path B — Legacy register:**

1. Employee record exists; the admin sets the legacy agent password (or an Agent Account exists).
2. The agent registers (`POST /api/agent/register`), creating a pending **agent registration**.
3. Admin approves in **Agent Approvals** → the employee is marked `agentApproved` and a Device is created.

### 2.3 Enrollment → approval → authentication (exact flow)

```
Agent login (AgentSession, 24h)
   → Discover → Device (inactive) + DeviceClaim (pending, secret issued once, 30-day expiry)
   → Admin approves claim (employee or guest mode) → device online, employee approved
   → Agent authenticates → AgentToken (24h, device-bound) → heartbeat/telemetry flow
```

- **Single active device per employee** is enforced: a second device trying to authenticate gets `409 ACTIVE_DEVICE_EXISTS` (the existing device is *not* kicked; the new device stays unauthenticated).
- **Employee removal / revocation**: revoking a device claim sets the device to `inactive`, which invalidates all its agent tokens immediately (fail closed). Archiving an employee (`status: archived`) or disabling their Agent Account also fails the token validation mid-session. Deleting an employee cascades to their tokens, activities, screenshots, etc.

### 2.4 Consent

- Monitoring begins only for consent types that are **granted** (and the corresponding org setting enabled).
- Consent is managed in **Consent** (bulk grant/revoke per employee) and via the agent (the agent asks for consent and reports state; server-side `GET /api/agent/consent`).
- **Granting requires a published policy** of that type — consent cannot be granted without one.
- Revocation is immediate: the server rejects further uploads of that telemetry type with 403 (fail closed). The agent pauses the collector within one heartbeat interval.
- Expiry: consents can have an `expiresAt`; the hourly job flips them to `expired`.
- Guests approved via zero-touch **never receive consent automatically** — approval never grants consent.

### 2.5 Monitoring policy (what can be monitored)

| Telemetry | Org setting (default) | Consent type | Notes |
|---|---|---|---|
| App activity | `app_tracking` (true) | `activity_tracking` | App names + durations |
| Website activity | `website_tracking` (true) | `activity_tracking` | Bare domains only, never full URLs |
| Idle detection | `idle_detection` (true) | `activity_tracking` | Idle time via input absence |
| Screenshots | `screenshot_enabled` (true), frequency (10 min) | `screenshot` | PNG/JPEG/WebP ≤ 5 MB |
| Keyboard statistics | `keystroke_logging_enabled` (false) | `keystroke` | Counts + active typing seconds only |
| Location | `location_tracking` (false) | `location` | Coordinates only |
| Webcam | `webcam_capture_enabled` (false) | `webcam_access` | On-demand relay only; nothing stored |
| USB events | `usb_monitoring` (false) | `usb_monitoring` | Insert/remove events |
| App policy (whitelist/blacklist) | `app_policy_enforcement` (false) | — (no consent type) | Violations reported; termination only with `app_policy_terminate` |

**Recommended policy** (not enforced by software): enable only the telemetry types your company actually needs and that your consent policies cover; keep keyboard/location/webcam off unless there is a documented business reason; publish clear policies explaining each data type's purpose and retention.

### 2.6 What happens when consent is revoked

- Server: subsequent uploads of that type → 403 (nothing persisted).
- Agent: the consent snapshot (refreshed every 60 s) fails the collector gate; the collector pauses. For webcam, an active session is ended with reason `consent_revoked`.

### 2.7 Privacy / break mode

- The employee can activate **Break / privacy mode** from the agent (the agent sends `POST /api/agent/break`). While a break is active, the agent pauses data collectors (activity/screenshot/etc.) — verified via the canonical break state returned in the heartbeat.
- Admins can also start/end breaks via the **Break Monitor** page (toggle). Break sessions are recorded with source (`agent|admin|self_service`) and end reasons.
- **Recommended policy**: make break mode known to employees; it is a privacy control, not a performance metric (breaks are excluded from productive time).

### 2.8 Data retention

- Org-scoped retention settings (Settings → Monitoring → Data Retention): screenshots 30 d, activities 90 d defaults; reports, AI insights, sentiment, USB events, policy violations, notifications, alerts, break sessions configurable (`0` = keep forever).
- The hourly `retention_cleanup` job enforces cutoffs. Audit logs and consent logs are **anonymized, never deleted** (compliance).

## 3. Admin operations

| Task | Where | Roles |
|---|---|---|
| Add employees | Employees → New | admin+ (create); viewer can view |
| Approve devices / claims | Agent Approvals | admin+ |
| Assign employees to departments/projects | Employee details → Projects / Departments | admin+ / manager+ respectively |
| Review activities | Activities, Employee details → Activity | viewer+ |
| Review screenshots | Screenshots (OCR search, flag, AI analyze) | viewer+ (analyze: admin+) |
| Review telemetry | Employee details → Keyboard / Location / Webcam tabs | viewer+ (data gated by consent+config) |
| Review AI insights | AI Insights (Run Analysis) | viewer+ (run: manager+ for some paths) |
| Manage AI providers | AI Provider | admin+ |
| Review alerts/notifications | Alerts / Notifications | viewer+ |
| Manage permissions | Settings → Users | admin+ (super_admin for super_admin users) |
| Review audit log | Audit Logs | viewer+ |
| Run reports | Reports / Daily Report | manager+ |
| Manage consent | Consent | manager+ |
| Break toggle | Break Monitor | admin+ (viewer/manager get 403) |

## 4. Recommended company workflow

A pragmatic adoption flow for a small/medium company (software behavior noted where relevant):

1. **Deploy** (see [INSTALLATION.md](./INSTALLATION.md)) and bootstrap the Super Admin.
2. **Create the organization** (first login).
3. **Create users** (Settings → Users): a second admin and managers.
4. **Create departments** and **employees** (or bulk-import from HR data).
5. **Publish consent policies** (Consent page) for the types you enable.
6. **Configure monitoring** (Settings → Monitoring): heartbeat, screenshot frequency, work hours; leave sensitive telemetry off until a decision is made.
7. **Configure AI** (AI Provider): add a provider key (BYOK — key is encrypted at rest and never returned by the API).
8. **Build the agent installer** via CLI (`AGENT_SERVER_URL=... node omnisight-agent/scripts/build-prod.mjs`) with your server URL; provision the enrollment code.
9. **Distribute to Windows machines** (MDM or manual install); approve claims as they appear in **Agent Approvals**.
10. **Grant consents** for each employee (bulk grant in Consent) — or let the agent prompt the employee.
11. **Monitor**: Dashboard, Live Monitor, Break Monitor, Screenshots, Analytics; review anomalies and alerts daily.
12. **Report**: Weekly reports (Reports / Daily Report), export CSV/Excel for HR/payroll inputs.

> **Recommended vs enforced:** steps 5–7 are configuration choices (the software does not force them). Steps that ARE enforced: no consent → no telemetry (403); no published policy → no grant; revoked consent stops collection; deactivated device stops tokens; cross-org access → 404.

## 5. Privacy & compliance posture

- See [PRIVACY.md](./PRIVACY.md) for the full data map and consent mechanics.
- OmniSight provides **technical controls** (consent enforcement, retention, break mode, data minimization). It does **not** constitute legal compliance (GDPR/CCPA etc.) by itself — your company remains responsible for its policies, notices, and legal obligations. No claim in this document should be read as legal advice.
