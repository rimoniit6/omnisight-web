# OmniSight Desktop Agent — API Contract

This document describes the endpoints the desktop agent consumes. They are the
**existing** `/api/agent/*` routes in the admin app — the agent does not invent
new APIs. Types mirror `omnisight-agent/src/types/api.ts`.

## Enrollment

### `POST /api/agent/register`

Auth: employee credentials (`employeeId` + `agentPassword`) in the body.

```json
{ "employeeId": "emp-1", "password": "...", "hostname": "DESKTOP-X",
  "os": "Windows", "osVersion": "11", "processor": "...", "memory": "...",
  "macAddress": "...", "agentVersion": "1.0.0" }
```

Responses:

| Code | Meaning |
|---|---|
| 201 | `{ success, status: 'pending', registrationId, name }` — admin must approve |
| 201 | `{ success, status: 'already_approved' }` — skip to authenticate |
| 400/401 | invalid credentials/body |

### `POST /api/agent-registrations/[id]/approve` (admin session)

Admin panel action; creates the `Device` and sets `employee.agentApproved`.

### `POST /api/agent/authenticate`

Auth: employee credentials in the body.

Returns:

```json
{ "success": true, "token": "<jwt>", "expiresAt": "<ISO +24h>",
  "deviceId": "dev-1", "employeeId": "emp-1", "name": "John Doe", "message": "ok" }
```

403 responses carry `{ status: 'pending' | 'rejected' }` so the agent can show
the right phase.

## Authenticated endpoints (Bearer token)

The token is attached as `Authorization: Bearer <token>`. It is validated
server-side (expiry, `agentApproved`, device active); expired tokens are
deleted and the agent re-authenticates.

| Endpoint | Method | Body | Consent gate | Notes |
|---|---|---|---|---|
| `/api/agent/heartbeat` | POST | `{}` | no | marks device online; rate ~600/min/token |
| `/api/agent/activity` | POST | `{ activities: [...] }` | `activity_tracking` | max 100/request; `duration` seconds ≤86400 |
| `/api/agent/screenshot` | POST | multipart `screenshot`, `timestamp`, `appWindow` | `screenshot` | image only ≤5MB; stored server-side |
| `/api/agent/consent` | GET | `?types=a,b,c` | — | `{ allGranted, consents: {type: bool}, missing }`, policy-version aware |
| `/api/agent/consent` | POST | `{ consentType, action: 'grant'\|'revoke' }` | — | audited; 409 when no published policy |
| `/api/agent/config` | GET | — | — | intervals, toggles, limits |
| `/api/agent/anomaly` | POST | `{ type, severity, title, description, score, ... }` | — | agent-reported anomaly |
| `/api/agent/tamper` | POST | `{ type, description, ... }` | — | tamper event |
| `/api/agent/break` | POST | `{ breakMode }` | — | idempotent break lifecycle: starts only when not already active, ends the open break, returns `{ breakMode, action, startedAt, endedAt }` |

## Activity record shape

```json
{ "type": "application" | "website" | "idle" | "work_session",
  "title": "agent.ts", "url": null, "applicationName": "Code",
  "category": "productive" | "neutral" | "unproductive" | "idle",
  "duration": 30, "timestamp": "<ISO>" }
```

## Consent response

```json
{ "employeeId": "emp-1", "allGranted": true,
  "consents": { "activity_tracking": true, "screenshot": true },
  "missing": [] }
```

The server resolves policy-version mismatch to `false`, so a v1 consent under a
v2 policy arrives as `false` — the agent treats it exactly like "not granted".

## Error handling

The API client maps: `0 → NETWORK_ERROR`, `TIMEOUT`, `400 → VALIDATION_ERROR`,
`401 → AUTH_ERROR` (triggers re-auth), `403 → FORBIDDEN` (consent or RBAC —
collectors stop), `404 → NOT_FOUND`, `409 → CONFLICT`, `429 → RATE_LIMITED`
(retried), `5xx → HTTP_xxx` (retried with backoff). 4xx other than 429 are
never retried.
