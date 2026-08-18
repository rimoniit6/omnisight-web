# WorkLensAI — Deployment Guide

> **File:** workload/14-Deployment.md · **Created:** 2026-08-02
> Target: Phase 1 (Sprint 02) packaging. Sections are "planned" until validated on a fresh machine; each validated section gets marked ✅. The reference architecture: **Docker Compose (web + db + storage volume)** with a **native Node install path** as fallback.

**Reference matrix:**

| Deployment | Recommended | Notes |
|---|---|---|
| Ubuntu 22.04+ (VPS/VM) | ✅ Docker Compose | Primary supported path |
| Windows Server 2019/2022 | Docker Desktop/Engine OR native | Native path documented for AD shops |
| Shared hosting (no Docker) | ⚠ Native Node — support-limited | Not primary; buyer beware |

**Env vars (see `.env.example`):**

```env
DATABASE_URL=file:../db/custom.db        # or postgres://… (Phase 3)
NEXTAUTH_SECRET=<strong-random-32+>      # REQUIRED in production
STORAGE_PATH=./data/screenshots           # screenshot/OCR storage volume
PORT=3000
SMTP_HOST=… SMTP_PORT=587 SMTP_USER=… SMTP_PASS=… SMTP_FROM=…   # Phase 2
AI_KEY_ENCRYPTION_SECRET=<random-32+>     # encrypts stored AI provider keys
```

---

## 1. Ubuntu (Docker Compose)

```bash
# 1) Prereqs
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
# 2) Get package
#    (from the buyer download: extract worklensai-v1.0.tar.gz)
tar xzf worklensai-v1.0.tar.gz && cd worklensai
# 3) Configure
cp .env.example .env && nano .env        # set NEXTAUTH_SECRET, STORAGE_PATH
# 4) Start
sudo docker compose up -d
# 5) Verify
curl -fsS http://localhost:3000/api/health   # health endpoint
```
- Open firewall ports: `80/443` (via Nginx) + optional `3000` (direct).
- Volumes: PostgreSQL data (external/volume) + `wl-storage` (screenshots) — back these up.

## 2. Ubuntu (Native Node — no Docker)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
# extract package, then:
npm ci --omit=dev && npx prisma migrate deploy && npx prisma generate && NODE_ENV=production node .next/standalone/server.js
```
- Run under a dedicated user + `systemd` unit (unit file shipped in `deploy/`).

## 3. Windows Server (Native)

1. Install Node.js 20 LTS (x64) on the server.
2. Extract package to `C:\WorkLensAI`; copy `.env.example` → `.env`; set secrets.
3. `npm ci --omit=dev`, then `npx prisma migrate deploy && npx prisma generate` (NEVER `db push` in production).
4. Register as a service: `nssm install WorkLensAI "C:\Program Files\nodejs\node.exe" ".next\standalone\server.js"` (or use Task Scheduler).
5. Docker Desktop on Windows Server (containers mode) also supported via `docker compose up -d`.

## 4. Docker (compose reference)

```yaml
# deploy/docker-compose.yml (shipped in v1.0)
services:
  app:
    image: worklensai:v1.0          # or build: .
    ports: ["3000:3000"]
    env_file: .env
    volumes:
      - wl-db:/var/lib/postgresql/data   # PostgreSQL data volume
      - wl-storage:/app/data/screenshots
    restart: unless-stopped
    healthcheck: { test: ["CMD","curl","-f","http://localhost:3000/api/health"], interval: 30s }
volumes:
  wl-db: {}
  wl-storage: {}
```
> Image is built from `.next/standalone`; static assets copied in (see `scripts/copy-standalone.js`).

## 5. Nginx (reverse proxy + HTTPS)

```nginx
# /etc/nginx/sites-available/worklensai
server {
    listen 80;
    server_name lens.example.com;
    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host;
                 proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                 proxy_set_header X-Forwarded-Proto $scheme; }
    client_max_body_size 50m;   # screenshot uploads
}
```
Then `sudo certbot --nginx -d lens.example.com` (SSL below).

## 6. Apache (reverse proxy)

```apache
# a2enmod proxy proxy_http ssl
<VirtualHost *:443>
    ServerName lens.example.com
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/lens.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/lens.example.com/privkey.pem
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```

## 7. SSL

- **Recommended:** Let's Encrypt via Certbot (`sudo certbot --nginx -d lens.example.com`), auto-renew enabled by default.
- **Alternative:** Caddy (shipped `Caddyfile` in repo uses port 81 demo) — one-file TLS (`lens.example.com { reverse_proxy localhost:3000 }`).
- Force HTTPS + set `NEXTAUTH_URL`/cookie `secure` flag (`NODE_ENV=production` already sets it).

## 8. SMTP (Phase 2 — notifications & password reset)

- Configure `SMTP_HOST/PORT/USER/PASS/FROM` in `.env`; UI under Settings → Alerts.
- Test: send test email from admin Settings.
- Supported: any SMTP (Gmail app password, SendGrid SMTP, transactional providers).

## 9. AI Providers (BYOK)

- In-app: **AI Providers** → add provider → choose type (OpenAI, Gemini, Claude, OpenRouter, DeepSeek, Qwen, Ollama…) → paste **your own** key + model + base URL.
- Local: Ollama — install Ollama on the server, add provider with `baseUrl=http://localhost:11434`, model `llama3`.
- Keys are **encrypted at rest** and **masked in UI** (Sprint 01).
- No traffic leaves the server except to the buyer's chosen provider.

## 10. Windows Agent

1. Install the signed MSI/EXE on each employee PC (silent: `WorkLensAI-Agent-setup.exe /S /ServerURL=https://lens.example.com`).
2. First run: device registers; admin approves/enables it in Devices.
3. Group Policy / Intune rollout documented in the agent guide.
4. Firewall: agent → server 443 outbound only; no inbound required.
5. Policy (screenshot interval, private time) pushed from server once config-push ships (v0.3).

---

## Validation matrix (Sprint 02 DoD)

- [ ] Ubuntu fresh VM: Docker path → health OK, agent registers, data flows
- [ ] Windows Server: native path boots; agent installs
- [ ] Nginx + Certbot HTTPS verified
- [ ] Apache config verified (or documented as community-provided)
- [ ] Backup/restore of volumes verified (12-Release-Checklist Backup/Restore)
