# OmniSight — Desktop Agent

> Previously branded as **WorkLensAI** — the agent binary, native module (`worklens_capture.node`), native messaging host (`com.worklensai.website`), and user-data folder (`%APPDATA%\worklensai-agent`) keep legacy names.

The Windows desktop agent (`omnisight-agent/`) is the data collector deployed on monitored machines.

Related docs: [INSTALLATION.md](./INSTALLATION.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [API.md](./API.md) §8

---

## 1. Identity & packaging

| Item | Value |
|---|---|
| Product name | OmniSight Agent |
| Package | `omnisight-agent` v1.1.0 (dev 0.1.0) |
| Runtime | Electron 33.4.11 (Chromium-based), CommonJS + TypeScript (strict) |
| Native addon | `worklens_capture.node` — N-API v8, C++17, MSVC v143, Windows SDK 10.0.26100 (source in `omnisight-agent/native/`) |
| User data | pinned to `%APPDATA%\worklensai-agent` (avoids roaming profile issues) |
| Installer | electron-builder NSIS (included only when `WL_UPDATE_URL` is configured); optional native-module check |
| Browser companion | Manifest V3 extension "OmniSight Website Tracker" (`browser-extension/`) + native messaging host `com.worklensai.website` (`worklens-native-host.exe`, `native-host/`) |

## 2. Server configuration (precedence)

- `OMNISIGHT_SERVER_URL` (env) → `WORKLENSAI_SERVER_URL` (env) → `http://localhost:3000` (default).
- `AGENT_SERVER_URL` is baked at build time (electron-builder `extraMetadata`) and wins over runtime env for built installers.
- Zero-touch enrollment: `AGENT_ENROLLMENT_CODE` (build-time) → `WL_ENROLLMENT_CODE` (runtime).
- Update feed: `WL_UPDATE_URL` (HTTPS required). Unset ⇒ auto-update disabled; agent also checks the `agent-update` config flag.

## 3. Lifecycle phases

`unregistered → pending_approval → starting → running → paused → stopped → error` (in `src/main/lifecycle.ts`).

- **Onboarding** (first run, no server): opens the onboarding view to enter the server URL.
- **Login** (Agent Account path): agent ID + password view.
- **Pending**: registration/claim submitted; waits for admin approval (DeviceClaim expires after 30 days; legacy AgentRegistration has no expiry but is non-functional once claimed).
- **Approved** → telemetry begins; status window shows the monitoring view.
- **Rejected / Revoked**: shows the reason, re-registration is blocked server-side (`AgentRegistration` state check in `authenticate`).
- **Conflict**: another device holds the employee's single active device slot (server 409 `ACTIVE_DEVICE_EXISTS`) — only "Try Again".
- **Paused** (privacy mode / break): collectors suspended until resumed.

## 4. Services

| Service | Behavior |
|---|---|
| Orchestrator | Central coordinator (`src/services/orchestrator.ts`) — starts/stops collectors from config, honors lifecycle, errors propagate as `error` phase |
| Heartbeat | `/api/agent/heartbeat` — online presence + server returns canonical break state |
| Consent refresh | `GET /api/agent/consent` every 60 s; cached locally (fail-closed: missing/expired consent ⇒ no capture) |
| Config refresh | `GET /api/agent/config` every 10 min (or on demand); drives collectors; unknown/incompatible fields are ignored |
| Queue uploader | Batch uploads (≤ 100 items), at-least-once delivery, retries with backoff; server dedupes |
| Screenshot spool | Screenshots spooled to disk **encrypted at rest** until uploaded (then removed) |
| Command poller | `POST /api/agent/commands` — pulls device commands (e.g. `webcam.start`) and acks |
| Webcam controller | Local camera control per command + consent; frames → server relay |
| Website bridge | Loopback TCP + token handshake; forwards browser-extension events |
| Native messaging host | Starts on demand in `--native-messaging-host` mode |
| Update service | `WL_UPDATE_URL` feed every 4 h (HTTPS only); auto-update flow |

## 5. Collectors

| Collector | Cadence / Trigger | Notes |
|---|---|---|
| Activity | 10 s tick | foreground window title + executable; idle-detected events; stored on server |
| Screenshot | config interval (min 30 s; off by default) | capture via native addon → JPEG/PNG/WebP; OCR text agent-side; upload ≤ 5 MB |
| Keyboard | 30 s ticks → 1-min aggregates | counts + active seconds only — never keys |
| Location | 5 min | GPS/Win32 fix; coordinates only |
| Webcam | command-driven (`webcam.start`) | live relay only, never stored |
| Website | browser-extension events + 15 s fallback tick | bare domains only |
| USB | 15 s diff | insert/remove events + device descriptors |
| Policy enforcer | 10 s sweep | app whitelist/blacklist (blocked action reporting) |

## 6. Native addon (`native/`)

N-API v8 module compiled from C++17 (MSVC v143, SDK 10.0.26100):

- `foregroundWindow()` — active window title + executable
- `idleSeconds()` — system idle time
- `captureWindow()` — bitmap → JPEG/PNG/WebP
- `keyboardStart/Stop/Reset/Snapshot()` — aggregate counting
- `processList()` / `processTerminate(pid)` — process APIs
- `usbList()` — USB device snapshot
- `locationGetPosition()` — OS location fix
- `cameraEnumerate/Open/Stop/Active/TakeFrame()` — webcam control

**Fail-closed rule:** if `require('worklens_capture')` fails (missing/ABI mismatch), `native = { available: false }` and every dependent collector is disabled — the agent never fabricates data. Build via `omnisight-agent/native/build.ps1` (MSVC vcvars + node-gyp).

## 7. Security model

- All telemetry authenticated with the device-bound `AgentToken` (24 h, SHA-256-hashed at rest); heartbeats renew automatically via `authenticate`.
- Agent never receives other employees' data; tokens are org+device scoped.
- Collectors gate on **config AND consent AND addon capability** before capturing.
- Screenshot spool encrypted at rest; uploads are TLS-encrypted (HTTPS).
- Tray menu has **no Quit** — lifecycle is admin-controlled; single-instance lock prevents duplicates.

## 8. Build & development

- `npm run dev:agent` — dev watch (Windows)
- `npm run build:agent` — TypeScript build
- `npm run package:agent` — electron-builder package (NSIS installer in `omnisight-agent/release/`)
- `npm run test:agent` — agent unit tests (Jest + ts-jest, `omnisight-agent/tests/`)
- Manual smoke: run the agent pointing at a dev server with enrollment configured; watch `%APPDATA%\worklensai-agent` logs.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "native addon not available" | addon missing/ABI mismatch → rebuild via `native/build.ps1` (needs MSVC + SDK 10.0.26100 + node-gyp); collectors will be off |
| Onboarding loops | server URL unreachable — verify `OMNISIGHT_SERVER_URL` / `WORKLENSAI_SERVER_URL` |
| Pending forever | claim not approved (Agent Approvals), or expired after 30 days — create a new registration |
| Conflict | another device holds the slot — revoke the other device (Device Approvals) |
| Revoked / Rejected | admin action; re-registration blocked — contact the admin |
| Update errors | `WL_UPDATE_URL` must be HTTPS; feed unavailable → agent keeps current version |
