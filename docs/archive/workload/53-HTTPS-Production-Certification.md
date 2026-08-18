# HTTPS Production Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| Caddy reverse-proxy config present | ✅ PASS |
| HSTS header configured | ✅ PASS |
| Secure session cookies (production) | ✅ PASS |
| CSP configured | ✅ PASS |
| WebSocket upgrade path (Caddy → 3010) | ✅ PASS (config) |
| Live HTTPS request (real TLS handshake) | 🔒 **BLOCKED — no production domain/TLS cert provisioned in this environment** |
| HTTP → HTTPS redirect live test | 🔒 **BLOCKED** |
| Agent HTTPS endpoint test | 🔒 **BLOCKED** |

---

## 1. Config evidence

| Item | Evidence |
|---|---|
| Reverse proxy | `Caddyfile` — `:81` proxies `localhost:3000` (Next.js admin) and `localhost:3010` (live-updates WS) via a fixed `XTransformPort=3010` allowlist |
| TLS | No TLS block/domain in `Caddyfile` (no domain provisioned in this environment). Caddy auto-provisions Let's Encrypt when a `domain { … }` block + public IP/DNS exist |
| HSTS | `next.config.ts` — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (header set in production) |
| Secure cookies | `src/lib/auth.ts` — `secure: process.env.NODE_ENV === 'production'` on the session cookie + clear path |
| CSP | `next.config.ts` + agent renderer CSP `default-src 'none'; script-src 'self'…` |
| WS upgrade | `websocket-provider.tsx` connects `io('/?XTransformPort=3010', { transports: ['websocket','polling'] })` → Caddy allowlist → `localhost:3010`. WSS when the site is HTTPS |
| Agent URL | `desktop-agent/src/main/main.ts` — `WORKLENSAI_SERVER_URL` env (default `http://localhost:3000` dev-only). **Production must set it to `https://…`** |

## 2. Required production configuration

```
Caddyfile:
https://admin.example.com {
    encode zstd gzip
    header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    reverse_proxy localhost:3000 { header_up X-Real-IP {remote_host} … }
    @ws { path /socket.io/* }
    handle @ws { reverse_proxy localhost:3010 }
}
```

`.env.production.example`: `WORKLENSAI_SERVER_URL=https://admin.example.com` (agent), `NODE_ENV=production` (secure cookies).

## 3. Not verified (requires provisioning)

- Real TLS certificate issuance + chain validation
- HTTP→HTTPS redirect live behavior
- Secure-cookie flag observed over a real HTTPS request
- WSS upgrade + agent HTTPS auth/heartbeat/uploads

## 4. Conclusion

Configuration is **production-ready as code**, but the mandatory live-HTTP(S) gate (real request over TLS) cannot be performed without a domain + certificate — **P1 blocker B-05**.
