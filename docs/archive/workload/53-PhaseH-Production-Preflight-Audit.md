# Phase H — Production Preflight Audit

> Project: WorkLensAI — read-only audit performed before any Phase H changes
> Date: 2026-08-10
> Verdict basis: verified current repository state, not prior reports.

---

## 1. Repository State

| Area | Status | Evidence |
|---|---|---|
| PostgreSQL provider | PASS | `prisma/schema.prisma` → `provider = "postgresql"`; baseline migration `20260810105722_postgresql_initial`; 29 SQLite migrations archived (not deleted) |
| Production DB config | PASS | `.env` → `DATABASE_URL=postgresql://…@localhost:5432/workai?schema=public`; `.env.example` has placeholders only |
| Zero-touch system | PASS | `src/app/api/agent/*`, `src/app/api/device-claims/*`, `src/lib/agent/auth.ts` all present and PG-tested (29/29) |
| Consent system | PASS | `Consent`/`ConsentPolicy`/`ConsentLog` + `src/lib/consent.ts` — semantics unchanged, 27/27 |
| Agent (desktop) | PASS | Main-process runtime independent of window; zero-control renderer |
| Test harness | PASS | All 4 backend suites run against throwaway PG DBs; desktop 111/111 |

## 2. Security Findings (verified against actual code)

### CRITICAL (fixed in this phase)
- **S1. `.env` was tracked in git** — committed in the initial commit with real `JWT_SECRET`, `SUPER_ADMIN_PASSWORD`, `ENCRYPTION_KEY`, `DATABASE_URL` credentials. `.gitignore` added later doesn't untrack already-tracked files. **Fixed:** `git rm --cached .env db/custom.db* prisma/db/custom.db .freebuff/desktop-v2.db*` — files remain on disk, no longer staged. (Rotating the secrets in a real deployment is still recommended since they exist in git history.)
- **S2. DB backup files tracked** — `db/custom.db`, `.bak-phase2`, `.bak-phase2b`, `.bak-phase3`, `prisma/db/custom.db`, `.freebuff/desktop-v2.db*` — **Fixed** (untracked, kept on disk).

### PASS (verified fixed from historical audits)
- **Agent passwords hashed** — `verifyAgentPassword` (bcrypt with legacy plaintext migration) in `src/lib/agent/auth.ts`; no plaintext comparison in `/api/agent/authenticate`.
- **No credential fallbacks** — `getSuperAdminCredentials` throws if env unset; no `Admin@2025`/`admin123` fallbacks in `src/lib/auth.ts`.
- **Claim secrets hashed** — sha256, constant-time compare (`verifyClaimSecret`).
- **Rate limiting** — agent auth/discover/heartbeat/writes all centrally limited; spoof-resistant client IP (rightmost XFF / x-real-ip).
- **`Math.random` removed** — `generateToken` always `randomBytes` (ZT-28).
- **No secrets to renderer** — renderer receives only `getStatusForRenderer()` snapshot; AgentToken/device secret never cross the preload boundary.
- **Renderer isolation** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP `default-src 'none'`, navigation + `window.open` denied.

### WARNINGS (noted, no change needed for certification)
- **S3. Dev demo credentials** — `src/lib/seed.ts` and E2E scripts contain `admin@techvision.com / admin123` (matches the seed's demo org). These are dev bootstrap only; production super admin comes from env vars. Flagged for cleanup before any external distribution.
- **S4. In-memory rate limiter** — per-process; adequate for single-instance, documented (P3).
- **S5. Legacy IPC channels** — `agent:enroll`, `agent:authenticate`, `agent:pause/resume/logout` still exist in preload/IPC for backward compatibility, but the zero-control renderer never calls them (verified). They are unreachable from the production UI.

## 3. Zero-Control Employee UI (source + dist + packaged ASAR)

| Check | Status |
|---|---|
| Renderer source (`src/renderer/*`) | PASS — read-only status views only (onboard/pending/rejected/revoked/offline/status) |
| Renderer compiled (`dist/renderer/*`) | PASS — 0 matches for employee-ID/password/register/connect/change-account patterns |
| Packaged ASAR (`out/win-unpacked/resources/app.asar`) | PASS — 0 legacy control strings; renderer byte-identical to dist |
| Window close behavior | PASS — closes → hides to tray, runtime continues |
| Tray | PASS — only "Open Agent"; **no Quit item** (admin-controlled lifecycle) |
| Single instance | PASS — `requestSingleInstanceLock`; second launch focuses existing window |
| Regression test | PASS — `desktop-agent/tests/zero-control-renderer.test.ts` asserts 7 forbidden-control patterns |

## 4. Windows Background Execution

| Check | Status |
|---|---|
| Auto-start with Windows | PASS — `app.setLoginItemSettings({ openAtLogin })`, default `autoStart: true` |
| Runtime survives window close | PASS — `window-all-closed` no-op on Windows; close event prevents default + hides |
| Runtime survives logout/reboot | PASS (login-item) — restarts with user session; **NOT VERIFIED** pre-login (no Windows Service) |
| Crash recovery | PASS (login-item) — Windows restarts login items; bounded retry/backoff in agent |
| Duplicate process | PASS — single-instance lock |
| Duplicate device identity | PASS — stable `Device.agentKey` (HMAC-bound, encrypted at rest) |
| **Windows Service** | **NOT IMPLEMENTED** — login-item architecture chosen deliberately (session-bound monitoring agent; a service would duplicate the runtime). Documented as a deployment decision; residual gap: no pre-login presence. |

## 5. Installer / Update

| Check | Status |
|---|---|
| NSIS installer | PASS — builds (`WorkLensAI Agent Setup 1.1.0.exe`, 82.1 MB) |
| Signing | **NOT VERIFIED** — no certificate in env; electron-builder auto-signs when `CSC_LINK` present (scaffolded) |
| Source↔packaged renderer | PASS — byte-identical (hash-verified) |
| Native addon | PASS — packaged (`resources/native/worklens_capture.node`, 134 KB) |
| Identity on uninstall | PASS — `deleteAppDataOnUninstall: false` (userData preserved) |
| Auto-update | **NOT VERIFIED** — `publish: null`; update service is HTTPS-only (`WL_UPDATE_URL` must be `https://`) and no-op when unset. No deployed feed exists. |

## 6. HTTPS / TLS

| Check | Status |
|---|---|
| Caddy reverse proxy | PASS (config exists) — `:81` proxies to Next (3000) + live-updates (3010); XFF/X-Real-IP set |
| HTTPS / TLS | **NOT VERIFIED** — Caddyfile is plain HTTP; no domain/certificate infrastructure in this environment |
| HTTP→HTTPS redirect, HSTS | **NOT VERIFIED** — not configured (absent) |
| Agent over HTTPS | **NOT VERIFIED live** — `WORKLENSAI_SERVER_URL` env-driven (default `http://localhost:3000` for dev); production must set an `https://` URL |

## 7. Database

| Check | Status |
|---|---|
| `prisma migrate deploy` (never `db push`) | PASS — production path documented and verified on fresh DB |
| 29 tables / FKs / unique indexes | PASS — verified via `scripts/pg-audit.sql` + backup/restore certification (Part 4) |
| Concurrency (one active device per employee) | PASS — `FOR UPDATE` employee lock (ZT-27) |
| Timestamps / UTC | PASS — round-trip verified in Phase G |

## 8. Performance Baseline (real measurements, PostgreSQL)

`scripts/perf-baseline.mjs` against live `workai` DB (P50 in µs): login lookup 410, device list 420, employee list+search 470, project list 470, consent state 460, consent policy 447, audit page 528, claim list 524, discover lookup 410, claim-by-device 408, config 341, heartbeat 423, activity insert (rolled-back tx) 1069, screenshot insert 1034, connect+query 1331 µs. No N+1/unbounded queries observed on the measured surface.

## 9. Summary Classification

| Area | Verdict |
|---|---|
| PostgreSQL production DB | **PASS** |
| Zero-touch + consent + security tests | **PASS** (101/101 backend) |
| Zero-control employee agent | **PASS** |
| Windows background runtime | **PASS** (login-item; service not implemented) |
| Backup/restore | **PASS** (Part 4 executed) |
| Installer | **PASS** (fresh build, hash-verified) |
| Auto-update | **NOT VERIFIED** |
| HTTPS/TLS live | **NOT VERIFIED** |
| Clean machine | **NOT VERIFIED** |
| Windows Service | **NOT IMPLEMENTED** (documented decision) |
| Code signing | **NOT VERIFIED** (no cert) |
