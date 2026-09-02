# OmniSight Agent Integration

This document describes how the OmniSight Web Admin Panel communicates with the OmniSight Desktop Agent (`omnisight-agent`).

## Overview

The Agent is a Windows Electron application that runs on employee devices. It collects activity data, screenshots, location, keyboard telemetry, USB events, and webcam sessions, and sends them to the Web Admin Panel via REST API.

The Admin Panel owns:
- **User/employee management** (CRUD, approval, roles)
- **Device registration and approval** (device claims)
- **Consent management** (policies, state machine, enforcement)
- **Policy configuration** (app whitelist/blacklist)
- **Data storage and display** (PostgreSQL, file storage)
- **Real-time updates** (Socket.io)

The Agent owns:
- **Data collection** (activity, screenshots, location, keyboard, USB)
- **Local processing** (queue management, retry logic)
- **Native APIs** (Windows Location API, screen capture, USB monitoring)
- **Consent enforcement** (checking server consent status before collecting)

## Enrollment Process

### PATH A: Device Claim (Traditional Flow)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Agent Start  │────▶│ POST /agent/ │────▶│  Server:     │
│              │     │   discover    │     │  Create       │
│              │     │              │     │  DeviceClaim  │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │ Admin:        │
                                          │ Approve claim │
                                          │ Assign employee│
                                          └──────┬───────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Agent:      │◀────│ POST /agent/ │◀────│  Server:     │
│  Store token  │     │ authenticate │     │  Create       │
│  Start heartbeat│   │              │     │  AgentToken   │
└──────────────┘     └──────────────┘     └──────────────┘
```

**Step 1: Agent Discovery**
- Agent sends device info to `POST /api/agent/discover`
- Requires a valid `AgentSession` token (from login)
- Server creates a `DeviceClaim` with a hashed claim secret
- Returns the claim ID to the agent

**Step 2: Admin Approval**
- Admin sees the pending claim in **Agent Approvals**
- Admin assigns the claim to an employee
- Server marks the claim as `approved` and creates/updates the `Device`

**Step 3: Agent Authentication**
- Agent sends device credentials to `POST /api/agent/authenticate`
- Server verifies the claim is approved
- Server verifies the claim secret (constant-time comparison)
- Server acquires the active device slot (FOR UPDATE lock)
- Server creates a 24-hour `AgentToken`
- Returns the token to the agent

### PATH B: Agent Login (New Flow)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Admin:       │────▶│ POST /employees│───▶│  Server:     │
│  Create       │     │ /[id]/agent- │     │  Create       │
│  AgentAccount │     │  account     │     │  AgentAccount │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Agent:      │────▶│ POST /agent/ │────▶│  Server:     │
│  Enter        │     │   login      │     │  Verify       │
│  credentials  │     │              │     │  credentials  │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │  Returns      │
                                          │  AgentSession │
                                          │  (short-lived)│
                                          └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │  Agent:       │
                                          │  Discover +   │
                                          │  Authenticate │
                                          └──────────────┘
```

**Step 1: Admin Creates Account**
- Admin creates an `AgentAccount` with `agentId` and `password`
- Employee receives credentials securely

**Step 2: Agent Login**
- Agent sends `agentId` + `password` to `POST /api/agent/login`
- Server verifies credentials (bcrypt)
- Server issues a short-lived `AgentSession`
- Note: This session ONLY authorizes discovery, not data submission

**Step 3: Follow PATH A** for device discovery and authentication

## API Contract

### Agent → Server API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/agent/login` | POST | None (credentials) | Agent login with AgentAccount |
| `/api/agent/discover` | POST | AgentSession | Device discovery |
| `/api/agent/authenticate` | POST | Device credentials | Device authentication |
| `/api/agent/heartbeat` | POST | AgentToken | Periodic heartbeat |
| `/api/agent/activity` | POST | AgentToken | Submit activity data |
| `/api/agent/screenshot` | POST | AgentToken | Upload screenshot |
| `/api/agent/location` | POST | AgentToken | Submit location |
| `/api/agent/keystroke` | POST | AgentToken | Submit keyboard telemetry |
| `/api/agent/usb` | POST | AgentToken | Submit USB events |
| `/api/agent/commands` | POST | AgentToken | Poll for commands |
| `/api/agent/consent` | POST | AgentToken | Check consent status |
| `/api/agent/config` | GET | AgentToken | Get agent configuration |
| `/api/agent/break` | POST | AgentToken | Start/stop break mode |
| `/api/agent/webcam/session` | POST | AgentToken | Start/stop webcam |
| `/api/agent/webcam/frame` | POST | AgentToken | Submit webcam frame |
| `/api/agent/policy-violations` | POST | AgentToken | Report policy violation |
| `/api/agent/logout` | POST | AgentToken | Agent logout |
| `/api/agent/compat` | GET | None | Version compatibility |
| `/api/agent/tamper` | POST | AgentToken | Report tamper detection |

### Server → Agent Command Flow

Commands are polled by the agent (not pushed):

1. Admin issues a command via the API (e.g., `webcam.start`)
2. Command is stored as `AgentCommand` with status `PENDING`
3. Agent polls `POST /api/agent/commands` on heartbeat
4. Agent receives pending commands
5. Agent executes and reports status (`DELIVERED` → `ACKNOWLEDGED`)
6. Command expires if not delivered within the TTL

### Command Types

| Command | Purpose | Payload |
|---------|---------|---------|
| `webcam.start` | Start webcam session | `{ sessionId: "..." }` |
| `webcam.stop` | Stop webcam session | `{ sessionId: "..." }` |

## Authentication Details

### Token Types

| Token Type | Lifetime | Scope | Used For |
|------------|----------|-------|----------|
| `AgentSession` | Short-lived (hours) | Login only | Discovery, logout |
| `AgentToken` | 24 hours | Device-bound | All data submission |

### Token Validation

Every protected endpoint validates:

1. Token exists in `AgentToken` table
2. Token is not expired
3. Employee is `active`
4. Employee is `agentApproved`
5. AgentAccount is `active` (if present)
6. Device is `online` or `offline` (not `inactive`)
7. Organization is `active`
8. Token's organization matches employee's organization

### Single Active Device Rule

One employee may have many registered devices, but only one device may hold a valid active `AgentToken` at a time. This is enforced via:

1. `Employee FOR UPDATE` row lock
2. Valid-token predicate check
3. `409 ACTIVE_DEVICE_EXISTS` response for second device

## Data Submission

### Activity

```json
{
  "activities": [{
    "type": "application",
    "title": "Visual Studio Code",
    "applicationName": "Code",
    "category": "productive",
    "duration": 300,
    "timestamp": "2026-09-02T10:00:00Z"
  }]
}
```

### Screenshot

Multipart form data with image file. Server validates:
- Image format (PNG, JPEG)
- File size limits
- Dimensions

### Location

```json
{
  "latitude": 23.8103,
  "longitude": 90.4125,
  "accuracy": 15.0,
  "recordedAt": "2026-09-02T10:00:00Z",
  "source": "native"
}
```

Location uses a **5 km movement threshold**: fixes below 5 km from the last accepted location are silently discarded.

### Keyboard

```json
{
  "keystrokeCount": 150,
  "activeTypingSeconds": 45,
  "application": "chrome.exe",
  "intervalStart": "2026-09-02T10:00:00Z",
  "intervalEnd": "2026-09-02T10:05:00Z"
}
```

Only aggregate counts are stored — no raw keystrokes.

## Consent Enforcement

The agent checks consent before collecting data:

1. Agent calls `POST /api/agent/consent` with the types it needs to collect
2. Server returns a map of `{ type: boolean }` indicating active consent
3. Agent only collects data for types with `true` consent
4. Server also validates consent on every data submission (defense in depth)

### Consent Types

| Type | Data |
|------|------|
| `monitoring` | Activity tracking |
| `screenshot` | Screenshot capture |
| `activity_tracking` | Website/app tracking |
| `keystroke` | Keyboard telemetry |
| `usb_monitoring` | USB device events |
| `webcam_access` | Webcam sessions |
| `location` | GPS/IP location |
| `email_monitoring` | Email metadata (not implemented in agent) |

## Configuration

The agent receives configuration from `GET /api/agent/config`:

- App whitelist/blacklist policies
- Screenshot frequency settings
- Location tracking enabled/disabled
- Keyboard monitoring enabled/disabled
- USB monitoring enabled/disabled

## Offline Behavior

When the agent cannot reach the server:

1. Data is queued locally
2. Agent retries with exponential backoff
3. On reconnection, queued data is submitted in order
4. Expired queue entries are discarded

## Error Handling

| Error | Agent Behavior |
|-------|---------------|
| `401 Unauthorized` | Re-authenticate |
| `403 Forbidden` | Report to user, stop collecting |
| `409 ACTIVE_DEVICE_EXISTS` | Another device is active; report to user |
| `429 Rate Limited` | Wait and retry |
| `500 Server Error` | Retry with backoff |
| Network error | Queue locally, retry |
