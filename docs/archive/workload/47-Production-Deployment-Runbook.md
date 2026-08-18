# WorkLensAI — Production Deployment Runbook

## 0. Prerequisites

- Node.js 24+ (verified v24.14.0 in this build)
- npm 11+
- A reverse proxy (Caddy provided in the repo; nginx works too)
- A database: SQLite (current) or PostgreSQL (intended — requires provider switch)
- TLS certificate (Caddy auto-provisions Let's Encrypt)

---

## 1. Pre-Deployment

```bash
# 1. Backup the database (see workload/46).
# 2. Record the current application version:
cat package.json | grep '"version"'
```

---

## 2. Deploy Code

```bash
cd /e/Workslens/workai

# 3. Pull the release:
git pull origin main

# 4. Install dependencies (clean):
npm ci

# 5. Generate the Prisma client:
npx prisma generate

# 6. Apply migrations (PRODUCTION — never `db push`):
npx prisma migrate deploy

# 7. Build the production bundle:
npm run build
```

> **Production migration mechanism is `prisma migrate deploy`.** The `db:push` script exists for development only (`npm run db:push`) and must NEVER be used as the production migration mechanism. The migration gate was verified: `prisma migrate deploy` applied all 28 migrations successfully on a fresh database (Phase E).

---

## 3. Environment

```bash
# 8. Copy the production env template and fill real values:
cp .env.production.example .env
#    - DATABASE_URL (production database)
#    - JWT_SECRET (openssl rand -base64 48)
#    - ENCRYPTION_KEY (32-byte hex, independent from JWT_SECRET)
#    - SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
#    - WORKLENSAI_SERVER_URL (https://...)
#    - WL_UPDATE_URL (https://... or leave empty to disable updates)
```

Never commit `.env`.

---

## 4. Reverse Proxy (Caddy)

The provided `Caddyfile` listens on :81 and proxies:
- `localhost:3000` → Next.js admin app
- `localhost:3010` (via `?XTransformPort=3010`) → Live Updates WebSocket

For production, replace the listen address with your domain:
```caddyfile
worklensai.yourcompany.com {
    reverse_proxy localhost:3000
}
```

Caddy auto-provisions TLS. HTTP→HTTPS redirect is automatic in Caddy.

---

## 5. Start the Application

```bash
# 9. Start the production server:
NODE_ENV=production npx next start -p 3000
```

Or use a process manager:
```bash
npm i -g pm2
pm2 start "npm run start" --name worklensai
pm2 save
```

---

## 6. Post-Deployment Verification

```bash
# 10. Health checks:
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/health/database

# 11. Verify login:
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}'

# 12. Verify Admin APIs (expect 401 without a token, 200 with):
curl -s http://localhost:3000/api/employees
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/employees

# 13. Verify agent API:
curl -s -X POST http://localhost:3000/api/agent/discover \
  -H 'Content-Type: application/json' \
  -d '{"deviceKey":"test-key-16-chars","hostname":"test"}'
#    → 400 (invalid deviceKey) proves the route is live without creating state

# 14. Verify WebSocket (if live-updates deployed):
#    Client connects to wss://...:3010

# 15. Verify consent enforcement (expect 403 without consent):
#    (via an approved device token — see ZT-21/22/23 tests)

# 16. Verify zero-touch discovery → approval → auto-auth flow:
#    Run scripts/zt-b5-e2e.mjs against the production URL
```

---

## 7. Desktop Agent Release

```bash
cd desktop-agent
npm ci
npm run typecheck
npm test
npm run build
npm run package:agent        # electron-builder --win (NSIS)
```

Record the installer SHA-256 (see workload/49 §Agent Release).

---

## 8. Restart Supporting Services

```bash
# 17. Restart the live-updates WebSocket service (if deployed):
#     (mini-services/live-updates — not yet deployment-certified)
# 18. Restart the Next.js process (pm2 restart worklensai or re-run step 9)
```

---

## 9. Rollback

See workload/48 §Rollback for the full procedure. Summary:
- **Application:** redeploy the previous tag (`git checkout <prev-tag>` + rebuild).
- **Database:** restore the pre-deployment backup (workload/46). Never blindly run `prisma migrate rollback` on additive migrations.

---

## 10. Deployment Checklist (final)

| # | Step | Done |
|---|------|------|
| 1 | Backup database | ☐ |
| 2 | `git pull` | ☐ |
| 3 | `npm ci` | ☐ |
| 4 | `npx prisma generate` | ☐ |
| 5 | `npx prisma migrate deploy` | ☐ |
| 6 | `npm run build` | ☐ |
| 7 | Configure `.env` | ☐ |
| 8 | Update Caddyfile domain | ☐ |
| 9 | Start Next.js | ☐ |
| 10 | Health check `/api/health` | ☐ |
| 11 | Health check `/api/health/database` | ☐ |
| 12 | Login works | ☐ |
| 13 | Admin APIs work | ☐ |
| 14 | Agent API live | ☐ |
| 15 | Consent enforcement 403 | ☐ |
| 16 | Zero-touch flow works | ☐ |
| 17 | Restart supporting services | ☐ |