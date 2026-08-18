# OmniSight Desktop Agent — Architecture

## 1. Overview

OmniSight is a single repository containing:

| Component | Path | Tech |
|---|---|---|
| **Admin Web App** (source of truth) | `/` (Next.js 16 + Prisma + SQLite) | existing, untouched |
| **Windows Desktop Agent** (this project) | `omnisight-agent/` | Electron + TypeScript + C++ native addon |

> Note: a legacy .NET agent (`agent/`) was removed in the project cleanup — the
> Electron agent is the single, supported implementation.

The desktop agent is a thin, consent-respecting client of the existing `/api/agent/*`
contract. It never duplicates server logic and never bypasses server-side enforcement.

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  OmniSight Admin (Next.js) │  HTTP  │  omnisight-agent/ (Electron)       │
│  /api/agent/* — source of   │◄──────►│  main ─ services ─ collectors    │
│  truth for consent, policy, │  JSON  │  preload (narrow IPC) ─ renderer │
│  activity, screenshots      │        │  native addon (Win32 capture)    │
└─────────────────────────────┘        └──────────────────────────────────┘
```

## 2. Folder structure

```
omnisight-agent/
├── src/
│   ├── main/                  Electron main process
│   │   ├── main.ts            app lifecycle, BrowserWindow, startup
│   │   └── ipc.ts             narrow IPC contract (validate every input)
│   ├── preload/preload.ts     contextBridge — exposes only typed getState/subscribe
│   ├── renderer/              lightweight employee-facing UI (status only)
│   ├── api/                   typed API client for the /api/agent/* contract
│   │   ├── client.ts          base URL, auth header, timeout, retry, error map
│   │   ├── device.ts          register / authenticate
│   │   ├── activity.ts        activity upload (max 100/request)
│   │   ├── screenshots.ts     multipart screenshot upload
│   │   ├── consent.ts         GET/POST consent state
│   │   ├── config.ts          GET agent configuration
│   │   └── heartbeat.ts       POST heartbeat
│   ├── auth/
│   │   ├── secure-store.ts    safeStorage (DPAPI) encrypted store; test double
│   │   └── auth-service.ts    enroll → pending → authenticate → auto re-auth
│   ├── storage/
│   │   ├── device-identity.ts persistent crypto-random device id + machine binding
│   │   ├── local-settings.ts  agent-owned preferences (e.g. start-with-Windows)
│   │   └── activity-queue.ts  bounded, crash-safe JSONL queue
│   ├── collectors/
│   │   ├── consent-gate.ts    pure fail-closed gate (testable, no I/O)
│   │   ├── native-bridge.ts   typed boundary to the C++ addon
│   │   ├── activity-collector.ts   consent-gated foreground/idle sampler
│   │   └── screenshot-collector.ts consent-gated interval capture → spool
│   ├── services/
│   │   ├── agent-orchestrator.ts lifecycle + wiring
│   │   ├── config-service.ts  server config → local defaults
│   │   ├── consent-service.ts periodic consent refresh
│   │   ├── heartbeat-service.ts
│   │   ├── queue-uploader.ts  drain queue with ack / retry / skip semantics
│   │   └── screenshot-spool.ts secure temp spool → upload → delete
│   ├── scheduler/scheduler.ts central scheduler (no ad-hoc setInterval)
│   └── types/api.ts           mirrors the backend contract (single source)
├── native/                    node-gyp addon (Win32)
│   ├── binding.gyp
│   └── src/                   foreground/idle (Win32 API) + capture (GDI+ PNG)
├── tests/                     node:test suites (run with tsx)
├── scripts/copy-assets.mjs    copies renderer assets into dist/
├── package.json
├── tsconfig.json
└── electron-builder.yml
```

## 3. Security posture (Electron)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Renderer has **no** Node/fs/process access — only the preload bridge.
- IPC is a narrow allow-list (`agent:getState`, `agent:subscribe`) with input
  validation; no `ipcMain.handle('*')`, no `eval`, no remote content.
- Credentials and tokens live only in the main process, encrypted at rest via
  Electron `safeStorage` (Windows DPAPI, machine+user bound). They are never
  logged and never cross the IPC bridge.

## 4. Employee onboarding UX (S)

The first-run experience guides a non-technical employee through device
registration without exposing URLs, tokens, or technical details:

| State | UI | Driver |
|---|---|---|
| First run | "Connect your work device" — Employee ID + agent password + **Register Device** | `agent:enroll` → `POST /api/agent/register` |
| Pending approval | "Waiting for administrator approval" — Employee ID, device, Pending pill, **Check Approval Status** / **Change Account** | `auth.enroll()` stores credentials, orchestrator registers an `approval-poll` scheduler task (20s) |
| Approved | auto-detected by the poll → `authenticate()` → token stored (DPAPI) | `auth.pollApproval()` / `agent:check-approval` |
| Rejected | "Registration was not approved" + **Try Again** | 403 `rejected` maps to `rejected` phase → `cancelEnrollment()` |
| Offline | "Unable to connect to OmniSight" + **Retry** / **Change Account** | network failures classify to `errorKind: 'network'`; `agent:retry-connect` recovers stored credentials or falls back to the form |
| Connected | dashboard with real consent pills, Employee ID, device hostname | renderer-safe status (`getStatusForRenderer`) |

Approval detection is automatic (the 20s `approval-poll` scheduler task stops
once the registration resolves); no application restart is required. A manual
"Check Approval Status" button runs one poll immediately. The consent pills
on the dashboard come from the server snapshot — never fabricated.

## 5. Identity & authentication

- **Device identity**: 32 crypto-random bytes hex-encoded, persisted under the
  user-data dir, survives restart/logout. An HMAC binding (machine key +
  identity) detects an identity file copied to another machine and regenerates.
- **Enrollment**: `POST /api/agent/register` (employeeId + agentPassword) →
  admin approves in the panel (`/api/agent-registrations`) →
  `POST /api/agent/authenticate` returns a 24h bearer token.
- **Auto re-auth**: the agent stores the employee agent-password encrypted and
  re-authenticates transparently after token expiry (401 handler → `recover()`).
  No admin credentials, no hardcoded secrets.
- **Start with Windows**: an explicit, user-visible setting (default **off** —
  never silently forced). Stored in `local-settings.json` under the user-data
  dir and applied immediately via `app.setLoginItemSettings({ openAtLogin })`
  when toggled (`agent:get-settings` / `agent:set-auto-start` IPC).

## 6. Consent enforcement (critical)

The server is the final authority; the agent's local gate is an optimization.

```
consent refresh (GET /api/agent/consent, policy-version aware)
   → snapshot {type: granted}
   → decideConsentGate(): enabled && fresh(≤5min) && granted → collect, else stop
   → collector starts/stops immediately (no restart needed)
```

The server still returns 403 for any upload without active, current-policy
consent — the agent never bypasses that.

## 7. Activity & screenshot pipelines

```
Activity:  Win32 foreground/idle sampler → normalize → queue (JSONL, bounded)
           → consent gate → upload (≤100/batch) → ack on 2xx

Screenshot: interval capture (GDI+ PNG) → secure temp spool → consent gate
            → multipart upload → delete spool file on success
```

Offline behavior: the queue persists; uploads retry with exponential backoff;
the queue is byte-bounded (oldest dropped first); permanent 4xx batches are
skipped (never wedge the queue); 5xx/network failures stay queued.

## 8. Scheduler

All periodic work — heartbeat (default 60s), activity drain, screenshot
capture, consent refresh, config refresh — is registered on one `Scheduler`
instead of scattered `setInterval`s. Jobs are non-overlapping where required,
errors are captured (never crash the agent), and `stopAll()` runs on shutdown.

Intervals are **server-driven and dynamic**: the heartbeat and screenshot
cadences come from `GET /api/agent/config` and are re-applied after every
config refresh (re-registering a job replaces its timer), so a config change
on the server takes effect without an agent restart. Values are clamped
(heartbeat ≥ 10s, screenshot ≥ 30s) to prevent tight loops from bad config.

**Org-scoped configuration** (R1): the heartbeat interval is stored in
`OrganizationSetting` (`heartbeat_interval`, default 60s, validated
10–600) and administered by admins via `GET/PUT /api/settings/monitoring`
(audited, tenant-scoped, strict whole-number validation → 422 on invalid).
`GET /api/agent/config` resolves and clamps it server-side, so the agent only
sees a valid cadence. The Settings → Monitoring admin card is the UI.

**Auto-update** (R8): an integration boundary (`services/update-service.ts`)
uses electron-updater against an HTTPS generic feed from `WL_UPDATE_URL`.
With no feed configured the update path is a no-op — the agent never
downloads or executes anything unsigned. Signed-release infrastructure
(certificate + static feed) remains an external deployment dependency.

## 9. Lifecycle

```
install → device identity → register → pending (poll auth) → authenticated
→ sync config + consent → start permitted collectors → run (heartbeat, queue,
screenshots) → pause/resume on consent or connectivity → stop (flush queue,
clear timers, close storage) → update (electron-builder, signed releases)
```
