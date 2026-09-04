# OMNISIGHT — PRODUCTION RELEASE CHECKLIST (Phase 5)

Pre-flight gate for a production deployment. Every item is either **verified**
(done + evidence) or explicitly **deployment responsibility** (operator action
at deploy time — never silently assumed done).

## Environment & secrets

- [ ] `.env` configured for the target environment (see `.env.example`; never commit real secrets).
- [ ] `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL` set to real (non-placeholder) values — verified by `GET /api/health/ready`.
- [ ] Secrets rotated/confirmed since any historical commit scan.
- [ ] `STORAGE_DRIVER` matches the environment (`supabase` requires real `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; placeholders fail closed).

## Database

- [ ] Backup verified (operator responsibility — frequency/retention/PITR documented in DEPLOYMENT docs).
- [ ] `prisma migrate deploy` applied against staging, then production.
- [ ] Post-migration smoke: `GET /api/health/database` → 200 `{ status: 'ok' }`.
- [ ] No destructive migration in the release set (Phase 5 is additive-only).

## Storage

- [ ] Storage driver configured (local dev / Supabase prod).
- [ ] Object storage reachable and writable (upload one screenshot in staging).
- [ ] Retention job verified against a short-retention org (metadata + object both removed).

## Application

- [ ] Typecheck: 0 errors.
- [ ] Lint: 0 errors.
- [ ] `next build` passes.
- [ ] Self-contained security/operational suite battery green (844/844 across 55 suites as of Phase 5 certification).
- [ ] Live-server suite (`node scripts/run-tests.mjs` with `npm run dev`) executed in CI at deploy time.
- [ ] `GET /api/health/ready` → 200 after deploy; liveness + DB probes monitored.

## AI

- [ ] Provider configured (Settings → AI Provider); test connection succeeds.
- [ ] AI generation writes org-scoped `AiUsage` rows — visible only to that org via `GET /api/ai-provider/metering`.
- [ ] No AI key stored in the Agent artifact or exposed to the browser.
- [ ] Per-org runtime AI keys: **confirmed decision** — instance-global key acceptable, or per-org keys routed at runtime (documented Phase 5 limitation).

## Agent / Builder

- [ ] Agent typecheck + full suite green (641/641 as of Phase 5).
- [ ] Packaged artifact built (`package:dir`) and credential-scanned (0 real leaks).
- [ ] Builder asks no DB/AI/Super-Admin credentials and cannot override server deployment authority (Builder suite green).
- [ ] Compat endpoint advertises current `serverVersion`/`minAgentVersion`.

## Subscription / License / Payments (manual sales)

- [ ] Manual payment verification → subscription ACTIVE → license ACTIVE flow exercised on staging.
- [ ] First-login forced password change exercised.
- [ ] Suspension denies operational access; reactivation restores it.

## Realtime / monitoring

- [ ] Realtime suites green (event stream/stats/presence/wakeup).
- [ ] Monitoring configured for: 5xx rate, 401/403 spikes, agent auth failures, storage failures, retention job failure, realtime disconnects (application-level signals + deployment-level alerting).

## Rollback

- [ ] Application rollback documented (Phase 5 = code + one additive migration).
- [ ] DB rollback documented: drop `AiUsage` table if the migration must be reverted (metering rows only — no operational data loss).
- [ ] Agent rollback documented (unchanged in Phase 5).

## Documentation

- [ ] `docs/PHASE-5-CERTIFICATION.md` reviewed (risks section read before sign-off).
- [ ] Operator runbook: backup/restore + disaster recovery confirmed by the deployment owner.

---

Sign-off: all **verified** items green AND all **deployment responsibility** items acknowledged by the deployment owner → **PRODUCTION READY WITH DOCUMENTED DEPLOYMENT LIMITATIONS** (Phase 5 classification).
