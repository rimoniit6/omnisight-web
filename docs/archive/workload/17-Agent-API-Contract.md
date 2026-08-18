# WorkLensAI — Agent ↔ Server Communication Protocol (API Contract)

> **File:** workload/17-Agent-API-Contract.md · **Version:** 1.0 · **Status:** Approved for implementation
> **Authors:** Architecture (2026-08-02) · **Reads:** ADR-002 (C#/.NET agent), ADR-004 (BYOK), ADR-005 (auth), ADR-006 (local storage), ADR-007 (batched HTTPS JSON), ADR-011…017 (this contract)
> **Contract goal:** a developer can build the Windows Agent **and** the server-side ingestion stack using ONLY this document.

---

## 0. Scope & Principles

- Single-tenant, self-hosted product (ADR-001). One `Installation` per deployed server.
- Transport: **HTTPS only** (server refuses plain HTTP for `/api/agent/*` in production; `http://localhost` allowed for dev).
- Payload: JSON (UTF-8), **gzip** `Content-Encoding` mandatory for bodies > 8 KB (agent sends gzip when batch > 8 KB; server accepts both).
- All agent endpoints are under the versioned prefix: **`/api/agent/v1/`**.
- The existing web middleware (`src/middleware.ts`) must whitelist `/api/agent/v1/*` as **agent-auth** (not web-JWT). Agent endpoints authenticate via the Agent-Token scheme in §2 — **never** the `X-API-Key`/`X-Agent-Token` passthrough (that bypass is removed per BL-001).
- Design is forward-compatible: additive-only within `v1`; enterprise capabilities negotiated via `capabilities[]`.

**Flow → Endpoint map (all 18 flows covered):**

| # | Flow | Endpoint |
|---|---|---|
| 1 | Agent Registration | E1 `POST /api/agent/v1/register` |
| 2 | Device Activation | E2 `POST /api/agent/v1/activate` |
| 3 | Heartbeat | E3 `POST /api/agent/v1/heartbeat` |
| 4 | Policy Sync | E4 `GET /api/agent/v1/policy` |
| 5–8 | Activity / App / Website / Idle Upload | E5 `POST /api/agent/v1/activity` (typed event kinds) |
| 9 | Screenshot Upload | E6 `POST/PUT /api/agent/v1/screenshots[/{uploadId}/chunks/{n}]` |
| 10 | Health Report | E7 `POST /api/agent/v1/health` |
| 11 | Version Check | E8 `GET /api/agent/v1/version` |
| 12 | Auto Update | E9 `GET /api/agent/v1/update` + `GET /api/agent/v1/update/download/{version}` |
| 13 | Log Upload | E10 `POST /api/agent/v1/logs` |
| 14 | Error Report | E11 `POST /api/agent/v1/errors` |
| 15 | Command Execution | E12 `POST /api/agent/v1/commands` (polled via E3, acked here) |
| 16 | Agent Configuration Sync | E13 `GET /api/agent/v1/config` |
| 17 | Shutdown | E14 `POST /api/agent/v1/shutdown` |
| 18 | Uninstall | E15 `POST /api/agent/v1/uninstall` |
| — | Token Rotation | E16 `POST /api/agent/v1/token/rotate` |

---

## 1. Identity Model

| Term | Definition | Where it lives |
|---|---|---|
| **Installation ID** (`installationId`) | Stable ID of one self-hosted deployment. Generated at setup; embedded in agent installer config (or entered at agent install). Binds every device to the org. | Server: `Installation` table. Agent: local config (DPAPI-protected). |
| **Join Key** (`joinKey`) | Install-time secret that authorizes a machine to join. Shown once in Admin → Devices → "Add device"; can be rotated. Hash stored server-side. | Server: `Installation.joinKeyHash`. Agent: installer arg / setup UI, never persisted. |
| **Device ID** (`deviceId`) | Server-issued cuid identifying this machine's agent install. | Server: `Device.id`. Agent: local config. |
| **Agent Token** (`agentToken`) | Opaque 256-bit random (base64url, 43 chars). Issued once at registration; **returned to the agent exactly once**. Server stores only `SHA-256(agentToken)`. | Server: `AgentCredential.tokenHash`. Agent: DPAPI-protected file. |
| **Organization ID** (`organizationId`) | Legacy org scoping (single tenant). Agent never needs it directly; server derives it from `installationId`. Kept for schema compatibility. | Server: `Device.organizationId`. |
| **Web JWT / API Key** | Admin-session auth (JWT) and future scoped API keys are **web-identity**, never agent identity. Agent endpoints never accept web JWTs. | Existing `wl_session` / future `ApiKey`. |

**Token lifecycle:** register → issue → rotate (E16) → revoke (admin action: suspend/retire device) → uninstall (E15) → purge.

---

## 2. Authentication & Request Signing

### 2.1 Scheme (all endpoints except E1/E8 anonymous-lean)

Every agent request carries:

```
Authorization: Bearer <agentToken>
X-Installation-ID: <installationId>
X-Device-ID: <deviceId>
X-Agent-Version: 0.1.0            # semver of agent build
X-Timestamp: 1785678846000        # unix ms, client clock
X-Nonce: <128-bit random base64url>
X-Agent-Signature: <base64url HMAC-SHA256>
Content-Type: application/json; charset=utf-8
Content-Encoding: gzip            # when body > 8 KB
X-Request-ID: <uuid>              # idempotency + tracing
```

### 2.2 Signature

```
canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256hex(rawBody)
signature = base64url( HMAC_SHA256( key = agentToken, message = canonical ) )
```

- `PATH` = path **including** query string, e.g. `/api/agent/v1/policy?format=v1`.
- Body bytes used for `sha256hex` are the **pre-gzip** bytes; the server re-hashes the decompressed body (or the exact bytes when identity `Content-Encoding`).
- Server recomputes and compares with constant-time comparison.

### 2.3 Replay protection

- **Timestamp window:** server accepts `|X-Timestamp − serverNow| ≤ 300 s` (configurable `AGENT_CLOCK_TOLERANCE_MS`). Outside → `429 AGENT_CLOCK_SKEW` + `X-Server-Time` header.
- **Nonce cache:** each (deviceId, nonce) accepted once; cached for `10 min` (in-memory LRU; Postgres table `AgentNonce` when multi-instance). Replay → `409 AGENT_REPLAY`.

### 2.4 Clock drift handling

- Every response includes `X-Server-Time` (unix ms).
- Agent maintains `clockOffset = serverTime − clientTime` (EWMA, updated on every heartbeat).
- If `|offset| > 300 s` on a signed request → `429 AGENT_CLOCK_SKEW`; agent must resync (call E3 heartbeat with `resync: true` — heartbeat is signed with a *tolerant* window of 600 s to allow bootstrap), then retry.
- Registration (E1) includes `clientTime` so the server returns initial skew info.

### 2.5 Token rotation (E16)

- Agent calls E16 signed with the **current** token.
- Server returns `{ agentToken: <new>, expiresAt }`; old token stays valid for **60 s** grace (in-flight requests), then revoked.
- Server stores `AgentCredential` rows: `tokenHash`, `prevTokenHash`, `issuedAt`, `rotatedAt`, `revokedAt`, `revokeReason`.
- Rotation required: server policy `maxTokenAgeDays` (default 180); agent rotates proactively when `X-Token-Expires` within 30 days.
- `401 AGENT_TOKEN_EXPIRED` → agent calls E16 once; if that fails → re-register flow (device re-enroll with join key).

### 2.6 Authentication failure semantics

| Code | Meaning | Agent action |
|---|---|---|
| `401 AGENT_UNAUTHORIZED` | bad token/signature | retry ≤ 2, then re-register |
| `401 AGENT_TOKEN_EXPIRED` | token revoked/expired | rotate, then retry once |
| `403 AGENT_DEVICE_REVOKED` | admin revoked/suspended device | stop sending; show "device suspended" |
| `403 AGENT_DEVICE_PENDING` | registered but not activated | poll E3 at 5 min interval (no data) |
| `426 AGENT_UPGRADE_REQUIRED` | agent below `minAgentVersion` | fetch E9 manifest, auto-update |

---

## 3. Common Conventions

**Error body (always):**
```json
{ "error": { "code": "AGENT_VALIDATION", "message": "human readable", "retryAfter": 5, "details": {} } }
```

**Success:** `200/201/202/204` with `X-Server-Time` and `X-Token-Expires` (when < 30 d) headers.

**Rate limits (per device, server-enforced):**

| Endpoint | Limit | Burst |
|---|---|---|
| E1 register | 5 / min / IP | — |
| E3 heartbeat | 1 / 15 s | 1 / 5 s |
| E5 activity | 1 / 2 s | 4 |
| E6 screenshots | 2 MB/s aggregate | — |
| E7 health | 1 / 60 s | — |
| E10 logs | 1 / 30 s | 2 |
| E11 errors | 1 / 10 s | 3 |
| E16 rotate | 1 / min | — |

`429 AGENT_RATE_LIMITED` + `Retry-After`.

**Retry policy (agent-side, all endpoints):** exponential backoff `base 2 s, ×2, max 10 min`, jitter ±20 %; honor `Retry-After`; retries are idempotent via `X-Request-ID` / `batchId` / `clientSeq`.

**Offline behavior:** local SQLite queue (disk, cap `AGENT_QUEUE_MAX_BYTES` default 500 MB; oldest dropped with a warning event); resume by server `highWaterMark`; no data loss under normal operation.

---

## 4. Endpoint Specifications

### E1 — Agent Registration  `POST /api/agent/v1/register`

- **Purpose:** a machine joins the installation; server creates the Device and issues the Agent Token. (Flow 1)
- **Auth:** anonymous + `joinKey` + `installationId` (body). No signature (no token yet).
- **Headers:** `Content-Type`, `X-Agent-Version`, `X-Request-ID`, `clientTime` in body.
- **Body:**
```json
{
  "installationId": "inst_abc123",
  "joinKey": "JK-xxxx",
  "clientTime": 1785678846000,
  "hostname": "WS-ACME-001",
  "os": { "family": "Windows", "version": "11", "build": "22631", "arch": "x64" },
  "hardware": { "cpu": "Intel i7-13700K", "ramGB": 32, "diskGB": 512, "mac": "AA:BB:..", "serial": "SN.." },
  "agentVersion": "0.1.0",
  "capabilities": ["activity", "screenshots", "health", "logs", "errors", "commands"]
}
```
- **Response 201:**
```json
{
  "deviceId": "cms...", "agentToken": "eyJ...base64url", "tokenExpiresAt": "2027-01-01T00:00:00Z",
  "serverTime": 1785678846000, "heartbeatIntervalMs": 30000, "minAgentVersion": "0.1.0",
  "policyVersion": 1, "configVersion": 1, "status": "pending"
}
```
- **Validation:** `installationId` exists; `joinKey` hash matches; `hostname` ≤ 128 chars; `agentVersion` semver; `capabilities` ⊆ whitelist. Duplicate hardware fingerprint within 24 h of a retired device → `409 AGENT_REENROLL_REQUIRED` (admin must approve re-enroll).
- **Retry:** backoff; `429` join-key rate limit; idempotent via fingerprint+`X-Request-ID` (server upserts).
- **Offline:** n/a (requires network); installer shows "cannot reach server" with URL guidance.
- **Security:** joinKey is the only secret; hash at rest; never logged.

### E2 — Device Activation  `POST /api/agent/v1/activate`

- **Purpose:** after an admin approves/assigns the device to an employee, the agent binds its user context. (Flow 2)
- **Auth:** Agent Token + signature (full scheme).
- **Body:** `{ "clientTime": 1785678846000 }` (device context is server-authoritative).
- **Response 200:**
```json
{ "status": "active", "userId": "cms..", "userName": "Aria Martin", "organizationId": "cms..",
  "telemetryPolicyVersion": 1, "configVersion": 1 }
```
- **Validation:** device must exist + be `pending`/`active`; admin assignment is server-side (Admin UI → Devices → Assign).
- **Retry/offline:** repeat on next heartbeat until `status: active`; agent does **not** upload activity while `pending`.
- **Security:** user binding only via server; agent never supplies `userId` (anti-spoof).

### E3 — Heartbeat  `POST /api/agent/v1/heartbeat`

- **Purpose:** liveness + server→agent control channel (commands, flags). (Flow 3)
- **Auth:** full scheme. **Headers:** as §2.1.
- **Body:**
```json
{ "clientTime": 1785678846000, "uptimeS": 86400, "status": "online",
  "queueDepth": 12, "lastAckedSeq": 1042, "lastScreenshotId": "sc_..",
  "pending": { "activity": true, "screenshots": 2, "logs": 0, "errors": 0 },
  "device": { "cpuPct": 4, "ramPct": 31, "diskFreeGB": 210, "batteryPct": 87, "network": "ethernet" } }
```
- **Response 200:**
```json
{ "serverTime": 1785678846000, "heartbeatIntervalMs": 30000,
  "policyVersion": 1, "configVersion": 1, "updateAvailable": false, "updateVersion": null,
  "commands": [ { "id": "cmd_..", "type": "sync-now", "payload": {} } ],
  "flags": { "forceActivitySync": false, "forcePolicyFetch": false, "suspended": false } }
```
- **Validation:** token valid; body ≤ 8 KB.
- **Retry/offline:** 1/15 s while online, 1/60 s while offline; server updates `Device.lastSeen`, marks `Offline` after 3 missed beats (`AGENT_HEARTBEAT_MISS_MS`).
- **Rate limit:** 1/15 s. **Security:** heartbeat carries no data beyond device state; signed to prevent spoofed "online" state.

### E4 — Policy Sync  `GET /api/agent/v1/policy`

- **Purpose:** fetch telemetry policy (capture rules). (Flow 4)
- **Auth:** full scheme (GET signed too).
- **Query:** `?version=<policyVersion>`; **Response 200** (only when version newer):
```json
{ "version": 2, "capture": { "screenshotIntervalSec": 60, "screenshotEnabled": true,
    "screenshotQuality": 80, "blurSensitive": true, "screenshotMaxKB": 512 },
  "idle": { "thresholdSec": 180, "reportIntervalSec": 30 },
  "activity": { "batchMaxEvents": 250, "flushIntervalSec": 20, "includeUrls": true },
  "categories": { "Productive": ["vscode","github",".*jetbrains.*"], "Neutral": [...], "Distracting": ["facebook.com","youtube.com"] },
  "privacy": { "privateApps": ["password manager"], "privateDomains": ["bank.*"], "privateTimeEnabled": true },
  "retention": { "activityDays": 365, "screenshotDays": 90 } }
```
- **Validation:** none beyond auth; policy is server-authored.
- **Retry/offline:** agent caches last policy; re-fetch on `policyVersion` change (from heartbeat).
- **Security:** signed + TLS; contains **no employee data**, only rules.

### E5 — Activity Upload  `POST /api/agent/v1/activity`  *(flows 5, 6, 7, 8)*

- **Purpose:** batched telemetry for app usage, website usage, idle, and session events. One endpoint, typed events (additive kinds for future).
- **Auth:** full scheme.
- **Body:**
```json
{ "batchId": "b_9f2c..", "clientTimeStart": 1785678800000, "clientTimeEnd": 1785678846000,
  "events": [
    { "seq": 1043, "ts": 1785678810000, "kind": "app",
      "app": { "name": "Code.exe", "windowTitle": "schema.prisma — WorkLensAI", "processName": "Code",
                "categoryHint": null, "durationSec": 120, "focusSec": 118, "version": "1.86.0" } },
    { "seq": 1044, "ts": 1785678820000, "kind": "website",
      "web": { "url": "https://developer.mozilla.org/...", "domain": "developer.mozilla.org", "browser": "Chrome",
                "title": "MDN Web Docs", "durationSec": 60, "focusSec": 55 } },
    { "seq": 1045, "ts": 1785678840000, "kind": "idle", "idle": { "durationSec": 300, "reason": "no-input" } },
    { "seq": 1046, "ts": 1785678700000, "kind": "session", "session": { "action": "login" } }
  ] }
```
- **Response 202:**
```json
{ "batchId": "b_9f2c..", "accepted": 4, "duplicates": 0, "rejected": [],
  "highWaterMark": 1046, "serverTime": 1785678847000 }
```
  `rejected[]` = `{ seq, code: "AGENT_VALIDATION", message, details }` — agent **drops** rejected events (they were produced by a buggy build; re-sending loops forever).
- **Validation:** max 500 events / 1 MB (gzip); `seq` monotonic per device; event `ts` within `±24 h` of server time (else `AGENT_CLOCK_SKEW` per event, not whole batch); URLs/domains length-capped; PII field caps.
- **Idempotency / conflict handling:** unique index `(deviceId, seq)`. Server `createMany(skipDuplicates: true)`; `seq ≤ highWaterMark` → counted `duplicates`, not an error. Server timestamps authoritative: activity stored with **both** `timestamp` (event ts, clamped) and `createdAt` (ingest time).
- **Batch size:** default 250 events (agent flushes at 250 or every 20 s), enterprise config up to 1000.
- **Compression:** gzip mandatory > 8 KB.
- **Retry:** batch-level; resume from `highWaterMark`; backoff on 429/503.
- **Offline queue:** local SQLite; `seq` assigned at enqueue; persist until acked.
- **Rate limit:** 1 req / 2 s, 4 burst.
- **Security:** signed; per-device scoping enforced server-side (`deviceId` from header must own events — never from body).

**Event kind → storage mapping:** `app`/`website`/`idle` → `ActivityLog` (existing model fits: `type`, `title`, `url`, `domain`, `browser`, `duration`, `focusTime`, `category`, `productive`). `session` → `LoginSession` (login/logout/lock/unlock).

### E6 — Screenshot Upload  `POST/PUT /api/agent/v1/screenshots`  *(flow 9 — details in §5)*

### E7 — Health Report  `POST /api/agent/v1/health`

- **Purpose:** detailed machine/agent health (OS patches, disk, AV status, agent thread stats). (Flow 10)
- **Auth:** full scheme.
- **Body:** `{ "clientTime": .., "os": { "version": .., "build": .., "patches": ["KB5034441"] }, "disk": { "totalGB": 512, "freeGB": 210 }, "ram": { "totalGB": 32, "freeGB": 21 }, "cpu": { "cores": 16, "loadPct": 7 }, "av": { "name": "Defender", "enabled": true }, "agent": { "threads": 9, "memMB": 42, "uptimeS": 86400, "lastGcMs": 12 }, "network": { "ssid": "HQ-5G", "ip": "10.0.1.12" } }`
- **Response 200:** `{ "serverTime": .., "accepted": true, "warnings": ["AV disabled"] }` (server may compute risk flags).
- **Validation:** ≤ 16 KB; optional fields tolerated.
- **Rate limit:** 1/60 s. **Retry:** drop on failure (next cycle covers it). **Security:** signed; contains host info — treat as sensitive.

### E8 — Version Check  `GET /api/agent/v1/version`

- **Purpose:** determine current/latest/minimum versions + update availability. (Flow 11)
- **Auth:** full scheme (GET signed) — light cache server-side (60 s).
- **Response 200:**
```json
{ "serverVersion": "0.3.0", "agent": { "current": "0.1.0", "latest": "0.2.0", "min": "0.1.0",
  "updateAvailable": true, "channel": "stable", "critical": false },
  "changelogUrl": "/api/agent/v1/update?from=0.1.0" }
```
- **Validation:** none. **Retry:** 1 h cadence or on heartbeat flag.

### E9 — Auto Update  `GET /api/agent/v1/update` + `GET /api/agent/v1/update/download/{version}`

- **Purpose:** fetch update manifest, download signed package. (Flow 12)
- **Auth:** full scheme. Manifest:
```json
{ "version": "0.2.0", "channel": "stable", "critical": false, "size": 64123456,
  "sha256": "ab12..", "signature": "<base64 Ed25519>", "url": "/api/agent/v1/update/download/0.2.0",
  "releaseNotes": "…", "minServerVersion": "0.3.0" }
```
- **Download endpoint:** serves the installer/zip; agent verifies `sha256` (MVP) and `signature` (Ed25519, enterprise) before executing.
- **Validation:** version semver; `minServerVersion` ≤ server version; signature check mandatory in production from agent v0.2.
- **Retry:** resumable download (Range); backoff; update staged, verified, then swap with rollback marker.
- **Security:** signed manifests prevent MITM/compromise of the update path; updates only from the buyer's server.

### E10 — Log Upload  `POST /api/agent/v1/logs`

- **Purpose:** agent diagnostics. (Flow 13)
- **Auth:** full scheme. **Body:** `{ "clientTime": .., "lines": [ { "ts": .., "level": "info", "scope": "tracker", "msg": "…" } ] }`
- **Response 202.** **Validation:** ≤ 256 lines, ≤ 64 KB, `msg` ≤ 4 KB, no secrets (agent redacts paths/emails).
- **Retention:** 30 days. **Rate limit:** 1/30 s. **Offline:** queue, low priority.

### E11 — Error Report  `POST /api/agent/v1/errors`

- **Purpose:** crash/exception telemetry (opt-in per installation). (Flow 14)
- **Auth:** full scheme. **Body:** `{ "clientTime": .., "error": { "code": "E_QUEUE_CORRUPT", "message": "…", "stack": "…", "fingerprint": "sha256(minified)" }, "context": { "agentVersion": "0.1.0", "uptimeS": .. } }`
- **Response 202.** **Validation:** ≤ 32 KB; fingerprint dedup (`AgentError` unique fingerprint within 24 h).
- **Retention:** 90 days. **Security:** never contains user activity; stack paths scrubbed.

### E12 — Command Execution  `POST /api/agent/v1/commands`

- **Purpose:** acknowledge + report results of server-issued commands (delivered in heartbeat `commands[]`). (Flow 15)
- **Auth:** full scheme.
- **Body:**
```json
{ "results": [ { "id": "cmd_..", "status": "ok" | "failed" | "ignored",
  "output": "…", "completedAt": 1785678846000 } ] }
```
- **Command vocabulary (v1):** `sync-now`, `fetch-policy`, `rotate-token`, `update`, `restart-agent`, `enable-private-mode`, `disable-tracking`, `shutdown`, `uninstall`, `wipe-local-queue`.
- **Response 200.** **Validation:** command IDs must be outstanding for this device; statuses valid.
- **Security:** commands are server-authored; agent executes only whitelisted types; destructive commands require `confirmToken` echoed from the admin action.
- **Rate limit:** 1/5 s. **Retry/offline:** results queue until delivered.

### E13 — Agent Configuration Sync  `GET /api/agent/v1/config`

- **Purpose:** agent *runtime* config (distinct from telemetry *policy*): server URL, intervals, feature flags, storage paths, log verbosity. (Flow 16)
- **Auth:** full scheme. **Query:** `?version=<configVersion>`.
- **Response 200:**
```json
{ "version": 3, "server": { "baseUrl": "https://lens.example.com", "heartbeatMs": 30000 },
  "agent": { "logLevel": "info", "queueMaxBytes": 524288000, "uploadConcurrency": 2,
             "clockToleranceMs": 300000 }, "features": { "screenshots": true, "video": false } }
```
- **Validation:** server URL https; intervals within sane bounds.
- **Retry/offline:** cache; re-fetch on `configVersion` change.

### E14 — Shutdown  `POST /api/agent/v1/shutdown`

- **Purpose:** graceful shutdown notification (OS shutdown / user exit / admin). (Flow 17)
- **Auth:** full scheme. **Body:** `{ "reason": "os-shutdown"|"user-exit"|"service-stop"|"update", "uptimeS": .., "flushQueue": true }`
- **Response 204.** Server marks device `Offline` immediately, closes `LoginSession` if open (session `action: logout`).
- **Validation:** reason enum. **Rate limit:** 1/5 min. **Retry:** best-effort, no backoff (process is stopping); `flushQueue: true` triggers a final activity flush first.

### E15 — Uninstall  `POST /api/agent/v1/uninstall`

- **Purpose:** intentional uninstall report; server retires the device + revokes token. (Flow 18)
- **Auth:** full scheme. **Body:** `{ "reason": "admin"|"user"|"replacement", "confirmToken": "…" }`
- **Response 204** (`X-Device-Retired: true`). Device → `status: Retired`, token revoked, device unbound from user.
- **Validation:** `confirmToken` required for `reason: user` (echoed from admin UI) — prevents a user silently uninstalling.
- **Security:** uninstall-protection policy (ADR/P2 feature) can refuse to run without admin token.

### E16 — Token Rotation  `POST /api/agent/v1/token/rotate`

- **Purpose:** rotate the agent token (scheduled or on expiry). See §2.5.
- **Auth:** full scheme with **current** token.
- **Body:** `{ "reason": "scheduled"|"expiring"|"compromised" }`
- **Response 200:** `{ "agentToken": "<new>", "tokenExpiresAt": "…", "oldTokenGraceMs": 60000 }`
- **Rate limit:** 1/min. **Offline:** defer until online; token expiry checked against `X-Token-Expires` at each response.

---

## 5. Screenshot Upload Design (E6)

### 5.1 Flow (two-step, chunked, resumable; single-shot fast path)

1. **Initiate** — `POST /api/agent/v1/screenshots`
   ```json
   { "ts": 1785678830000, "sha256": "ab12..", "size": 482013, "format": "webp",
     "width": 1920, "height": 1080, "multiMonitor": false, "monitorId": 0,
     "privacyMode": false, "blurSensitive": true, "appContext": { "name": "Word.exe", "title": "…" },
     "sessionId": null, "flags": { "screenLocked": false, "idleAtCapture": false } }
   ```
   → **201:** `{ "uploadId": "up_..", "chunkSize": 524288, "chunks": 1, "expiresAt": "+10 min", "duplicate": false }`
   - Server checks content-addressable dedup: if `sha256` exists within retention → `201 { "duplicate": true, "existingId": "sc_.." }`, agent skips upload.
2. **Upload chunks** — `PUT /api/agent/v1/screenshots/{uploadId}/chunks/{index}` with `Content-Type: application/octet-stream`, header `Content-Range: bytes start-end/total`. → `200 { "received": true, "nextIndex": 1 }` (or `409` wrong size).
3. **Complete (implicit)** — when all chunks received (or single-shot `POST /api/agent/v1/screenshots?mode=single` with full body when `size ≤ chunkSize`), server verifies `sha256` → **201** `{ "screenshotId": "sc_..", "duplicate": false, "stored": true }`.

### 5.2 Storage strategy

- Files on server local disk under `STORAGE_PATH` (ADR-006): `{STORAGE_PATH}/{yyyy}/{mm}/{dd}/{screenshotId}.webp`, **outside the web root**; served only via authenticated admin API (JWT + role) with `Cache-Control` + conditional headers.
- Metadata row in `Screenshot` (existing model + new `sha256`, `storagePath`, `size`, `uploadId`).
- Phase 3: S3-compatible adapter behind a `StorageBackend` interface (local/minio/s3) — no contract change.

### 5.3 Compression

- Format: **WebP** (quality from policy, default 80; 60–85 range), PNG fallback; agent downscales to max 1920 px wide when source larger; DPI-aware capture.
- JSON metadata gzip; binary chunks as-is (WebP is already compressed).

### 5.4 Chunking & size

- `chunkSize` default 512 KB (configurable); single-shot path when `size ≤ chunkSize`.
- **Max screenshot size:** 10 MB (server `413 AGENT_PAYLOAD_TOO_LARGE` beyond; policy `screenshotMaxKB` typically 512 KB).
- Resumable: agent tracks uploaded chunk bitmap; `PUT` retries missed chunks; ticket expires 10 min → re-initiate.

### 5.5 Retry & dedup

- Retry: chunk-level with backoff; batch-level via `uploadId`; idempotent.
- Dedup: global content-addressable by `sha256` within retention window (identical screenshots stored once — the docs' dedup goal); also per-device `flags.idleAtCapture` can suppress capture entirely when screen locked.
- GC: orphaned tickets/chunks purged hourly; unreferenced files removed after ticket expiry.

### 5.6 Privacy mode

- `privacyMode: true` → server stores **metadata only** (no bytes) OR stores blurred copy; configured by policy `privacy.privateApps/privateDomains` + per-device `privateTimeEnabled`.
- `blurSensitive: true` (default) → viewer applies client-side blur overlay until admin "reveals".
- Screenshots never uploaded while `screenLocked` or during `privateTime` (policy-driven).

---

## 6. Activity Upload Design (E5) — summary

| Aspect | Decision |
|---|---|
| Batch size | 250 events default (max 500), flush every 20 s or at capacity |
| Compression | gzip > 8 KB (mandatory server-side decode support) |
| Offline queue | local SQLite, monotonic `seq`, cap 500 MB, oldest-drop + alert |
| Retry | batch-level, exponential backoff, resume from `highWaterMark` |
| Conflict | unique `(deviceId, seq)`; `skipDuplicates`; `rejected[]` dropped; server time authoritative via `createdAt` |
| Bandwidth | per-device 10 MB/min ceiling; screenshot interval caps protect |

---

## 7. Database Impact

### 7.1 Existing tables (reusable, with additions)

| Table | Reuse | Required changes |
|---|---|---|
| `Device` | fleet state | +`installationId`, +`lastHeartbeatAt`, +`lastErrorAt`, +`status` enum extension (`pending/active/suspended/retired`), +`hardwareFingerprint`, +`joinApprovedAt`, +`highWaterMark` (or separate) |
| `ActivityLog` | app/website/idle events | **fits as-is** (`type/title/url/domain/browser/duration/focusTime/category/productive/timestamp`) |
| `LoginSession` | session events | fits as-is |
| `Screenshot` | metadata | +`sha256`, +`storagePath`, +`size`, +`uploadId`, +`privacyMode`, +`deviceId` already present |
| `User` | employee binding | +`deviceId` already present |
| `Alert` | server-generated alerts | no change |

### 7.2 New tables required

| Table | Purpose | Key columns |
|---|---|---|
| `Installation` | deployment identity + join key | `id, joinKeyHash, name, settings(json), minAgentVersion, createdAt` |
| `AgentCredential` | token lifecycle (rotation/revocation) | `id, deviceId, tokenHash, prevTokenHash, issuedAt, expiresAt, rotatedAt, revokedAt, revokeReason` |
| `AgentCommand` | command queue per device | `id, deviceId, type, payload(json), status, issuedAt, ackedAt, result(json)` |
| `AgentLog` | log uploads (30 d) | `id, deviceId, ts, level, scope, message` |
| `AgentError` | error reports (90 d, dedup) | `id, deviceId, ts, code, message, stack, fingerprint, unique(fingerprint,ts-range)` |
| `UploadTicket` | screenshot chunk state (24 h TTL) | `id, deviceId, sha256, size, chunkSize, chunks, receivedBitmap, status, expiresAt` |
| `AgentNonce` | replay cache (multi-instance) | `deviceId, nonce, expiresAt` (in-memory LRU acceptable at MVP) |
| `AgentUpdate` | release manifests | `version, channel, size, sha256, signature, minServerVersion, releasedAt` |
| `AgentPolicy` | telemetry policy (versioned) | `id, version, rules(json), active` |
| `AuditLog` *(Phase 2, listed for completeness)* | admin audit trail | `id, actorId, action, entity, details(json), ip, ts` |

### 7.3 Indexes

- `UNIQUE(Device.deviceId, ActivityLog.seq)` — idempotent ingest (seq col added to `ActivityLog` + `LoginSession`).
- `(Device.id, ActivityLog.timestamp DESC)` — time-series reads.
- `UNIQUE(Screenshot.sha256)` — content dedup.
- `(AgentCommand.deviceId, status)` — command polling.
- `(AgentLog.deviceId, ts)` / `(AgentError.deviceId, ts)` — retention deletes.
- `(Device.status)` — fleet filters.

### 7.4 Retention & cleanup (server background job, hourly)

| Data | Retention | Action |
|---|---|---|
| Activity events | 365 d | delete rows (SQLite) / drop partition (Postgres, Phase 3) |
| Screenshot files | 90 d | delete file + metadata (files first, then rows) |
| Screenshot metadata | 365 d | delete row |
| Agent logs | 30 d | delete |
| Agent errors | 90 d | delete |
| Upload tickets | 24 h | delete + GC orphan chunks |
| Agent nonces | 10 min | flush |
| Commands | 90 d | delete acked |
| Sessions | 365 d | delete |

---

## 8. Versioning

- **API versioning:** path prefix `/api/agent/v{n}`. `v1` is the only version at MVP. Within `v1`: **additive-only** — new event `kind`s, new optional body fields, new command types, new capabilities. Breaking change (rename/remove field, change semantics) → `v2`; server runs `v1`+`v2` during a ≥ 1-major-version overlap window, then deprecates `v1` with `Deprecation` header.
- **Agent versioning:** semver (`MAJOR.MINOR.PATCH`). Server enforces `minAgentVersion` (426 upgrade-required). Agent sends `X-Agent-Version` on every call; server logs + may route by version.
- **Capability negotiation:** agent declares `capabilities[]` at E1; server stores and uses to tailor responses (`screenshots` off for a stripped build).
- **Backward compatibility rules:** (1) server parsers ignore unknown JSON fields; (2) new optional fields default server-side; (3) enum values are additive; (4) response objects are never removed, only extended; (5) `x-format-version: 1` header on every request body for future evolution.

---

## 9. Failure Handling Matrix

| Scenario | Server behavior | Agent behavior |
|---|---|---|
| **Server unavailable** (TCP/TLS/5xx) | — | backoff 2 s→10 min + jitter; queue persists; `status: offline` UI |
| **Database unavailable** | `503 {error:{code:"SERVER_BUSY"}}` + `Retry-After: 5`; health endpoint degrades | honor `Retry-After`; keep queueing; no data loss (seq idempotent) |
| **Network loss** | — | full offline mode; resume at `highWaterMark`; `X-Request-ID` dedup |
| **Clock mismatch** | `429 AGENT_CLOCK_SKEW` + `X-Server-Time` | resync via E3 (`tolerant` window), then retry |
| **Authentication failure** | `401 AGENT_UNAUTHORIZED` | retry ≤ 2 → E16 rotate → re-register |
| **Expired token** | `401 AGENT_TOKEN_EXPIRED` + `X-Token-Expires` | rotate immediately; if rotate fails → re-register |
| **Large upload** | `413 AGENT_PAYLOAD_TOO_LARGE` | chunk (screenshots) / split batch (activity) |
| **Corrupt upload** | `422 AGENT_CORRUPT` (sha mismatch) | re-encode/re-capture; do not retry the bad bytes forever (max 3) |
| **Rejected events** | `rejected[]` with codes | drop (build bug), log to E11 |

---

## 10. Deployment Compatibility

| Target | Notes |
|---|---|
| **SQLite (MVP)** | Same Prisma schema; WAL mode; batch `createMany(skipDuplicates)`; keep writes < 50 ms p95 at 100 agents; background flush |
| **PostgreSQL (Phase 3)** | Same schema via provider switch; `ON CONFLICT (deviceId, seq) DO NOTHING`; partitioned `ActivityLog` by month; `AgentNonce` table instead of in-memory |
| **Windows Server** | Node native or Docker; agent endpoints do not need inbound ports; only 443/80 outbound from agents |
| **Linux** | Docker Compose reference (`14-Deployment.md`); `client_max_body_size 50m` for nginx |
| **Docker** | volumes: `wl-db`, `wl-storage`; healthcheck → `GET /api/settings/health` (BL-607) + E7 exercised |
| **Reverse proxy** | pass-through `Content-Encoding`/`Content-Range` headers; `X-Forwarded-For/Proto`; `X-Real-IP` for rate limiting; keep-alive tuned for bursty uploads |

---

## 11. Implementation Order (backend first, agent parallel after contract freeze)

| Step | Work | Est. |
|---|---|---|
| 1 | Schema: new tables/fields/indexes + Prisma migrate (SQLite) | 1–2 pd |
| 2 | Agent auth middleware (token verify, HMAC, nonce cache, clock window) + error envelope | 2–3 pd |
| 3 | E1 register + E2 activate + E3 heartbeat + E16 rotate | 2–3 pd |
| 4 | E5 activity ingest (idempotency, HWM, rejected[]) | 3–4 pd |
| 5 | E6 screenshots (ticket, chunks, dedup, storage backend) | 4–5 pd |
| 6 | E4 policy + E13 config + E8/E9 version/update manifest | 2–3 pd |
| 7 | E7 health + E10 logs + E11 errors + E12 commands + E14 shutdown + E15 uninstall | 2–3 pd |
| 8 | Retention/GC jobs + rate limiter + admin UI (devices, assign, commands) | 3–4 pd |
| 9 | Agent .NET: transport, signing, queue, backoff, capture loop | 10–14 pd |
| 10 | Agent screenshots + update pipeline | 4–6 pd |
| 11 | Integration test harness (mock server ↔ agent) + Playwright admin flows | 3–4 pd |

**Total backend ≈ 16–24 pd · Agent ≈ 14–20 pd · Integration ≈ 3–4 pd → ~33–48 pd** (≈ 5–7 weeks solo, 3–4 weeks with 2 devs).

---

## 12. Security Decisions (recap)

1. Agent tokens hashed at rest (SHA-256), returned once, DPAPI-protected client-side.
2. HMAC-SHA256 request signing + nonce + ±300 s window ⇒ replay-resistant even if a token leaks.
3. TLS 1.2+ mandatory; HTTP refused in production.
4. Join key required to enroll; rotatable; never persisted by agent.
5. Token rotation with 60 s grace; automatic before expiry; revocation on suspend/uninstall.
6. Per-device scoping server-side (deviceId from header, never body).
7. Signed update manifests (sha256 MVP, Ed25519 enterprise).
8. Screenshot privacy mode + blur + private-time suppression; files outside web root, served via authorized API.
9. Rate limits per endpoint/device; consistent error envelope; no stack traces to agents.
10. Agent endpoints excluded from the (removed) web API-key bypass; web JWT never accepted on agent routes.
