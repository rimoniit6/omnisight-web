# OmniSight — Troubleshooting

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

Common problems, grouped by area, with root causes from the actual implementation.

Related docs: [INSTALLATION.md](./INSTALLATION.md) · [USAGE.md](./USAGE.md) · [omnisight-agent.md](./omnisight-agent.md) · [DEVELOPMENT.md](./DEVELOPMENT.md)

---

## 1. Server won't start

| Symptom | Cause / fix |
|---|---|
| `DATABASE_URL` errors | Verify Postgres is up and `DATABASE_URL` points to it. Run migrations: `npm run db:deploy`. Postgres is the only supported DB. |
| "Cannot find module" on start | `npm run build` then `npm run start` (standalone output) or dev via `npm run dev`; node_modules must be installed (`npm ci`). |
| Port 3000/3010 in use | Change port or stop the conflicting process; live-updates uses `LIVE_UPDATES_PORT` (3010). |
| ENOENT on `scripts/copy-standalone.js` | The copy script exists; ensure you're on the root and ran `npm run build` first (see [INSTALLATION.md](./INSTALLATION.md) §7). |
| Caddy errors | The repo Caddyfile proxies `:81` → `:3000` and `?XTransformPort=3010` → `:3010`; adjust ports to match your setup. |

## 2. Login problems

| Symptom | Cause / fix |
|---|---|
| 401 "Invalid email or password" | Wrong credentials, or account deactivated. Login is deliberately uniform (no enumeration). |
| 429 on login | Rate limited (10 per 5 min per IP+email) — wait for the window (see `Retry-After`). |
| Logged out after server restart | Expected if `JWT_SECRET` changed — all tokens invalid; users re-login. |
| Cookie not set | App must run over `http://localhost:3000` or the same origin as `NEXT_PUBLIC_*`; check the browser rejects the httpOnly cookie (HTTPS vs HTTP mismatch). |

## 3. No telemetry / empty data

The collection chain is: **org setting → consent (policy-bound) → device approved/online → agent capability (native addon) → server gate**.

| Symptom | Check |
|---|---|
| Activities empty | 1) Activity setting enabled? 2) Consent `activity_tracking` granted? 3) Device approved? 4) Agent running (status window)? 5) Break mode active (collectors paused)? |
| Screenshots empty | `screenshot_enabled` interval set (≥ 30 s) + `screenshot` consent + agent screenshots allowed by config; OCR search needs captured `ocrText`. |
| Keyboard tab empty | `keystroke_logging_enabled` + `keystroke` consent; data is aggregate-only by design. |
| Location empty | `location_tracking_enabled` + `location` consent; device must have OS location available. |
| Webcam "not available" | `webcam_relay_enabled` + `webcam_access` consent + camera present; sessions require an active `webcam.start` command from the operator. |
| Websites show only some domains | Bare-domain normalization is by design; the browser extension is optional (`website_native_tracking_enabled`). |
| Agent reports "native addon unavailable" | `worklens_capture.node` missing/ABI mismatch — rebuild with `native/build.ps1` (MSVC v143, SDK 10.0.26100); collectors fail closed. |
| Telemetry stopped mid-day | Consent revoked/policy re-consent required (server 403s + agent pauses), or device revoked. Check consent page and `ConsentLog`. |

## 4. Agent-specific issues

| Symptom | Cause / fix |
|---|---|
| "Pending" forever | Claim not approved (Agent Approvals), or claim expired (30 days) → re-register. Legacy registrations: approve via Agent Registrations. |
| "Conflict" | Single-active-device rule: another device holds the employee slot → admin revokes/removes the other device, then "Try Again". |
| "Rejected/Revoked" | Admin action; re-registration is blocked server-side. Contact admin. |
| Stuck onboarding | Server URL wrong/unreachable — check `OMNISIGHT_SERVER_URL` / `WORKLENSAI_SERVER_URL` (default `http://localhost:3000`). |
| Agent not starting at boot | Ensure it was installed with the NSIS installer; check `%APPDATA%\worklensai-agent` logs. |
| No updates applied | `WL_UPDATE_URL` must be HTTPS; feed checked every 4 h; auto-update disabled when unset. |
| Native messaging host fails | `com.worklensai.website` manifest must be installed (see [omnisight-agent.md](./omnisight-agent.md)); only one browser connection allowed. |

## 5. AI problems

| Symptom | Cause / fix |
|---|---|
| "Data Summary" instead of AI | No provider active, key invalid, provider 429/timeout, or invalid response schema — by design the app falls back honestly. See [AI-GUIDE.md](./AI-GUIDE.md) §7 for codes. |
| Test connection fails | Key wrong (auth failure), or custom base URL not HTTPS/allowlisted (SSRF guard). Ollama: loopback only. |
| `ENCRYPTION_KEY` changed | Existing AI keys can't be decrypted → re-enter provider keys. |
| Rate limited on analysis | `aiWrite` limit is 10/min; screenshot batch analyze ≤ 10 images. |

## 6. Realtime / notifications

| Symptom | Cause / fix |
|---|---|
| Live feed disconnected | `mini-services/live-updates` not running (start with `npm run dev:live`), or client can't reach `:3010` (check Caddy `?XTransformPort=3010`, `NEXT_PUBLIC_LIVE_UPDATES_URL`, `ALLOWED_ORIGIN`). |
| Events missing | The polling engine caps per-model rows per 5 s tick; status transitions are emitted, high-volume repeats may be skipped. |
| Notifications not created | Org notification preferences may disable the type (absent row = enabled); some notifications only fire for specific producers. |

## 7. Jobs / background

| Symptom | Cause / fix |
|---|---|
| Anomalies not detected | Job `anomaly_detection` runs on `JOBS_INTERVAL_SECONDS` (default 3600 s) — runs only while the server process is up; check `JobRun` records. |
| Retention not applied | `retention_cleanup` hourly job; audit/consent logs are anonymized, never deleted (by design). |
| Project time not auto-logged | `project_time_sync` org setting must be enabled; a single active tracking project required for attribution. |

## 8. Performance

| Symptom | Fix |
|---|---|
| Slow dashboard/analytics | The polling engine runs every 5 s; if it's heavy, reduce connected clients or raise the poll interval (config in `mini-services/live-updates`). Queries are indexed by (org, timestamps). |
| Large screenshot storage | Enable retention cleanup; check `uploads/screenshots` growth. |
| Memory growth | In-memory rate limiter + webcam relay are per-process; restart the service to clear. |

## 9. Still stuck?

- Server logs: structured JSON on stdout (`LOG_LEVEL=debug` for more).
- Agent logs: `%APPDATA%\worklensai-agent`.
- Test suites cover most flows — run the relevant suite per [DEVELOPMENT.md](./DEVELOPMENT.md) to compare behavior.
- Open an issue with: environment, exact endpoint (from network tab), request/response bodies (redact secrets), and `JobRun`/audit-log excerpts.
