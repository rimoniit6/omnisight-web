# V1 OPERATIONS READINESS

## Regression / release engineering

| Item | Evidence | Verdict |
|---|---|---|
| Clean typecheck/build | `bun run typecheck` exit 0; `bun run build` exit 0 (web); agent typecheck/build exit 0 | PASS |
| Lint | 0 errors (437 pre-existing warnings) | PASS |
| Full test suite | web 104/104 suites · 1651/1651 · 0 fail; agent 628/628 | PASS |
| `.next/dev/types` corruption guard | `scripts/clean-next-types.mjs` runs before typecheck AND build (package.json) | PASS |
| Canonical package manager | web bun (CI `oven-sh/setup-bun` + `bun install --frozen-lockfile`; bun.lock, package-lock removed); agent npm (package-lock) | PASS |
| CI sequence | web: clean types → typecheck → lint → build → tests; agent: typecheck → tests → build (`.github/workflows/ci.yml`) | PASS |
| Migration drift | `prisma migrate diff` (dev DB → schema) → No difference detected | PASS |
| Additive migrations reproducible | 41 migrations applied cleanly on scratch DB (per-phase evidence; latest in PHASE-5-REPORT §6) | PASS |

## Health / monitoring

| Item | Evidence | Verdict |
|---|---|---|
| App liveness | `/api/health` (public, proxy whitelist) | PASS |
| DB reachability | `/api/health` `database` field (SELECT 1, degrades) + `/api/health/database` (503 only on real outage, safe body) | PASS |
| Storage signal | `/api/health` `storage` driver-config status | PASS |
| No secrets in health | health.test H-1 asserts absence of jwt/password/secret/db-url material | PASS |
| Worker liveness | JobRun rows: status/lastRunAt/lastError/lastResult/lastDurationMs per job — externalized ops signal | PASS (by design) |
| Realtime liveness | socket ping/pong + service logs (`[live-updates]`) | PASS (by design) |
| Error logging | shared logger with request context; safe identifiers only; no credentials/screenshot content | PASS |

## Background jobs inventory (12)

| Job | Lease | Bounded | Retry | Restart safe | Org scoped | Observable |
|---|---|---|---|---|---|---|
| expire_consents | JobRun | batch | next run | yes | per-org | lastResult |
| retention_cleanup | JobRun | per-org | next run | yes | per-org | counts + errors |
| project_time_sync | JobRun | cursor/buckets | next run | yes | per-org | counts |
| anomaly_detection | JobRun | per-org | next run | yes | per-org | counts |
| agent_token_sweep | JobRun | expired rows | next run | yes | per-org | counts |
| rate_limit_sweep | JobRun | stale rows | next run | yes | global-bounded | counts |
| device_integrity | JobRun | per-org devices | next run | yes | per-org | dedupe-keyed anomalies |
| user_session_sweep | JobRun | expired+revoked | next run | yes | global | counts |
| audio_transcription | JobRun | bounded queue | bounded | yes | per-org | processed/failed |
| screenshot_processing | JobRun | `uploaded` batch cap | 3 max | yes | per-org | processed/failed |
| workday_summary | JobRun | day window | whole-day upsert | yes | per-org | summary counts |
| alert_rule_evaluation | JobRun | org-local day | cooldown | yes | per-org | alerts/suppressed |

All claims use the atomic `claimJob` UPDATE (no TOCTOU), stale leases expire
after 5 minutes, and `finishJob` records success/failure + results.

## Production configuration

| Item | Evidence | Verdict |
|---|---|---|
| `.env.example` hygiene | placeholders only (verified values) | PASS |
| Committed secrets | git scan clean | PASS |
| Session cookie | httpOnly + SameSite=lax | PASS |
| HTTPS Secure flag | requires deployment TLS — env dependent | NOT VERIFIED |
| Hosted DB/storage creds | env only | NOT VERIFIED |
| Caddy/proxy + CORS origin | repo Caddyfile + ALLOWED_ORIGIN code paths | PASS (code); NOT VERIFIED (deployed) |
| Realtime config | LIVE_UPDATES_PORT / NEXT_PUBLIC_LIVE_UPDATES_URL / ALLOWED_ORIGIN | PASS (code) |
| Backup/restore | `scripts/pg-backup-restore-certification.mjs` present | NOT VERIFIED (no environment drill) |

## Performance / scale notes

- Bounded hot paths: summary-first dashboard reads, keyset/cursor
  pagination, realtime per-table `take` caps + durable cursor, per-org job
  windows, 50-rule org caps.
- Synthetic evidence in gate: classification 100 orgs × 100 rules × 10k
  activities ≈1.6 s; aggregation 3.6M rows ≈362k rows/s.
- Full-scale production load (1M screenshots/month, 1k+ sockets) is
  **NOT VERIFIED** in this workspace.

## Rollback plan (V1)

Every V1 feature ships behind an OFF-by-default org flag
(`activity_dedupe`, `server_classification`, `alert_rules_enabled`) with
additive migrations. Rollback = disable flag → revert additive code →
optionally drop the additive tables after confirming no code path depends on
them. No V1 path deletes or rewrites existing telemetry. Feature-flag
rollback procedures are documented per phase report (PHASE-1/3/5-REPORT).

## Operations verdicts

Health/Observability: **PASS** · Jobs/Reliability: **PASS** · Production
Configuration: **PASS (code) / NOT VERIFIED (deployment)** · Regression:
**PASS** · Performance evidence: **PASS (synthetic) / NOT VERIFIED (full
scale)** · Backup/Restore: **NOT VERIFIED**

**No blockers.**
