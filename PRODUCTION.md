# OmniSight — Production Operations Guide

Operational guide for the **PostgreSQL** production deployment. Companion docs:
[DEPLOYMENT.md](./DEPLOYMENT.md) (deploy/rollout) · [INSTALLATION.md](./INSTALLATION.md)
(install + requirements) · [SECURITY.md](./SECURITY.md) (threat model).

> **Historical note:** earlier revisions of this document described a SQLite
> demo deployment. **PostgreSQL is the only supported production database**
> (`db/*.db` files are legacy development artifacts; SQLite was migrated out —
> see `docs/archive/workload/51-PostgreSQL-Migration-Report.md`).

---

## 1. Reference topology

```
Internet ──► Caddy (TLS termination; repo Caddyfile) ──► :3000 Next.js standalone
                                                    └──► :3010 live-updates (Socket.IO)
                                                           PostgreSQL
                                                              │
                                                              └──► uploads/ (screenshots)
```

- **One application instance** is the supported topology (see §6 — the rate
  limiter is in-memory and the realtime service is single-instance).
- All application state lives in PostgreSQL; file artifacts live under
  `uploads/` and are referenced by DB rows.
- TLS terminates at the edge; the app trusts `x-real-ip` / the right-most
  `x-forwarded-for` entry via the canonical resolver (`src/lib/client-ip.ts`).

### Workload profile (PostgreSQL)

| Workload | Frequency | Volume | Notes |
| --- | --- | --- | --- |
| Agent heartbeats | 15–60 s per agent | ~1 row/min per agent | covered by `@@index([updatedAt])` |
| Activity submissions | per agent window | hundreds–thousands/day | `@@index([employeeId, timestamp])`, `@@index([timestamp])`, `@@index([category, timestamp])` |
| Screenshot uploads | per policy | PNGs on disk, rows in DB | `@@index([employeeId, capturedAt])` |
| Analytics | read-mostly, 90-day max window | DB-side aggregation | see §5 — no full-table loads |
| Realtime poll | every 5 s | bounded per-table `take` | see §4 |
| Concurrent admins | 1–5 | read-mostly | — |

Run `EXPLAIN ANALYZE` on the hot queries after any schema change; the schema
already carries composite indexes for the primary list/sort paths.

---

## 2. Backup & Recovery

### Database backup (PostgreSQL) — certified procedure

The certified, executed-and-verified procedure lives in
`scripts/pg-backup-restore-certification.mjs` (it takes a `pg_dump` of the
source DB, restores into a throwaway DB, and verifies row counts, foreign
keys, unique constraints, and application connectivity). Run it manually:

```bash
node scripts/pg-backup-restore-certification.mjs
# Env: PG_BASE_URL (default postgresql://postgres:123456@localhost:5432)
#      PGBIN      (default C:\Program Files\PostgreSQL\18\bin — the pg_dump/pg_restore/psql tools)
#      SOURCE_DB  (default workai)
# Output: backups/pg/workai-<timestamp>.dump  (pg_dump --format=custom --compress=9)
```

For a plain scheduled backup without the restore-certification steps:

```bash
mkdir -p /var/backups/workai
pg_dump --format=custom --compress=9 --no-owner \
  "$DATABASE_URL" > "/var/backups/workai/workai-$(date +%F).dump"
```

`pg_dump --format=custom` is non-locking for readers and safe to run against a
live database.

Automate with cron, keep **14 days of daily backups and one monthly archive**,
and store copies off-host (separate volume / object storage):

```cron
30 2 * * * PGPASSWORD=... pg_dump --format=custom --compress=9 --no-owner postgresql://user:pass@host:5432/workai > /var/backups/workai/workai-$(date +\%F).dump && find /var/backups/workai -name 'workai-*.dump' -mtime +14 -delete
```

### Upload storage backup

Screenshots live in `uploads/` (server-referenced via DB rows). Back up the
directory with the same cadence:

```bash
tar -czf /var/backups/workai-uploads-$(date +%F).tgz uploads/
```

### Restore process

```bash
# 1. Stop the app (and the live-updates service)
systemctl stop omnisight   # adjust to your unit/process-manager name

# 2. Restore the database into a fresh database first, then swap, OR drop+restore
createdb workai_restore
pg_restore --dbname=workai_restore --no-owner /var/backups/workai/workai-2026-08-07.dump
# verify row counts / connectivity, then:
#   dropdb workai && createdb workai && pg_restore --dbname=workai --no-owner <backup>

# 3. Restore uploads
rm -rf uploads && tar -xzf /var/backups/workai-uploads-2026-08-07.tgz

# 4. Start
systemctl start omnisight
```

### Migration & rollback

- Schema changes are applied with `npx prisma migrate deploy` (never
  `prisma db push` against production — it has no migration history).
- **Rollback = restore the pre-migration backup** taken immediately before the
  `migrate deploy` run. Keep that backup until the new schema has run clean
  for a full cycle.

### Secret recovery

Secrets live only in `.env` (never committed; `.env*` is gitignored with
`.env.example` allowed). Recovery plan:

- `JWT_SECRET` / `ENCRYPTION_KEY`: **back up `.env` to a password manager or
  encrypted store.** Losing `JWT_SECRET` signs everyone out (agents re-auth via
  their device tokens; users must re-login). Losing `ENCRYPTION_KEY` makes
  stored AI provider keys undecryptable — re-enter them on the AI Settings page.
- `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`: re-run
  `npx tsx scripts/bootstrap-super-admin.ts` in a maintenance window (it only
  creates the account when absent).

---

## 3. Environment configuration

See `.env.production.example` for the full annotated list. Required in production:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | `postgresql://user:pass@host:5432/workai?schema=public` — **PostgreSQL only** |
| `JWT_SECRET` | yes | ≥ 32 random chars; `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | no | default `7d`. Web sessions are server-authoritative: every login creates a `UserSession` row (JWT carries `sessionId`; revoked/expired rows reject the token at the proxy + handlers). Logout revokes the row; `/api/auth/sessions/revoke-all` kills every session; admins force-logout via `/api/auth/users/[id]/revoke-sessions`; account disable and password change revoke sessions too. Expired/revoked rows are swept hourly by the `user_session_sweep` job |
| `SUPER_ADMIN_EMAIL` | yes | bootstrap only |
| `SUPER_ADMIN_PASSWORD` | yes | bootstrap only; `openssl rand -base64 18` |
| `ENCRYPTION_KEY` | yes | 32-byte hex; AES-256-GCM for AI keys at rest. **Mandatory in production** — missing/too-short fails fast; `JWT_SECRET` is never used as a fallback. Dev-only: unset auto-generates `.worklens/dev.key` |
| `SESSION_COOKIE_NAME` | no | default `worklens_token` |
| `NODE_ENV` | yes (prod) | set by the start script |
| `ALLOWED_ORIGIN` | yes | realtime CORS; comma-separated origins |
| `LIVE_UPDATES_PORT` | no | default `3010` |
| `LIVE_UPDATES_URL` / `NEXT_PUBLIC_LIVE_UPDATES_URL` | one of | browser→socket endpoint (`https://<host>/` with the Caddy transform, or a direct `ws://` URL) |
| `JOBS_INTERVAL_SECONDS` | no | background-jobs cadence (hourly default); jobs run on the main server process |

### ENCRYPTION_KEY lifecycle

- **Independent from `JWT_SECRET` by design.** Rotating `JWT_SECRET` never
  invalidates stored AI credentials.
- **Production:** required; missing/short keys make secret operations throw
  immediately (fail fast).
- **Development:** unset → a random per-workspace key is generated once and
  persisted to `.worklens/dev.key` (gitignored).
- **Rotation:** rotating `ENCRYPTION_KEY` makes previously stored values
  undecryptable — re-enter AI keys after rotation.

---

## 4. Realtime service (`live-updates`)

The WebSocket mini-service (`mini-services/live-updates`, Socket.IO on
`:3010`) validates the same `JWT_SECRET`, reads the same PostgreSQL database,
and joins every socket to an organization-scoped room — cross-tenant events are
impossible. It is **poll-driven, not push**:

- The desktop agent reports in ~10 s windows; the service polls the DB every
  **5 s**. End-to-end live-update latency is **≈ 5–15 s**.
- **Durable poll cursor (P2-5):** the cursor is persisted to `SystemSetting`
  (`live_updates.poll_cursor`) after every successful round and restored on
  startup, so a service restart resumes the stream instead of resetting to
  "now" and dropping gap events. Semantics are at-least-once: a crash between
  broadcast and cursor-persist replays those events once; a crashed round
  never advances the cursor (nothing is lost); a DB outage skips persistence
  and retries the old cursor.
- **Catch-up:** per-table `take` limits mean a long outage is caught up
  newest-first — middle rows may be skipped by the *stream* only. The web
  client refetches full state from the API on reconnect/refresh (the DB is the
  source of truth; the socket is a delta layer), so the Live Monitor never
  shows stale data permanently.
- Every emitted event maps to a real DB row; nothing is fabricated or random.
- The service is **single-instance** (one cursor, one poller). Run exactly one
  replica.

---

## 5. Analytics & export scaling model

- Analytics aggregates **in the database** (`groupBy` + raw SQL with
  `AT TIME ZONE` for org-local day bucketing) — the application never
  materializes the 90-day activity window in memory. Output is byte-identical
  to the previous in-memory implementation (pinned by
  `tests/analytics-aggregation.test.ts`).
- Exports fetch **bounded pages** (2,000-row keyset pages) with a 100,000-row
  hard cap and a **90-day default window** when no date range is given; the
  UI always sends an explicit range. Malformed/inverted ranges are rejected
  with 400 at the boundary.
- Raw-SQL date bounds are bound as naive UTC `::timestamp` casts so window
  comparisons are independent of the database session timezone.

---

## 6. Rate limiting (in-memory — single instance)

The rate limiter (`src/lib/rate-limit.ts`) is an **in-memory, per-process**
sliding window. It is adequate for the supported single-instance deployment
and is keyed by the canonical client-IP resolver (`src/lib/client-ip.ts`), so
login and all proxy-level limits agree on the client identity (right-most
`x-forwarded-for` / `x-real-ip` — spoofed prepended entries are ignored).

**Classification of the limits** (which must migrate first if you ever scale
horizontally):

| Class | Limits | Migrate before horizontal scaling? |
| --- | --- | --- |
| **Security-critical** (brute-force / auth / bootstrap) | `login` (10/5 min/IP+email), `agentLogin`, `agentAuthenticate`, `agentRegister`, `agentDiscover`, `orgCreate`, `aiTestConnection`, `deviceClaimWrite`, `agentRegistrationWrite` | **Yes — first.** A shared store (e.g. Redis) is required, or these become per-instance and an attacker can multiply their attempts by the instance count |
| **Abuse / expensive-operation protection** | `exportCsv`, `exportPdf`, `bulkWrite`, `importWrite`, `employeeWrite`, `deviceWrite`, `aiWrite`, `analyticsRead`, `uploadAvatar`, `screenshotImage` | Yes, before scaling (same weakness, lower risk) |
| **Per-token convenience throttles** (agent telemetry) | `agentHeartbeat` (600/min/token), `agentWrite`, `agentAccountWrite` | No — keyed by agent token, and each agent talks to one instance; acceptable per-instance |

**Operational rule:** run exactly **one** application instance (Caddy → one
`:3000`). Load-balancing multiple instances without a shared rate-limit store
weakens the security-critical limits above. If multi-instance is ever
required, replace `checkRateLimit` with a Redis-backed implementation of the
same API shape (`allowed/limit/remaining/retryAfterSeconds`) and keep the same
keys.

---

## 7. Security configuration checklist

- [ ] `.env` has a unique `JWT_SECRET` and `ENCRYPTION_KEY`
- [ ] `SUPER_ADMIN_PASSWORD` is strong and rotated
- [ ] TLS terminates at Caddy (HSTS enforced via Next headers)
- [ ] `uploads/` and `backups/` are outside the web root / not publicly served
- [ ] PostgreSQL is reachable only from the app host (no public `5432`)
- [ ] `ALLOWED_ORIGIN` lists only real origins (realtime CORS)
- [ ] Exactly one app instance (in-memory rate limiter + single realtime cursor)
- [ ] Logs do not contain passwords, JWTs, or API keys (structured logger
      redacts these automatically)
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm run build`, and
      `npx tsx --test tests/*.test.ts` all pass before deploy
