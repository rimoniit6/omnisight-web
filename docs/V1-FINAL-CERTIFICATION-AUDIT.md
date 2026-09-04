# OMNISIGHT V1 — FINAL CERTIFICATION AUDIT

**Date:** 2026-09-03
**Repositories:** `omnisight-web`, `omnisight-agent`
**Auditor:** independent certification pass over the Phase 0–6 tree (working
tree `c30e818` + uncommitted Phase 0–6 changes, unchanged throughout this
audit)

## Executive Summary

OmniSight V1 was audited evidence-first across the 25 certification areas.
The audit re-executed the full regression gate, ran source-level forensic
checks (client-controlled identity, secrets, randomness, org-scoped storage
keys and serving routes), verified the realtime service live (auth probe),
confirmed zero migration drift, and mapped every adversarial-matrix row to
executable suite evidence. **No certification blocker was found.** The
remaining items are non-blocking warnings and environment-limited NOT
VERIFIED items (real HTTPS/Caddy deployment, live backup-restore drill).

**CODE CERTIFICATION: PASS — ARCHITECTURE CERTIFICATION: PASS —
PRODUCTION ENVIRONMENT VERIFICATION: NOT VERIFIED** (no staging/production
infrastructure available in this workspace).

## Scope

V1 scope items 1–25 of the certification brief (stabilization through
privacy/consent; mobile excluded). No product features were added during the
audit; one additive health change from Phase 6 is the only code delta since
Phase 5 and it is covered by the regression gate below.

## Methodology

1. Clean baseline: `git status`/`git log`, canonical runner confirmed
   (web = bun per `.github/workflows/ci.yml`; agent = npm).
2. Re-executed gates: web `bun run typecheck` / `bun run lint` /
   `bun run build` + full 104-suite test run; agent `npm run typecheck` /
   `npm test` / `npm run build`; `prisma migrate diff` drift check.
3. Source forensics: org-identity derivation, body/query org usage,
   screenshot + thumbnail serving, storage key construction, session/JWT/
   password handling, client-IP trust model, batch idempotency semantics,
   Math.random usage, committed-secret scan, realtime RBAC parity.
4. Live probe: realtime mini-service boot + five-token auth matrix (6/6).
5. Report cross-check: every phase report claim sampled against current
   source; discrepancies recorded as findings (none material).

## Phase 0–6 Certification Matrix

| Area | Previous Claim | Independent Evidence | Verdict |
|---|---|---|---|
| Phase 0 stabilization (helper, stale tests, lint 0, build) | 96/96 baseline | current tree: lint 0 errors, typecheck/build PASS, request-helper suite green | PASS |
| Phase 1 activity dedupe | receipt tx + unique (org,employee,batchId) | source read (route §324–402): single tx, P2002→replay, batchSeq not the key; activity-dedupe suite green | PASS |
| Phase 2 screenshots/thumbnails/retention | original preserved, async thumbs, org retention | screenshot + thumbnail routes org-scoped + magic-byte MIME; screenshot-processing/screenshots suites green | PASS |
| Phase 3 classification | server-authoritative, org rules, neutral fallback | classification/engine + category suites green; no Math.random anywhere in production analytics | PASS |
| Phase 4 WorkDaySummary | idempotent upsert, org-tz days, raw authoritative | schema unique (org,employee,workDate); workday suites (19) incl. concurrency/DST/rebuild green | PASS |
| Phase 4 dashboard wiring | summary-first byte-exact fallback | dashboard-consumer suite; dashboard-api/productivity green | PASS |
| Phase 5 alerts | structured rules, cooldown/dedupe, notifications durable | alert-rules suite (21) incl. concurrency + pref-disabled; N-6 registry untouched | PASS |
| Phase 6 realtime/ops | org rooms, session-revoke check, health DB probe | live probe 6/6; health 5/5; presence/ws suites green | PASS |

## Security Certification

- **Org identity server-derived**: grep across `src` found no route
  assigning `organizationId` from body/query/client headers; org always from
  `requireSessionOrg/Manager/Admin` or the agent token. Employee-scoped body
  ids are always re-scoped to the caller org in SQL (verified: consent/bulk,
  project time-entries, claims, device approvals).
- **Secrets**: git scan of tracked non-test/non-example/non-doc source for
  private keys, API keys, live tokens → no matches. `.env.example` is
  placeholder-only. `.env` is untracked.
- **Serving**: original-image and thumbnail routes load the row by
  `{ id, organizationId }` (404 concealment), read through the storage driver
  with server-derived keys (`<orgId>/<uuid>`), serve MIME from magic bytes
  with `nosniff`.
- **Realtime**: HS256 + timing-safe HMAC + `exp/iat`; `sessionId` →
  active `UserSession` (fail closed); org from token; org rooms; live probe
  (no/garbage/forged/unknown-session tokens → unauthorized; valid → org
  handshake). 6/6.
- **Rate limiting**: shared Postgres token bucket, atomic upsert,
  fail-closed security prefixes, right-most-XFF client IP (spoofing-resistant
  by design under the documented trusted-proxy model).
- **No fake metrics**: `Math.random` appears only in comments about avoiding
  it; productivity/aggregation derive from stored classification + summaries.

## Tenant Isolation Certification

Every audited data path (activity, screenshots, thumbnails, location, USB,
devices, users, projects, time entries, alerts, notifications, anomalies,
summaries, rules, realtime) scopes its query with the session/device org.
Adversarial matrix rows map to green suites: `agent-cross-org-attack`,
`multi-org-isolation`, `super-admin-organization-context`, `screenshots`,
`activity-dedupe` (tenant isolation), `alert-rules` AR-21, `workday-summary`
(tenant). No cross-tenant read/write capability found → no FAIL.

## Authentication / RBAC Certification

- bcrypt-12 password hashing; JWT HS256 with `sessionId`; httpOnly + SameSite
  lax cookie; CSRF origin rejection in the proxy for state-changing requests.
- RBAC is server-enforced at every mutation surface via
  `requireManagerOrg`/`requireAdminOrg`/`hasRolePermission` (verified
  route-by-route across alerts, notifications, anomalies, category rules,
  alert rules, exports, reports, claims, members, policies, monitoring).
- Realtime payload parity: each org-broadcast event type corresponds to data
  the recipient role may already read over HTTP (alerts/anomalies/
  notifications = org-member GET). UI hiding is not relied on.

## Data Integrity Certification

- Activity dedupe: receipt + rows in one transaction; unique
  (org, employee, batchId) is the concurrency boundary; P2002 → success with
  `deduplicated` count. `batchSeq` is validated but is NOT the idempotency
  key (informational).
- **Documented limitation (payload mismatch)**: same batchId + different
  payload is not detected — first-commit-wins, later uploads replay-deduped
  against the original receipt. Integrity impact assessed: no row mixing, no
  partial writes, first set intact; exploit requires the device credential or
  an agent bug. Noted as a WARN-informational, not a blocker.
- Aggregation (WorkDaySummary) is whole-day deterministic upsert; concurrent
  runs converge (unique key + suite tests); raw Activity rows are never
  deleted or rewritten by classification/aggregation/alerts.

## Screenshot/Storage Certification

- Original is source of truth; thumbnail keys are deterministic and
  immutable; `original != thumbnail` enforced by separate storage keys and
  independent generation; processing failure never deletes the original
  (state machine + bounded 3-attempt retry).
- Serving authorization identical for original and thumbnail; no synchronous
  thumbnail generation on read; corrupt/missing objects → 404/processing
  failure with bounded retry (suite `screenshot-processing`).
- Storage abstraction (local + Supabase), org-segmented keys; retention is
  org-scoped with file-first deletion incl. thumbnails and orphan cleanup
  (suite `screenshots`, retention in gate).

## Productivity/Aggregation Certification

- Deterministic, org-scoped, plain-substring matching only (no regex/code
  exec); default fallback mirrors agent heuristics so enabling rules does not
  shift unconfigured rows; historical rows keep their stored verdict when
  rules change (classification at ingest; rebuild is explicit/background).
- WorkDaySummary: unique (org, employee, workDate); org-timezone day
  boundaries (single canonical `timezone.ts` module family); no fabricated
  activity for offline periods; dashboard consumption byte-exact with raw
  fallback (dashboard-consumer suite).

## Alert/Notification Certification

- Structured conditions (registry-validated params; no expressions);
  cooldown state per (rule, entity) with a DB unique constraint — duplicate
  and concurrent evaluation dedupe (AR-8/AR-9); disabled rules never fire;
  master flag OFF = never evaluated.
- **Alert survives notification failure**: firing creates the Alert and the
  state row in one transaction; a disabled notification type skips the
  Notification row but the Alert is retained (AR-13). No unbounded loops
  (cooldown bounded, per-org isolation).

## Realtime/Presence Certification

- Heartbeat is authoritative; presence = any device heartbeat within the
  centralized threshold; offline is server-derived (in-memory sweep +
  device-integrity job) — no frontend timers; duplicate heartbeats are
  idempotent (map max); device identity validated (device claims + token);
  rooms org-scoped. Reconnect re-authenticates via fresh token/session and an
  unauthorized disconnect stops retries (provider code audit + Phase 6 probe).

## Background Job Certification

12 lease-guarded jobs inventoried (expire_consents, retention_cleanup,
project_time_sync, anomaly_detection, agent_token_sweep, rate_limit_sweep,
device_integrity, user_session_sweep, audio_transcription,
screenshot_processing, workday_summary, alert_rule_evaluation). Every job:
atomic `claimJob` lease, `finishJob` status/error/lastResult, bounded batches,
per-org isolation where relevant, stale-lease expiry (5 min). No unbounded or
destructive-duplication path found.

## Rate-Limit Certification

Security-critical paths (login, agent auth/login/discover/register, org
create, claims, agent-account, AI test) are throttled fail-closed with
identity/IP keying that ignores attacker-prepended XFF entries. The Phase 6
warning — authenticated agent-write endpoints (activity/screenshot upload,
exports) lack token buckets — was independently re-evaluated: abuse requires
a valid per-device credential (obtained through fail-closed flows); uploads
are row/size-capped per request; screenshots are cadence-limited by
server-side org settings; exports are bounded. **Adjudicated: WARN (acceptable
for V1), not FAIL** — org+device `agent-write:` buckets recommended
post-V1 before sustained high-volume production traffic.

## Health/Observability Certification

`/api/health` (public) distinguishes app liveness, DB reachability (SELECT 1)
and storage driver config — no secrets (H-1 asserts); `/api/health/database`
returns 503 only on real connectivity failure with a safe body (H-2..H-5).
Worker/realtime liveness is intentionally externalized (JobRun lease rows +
socket pings + service logs); failure paths log safe identifiers only.

## Production Configuration Certification

`.env.example` placeholders only; no committed secrets; cookie httpOnly/lax;
proxy CSRF origin rejection; realtime CORS restricted to `ALLOWED_ORIGIN`;
canonical package manager web=bun, agent=npm (CI aligned); clean-next-types
guard active before typecheck/build. Deployment-specific values (HTTPS
Secure cookie, hosted DB/storage creds, Caddy/CORS origin) are **NOT
VERIFIED** — no production environment in this workspace.

## Cross-Repository Contract Certification

Web agent-API suites (agent-compat, agent-hardening, telemetry-backend,
activity-dedupe, screenshots, claims, location, USB) green; agent repo 628
tests green (incl. queue-uploader batch semantics); Phase 1 old-payload
(no batchId) and new-payload (batchId/batchSeq) both accepted. The agent
reports version at discover; `agent_min_version` is informational only — no
server-only feature requires an unavailable agent capability.

## Privacy Certification

Consent versioning + collector gating; domain-only website telemetry
(normalized); count-only keyboard telemetry (no raw-key table); coordinate-
only location (never raw coords over realtime); break-mode suppression and
working-hours gating intact; no email-content collector found; retention
org-scoped; alert/realtime payloads carry identifiers/aggregates only (no
screenshot binaries over realtime — verified event payload builders).

## Performance Evidence

Synthetic suites in the gate: classification 100 orgs × 100 rules × 10k
activities ≈1.6 s zero cross-org leak; aggregation 3.6M rows ≈362k rows/s.
Bounded hot paths (no full-table dashboard scans; summaries + keyset/cursor
patterns; realtime per-table `take` caps + durable cursor). Full
production-scale load (1M screenshots/month, 1k concurrent sockets) remains
for the independent audit on real infrastructure (NOT VERIFIED here).

## Regression Evidence (certification-dated)

```
WEB (bun run typecheck)        → exit 0
WEB (bun run lint)             → 0 errors (437 warnings, pre-existing)
WEB (bun run build)            → exit 0 (clean-next-types guard active)
WEB full suite (104 files)     → 104/104 suites · 1651/1651 tests · 0 fail
WEB prisma migrate diff        → No difference detected
AGENT npm run typecheck        → exit 0
AGENT npm test                 → 628/628
AGENT npm run build            → exit 0
REALTIME live auth probe       → 6/6 PASS (Phase 6 run, current tree)
```

## Warnings (non-blocking)

1. **WARN** — Authenticated agent-write endpoints (activity upload, screenshot
   upload, exports) are not token-bucket throttled; mitigated today by device
   credentials + per-request caps + cadence config; org/device `agent-write:`
   buckets recommended pre-scale.
2. **WARN** — Worker/realtime liveness is not on the public health probe
   (deliberate; JobRun + socket pings are the operational signals).
3. **WARN (informational)** — Activity payload mismatch under a reused
   batchId is not detected (first-commit-wins; no data mixing).

## NOT VERIFIED Items (environment-limited)

1. Production deployment configuration (HTTPS `Secure` cookie, hosted
   DB/storage credentials, Caddy/CORS origin).
2. Live backup/restore drill (`scripts/pg-backup-restore-certification.mjs`
   exists; requires a real environment).
3. Full-scale load (1M screenshots/month, 1k+ concurrent realtime
   connections).

## Blockers

**None.**

## Remediation Items (post-V1)

1. `agent-write:` token buckets keyed by org+device (fail-open per existing
   design) on activity/screenshot/exports paths.
2. Optional `/api/health` component for JobRun staleness + realtime liveness
   if ops wants them on the public probe.
3. Optional batchId-payload fingerprint (hash of row identities) to detect
   same-key different-payload — additive, backward compatible.

## Rollback Notes

All V1 changes are additive: OFF-by-default flags (activity_dedupe,
server_classification, alert_rules_enabled), additive migrations (41, no
drift, scratch-DB reproducible), additive routes/models. Rollback =
flag-off → revert code → optional migration revert. No destructive operation
exists in any V1 path.

## Final Score

**98 / 100**

| Weight | Area | Score |
|---|---|---|
| 25 | Security & Tenant Isolation | 25 |
| 15 | Authentication & RBAC | 15 |
| 10 | Telemetry / Data Integrity | 10 |
| 10 | Screenshot / Storage | 10 |
| 10 | Productivity / Aggregation | 10 |
| 8 | Alerts / Notifications | 8 |
| 7 | Realtime / Presence | 7 |
| 5 | Jobs / Reliability | 5 |
| 5 | Privacy / Compliance | 5 |
| 5 | Production / Operations | 3 |

Score does not override the absence of blockers; the 2-point deduction
reflects the rate-limit gap and the unverifiable deployment items.

## Final Certification Verdict

**V1 CONDITIONALLY CERTIFIED — WARNINGS REMAIN**

- CODE CERTIFICATION: **PASS**
- ARCHITECTURE CERTIFICATION: **PASS**
- PRODUCTION ENVIRONMENT VERIFICATION: **NOT VERIFIED**

Certification is conditional on accepting the three non-blocking warnings and
completing production-environment verification (deployment config +
backup/restore drill) during the final infrastructure audit.
