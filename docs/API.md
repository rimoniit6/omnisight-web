# OmniSight API Reference

Base URL: `http://localhost:3000` (development) or your production domain.

All endpoints return JSON. Authentication is via `Authorization: Bearer <token>` header or httpOnly session cookie.

---

## Authentication

### POST /api/auth/login

Authenticate a web user.

**Request:**
```json
{
  "email": "user@company.com",
  "password": "securepassword"
}
```

**Response (200):**
```json
{
  "token": "eyJ...",
  "user": {
    "id": "clx...",
    "name": "John Doe",
    "email": "user@company.com",
    "role": "org_admin",
    "roleLabel": "Organization Admin",
    "initials": "JD",
    "avatar": null,
    "lastLogin": "2026-09-02T10:00:00Z"
  },
  "organization": {
    "id": "clx...",
    "name": "Acme Corp",
    "slug": "acme-corp",
    "status": "active",
    "timezone": "Asia/Dhaka",
    "currency": "USD"
  }
}
```

Sets httpOnly session cookie (`worklens_token`).

**Rate Limits:** Dual-layer — per-email (5 attempts/15 min) + per-IP+email.

### POST /api/auth/logout

Revoke the current session. Requires authentication.

### GET /api/auth/me

Get current user profile and active organization. Requires authentication.

### POST /api/auth/change-password

Change the authenticated user's password. Revokes all other sessions.

### GET /api/auth/sessions

List active sessions for the current user.

### POST /api/auth/refresh-token

Refresh the JWT and extend the session expiry.

### GET /api/auth/users

List users in the current organization. Requires `admin`+ role.

### POST /api/auth/users

Create a new user in the organization. Requires `admin`+ role.

---

## Organization Management

### GET /api/organizations

List all organizations. Requires `super_admin`.

### POST /api/organizations

Create a new organization. Requires `super_admin`.

### GET /api/organizations/[id]

Get organization details. Requires organization membership.

### PUT /api/organizations/[id]

Update organization. Requires `org_admin`+ in that organization.

### GET /api/organization

Get the current organization details.

### PUT /api/organization

Update the current organization. Requires `org_admin`+.

### POST /api/me/organization/switch

Switch active organization. Requires valid membership in the target org.

### GET /api/me/organizations

List organizations the current user belongs to.

---

## Super Admin

### GET /api/super-admin/organizations

List all organizations with details. Requires `super_admin`.

### PUT /api/super-admin/organizations/[id]

Update organization (status, settings). Requires `super_admin`.

---

## Employee Management

### GET /api/employees

List employees in the current organization. Supports pagination, search, filtering.

**Query Parameters:**
- `page` (default: 1)
- `pageSize` (default: 20, max: 200)
- `search` — Search by name, email, employee ID
- `status` — Filter by status (active, inactive, archived)
- `departmentId` — Filter by department

### POST /api/employees

Create a new employee. Requires `org_admin` or `manager` role.

### GET /api/employees/[id]

Get employee details.

### PUT /api/employees/[id]

Update employee. Requires `org_admin` or `manager`.

### DELETE /api/employees/[id]

Delete employee. Requires `org_admin`.

### GET /api/employees/[id]/agent-account

Get the employee's agent account status.

### POST /api/employees/[id]/agent-account

Create or reset the employee's agent account credentials.

### POST /api/employees/[id]/agent-account/reset-password

Reset the agent account password (also activates placeholder accounts).

---

## Device Management

### GET /api/devices

List devices in the current organization. Supports pagination, search, filtering.

### POST /api/devices

Register a device manually. Requires `org_admin`.

### GET /api/devices/[id]

Get device details.

### PUT /api/devices/[id]

Update device. Requires `org_admin`.

### DELETE /api/devices/[id]

Delete/deactivate device. Requires `org_admin`.

### GET /api/devices/chart-data

Get device status chart data for the dashboard.

---

## Device Claims (Agent Enrollment)

### GET /api/device-claims

List pending device claims. Requires `org_admin`.

### POST /api/device-claims/[id]/approve

Approve a device claim and assign to an employee. Requires `org_admin`.

### POST /api/device-claims/[id]/reject

Reject a device claim. Requires `org_admin`.

### POST /api/device-claims/[id]/revoke

Revoke an approved device claim. Requires `org_admin`.

---

## Agent API

### POST /api/agent/login

Agent login using AgentAccount credentials (agentId + password).

**Request:**
```json
{
  "agentId": "EMP001",
  "password": "agent-password"
}
```

**Response (200):**
```json
{
  "success": true,
  "token": "...",
  "expiresAt": "2026-09-02T22:00:00Z",
  "employee": {
    "id": "clx...",
    "employeeId": "EMP001",
    "name": "John Doe"
  }
}
```

### POST /api/agent/discover

Agent device discovery (after login). Creates a DeviceClaim.

**Headers:** `Authorization: Bearer <agent-session-token>`

### POST /api/agent/authenticate

Device credential authentication (PATH A). Issues a 24-hour AgentToken.

**Request:**
```json
{
  "deviceId": "...",
  "deviceSecret": "...",
  "os": "Windows",
  "osVersion": "11",
  "agentVersion": "1.0.0"
}
```

### POST /api/agent/heartbeat

Agent heartbeat. Updates device status and last heartbeat time.

**Headers:** `Authorization: Bearer <agent-token>`

### POST /api/agent/activity

Submit activity data. Requires valid AgentToken and activity consent.

**Headers:** `Authorization: Bearer <agent-token>`

### POST /api/agent/screenshot

Upload a screenshot. Requires valid AgentToken and screenshot consent.

### POST /api/agent/location

Submit location data. Requires valid AgentToken and location consent.

**Request:**
```json
{
  "latitude": 23.8103,
  "longitude": 90.4125,
  "accuracy": 15.0,
  "recordedAt": "2026-09-02T10:00:00Z",
  "source": "native"
}
```

### POST /api/agent/keystroke

Submit keyboard activity (aggregate counts only). Requires valid AgentToken and keystroke consent.

### POST /api/agent/usb

Submit USB device events. Requires valid AgentToken.

### POST /api/agent/commands

Poll for pending commands. Requires valid AgentToken.

### POST /api/agent/consent

Check consent status for multiple consent types. Requires valid AgentToken.

### GET /api/agent/config

Get agent configuration (policies, settings). Requires valid AgentToken.

### POST /api/agent/break

Start/stop break mode. Requires valid AgentToken.

### POST /api/agent/webcam/session

Start/stop webcam session. Requires valid AgentToken.

### POST /api/agent/webcam/frame

Submit webcam frame (WebRTC relay). Requires valid AgentToken.

### POST /api/agent/policy-violations

Submit policy violation report. Requires valid AgentToken.

### POST /api/agent/logout

Agent logout. Invalidates the AgentToken.

### GET /api/agent/compat

Agent compatibility check (version negotiation).

### POST /api/agent/tamper

Report tamper detection. Requires valid AgentToken.

---

## Activity

### GET /api/activities

List activities. Supports pagination, date range, employee, device, category filtering.

### GET /api/activities/website-100

Get website tracking data (100% implementation).

---

## Screenshots

### GET /api/screenshots

List screenshots. Supports pagination, date range, employee filtering.

### GET /api/screenshots/[id]

Get screenshot details.

### GET /api/screenshots/[id]/file

Serve screenshot image file. Requires authentication and org scope.

---

## Projects

### GET /api/projects

List projects. Supports pagination, status, priority filtering.

### POST /api/projects

Create a project. Requires `org_admin` or `manager`.

### GET /api/projects/[id]

Get project details.

### PUT /api/projects/[id]

Update project. Requires `org_admin` or `manager`.

### DELETE /api/projects/[id]

Delete project. Requires `org_admin`.

### GET /api/projects/[id]/members

List project members.

### POST /api/projects/[id]/members

Add member to project. Requires `org_admin` or `manager`.

### DELETE /api/projects/[id]/members/[employeeId]

Remove member from project.

### GET /api/projects/time-entries

List time entries. Supports project, employee, date filtering.

### POST /api/projects/time-entries

Create a manual time entry.

---

## Consent

### GET /api/consent

List consent records. Supports employee, type, status filtering.

### POST /api/consent

Create or update consent. Requires `org_admin`.

### POST /api/consent/bulk

Bulk update consent status. Requires `org_admin`.

### GET /api/consent/policies

List consent policies.

### POST /api/consent/policies

Create a consent policy. Requires `org_admin`.

### PUT /api/consent/policies/[id]

Update a consent policy.

### POST /api/consent/policies/[id]/publish

Publish a consent policy (archives previous version).

### GET /api/consent/summary

Get consent summary statistics.

---

## Policies (App Whitelist/Blacklist)

### GET /api/app-list

List app list entries (whitelist/blacklist).

### POST /api/app-list

Add an app to the whitelist or blacklist. Requires `org_admin`.

### PUT /api/app-list/[id]

Update an app list entry.

### DELETE /api/app-list/[id]

Remove an app from the list.

### GET /api/policy-violations

List policy violations.

---

## Analytics

### GET /api/analytics

Get dashboard analytics data.

### GET /api/analytics/productivity

Get productivity analytics.

---

## Dashboard

### GET /api/dashboard

Get dashboard overview data.

---

## Reports

### GET /api/reports

List generated reports.

### POST /api/reports

Generate a new report. Requires `org_admin` or `manager`.

### GET /api/reports/[id]

Get report details.

### GET /api/export

Export data (PDF, Excel, CSV). Requires `org_admin` or `manager`.

---

## Notifications

### GET /api/notifications

List notifications for the current user.

### PUT /api/notifications/[id]/read

Mark a notification as read.

### PUT /api/notifications/read-all

Mark all notifications as read.

---

## Alerts

### GET /api/alerts

List alerts. Supports status, severity filtering.

### PUT /api/alerts/[id]

Update alert status (acknowledge, resolve).

---

## Audit Logs

### GET /api/audit-logs

List audit logs. Supports action, resource, date filtering.

### GET /api/audit-logs/export

Export audit logs. Requires `org_admin`.

---

## AI Insights

### GET /api/insights

List AI insights.

### GET /api/ai-provider

Get AI provider configuration. Requires `super_admin`.

### PUT /api/ai-provider

Update AI provider configuration. Requires `super_admin`.

---

## Anomalies

### GET /api/anomalies

List detected anomalies. Supports type, severity, status filtering.

### PUT /api/anomalies/[id]

Update anomaly status (investigating, resolved, false positive).

---

## Sentiment

### GET /api/sentiment

Get sentiment records.

---

## Departments

### GET /api/departments

List departments.

### POST /api/departments

Create a department. Requires `org_admin`.

### PUT /api/departments/[id]

Update a department.

### DELETE /api/departments/[id]

Delete a department.

---

## Settings

### GET /api/settings

Get organization settings.

### PUT /api/settings

Update organization settings. Requires `org_admin`.

---

## Branding

### GET /api/branding

Get effective branding for the current organization.

### PUT /api/branding

Update organization branding. Requires `org_admin`.

### GET /api/branding/platform

Get platform-wide branding. Requires `super_admin`.

### PUT /api/branding/platform

Update platform branding. Requires `super_admin`.

---

## Audio

### GET /api/audio

List audio recordings.

### POST /api/audio

Upload an audio file for transcription.

### GET /api/audio/[id]

Get audio recording details and transcription.

### POST /api/audio/[id]/transcribe

Trigger transcription for an uploaded recording.

---

## Upload

### POST /api/upload

General file upload (avatars, logos). Requires authentication.

### POST /api/upload/logo

Upload organization logo. Supports PNG, JPG, SVG.

---

## Health

### GET /api/health

Public health check endpoint. Returns server status, uptime, version, and storage health.

**Response (200):**
```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2026-09-02T10:00:00Z",
  "version": "0.2.1",
  "storage": "ok"
}
```

---

## Search

### GET /api/search

Global search across employees, devices, projects.

---

## Internal

### POST /api/internal/audio/transcription-callback

Internal callback from the transcription microservice.

---

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "message": "Human-readable description"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 400 | Bad Request — invalid input |
| 401 | Unauthorized — no valid session |
| 403 | Forbidden — insufficient permissions |
| 404 | Not Found — resource does not exist |
| 409 | Conflict — concurrent modification or active device conflict |
| 422 | Unprocessable Entity — validation error |
| 429 | Too Many Requests — rate limited |
| 500 | Internal Server Error |

### Rate Limiting

Rate-limited endpoints return `429` with:
```json
{
  "error": "Too many login attempts. Please try again later.",
  "retryAfter": 300
}
```

The `Retry-After` header is also set.

---

## Agent API Authentication

Agent endpoints use Bearer token authentication:

```
Authorization: Bearer <token>
```

Two token types:
1. **AgentSession** (login-only): Short-lived, issued by `/api/agent/login`. Only authorizes `/api/agent/discover` and `/api/agent/logout`.
2. **AgentToken** (device-bound): 24-hour, issued by `/api/agent/authenticate`. Authorizes all agent data submission endpoints (heartbeat, activity, screenshot, location, etc.).
