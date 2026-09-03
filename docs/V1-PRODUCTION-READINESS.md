# OMNISIGHT V1 — PRODUCTION READINESS

Phase 6 certification checklist. Every item carries a verdict and evidence.
Verdict scale: **PASS / WARN / BLOCKED / NOT VERIFIED**.

Legend for evidence:
- **[G] full regression gate** — 104/104 suites · 1651/1651 tests · 0 fail
  (web), typecheck/lint/build PASS, agent 628/628.
- **[P#] phase report** — `docs/PHASE-#-REPORT.md`.

---

## Authentication
| Item | Verdict | Evidence |
|---|---|---|
| Session auth (JWT + httpOnly cookie) | **PASS** | `worklens_token` httpOnly + sameSite:lax (`src/lib/auth.ts`); session rows checked server-side on every request incl. realtime handshake; [G] security/rbac/super-admin suites. |
| Agent auth (device claims, tokens, per-device expiry) | **PASS** | claim→approve→token flow; token sweeps; expired/revoked tokens rejected; [G] agent-auth-login/agent-active-device/claim-cancel/agent-token-sweep. |
| Realtime socket auth | **PASS** | live probe: no token / garbage / forged / unknown-sessionId → `unauthorized`; valid org JWT → org-scoped `connected` handshake (6/6) — Phase 6 run. |

## Authorization / RBAC
| Item | Verdict | Evidence |
|---|---|---|
| Org-bound roles (viewer/manager/admin/super_admin) enforced server-side | **PASS** | `requireSessionOrg/Manager/Admin` helpers; mutation routes role-gated; [G] rbac-* suites, admin-prod-reports-rbac. |
| No client-controlled org identity | **PASS** | org always derived from verified session/agent token; [P1/P3/P5] tenant tests (cross-org 404/403). |

## Tenant isolation
| Item | Verdict | Evidence |
|---|---|---|
| HTTP API org isolation | **PASS** | [G] multi-org*, agent-cross-org-attack, super-admin-organization-context; every audited query scoped by session org. |
| Realtime org isolation | **PASS** | sockets join `org:<id>` from verified token; every broadcast `io.to(org room)`; RBAC read-scope parity checked route-by-route (Phase 6 baseline §3). |
| Rule/summary/alert engines tenant-scoped | **PASS** | [P3/P4/P5] tenant tests incl. same-batchId different-org isolation. |

## Consent / Privacy
| Item | Verdict | Evidence |
|---|---|---|
| Consent versioning + enforcement (agent collectors gated on granted consent) | **PASS** | [G] consent*/consent-summary/consent-seed; collector gating audited [P2]. |
| Fail-closed privacy (no raw keystrokes, no full URLs, coordinate-only location, no hidden collection) | **PASS** | schema + collector audits [P0–P5]; [G] location-privacy suites, website-100/domain normalization suites. |
| Break-mode + working-hours enforcement preserved | **PASS** | [G] break-hardening, timezone-boundaries, policy suites. |

## Telemetry
| Item | Verdict | Evidence |
|---|---|---|
| Activity ingestion backward compatible | **PASS** | legacy payload (no batchId) + new (batchId/batchSeq) both accepted [P1][G activity-dedupe, agent-compat]. |
| Idempotent batch ingestion (retry/crash/concurrent) | **PASS** | ActivityBatchReceipt unique (org,employee,batchId), transactional, concurrent-tested [P1]. |
| Server-authoritative classification | **PASS** | [P3][G category-classification]; no Math.random anywhere in productivity (audited). |

## Screenshots / Storage
| Item | Verdict | Evidence |
|---|---|---|
| Binaries outside DB via storage abstraction (local + Supabase/S3) | **PASS** | [P2]; `src/lib/storage/` index/local/supabase. |
| Async thumbnails; original survives failure | **PASS** | [P2][G screenshot-processing, screenshots, png-dimensions]. |
| Org retention (original + thumbnail + metadata), file-first deletion, orphan cleanup | **PASS** | [P2]; retention job org-scoped with per-org timezone window [P2/P4]. |
| Org byte accounting + optional quota (507 only when enabled) | **PASS** | [P2]. |
| Serving authorization (no cross-org image access) | **PASS** | [G screenshots/security suites; serving route org-checked]. |

## Productivity / Aggregation / Alerts
| Item | Verdict | Evidence |
|---|---|---|
| CategoryRules CRUD + precedence + domain normalization | **PASS** | [P3][G category-classification]. |
| WorkDaySummary: org-tz day boundaries, idempotent upsert, no fabrication, rebuild | **PASS** | [P4][G workday-summary*]; DST/midnight/overnight tested. |
| Dashboard consumes summaries (byte-exact raw fallback) | **PASS** | [P4 §15b][G dashboard-consumer/dashboard-api]. |
| Alert rules: structured conditions, cooldown/dedupe, notification records, no storms | **PASS** | [P5][G alert-rules]. |

## Realtime
| Item | Verdict | Evidence |
|---|---|---|
| Auth + tenant isolation + RBAC parity | **PASS** | Phase 6 live probe + baseline §1/§3. |
| Reconnect re-auth, no stale authorization | **PASS** | provider rebuilds socket on token change; unauthorized stops retry; refetch on reconnect (code audit + [G live suites]). |
| Presence: crashed agent → offline server-side | **PASS** | heartbeat staleness + in-memory sweep + device-integrity job; [G presence*/device-integrity]. |
| Polling/cursor fallback + durable catch-up | **PASS** | persisted cursor, at-least-once, [G live-updates-cursor*, live-event-stream]. |

## Jobs
| Item | Verdict | Evidence |
|---|---|---|
| Every job lease-guarded, bounded, restart-safe | **PASS** | 12 jobs all under `claimJob`/`finishJob` [P4/P5 audits]. |
| Concurrency (two workers, same job) | **PASS** | atomic lease claim; suite-tested races (workday/alert/activity dedupe). |
| Failure observability (lastResult/lastError/lastDuration) | **PASS** | JobRun fields written by every job. |

## Reports / Exports
| Item | Verdict | Evidence |
|---|---|---|
| Bounded exports, no full-table scans | **PASS** | [G export-bounded]; reports consume summaries where exact [P4 §15b]. |

## AI
| Item | Verdict | Evidence |
|---|---|---|
| Screenshot AI deferred/opt-in with caps | **PASS (by design)** | not enabled in V1 core; manual analysis unchanged [V1 plan §26]. |

## Database
| Item | Verdict | Evidence |
|---|---|---|
| Migration state clean, no drift | **PASS** | 41 additive migrations; `migrate diff` (dev DB → schema) → **No difference detected** (Phase 6 rerun). |
| Indexes for hot query paths | **PASS** | documented per phase (Activity/Screenshot/Summary/Receipt/Firing). |
| Additive-only migrations, no destructive ops | **PASS** | [P1–P5] scratch-DB verified each phase. |
| Connection pool / config | **PASS** | pooled URL for runtime (`.env` comment), realtime service caps pool; deployment-specific sizing NOT VERIFIED. |

## Backups / Monitoring / Logging
| Item | Verdict | Evidence |
|---|---|---|
| Backup/restore certification | **NOT VERIFIED** | `scripts/pg-backup-restore-certification.mjs` exists; a live restore drill requires a production/staging environment (not available here). |
| Health endpoints (app/DB/storage distinguished) | **PASS** | `/api/health` (app+DB `SELECT 1`+storage) and `/api/health/database`; [G health 5/5]. |
| Worker/realtime liveness surfaced | **WARN** | via JobRun rows + socket pings/service logs — not exposed on the public health probe (deliberate; add if ops wants it). |
| Production-safe logs | **PASS** | no secrets/credentials/screenshot content logged; safe identifiers only. |

## Deployment / Rollback
| Item | Verdict | Evidence |
|---|---|---|
| Clean build from lockfile + prisma generate | **PASS** | `npm run build` (cleans `.next/dev/types`) PASS; canonical lockfile strategy documented [P0]. |
| Feature-flag rollbacks | **PASS** | every V1 phase ships OFF-by-default flags (activity_dedupe, server_classification, alert_rules_enabled) + additive migrations [P1/P3/P5]. |
| Production env config (HTTPS secure cookie, hosted storage/DB creds, CORS origin, Caddy) | **NOT VERIFIED** | no production/staging environment in this workspace; `.env.example` placeholders only; code paths verified. |

## Rate limiting
| Item | Verdict | Evidence |
|---|---|---|
| Security-critical paths throttled, fail-closed, identity-keyed | **PASS** | [G rate-limit-shared]; shared PG token bucket, atomic upsert. |
| High-cost write endpoints (agent activity/screenshot upload, exports) token-bucketed | **WARN** | authenticated + request-capped + cadence-limited today; org+device `agent-write:` buckets recommended pre-scale (Phase 6 baseline §7). |

---

## Summary of WARN / NOT VERIFIED items

1. **WARN** — authenticated write-endpoint rate buckets not yet implemented.
2. **WARN** — worker/realtime liveness not on the public health probe (ops
   signals available via JobRun + socket pings).
3. **NOT VERIFIED** — production deployment configuration and a live
   backup/restore drill require a real environment; `.env.example` is clean
   and code paths are verified, but deployment-specific values are outside
   this workspace's reach.

No **BLOCKED** items.
