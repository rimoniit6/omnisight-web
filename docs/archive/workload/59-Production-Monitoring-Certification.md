# Production Monitoring Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| `/api/health` endpoint exists + safe | ✅ PASS |
| `/api/health/database` endpoint exists + safe | ✅ PASS |
| No secrets exposed by health endpoints | ✅ PASS (code-verified) |
| Structured logging + redaction | ✅ PASS (`src/lib/logger.ts`) |
| Agent heartbeat freshness observable (admin) | ✅ PASS (`lastHeartbeat` in device routes/UI) |
| External uptime/alerting integration provisioned | 🔒 **NOT VERIFIED — external service provisioning required** |

---

## 1. Internal health endpoints (verified)

- `GET /api/health` → `{ status, uptime, timestamp, version }` — no credentials/env/stack traces.
- `GET /api/health/database` → `{ status: ok|error, latencyMs }` (503 on unreachable DB) — no schema/query detail.

Both are safe for public uptime monitors.

## 2. Admin observability (device diagnostics without touching the PC)

- Device status, last heartbeat, agent version, claim status, online/offline — all server-backed and displayed in the admin UI (verified in Phase D/E audits).

## 3. External monitoring — integration requirements (not yet provisioned)

| Monitor | Endpoint/Data | Suggested tool |
|---|---|---|
| Uptime | `https://admin.example.com/api/health` every 60s | UptimeRobot / Healthchecks.io |
| DB availability | `https://admin.example.com/api/health/database` every 60s | same |
| Disk/upload storage | `df` on `uploads/` + DB size (retention job already bounds growth) | server agent / cron |
| Agent heartbeat freshness | Admin API devices endpoint (alert on `lastHeartbeat` > 3× interval) | scheduled job / external API poll |
| Error rate | structured logs (`/var/log/worklens/`) + `AuditLog`/`JobRun` tables | log shipper / dashboard |
| WebSocket availability | socket.io health (service up on 3010) | process monitor |

Requirements: no secrets in any probe; alerts for app-down, DB-down, disk>85%, heartbeat spike,
upload-failure spike (all documented in `workload/48` §Operational monitoring).

## 4. Conclusion

Internal health + logging + observability are in place and verified. External monitoring is a
provisioning task (P3, B-09) — exact integration requirements documented above; the product
gate remains **NOT VERIFIED until provisioned**.
