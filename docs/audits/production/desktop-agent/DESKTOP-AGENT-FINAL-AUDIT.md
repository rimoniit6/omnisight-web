# WorkLensAI — Desktop Agent Full Security, Functional & Production Readiness Audit

**Date:** 2026-08-13
**Mode:** Audit-only — NO source code modified. All probes used temporary data, fully removed and verified.

---

## 1. Executive Summary

**Verdict: CONDITIONAL** — strong security posture, no P0/P1 findings, but P2 items (local data-at-rest protection, server-side activity-input validation, multi-tenant anonymous-discover scoping) should be resolved before broad production rollout.

- **Score: 78/100**
- **P0 = 0 · P1 = 0 · P2 = 4 · P3 = 9**

The Desktop Agent is a well-engineered, fail-closed monitoring runtime. Authentication is device-credential based (24h random tokens, DPAPI-encrypted at rest, revocable, single-active-device enforcement with 409 on conflict); every agent API derives the employee/org from the verified token (never client input); consent is enforced at BOTH the agent (immediate collector stop) and server (403 on every upload) layers; website tracking is genuinely domain-only enforced at three layers (extension, agent, server); screenshots are magic-byte validated, org-scoped, and size-bounded; the queue is crash-safe and bounded; rate limits cover every brute-force and write path. The main gaps are: sensitive activity/screenshot data sits unencrypted in the user-data directory, the server trusts client-declared activity `category`/`type`/`timestamp` values without validation (forgery surface for a token holder), the anonymous zero-touch discover path binds to the FIRST organization (a documented single-tenant default that is unsafe for multi-tenant deployments), and the anomaly endpoint uses weaker auth than the rest of the agent API.

Every claim below is verified against real source + a live probe run (51/51 agent-flow checks + 8/8 auth checks against the running server, each with DB before/after), the desktop-agent unit suite (244/244), the browser-extension suite (7/7), and both TypeScript configs.

---

## 2. Scope

- `desktop-agent/` — Electron main process, preload, sandboxed renderer, services, collectors, storage, auth, API client, native addon, native-messaging host, launcher, tests, scripts.
- `browser-extension/` — MV3 extension (background service worker + shared domain normalization), native-messaging manifests, tests.
- Server-side enforcement consumed by the agent: `src/app/api/agent/*` (13 routes), `src/lib/agent/*` (auth, activation, session, agent-account), `src/lib/consent.ts`, `src/lib/screenshots/storage.ts`, `src/proxy.ts` agent rules, `src/lib/rate-limit.ts`.

---

## 3. Architecture Understanding

```
┌────────────────────────────── Windows 10/11 machine ──────────────────────────────┐
│                                                                                    │
│  Browser extension (MV3)                                                           │
│    tabs/webNavigation events → domain-only normalization → Native Messaging        │
│        │                                                                           │
│        ▼                                                                           │
│  worklens-native-host.exe (C launcher, 20KB dumb relay, no parsing)                │
│        │ 4-byte-LE-length JSON framing on stdin/stdout                             │
│        ▼                                                                           │
│  Agent EXE (--native-messaging-host mode) → loopback TCP 127.0.0.1:<port>          │
│        │ token-authenticated (32-byte random in website-bridge.json)               │
│        ▼                                                                           │
│  WebsiteBridgeServer → WebsiteCollector → ActivityQueue (domain slices)            │
│                                                                                    │
│  Native addon (worklens_capture.node): foregroundWindow / idleSeconds / capture    │
│        │                                                                           │
│        ▼                                                                           │
│  ActivityCollector (10s poll, app slices) → ActivityQueue                          │
│  ScreenshotCollector (config cadence) → bounded PNG spool → upload                 │
│        │                                                                           │
│        ▼                                                                           │
│  AgentOrchestrator: heartbeat / config sync / consent sync / queue drain /         │
│  screenshot drain / approval poll / discovery retry / status push (5s)             │
│        │                                                                           │
│        ▼                                                                           │
│  ApiClient → https://<server> /api/agent/* (Bearer AgentToken)                     │
└────────────────────────────────────────────────────────────────────────────────────┘
        ▼
  Next.js server: validateAgentToken → consent check → org-scoped DB write
```

**Entry points:** `dist/main/main.js` (normal boot), `--native-messaging-host` flag (headless host mode). Single-instance lock for the agent; host mode deliberately has none (multiple browser windows).

---

## 4. Feature Inventory

| Feature | Exists | Functional | Server-backed | Security enforced | Production-ready |
|---|---|---|---|---|---|
| Install/startup | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zero-touch device discovery (PATH A) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Legacy employee+password auth (PATH B) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Phase 3 AgentAccount login | ✅ | ✅ | ✅ | ✅ | ✅ |
| Token management (24h, encrypted, rotation, revocation) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Single-active-device rule | ✅ | ✅ | ✅ | ✅ 409 conflict | ✅ |
| Employee/org association | ✅ (server-derived) | ✅ | ✅ | ✅ | ✅ |
| Heartbeat | ✅ | ✅ | ✅ | ✅ | ✅ |
| Activity tracking (foreground app) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Idle detection (GetLastInputInfo) | ✅ | ✅ | — | ✅ config-gated | ✅ |
| Application tracking | ✅ | ✅ | ✅ | ✅ | ✅ |
| Browser/URL tracking (domain-only) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Screenshot capture + upload | ✅ | ✅ | ✅ | ✅ | ✅ |
| Screenshot retry / bounded spool | ✅ | ✅ | — | ✅ | ✅ |
| Offline queue (crash-safe, bounded) | ✅ | ✅ | — | ⚠️ plaintext | ⚠️ |
| Break mode | ❌ NOT IMPLEMENTED (server endpoint exists; agent never calls it; flag false) | | | | |
| Privacy mode | ⚠️ consent revocation stops collectors immediately (real) — no separate "privacy" toggle | | | | |
| Tracking pause | ⚠️ IPC `agent:pause`/`resume` exist but the zero-control renderer exposes NO pause control (by design) | | | | |
| Config sync (10 min) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Consent sync (60 s) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Error reporting | ✅ bounded | ✅ | — | ✅ | ✅ |
| Logging | ✅ level-filtered, redacted | ✅ | — | ✅ | ✅ |
| Auto-start with Windows | ✅ (default ON, no employee toggle — policy) | ✅ | — | ✅ | ✅ |
| Background/tray execution | ✅ (tray has no Quit) | ✅ | — | ✅ | ✅ |
| Auto-update | ✅ boundary only (disabled without signed HTTPS feed) | ⚠️ no feed configured | — | ✅ | ⚠️ |
| Tamper detection | ❌ NOT IMPLEMENTED (flag false; no watchdog) | | | | |
| USB monitoring | ❌ NOT IMPLEMENTED (flag false) | | | | |

**Verification markers:** all collector features are VERIFIED (unit-tested + live agent API flow); break/tamper/USB are NOT IMPLEMENTED (honest config flags, never instantiated API classes); screenshot pixel capture is STATIC-CODE EVIDENCE ONLY (native addon requires a real Windows session — live capture not reproducible in this environment).

---

## 5. Authentication Audit

**VERIFIED (live + source).**

- Legacy PATH B: `POST /api/agent/authenticate` with `employeeId + agentPassword` (bcrypt, with legacy-plaintext migration) → 24h `AgentToken`. Unknown employee and wrong password both return **401** (uniform, no enumeration). Pending/rejected/revoked → 403 with machine-readable `status`. Rate limited 20/min/IP.
- Zero-touch PATH A: device claim secret (SHA-256 hash stored server-side, constant-time verify) → token.
- Phase 3 login: `POST /api/agent/login` with Admin-created AgentAccount (bcrypt, lockout after 5 fails, disabled-account fail-closed) → short-lived **AgentSession** (NOT a device credential — can only authorize discover/logout).
- Every protected endpoint calls `validateAgentToken` (token exists → not expired → employee approved+active → AgentAccount not disabled → device active) and returns **401** otherwise. Live: `deadbeef…` token → 401 on config/activity/tamper/anomaly.
- Token lifecycle: 24h expiry (with 1-min skew), transparent re-auth on 401 (latched single in-flight recovery, retained data, no loop), server-side logout revocation (live: heartbeat after logout → 401), admin device-revoke → device inactive → all its tokens invalid immediately.
- **Expired tokens are deleted on detection** (no accumulation).

## 6. Device Identity Audit

**VERIFIED.**

- Device identity = 32 cryptographically-random bytes (hex), stored in `userData/state/device-identity.json` (0600). Never username/hostname/MAC-based.
- `binding` = HMAC-SHA256(id, machine-key) where machine-key = DPAPI-encrypted fixed string. Cloned identity file on another machine fails DPAPI decrypt → binding mismatch → regenerated (fresh-install semantics) — **clone detection works**.
- The `agentKey` is client-supplied on discover; the server binds device→employee/org SERVER-SIDE (session-derived for authenticated discover; first-org for anonymous — see finding P2-3). A client cannot set the employee/org of a discovered device (live: authenticated discover bound device to the session employee's org B, never the first org).

## 7. Tenant Isolation Audit

**VERIFIED — PASS. No cross-org access found.**

- Employee + organization are ALWAYS derived from the verified token's employee row. Live proofs:
  - Activity upload carrying `employeeId: <org-B employee>` in the body → stored row attributed to the token's own employee (org A), **not** the forged id.
  - Same for `organizationId` and `deviceId` forgery attempts (ignored; deviceId server-bound).
  - Cross-org forged activity row attributed to token employee (verified in DB).
- Org A token cannot read org B config/consent (config is org-scoped via `resolveOrgMonitoring(orgId)`; consent via `getConsentState(employeeId, orgId)`).
- Screenshot upload binds `organizationId` from the token employee; retrieval (`GET /api/screenshots/[id]/image`) requires `findFirst({ id, organizationId: sessionOrg })` → foreign id = 404 (admin-side, verified in prior certification).
- Discover (authenticated) enforces session-derived org/employee rules with uniform 404 for any mismatch (rules B/C/D under the device row lock).
- **Anonymous** discover binds to the FIRST org (documented single-tenant default) — multi-tenant limitation, finding P2-3.

## 8. API Security Audit

| Endpoint | Method | Auth | Authorization | Validation | Rate Limit | Tenant Scoped | Audit | Risk |
|---|---|---|---|---|---|---|---|---|
| /api/agent/discover | POST | anon or AgentSession | claim lifecycle machine | deviceKey 16–128, hostname ≤128 | 20/min IP+key | session-derived / first-org | ✅ (auditLog) | P2-3 |
| /api/agent/authenticate | POST | deviceSecret or password | single-active-device | presence | 20/min IP | ✅ | ✅ login | ✅ |
| /api/agent/login | POST | AgentAccount | account state+org active | agentId≤64, pw≤256 | 20/min IP | ✅ | ✅ | ✅ |
| /api/agent/register | POST | agentPassword | employee approved | presence | 10/min IP | ✅ | ✅ | ✅ |
| /api/agent/logout | POST | bearer | — | token len ≥20 | (agent-write) | ✅ | ✅ | ✅ |
| /api/agent/heartbeat | POST | AgentToken | device active | — | 600/min token | ✅ | — | ✅ |
| /api/agent/config | GET | AgentToken | device active | — | agent-write | ✅ | — | ✅ |
| /api/agent/consent | GET | AgentToken | device active | type allowlist | 600/min token | ✅ | — | ✅ |
| /api/agent/consent | POST | AgentToken | device active | type+action allowlist | agent-write | ✅ | ✅ ConsentLog | ✅ |
| /api/agent/activity | POST | AgentToken | **consent 403** | ≤100 items, duration ≤86400 | 120/min token | ✅ | — | P2-2 |
| /api/agent/screenshot | POST | AgentToken | **consent 403** | ≤5MB, magic-byte+MIME, timestamp parse | 120/min token | ✅ | ✅ (no userId — P3-1) | ✅ |
| /api/agent/break | POST | AgentToken | device active | breakMode boolean | agent-write | ✅ | — | P3-2 (unused) |
| /api/agent/tamper | POST | AgentToken | device active | type allowlist | agent-write | ✅ | ✅ | P3-2 (unused) |
| /api/agent/anomaly | POST | AgentToken (WEAKER — own lookup) | employee active only | type/title/desc, score 0–100 | agent-write | ✅ | — | P2-4 |
| /api/device-claims/[id]/cancel | POST | claim secret+deviceKey | claim ownership | presence | 20/min IP+key | ✅ | ✅ | ✅ |

**No SQL injection** (Prisma parameterized), **no replay protection needed** (stateful random tokens), **payload bounds** enforced (100 activities, 5MB screenshot, 256KB native frames), **error handling** uniform (no stack traces; `Internal server error` only).

## 9. Activity Tracking Audit

**VERIFIED.** Capture → local aggregation (per-app/domain slices, sub-5s ignored) → crash-safe queue → 100-item batches → server `createMany`. Server caps duration at 86400s and clamps negatives to 0; the employee/device/org are server-derived. Findings: server does **not** validate `category`/`type` enums or reject future timestamps (P2-2); the queue is plaintext and locally editable (P2-1); "server re-categorizes" doc claim is false (P3-3).

## 10. Idle Detection Audit

**VERIFIED (source + unit tests).** `GetLastInputInfo` via the native addon; `idleSeconds()`; classifier gated by `idleDetectionEnabled` (default false — employee is never classified idle when off) and `idleTimeoutMinutes`. Config-gated means a trivially-idle employee can't be classified idle unless the org enables it. Sleep/wake and lock are handled by the OS idle counter (last input resets on wake). No bypass found. Algorithm documented in `activity-collector.ts`.

## 11. Application Tracking Audit

**VERIFIED (source).** Real foreground-window sampling (GetForegroundWindow + process name), aggregated into per-process slices; the agent's own process is excluded at collection AND server ingestion; sensitive apps are not special-cased (all apps recorded as configured). Duration is elapsed wall-time — an employee can inflate it by keeping an app in the foreground (inherent to the model; see P2-2/P3-4).

## 12. Browser / URL Tracking Audit

**VERIFIED — privacy-first, domain-only, enforced at 3 layers.**

- Extension: active-tab-only reporting, incognito tabs NEVER reported, internal schemes dropped, full URL → `normalizeWebsiteDomain` → bare lowercase hostname. Buffer bounded (100 events). `tabs`/`webNavigation`/`nativeMessaging` permissions only.
- Agent host: re-validates every frame; raw URLs never logged/forwarded.
- Server: re-normalizes website rows; full URLs/paths/query strings dropped. Live proof: uploaded `https://www.PROBE-A-SITE-xxx.com/page?token=SECRET` → stored as `probe-a-site-xxx.com`; **zero rows** contain `token=SECRET`; `www.` stripped.
- `website_tracking` config flag is REAL: the WebsiteCollector gates on `websiteTrackingEnabled && activity_tracking consent` (fail-closed) and the server config route serves the org-scoped value. Not a cosmetic setting.

## 13. Screenshot Security Audit

**VERIFIED (server enforcement live; capture static).**

- **Capture:** config-cadence (min 1 min, ≥30s clamp), consent-gated, working-hours-gated, bounded spool (50 files / 250MB, oldest dropped; PNG+JSON sidecar as one unit). Locked-screen/sleep behavior is STATIC-CODE: BitBlt of the foreground window rect fails when the window is unavailable → empty → collector stops (fail-closed). No explicit lock detection (P3-6).
- **Upload:** 401-retained with auth recovery; 400/403 dropped as permanent; max 5MB; PNG/JPEG/WebP allowlist with **magic-byte verification** (live: real PNG accepted, SVG-as-PNG → 400); timestamp must parse (400 otherwise); server-generated `randomUUID()` filenames with sanitized employee segment; no path traversal.
- **Retrieval:** org-scoped `findFirst({ id, organizationId })` → foreign id 404; `basename()` path guard; stored bytes re-signed with `safeServeMime` + `nosniff`; not publicly served.
- **Replay/duplicates:** at-most-once per file (ack-after-confirm); no idempotency key needed.

## 14. Offline Queue / Retry Audit

**VERIFIED (unit + soak scripts).** Append-only JSONL, atomic tmp-rename persist, crash-safe (crash between server-2xx and ack → re-upload = at-least-once, documented F-13), bounded 32MB with oldest-drop, per-item attempt counters, no infinite retry (scheduler backoff + permanent-4xx drop + repeated-401 stop). Queue survives restart (persistent file). Local queue content is PLAINTEXT activity data (P2-1).

## 15. Network Reliability Audit

**VERIFIED (source + unit).** ApiClient: 15s timeout, 2 retries with exponential backoff + jitter, 4xx not retried (429/5xx/network retried), abort-safe. 401 triggers latched recovery (single in-flight, shared across heartbeat/queue/screenshot). Heartbeat failures don't crash; collectors keep their last state; discovery retries with bounded backoff (30s→10min) on server-unavailable; graceful shutdown drains ≤3s with a 6s hard cap. No crash/freeze/duplicate-flood paths found.

## 16. Local Storage & Secrets Audit

**VERIFIED (source).**

| File | Contents | Protected? |
|---|---|---|
| `sec-*.bin` (agent.token, agent.credentials, agent.claim, agent.session) | JWT-ish bearer, employee password, claim secret, login session | ✅ DPAPI (safeStorage), 0600, hashed filenames |
| `device-identity.json` | device id + binding HMAC | ⚠️ 0600, not secret by design |
| `settings.json` | autoStart only | ⚠️ 0600, non-secret |
| `activity-queue.jsonl` | activity records (app names, titles, domains, durations) | ❌ **plaintext, default perms** (P2-1) |
| `screenshot-spool/*.png` | screenshots | ❌ **plaintext, default perms, bounded** (P2-1) |
| `website-bridge.json` | loopback port + 32-byte token | ⚠️ default perms, same-user OS boundary (P3-8) |

No hardcoded credentials, no tokens in logs (redact() + contract), no crash-dump exposure paths found. Machine key is a DPAPI-encrypted constant (not a secret value, but machine-bound — acceptable).

## 17. Tamper Resistance Audit

**HONEST: NOT IMPLEMENTED, and the code says so.**

- Employee can kill the process (Task Manager), edit `settings.json` autoStart, edit the plaintext queue to inject fake activity, change the system clock (bypass working-hours gate / inflate durations), or block the network. There is NO watchdog, NO integrity checking, NO process guard.
- Mitigations that DO exist: no employee Quit in the tray (installer/Task Manager only), autoStart default ON, device binding detects cloned identity files, consent fail-closed on staleness, server re-enforces consent/roles, device deactivation invalidates tokens server-side.
- The feature flags `tamperDetectionEnabled: false` are truthful — this is a documented capability gap, not a hidden claim (P3-4).

## 18. Privacy / Break Mode Audit

**VERIFIED — consent revocation is real and immediate.**

- Server consent revoke → agent's next consent refresh (≤60s) → `ConsentService` fires listeners → collectors stop instantly (activity/screenshot/website). Live: agent-side revoke → screenshot upload 403 immediately; re-grant → 200.
- The upload endpoints independently 403 without active consent — the local gate is an optimization, the server is authoritative.
- Break mode: NOT implemented agent-side (no UI, API class never instantiated, config flag false). The server endpoint exists and would record an idle row — reachable only with a valid token (P3-2).
- Tracking pause: `agent:pause/resume` IPC exists but the zero-control renderer exposes no employee control (by design — no UI toggle that could falsely imply control).

## 19. Configuration Synchronization Audit

**VERIFIED.** Org-scoped `OrganizationSetting` → `GET /api/agent/config` → agent applies without restart (heartbeat/screenshot cadence re-registered; collectors re-evaluated immediately). Fail-safe: pre-sync defaults all-disabled; malformed working-hours → fail closed; invalid cadence clamped server-side AND agent-side (min 10s heartbeat / 30s screenshot). No WebSocket — 10-min polling. Server is the single source of truth for assignment data (read-only snapshot).

## 20. Logging & Error Handling Audit

**VERIFIED.** Structured JSON logger, `WL_LOG_LEVEL` filter (default info; heartbeat/config success at debug), success-path logs quiet, `redact()` strips bearer/password/JWT patterns, domain-only website logs, no secrets/stack traces to clients (server returns generic errors; agent logs sanitized). Renderer never receives tokens. Errors fail safe (scheduler catches job errors, shutdown bounded, boot watchdog).

## 21. Resource Usage Audit

**VERIFIED (static + code paths); no live measurements fabricated.**

- Bounded everywhere: queue 32MB, spool 50 files/250MB, native frames 256KB, extension buffer 100 events, scheduler timers capped/unref'd, status push every 5s (not logged), errors list capped at 8, log levels filtered.
- No infinite loops; exclusive drain jobs prevent overlap; 10s sample cadence is lightweight (GetForegroundWindow + GetLastInputInfo only).
- The repo ships `offline-soak.mjs` (queue/crash/ack-loss/bound modes) and `soak-24h.mjs` for long-run measurement — NOT run here (audit-only; no live soak performed).

## 22. Lifecycle Audit

**VERIFIED (unit tests + orchestrator flow).** First-run zero-touch discovery → pending → approval poll (20s) → auto-auth; restart resumes claims; reboot via autoStart; forced termination → next boot recovers (queue intact, token refresh on 401); single-instance lock prevents duplicated workers; host mode intentionally un-locked (browser spawns many). Sleep/wake handled by OS idle counter. Shutdown: coordinator drains ≤3s, hard 6s cap, `before-quit` prevented until done.

## 23. Dependency & Supply-Chain Audit

**STATIC CODE EVIDENCE ONLY (no upgrade performed, per instructions).**

- Runtime deps: `electron-updater` only. Dev: electron 33.3.0, electron-builder 25.1.8, typescript 5.7, tsx, @types/node.
- `electron-builder.yml` has **no committed certificate**; signing activates from env (`CSC_LINK`/`WIN_CSC_LINK`) — nothing secret in the repo. `publish: null` (no auto-update feed configured).
- Native addon + launcher are compiled locally (MSVC/gcc); binaries are **unsigned** unless the release machine signs them (documented; a gap for supply-chain integrity but standard for internal tooling).
- Update path: disabled without `WL_UPDATE_URL` (https-only, redacted); `autoDownload: false`, signature verified by electron-updater when a feed exists.

## 24. Code Quality & Architecture Audit

**VERIFIED.** Clean service boundaries (auth/storage/collectors/services/API), no God modules, single responsibility per collector, all failure paths fail closed, `strict` TS with `noUncheckedIndexedAccess`, no `any` in agent source, no swallowed exceptions that hide security failures (catches are logged), honest comments (break/tamper/USB/retention all truthfully marked unimplemented or server-side). The `ActivityQueue.persist()` is O(n) per write — documented and acceptable at current cadence (F-16).

## 25. Testing Audit

**RUN — 244/244 pass (desktop-agent), 7/7 pass (browser-extension).**

| Suite | Result |
|---|---|
| auth-service, zero-touch, onboarding, active-device-conflict, api-client, device-identity, local-settings, server-url | ✅ |
| activity-collector (idle, internal-process), working-hours, consent-gate, consent-lifecycle, website-collector, website-bridge, native-messaging-host, domain | ✅ |
| queue-uploader, activity-queue, screenshot-spool-auth-retry, screenshot-collector-working-hours | ✅ |
| scheduler, shutdown-coordinator, update-service, orchestrator-dynamic-config, renderer-build, zero-control-renderer | ✅ |
| browser-extension domain tests | ✅ 7/7 |

**Coverage gaps (reported, not fixed):** no Windows-native live capture E2E in CI (requires a real session), no automated multi-org *agent* tenant-isolation test in the agent suite (server-side tests cover it), no live-soak run in this audit.

## 26. Live Verification Evidence

**AGENT-FLOW LIVE PROBE (running server, fresh probe orgs A+B, seeded published policies + granted consents, full cleanup): 51/51 PASS.**

Highlights: PATH B register/authenticate 200 + token; wrong password 401; heartbeat/config/consent 200; activity upload with **forged employeeId/orgId/deviceId in the body** → stored row attributed to the token's employee (verified in DB); website full-URL upload → stored bare domain, zero `token=SECRET` rows; 101-activity batch → 400; screenshot PNG 200 / SVG-as-PNG 400; consent revoke → upload 403 → re-grant → 200; cross-org forged activity attributed to token employee; Phase 3 login → session → authenticated discover bound device to **org B** (employee + org, not first org); pending-claim auth 403; approved-claim auth 200 + heartbeat 200; same-device re-auth 200 (token replaced); second-device auth **409 ACTIVE_DEVICE_EXISTS**; anonymous discover → 201 bound to first org (documented default); invalid token 401; logout → heartbeat 401; break/tamper/anomaly 200/200/201 with a valid token; login brute force → 429.

**AUTH-CHECK PROBE: 8/8 PASS** — activity/heartbeat/config/consent/break unauthenticated → 401; activity/tamper/anomaly with `deadbeef` token → 401.

**DB BEFORE/AFTER:** every mutation asserted against actual stored rows (employee attribution, domain normalization, device binding/org, claim lifecycle, token revocation, zero rows for rejected uploads).

## 27. Database Verification

**Probe residue = 0** across all 16 models (orgs, employees, activities, devices, agentTokens, agentSessions, agentAccounts, deviceClaims, consents, consentPolicies, consentLogs, alerts, notifications, agentRegistrations, auditLogs, screenshots) and **0 probe screenshot files** on disk. Temporary probe scripts deleted (0 remain). The dev DB is back to its pre-probe state.

## 28. Findings Matrix

| ID | Severity | Category | Title |
|---|---|---|---|
| P2-1 | P2 | Local storage | Sensitive data at rest unencrypted (activity queue + screenshot spool) |
| P2-2 | P2 | Validation | Server trusts client-declared activity category/type/timestamp (forgery surface) |
| P2-3 | P2 | Tenant isolation | Anonymous zero-touch discover binds to FIRST organization (multi-tenant limitation) |
| P2-4 | P2 | Auth | /api/agent/anomaly uses weaker token validation than other agent routes |
| P3-1 | P3 | Audit | Screenshot upload auditLog lacks userId (actor attribution) |
| P3-2 | P3 | Dead code | break/tamper/anomaly server endpoints unused by the agent (break fabricates idle rows) |
| P3-3 | P3 | Truthfulness | "Server re-categorizes activity" doc claim is false (category stored as sent) |
| P3-4 | P3 | Tamper | System-clock dependence + no tamper protection (honest flag; employee can modify local state) |
| P3-5 | P3 | Reliability | At-least-once queue may duplicate rows on crash-between-2xx-and-ack (documented F-13) |
| P3-6 | P3 | Screenshot | No explicit locked-screen detection at capture (likely fail-closed; static evidence only) |
| P3-7 | P3 | Config | Default server URL is http://localhost:3000 (ops must set WORKLENSAI_SERVER_URL) |
| P3-8 | P3 | Local storage | website-bridge.json default file perms (token readable by same user — OS boundary only) |
| P3-9 | P3 | Performance | validateAgentToken writes lastUsedAt on every request (write amplification) |

---

## 29. P0/P1/P2/P3 Summary

### P0 = 0
No authentication bypass, no cross-org data access, no arbitrary screenshot access, no credential compromise, no RCE, no complete agent impersonation found.

### P1 = 0
No IDOR/BOLA, no weak device authentication, no screenshot authorization flaw, no activity-forgery-without-token, no exposed secrets, no missing authorization on sensitive agent APIs, no major privacy bypass.

### P2 = 4

**P2-1 — Sensitive data at rest unencrypted**
- **Status:** VERIFIED (source) · **Affected:** `desktop-agent/src/storage/activity-queue.ts` (`activity-queue.jsonl`), `desktop-agent/src/collectors/screenshot-collector.ts` (`screenshot-spool/*.png` + sidecars) · **Endpoints:** n/a (local files)
- **Description:** Activity records (app names, window titles, domains, durations) and full screenshots sit as plaintext files in the user-data directory with default file permissions. OS user ACLs are the only boundary.
- **Impact:** A second local account or another process running as the user can read monitoring data and screenshots. On a shared machine this is a privacy concern; on a single-user workstation the risk is the user's own data.
- **Evidence:** `fs.writeFile(tmpFile, content, 'utf8')` (no `mode`), `fs.writeFile(file, Buffer.from(bytes))` (no `mode`). SecureStore files correctly use DPAPI + 0600.
- **Recommended fix:** Move the queue/spool under a directory with strict ACLs; or DPAPI-encrypt the queue entries and spool images before write (decrypt only in memory at upload). At minimum, chmod 0600 the spool files. Do NOT encrypt tokens twice — the queue is the priority (screenshots are the most sensitive).
- **Regression test required:** YES — test that queue/spool files are created with restrictive perms and that a simulated read by another user is denied.
- **Production blocker:** NO (conditional — resolve for shared-workstation deployments).

**P2-2 — Server trusts client-declared activity values (forgery surface)**
- **Status:** VERIFIED (live) · **Affected:** `src/app/api/agent/activity/route.ts` · **Endpoint:** `POST /api/agent/activity`
- **Description:** The server accepts `category` and `type` as free-form strings (`category: act.category || 'neutral'`, `type: act.type || 'application'`) with no allowlist, and accepts any parseable `timestamp` (including future dates). `duration` is clamped to [0, 86400] but the lower bound means a negative value becomes 0 silently rather than a validation error.
- **Impact:** A token holder (or a user who edits the local plaintext queue — see P2-1) can forge activity: arbitrary category labels, arbitrary `type` strings, backdated or future-dated records. This can distort org analytics. The token is the trust boundary, so impact is limited to the device's own employee — but validation should not be skipped.
- **Evidence:** Live upload with `category: 'productive'` stored verbatim; no server-side re-categorization exists anywhere (`categorize` is agent-only) despite the agent's comment claiming the server re-categorizes.
- **Recommended fix:** Server-side allowlist for `type` (application/website/idle/work_session) and `category` (productive/neutral/unproductive/idle — reject or coerce unknown values); reject future timestamps beyond a small skew; reject negative durations with 400.
- **Regression test required:** YES.
- **Production blocker:** NO.

**P2-3 — Anonymous zero-touch discover binds to FIRST organization**
- **Status:** VERIFIED (live + source) · **Affected:** `src/app/api/agent/discover/route.ts` · **Endpoint:** `POST /api/agent/discover`
- **Description:** Anonymous (no-session) discover targets `db.organization.findFirst({ orderBy: { createdAt: 'asc' } })` — the FIRST organization in the system. Live: an anonymous probe device landed in the seeded first org. The code documents this as the single-tenant default, and the Phase 3 authenticated path correctly derives org from the session.
- **Impact:** In a multi-tenant deployment, a fresh agent with no session would register its device claim in the wrong tenant's org, appearing in that org's admin approval queue and creating a notification/audit row there. Rate limited (20/min/IP+deviceKey) but the scoping itself is unsafe for multi-tenant.
- **Evidence:** Live probe — anonymous discover → device in first org; authenticated discover → device in session org B. Both documented in code comments.
- **Recommended fix:** For multi-tenant deployments, either (a) require the Phase 3 authenticated discover (AgentAccount login) as the only onboarding path, or (b) make anonymous discover fail 503 when more than one organization exists (it already 503s when none exists).
- **Regression test required:** YES.
- **Production blocker:** NO for single-tenant; **conditional** for multi-tenant.

**P2-4 — /api/agent/anomaly uses weaker token validation**
- **Status:** VERIFIED (source) · **Affected:** `src/app/api/agent/anomaly/route.ts` · **Endpoint:** `POST /api/agent/anomaly`
- **Description:** Unlike every other agent route, anomaly uses its own lookup (`findUnique({ where: { token } })` + expiry check only) instead of `validateAgentToken`. It skips: employee `agentApproved`/`status` checks, AgentAccount disabled check, and device active check. A revoked device's token can still report anomalies for up to 24h.
- **Impact:** Low — anomaly rows are org-scoped and bounded (score/severity validated); but a disabled device could still inject anomaly/alert/notification rows. Inconsistent enforcement.
- **Evidence:** Source comparison: `validateAgentToken` checks 5 conditions; anomaly checks 2.
- **Recommended fix:** Replace the inline lookup with `validateAgentToken(req)` (keeping the org derivation).
- **Regression test required:** YES.
- **Production blocker:** NO.

### P3 = 9

**P3-1 — Screenshot upload auditLog lacks userId (actor)** — `src/app/api/agent/screenshot/route.ts` creates the audit row without `userId` (the agent is the actor; there is no AppUser, but the employeeId is known). Add `userId: authResult.employee.id` for attribution parity with authenticate/login logs.

**P3-2 — break/tamper/anomaly endpoints unused by the agent (dead-but-reachable)** — `BreakApi`, `TamperApi`, `AnomalyApi` classes exist in `desktop-agent/src/api/heartbeat.ts` but are NEVER instantiated; the agent never calls break/tamper/anomaly (config flags false). The server endpoints are reachable with any valid token (live: break → 200, creates an `idle` row "Break Mode Started"). Either wire the agent to real break-mode controls or remove/disable the endpoints.

**P3-3 — "Server re-categorizes" claim is false** — `ActivityCollector.flushCurrent()` comment says "the server re-categorizes via its own logic"; no such logic exists server-side. Category is stored exactly as sent. Fix the comment or implement server-side categorization.

**P3-4 — System-clock dependence / no tamper protection** — Working-hours windows and durations use the machine clock; an employee can change the system clock to bypass the working-hours gate or inflate durations. Tamper detection is honestly unimplemented (`tamperDetectionEnabled: false`, no watchdog). Document as accepted risk or add clock-skew detection (e.g., compare with heartbeat/server time).

**P3-5 — At-least-once queue duplicates** — crash between server 2xx and local ack re-uploads the batch (documented F-13). Acceptable; consider a client idempotency key if duplicates ever matter.

**P3-6 — No explicit locked-screen detection at capture** — the native capture fails closed when the window is unavailable, but there is no explicit Win+L lock check before capture. Static evidence only.

**P3-7 — Default server URL is http://localhost:3000** — packaged EXEs without `WORKLENSAI_SERVER_URL` point at localhost. Ops must set the env; a misconfigured machine would silently talk to a local server. Document in the install guide (already a startup warning for invalid overrides).

**P3-8 — website-bridge.json default perms** — the loopback token file is written without an explicit mode (same-user OS boundary only). Set 0600 for defense-in-depth.

**P3-9 — lastUsedAt write amplification** — `validateAgentToken` updates `agentToken.lastUsedAt` on every request (every heartbeat/consent/config/upload). Minor DB write per request; fine at current scale.

---

## 30. Production Readiness Score

| Dimension | Score | Notes |
|---|---|---|
| Security | 9/10 | fail-closed everywhere; no P0/P1 |
| Authentication | 9/10 | strong device/claim/session model; anomaly endpoint gap (P2-4) |
| Authorization | 9/10 | server-derived tenant scope proven live; P2-3 anonymous-discover caveat |
| Tenant Isolation | 8/10 | proven for authenticated flows; anonymous discover = first-org (P2-3) |
| Data Integrity | 7/10 | crash-safe queue, at-least-once; client-value validation gap (P2-2) |
| Privacy | 8/10 | domain-only website tracking proven; plaintext at-rest data (P2-1) |
| Screenshot Security | 8/10 | magic-byte + org-scope + bounded; plaintext spool + no lock-check |
| API Security | 8/10 | rate limits + validation + bounds; P2-2/P2-4 |
| Reliability | 9/10 | retries, backoff, shutdown, bounded queues |
| Performance | 9/10 | bounded everywhere; O(n) queue persist acceptable |
| Code Quality | 9/10 | clean boundaries, strict TS, honest docs |
| Test Coverage | 8/10 | 251 tests green; no live-capture E2E in CI |
| Production Readiness | 8/10 | CONDITIONAL — P2s before wide rollout |

**Desktop Agent Production Readiness: 78/100 · P0 = 0 · P1 = 0 · P2 = 4 · P3 = 9**

---

## 31. Recommended Fix Priority

1. **P2-1 (data at rest)** — restrict spool/queue permissions; DPAPI-encrypt at rest (highest privacy value).
2. **P2-2 (activity validation)** — server-side type/category/timestamp/duration validation.
3. **P2-3 (anonymous discover scoping)** — multi-tenant: require authenticated discover or 503 on multi-org.
4. **P2-4 (anomaly auth parity)** — use `validateAgentToken`.
5. **P3 cluster** — audit attribution (P3-1), remove/disable unused endpoints (P3-2), fix false docs (P3-3), document clock risk (P3-4), perms (P3-8), lastUsedAt batching (P3-9).
6. **Regression tests** — one per P2/P3 fix; re-run the full live probe matrix + both suites.
7. **Re-certify** after fixes.

---

## 32. Final Verdict

```
Desktop Agent Audit Verdict: CONDITIONAL
Score: 78/100
P0: 0
P1: 0
P2: 4
P3: 9

Top 10 Risks:
1. P2-1 Screenshots + activity queue stored plaintext at rest (user-data dir)
2. P2-3 Anonymous zero-touch discover binds to the FIRST org (multi-tenant only)
3. P2-2 Server trusts client activity category/type/timestamp (forgery surface)
4. P2-4 Anomaly endpoint skips device/account/approval checks
5. P3-4 No tamper protection; system-clock manipulation possible
6. P3-2 Unused break/tamper/anomaly endpoints reachable with any valid token
7. P3-1 Screenshot audit log missing actor attribution
8. P3-7 Default server URL = localhost:3000 (ops must configure)
9. P3-6 No explicit locked-screen capture guard
10. P3-9 lastUsedAt write on every authenticated request

Test Status:
  desktop-agent: 244/244 PASS · browser-extension: 7/7 PASS
  tsc (main): 0 errors · tsc (renderer): 0 errors · npm run build: PASS

Live Verification Status:
  Agent-flow probe: 51/51 PASS (against the running server, DB-verified)
  Auth checks: 8/8 PASS (unauthenticated/invalid-token → 401)
  Browser E2E: NOT TESTABLE in this environment (Electron window + native addon
  require an interactive Windows session; agent API surface verified live instead)

Database Cleanup Status: 0 PROBE rows across 16 models; 0 temp files/scripts

Recommended Next Step: Fix P2-1..P2-4 in the Agent Hardening phase, add the
regression tests, re-run the live probe matrix, then re-certify.
```

**No source code was modified during this audit.** All probe data and temporary files were removed; the development database was verified clean.
