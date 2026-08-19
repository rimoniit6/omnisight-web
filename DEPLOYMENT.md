# OmniSight — Deployment

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

How to deploy the server, the realtime mini-service, and the desktop agent to production.

Related docs: [INSTALLATION.md](./INSTALLATION.md) · [PRODUCTION.md](./PRODUCTION.md) (Phase 3 hardening) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ADMIN-GUIDE.md](./ADMIN-GUIDE.md)

---

## 1. Reference topology

```
Internet ──► Caddy (TLS termination; repo Caddyfile) ──► :3000 Next.js standalone
                                                   └──► :3010 live-updates (Socket.IO)
                                                          PostgreSQL  ──► uploads/ (screenshots)
```

The repo `Caddyfile` binds `:81` and proxies:
- `*` → `http://localhost:3000`
- paths with `?XTransformPort=3010` query → `http://localhost:3010` (realtime upgrade path)

## 2. Build & serve

1. `npm ci` → `npm run build` → `node scripts/copy-standalone.js` (copies standalone output + `uploads/` layout to `dist/`).
2. Serve `dist/` with `npm run start` (or your process manager). The app itself serves HTTP — terminate TLS at the edge (Caddy/nginx).
3. Realtime: `mini-services/live-updates` — `npm run dev:live` in dev; for prod, run with a process manager (systemd/supervisor/pm2) or Dockerize; env: `DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGIN` (comma-separated origins), `LIVE_UPDATES_PORT` (3010).
4. Environment: copy `.env.production.example` → `.env.production`; set `DATABASE_URL`, `JWT_SECRET` (≥ 32 random bytes), `ENCRYPTION_KEY` (32-byte key, base64), `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD` (first run only), `ALLOWED_ORIGIN`, `LIVE_UPDATES_URL` (`https://<host>/` — used with Caddy transform) or `NEXT_PUBLIC_LIVE_UPDATES_URL`.
5. Migrations: `npm run db:deploy` (runs `prisma migrate deploy`). Postgres is the **only supported production database**.
6. Bootstrap: `npm run bootstrap:super-admin`, then log in as Super Admin and create the organization.
7. Verification: `GET /api/health` and `GET /api/health/database` return 200; admin dashboard loads; realtime badge shows connected.

## 3. Desktop agent deployment

1. Build the installer on a Windows machine with MSVC v143 + SDK 10.0.26100 + node-gyp:
   ```bash
   AGENT_SERVER_URL=https://your-server.example.com AGENT_ENROLLMENT_CODE=<code> node omnisight-agent/scripts/build-prod.mjs
   ```
   Alternatively, use the CI pipeline if configured. The build produces an NSIS installer under `uploads/agent-builds`.
2. Distribute the installer (intranet share / MDM). Set `WL_UPDATE_URL` to an HTTPS feed for auto-updates (unset = updates disabled).
3. On each Windows machine: install, launch; agent onboards (server URL default `http://localhost:3000` — override via `OMNISIGHT_SERVER_URL`/`WORKLENSAI_SERVER_URL` or bake `AGENT_SERVER_URL` at build time).
4. Approve devices in **Agent Approvals** (employee-bound) or **Guests**; legacy registrations via **Agent Registrations**.

## 4. Operational notes

| Item | Note |
|---|---|
| Uploads | `uploads/screenshots` must be backed up with the DB; served only via authenticated routes with `nosniff`. |
| Backups | DB dump or `VACUUM INTO` (see PRODUCTION.md); also back up `uploads/`. |
| Secrets rotation | Rotating `JWT_SECRET` signs everyone out; rotating `ENCRYPTION_KEY` makes AI keys undecryptable — re-enter them. |
| Multiple instances | The rate limiter is in-memory (per-process) — a load-balanced multi-instance setup weakens rate limits; pin to a single instance, or move limiting to the edge. |
| Live-updates | Single instance; the polling engine holds one DB cursor. |
| Background jobs | Run on the main server process (hourly per `JOBS_INTERVAL_SECONDS`); keep one instance running `jobs` or the process alive. |
| Logging | Structured JSON to stdout; `LOG_LEVEL=debug` for verbose; secrets redacted. |
| Health | `/api/health`, `/api/health/database`; monitor both + realtime connectivity. |
| Operations | `PRODUCTION.md` is the PostgreSQL operations guide (backup/restore, env vars, realtime latency model, rate-limiter single-instance rule). SQLite is not supported in production. |

## 5. TLS / proxy checklist

- [ ] HTTPS terminates at the edge; app behind it sees `X-Forwarded-*` (Caddy handles this)
- [ ] CSP/HSTS/nosniff headers (set by `next.config.ts`) reach clients
- [ ] `ALLOWED_ORIGIN` matches the real origins (used by realtime CORS)
- [ ] Realtime reachable from the browser: either `NEXT_PUBLIC_LIVE_UPDATES_URL` or the Caddy `?XTransformPort=3010` rewrite
- [ ] `WL_UPDATE_URL` for the agent is HTTPS

## 6. Rollout

1. Stage → prod with the same DB migration sequence (`db:deploy`).
2. After deploy: check health endpoints, log in as super admin, verify one device end-to-end (approve → consent → heartbeat → activity row).
3. Enable monitoring features incrementally (settings + consent + policies), then roll out the agent fleet.
4. See [PRODUCTION.md](./PRODUCTION.md) for the full Phase-3 security hardening checklist (6 items documented as still open there).
