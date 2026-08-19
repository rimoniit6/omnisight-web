# OmniSight — Usage Guide

> Previously branded as **WorkLensAI** — technical identifiers from that era (cookie names, environment variables, native module names) are intentionally preserved for compatibility.

A practical, step-by-step user manual for the full product lifecycle. UI labels match the actual source (`src/components/...`). Where a workflow needs a role, the minimum role is stated; role names are `super_admin` > `owner` > `admin` > `manager` > `viewer`.

Related docs: [ADMIN-GUIDE.md](./ADMIN-GUIDE.md) · [COMPANY-GUIDE.md](./COMPANY-GUIDE.md) · [EMPLOYEE-GUIDE.md](./EMPLOYEE-GUIDE.md) · [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

## 1. First login

1. Open the app (`http://localhost:3000` in dev, your domain in production).
2. Enter the Super Admin email and password → **Sign in**. Success shows a "Welcome back, {name}!" toast.
3. If you are an org-less Super Admin (fresh deployment), the **Create Organization** screen appears. Enter an organization name (min 2 chars) and create it. You are then bound to the organization.

**Errors:** wrong credentials → "Invalid email or password" (401). Missing fields → "Please enter both email and password".

## 2. Admin dashboard

1. After login you land on **Dashboard**.
2. KPI cards: total employees, total devices, online devices, average productivity, active alerts.
3. Charts: Productivity (7 days, org-local days), Department breakdown, Device status, Top employees.
4. The **Live Activity** strip shows the 3 most recent realtime activities; the **Live Feed** panel streams events while the WebSocket is connected.
5. Widget layout is customizable (widget customizer). A **PDF export** button downloads the dashboard summary.

**Permissions:** viewer+ can open the Dashboard.

## 3. Create an employee

1. Sidebar → **Employees**.
2. Click **New Employee** (dialog fields: First Name*, Last Name*, Email*, Phone, Designation, Employee ID, Department, Join Date, Status). * = required.
3. Save. A `new_employee` notification is created; the row appears in the table.
4. Bulk: use **Import** (see §21) or select rows → **Archive**.

**Permissions:** create requires admin+ (API); viewer can view. Cross-org/duplicate emails → error toasts.

## 4. Register a device / install the agent

Two paths exist; both end with a device awaiting admin approval.

**Path A — zero-touch (recommended):**

1. In **Organization**, generate the enrollment code (shown once).
2. Build the installer with the enrollment code baked in (use the CLI: `AGENT_ENROLLMENT_CODE=<code> node omnisight-agent/scripts/build-prod.mjs`, or set `AGENT_ENROLLMENT_CODE` on the machine).
3. On the Windows machine, install and run **OmniSight Agent**. The agent shows its status window (onboarding → login/pending).

**Path B — Agent Account login:**

1. In the employee's record (**Employees → {employee} → Agent Account**), create an Agent Account (agent ID defaults to the employee ID; password ≥ 12 chars with upper + lower + digit).
2. On the Windows machine, run the agent and log in with the agent ID + password (agent login screen).

**What happens:** the agent calls the server (discovery or registration) and the device appears in **Agent Approvals** as a pending claim/registration. Claims expire after 30 days if not approved.

## 5. Approve a device

1. Sidebar → **Agent Approvals** (badge shows pending count).
2. Pending tab → inspect the device (hostname, OS, agent version, first seen).
3. Choose **Approve**:
   - **Employee mode**: select the employee to bind → the device becomes online, the employee becomes agent-approved.
   - **Guest mode**: approve as guest — a guest record is created (no Agent Account, **no consent**). Guest tabs (Active/Suspended/Rejected/Revoked) are managed in **Guests**.
4. Or **Reject** (optionally with a reason).

**Common errors:** claim already approved/rejected (state conflict), device binding to a suspended org (denied). After approval the agent's next authenticate call succeeds and telemetry begins (subject to consent).

## 6. Assign an employee (department/project)

- **Department**: Departments page → edit department, or in the employee dialog set Department.
- **Projects**: Employee details → **Projects** tab → **Manage Projects** dialog → search and toggle project membership.
- **Active tracking project**: with exactly one active membership, project time auto-sync attributes activity time automatically. Admins can set an explicit active tracking project (Employee → Projects).

## 7. Configure consent

1. Sidebar → **Consent** (manager+).
2. **Policies**: ensure a **published** policy exists for each consent type (Monitoring, Screenshot, Activity Tracking, Keystroke, USB Monitoring, Webcam Access, Location, Email Monitoring). Draft → **Publish** (publishing v2 archives v1 and requires re-consent for v1-bound employees).
3. **Employees**: search an employee, view their consent rows, and **Grant**/**Revoke** (bulk grant/revoke available for many employees at once).
4. Without a published policy, granting fails (consent requires a policy).

**Effect:** telemetry of a type is collected only when org setting + consent + agent capability all allow it. Revoking stops collection immediately (server 403s uploads).

## 8. Start the agent

On the Windows machine, run the installed agent. It runs in the tray ("Open Agent" shows the status window — there is intentionally **no Quit** item; lifecycle is admin-controlled). The window shows one of: onboarding, login, pending approval, rejected, revoked, conflict (another device active), offline, or status (monitoring).

**Active-device conflict:** if another device holds the employee's single active slot, the agent shows a conflict state; only "Try Again" (after the other device is revoked/offline) clears it.

## 9. Monitor activity

- **Dashboard** — KPIs and live ticker.
- **Activities** page — filterable activity list (application/website/idle), category colors, pagination.
- **Live Monitor** — realtime event stream: LIVE/OFFLINE badge, sound toggle, pause/resume, clear, event-type filter chips (device-status, activity-ping, notification, break-status, screenshot, agent-registration, usb-event, device-claim, guest), Event Stats (today/24h/7d counts), device grid.
- **Employee details → Activity tab** — per-employee timeline with date range selection.

## 10. Review website activity

- Employee details → **Apps & Websites** tab: domains (bare domains only — never full URLs), visits, time on websites, aggregated across the selected period.
- Activities page filters by type `website`.
- Note: the agent's website collector works without a browser extension; the **browser extension** (Chrome/Edge/Firefox, "OmniSight Website Tracker") is an optional extra source when `website_native_tracking` is enabled.

## 11. Review application activity

- Employee details → **Apps & Websites** tab lists applications with durations and categories.
- **Analytics → Top Apps** (top 10 by duration) and **Workload Distribution**.
- Application categories (productive/neutral/unproductive) drive productivity scores. Category assignment is defined in the agent's activity collector (server trusts the reported category for `application` rows).

## 12. Review screenshots

1. Sidebar → **Screenshots** (viewer+).
2. Stat cards + filters (employee, device, flagged status, date). Search switches between **OCR text search** and **search by employee or app window**.
3. Click a screenshot to view it; available actions:
   - **Flag for Review** — with a reason (`flagged` + `flagReason` stored).
   - **Analyze** (admin+) — runs the AI vision provider; results stored on the row.
   - Delete (admin+).
4. OCR text is searchable when the agent captured it (OCR runs agent-side at capture; the server stores `ocrText`).

## 13. Review keyboard telemetry

- Employee details → **Keyboard** tab (requires `keystroke_logging_enabled` + `keystroke` consent): keystroke count, active typing seconds, intervals, per-application breakdown, 1-minute buckets.
- **Privacy guarantee:** only aggregate counts are stored — raw keys are never captured or transmitted.

## 14. Review location telemetry

- Employee details → **Location** tab (requires `location_tracking` + `location` consent): latest fix (lat/long, accuracy, recorded time) + location history with total fix count in the selected period.
- Only coordinates are stored — never addresses.

## 15. Review webcam sessions

- Employee details → **Webcam** tab: status chips (consent granted, config enabled, device available), **Start** button.
- **On-Demand Webcam** is explicit operator control: pressing Start sends a `webcam.start` command to the agent; the camera opens only after the agent confirms consent + configuration; frames stream live (in-memory relay, ~10 fps) and are **never stored**.
- **Stop** ends the session (reason `command`); sessions also end on timeout/disconnect/consent revocation/config disable.

## 16. Review AI insights

1. Sidebar → **AI Insights** (viewer+; analysis requires manager+ for some actions).
2. **Analysis Filters** (period 7/30 days or custom, employee, department, project) apply to both measured stats and AI analysis.
3. Click **Run Analysis** (or **Generate Insight**).
4. Results: mode badge — **AI Analysis** (provider used) or **Data Summary** (provider unavailable; honest fallback with reason). Insight feed items can be actioned/dismissed (statuses `active|actioned|acknowledged|dismissed`).

## 17. Use AI chat / sentiment

- There is **no general-purpose chat**. AI surfaces are: AI Insights (analysis), Sentiment (per employee/project), Daily Report AI summary, and Screenshot analysis.
- **Sentiment**: Sentiment page → **Run Analysis** → scores per employee with mood (`positive|neutral|negative|critical|no-data`), signals, risk factors, recommendations. Project sentiment is available on the project detail → Sentiment tab.
- Without an AI provider key, sentiment falls back to deterministic rules (`aiProviderUsed: 'rules'`) and AI summaries show per-error fallback copy — nothing is fabricated.

## 18. Manage AI providers

1. Sidebar → **AI Provider** (admin+).
2. Tabs: **AI Providers**, **Available Models**, **Generation Parameters**, **Advanced Settings** (system prompt), **Usage Statistics**.
3. Select a provider card (OpenAI, Anthropic, Google, Mistral, Ollama, Custom) → **Configure** → enter API key (BYOK) and base URL (Custom/Ollama) → **Test Connection** (persists config only on success) → **Set Active**.
4. Keys are encrypted at rest (`ENCRYPTION_KEY`) and never returned by the API (shown as `REDACTED`).

**Errors:** wrong key → provider auth failure; incompatible provider/model combo → validation error; rate limit 10/min on test-connection.

## 19. Team comparison

- **Analytics → Compare** (toggle): two modes:
  - **Periods**: pick 4 dates; compare metrics across periods (productivity score, active hours, active days, active employees, activities, top 5 apps, workload %).
  - **Departments**: pick 2 departments (+ optional date range; falls back to trailing 90 days) → side-by-side metrics.
- Department performance also appears in **Analytics → Department breakdown** and `/api/departments/performance`.

## 20. Projects and tasks

1. Sidebar → **Projects** (viewer+). Cards/table toggle; **New Project** (admin+ to manage) with name, description, status, priority, dates, estimated hours, color, tags, budget type/rate, department.
2. Project detail tabs: **Overview / Team / Time Log / Analytics / Sentiment**.
3. **Time Log**: add time entries (manual source); automatic entries appear with source `ACTIVITY_AUTO` from the project time sync engine.
4. There is **no task/todo tracking** — projects track time only.

## 21. Notifications and alerts

- **Bell icon** (header): unread count; popover with mark-all-read. Types colored by type; priorities shown.
- **Notifications page**: tabs All/Unread/Read, stat cards, type filters, search; batch actions (admin+): Mark Read, Archive, Delete, Clear.
- **Alerts page** (viewer+): severity distribution, card/timeline view, actions Acknowledge / Escalate / Resolve, bulk acknowledge. Alerts also stream to the Live Monitor.
- **Agent Security page** (admin+): security-scoped alert subset (`security, device_offline, policy_violation, high_inactivity`).
- Preferences: **Notifications → preferences** (manager+) per-type enable/disable (absent row = enabled).

## 22. Employee self-service

- Sidebar → **Employee Portal** (manager+): pick an employee, view tabs **Overview / Consents / Anomalies / Projects / Telemetry** (per-tab empty states until an employee is selected).
- Overview: today's hours, weekly productivity (±change), devices (online/total), consent status, **Break / Privacy Mode** card, and **Revoke Consent** (with confirmation dialog).
- **Important:** employees do **not** log in themselves — this page is a manager/admin view of one employee's data.

## 23. Reports and exports

1. **Reports** page (manager+): type filter chips, **Generate Report** (type + optional department/employee + date range), report list with preview, **Download as CSV** / **Download as JSON**; **PDF Report Downloads** card: Dashboard Summary, Activity Log, Audit Log (instant PDFs).
2. **Daily Report** (manager+): pick Today/Yesterday → **Generate** → metrics + (optional) **Generate AI Summary**; **Export** and report history.
3. **Export dialog** (Employees/Activities/Projects pages): CSV or Excel with selectable columns.
4. **Audit Logs** page: filter by action/resource, grouped by day; CSV export (manager+).

## 24. Data retention settings

- **Settings → Monitoring → Data Retention**: per-class retention days (0 = keep forever); enforced by the hourly background job; audit + consent logs are anonymized, never deleted. Validation: whole number 0–3650.

## 25. Common errors quick reference

| Symptom | Cause / fix |
|---|---|
| 401 on login | wrong credentials, or account deactivated |
| 403 on a page action | insufficient role (e.g., viewer trying to manage users) |
| 404 for an employee/device | cross-organization ID (deliberate concealment) |
| Telemetry not appearing | consent not granted, org setting disabled, or device not approved/online |
| "AI provider unavailable" | no key configured, key invalid, provider rate-limited/timeout — app falls back to Data Summary |
| Agent shows "pending" forever | claim not approved in Agent Approvals, or claim expired (30 days) |
| Agent shows "conflict" | another device holds the single active device slot |
