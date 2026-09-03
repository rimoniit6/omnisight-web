# PHASE 5 REPORT — Alerts, Detection Rules & Notification Pipeline

**Status:** GREEN
**Date:** 2026-09-03

## 1. Executive Summary

Added an admin-configurable, org-scoped **AlertRule** layer on top of the
existing Alert/Notification/Anomaly infrastructure. Each rule is ONE bounded
structured condition (no code execution) evaluated by a lease-guarded job over
real telemetry; firings create an Alert + Notification through the existing
shared services and record per-(rule, entity) cooldown state whose DB unique
constraint makes concurrent/replayed evaluations safe by construction. A
server-side `alert_rules_enabled` flag (default OFF) makes the engine
fail-closed. Zero agent changes, zero new collectors, zero new notification
types, zero existing telemetry modified.

## 2. Baseline

- Phase 0–4 GREEN (docs/PHASE-1..4-REPORT.md). Web baseline 103/103 suites ·
  1630/1630 tests; agent 628/628.

## 3. Architecture

See `docs/PHASE-5-IMPLEMENTATION.md` §2. Key decision: rules reuse the existing
`Alert`/`Notification`/`JobRun`/settings-registry infrastructure rather than
inventing a second pipeline, and rule notifications reuse the **already-active**
`security` notification type so the pinned `device_offline.active === false`
registry semantics (N-6) are untouched.

## 4. Agent Changes

**None.** The agent repo was not modified in Phase 5.

## 5. API / Database / UI

- Additive migration `20260903040000_alert_rules` (`AlertRule` +
  `AlertRuleFiring`, unique `(ruleId, entityType, entityId)`, org + rule
  cascade FKs, org/enabled/rule indexes).
- Admin API `GET/POST /api/alert-rules`, `PATCH/DELETE /api/alert-rules/[id]`
  (manager+, 404 cross-org, 422 validation).
- `alert_rules_enabled` registry flag (default false).
- `AlertRulesCard` mounted in Settings → Monitoring.
- `runAlertRulesJob` wired into `run.ts` under the `alert_rule_evaluation`
  lease.

## 6. Evidence — Database / Migration

```
node scripts/pg-test-db.mjs ensure p5scratch_phase5
→ postgres test db ensured: p5scratch_phase5
(env pointed at the scratch DB via .env DATABASE_URL+DIRECT_URL swap)
npx prisma migrate deploy
→ All migrations have been successfully applied.   (41/41 incl. alert_rules)
npx prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma
→ No difference detected.
(.env restored; verified back to workai_test_e2e)
npx prisma migrate status   (dev DB, normal .env)
→ Database schema is up to date!
npx prisma generate → clean (no EPERM after pausing the dev server)
```

Interpretation: the new migration applies cleanly on a fresh database, the
migrated schema exactly matches `schema.prisma`, and the dev DB is reconciled.
No existing table/row touched (additive DDL only).

## 7. Evidence — Tests

New suite `tests/alert-rules.test.ts` (21 tests) — full run:

```
node --import tsx --test tests/alert-rules.test.ts
→ ℹ tests 21   ℹ pass 21   ℹ fail 0
```

Coverage mapping:

| Requirement | Test(s) |
|---|---|
| condition evaluators (offline/idle/unproductive/off-hours, thresholds, exclusions, overnight windows) | AR-1..AR-4 |
| corrupt params → safe defaults, never throw | AR-5 |
| master flag OFF → never evaluated (fail closed) | AR-6 |
| firing → Alert + Notification + one state row; activity untouched | AR-7 |
| replay within cooldown dedupes (lost response / crash) | AR-8 |
| concurrent duplicate evaluation → exactly one firing | AR-9 |
| cooldown expiry → second firing allowed, state updated | AR-10 |
| disabled rules ignored; org B telemetry cannot fire org A rules | AR-11 |
| device_offline respects monitoring consent | AR-12 |
| org notification preference honored (skipped record, alert kept) | AR-13 |
| rule delete cascades firing state | AR-14 |
| full lease-guarded job path + JobRun result observability | AR-15 |
| RBAC (anon 401 / viewer 403 / manager+ create+list) | AR-20 |
| tenant isolation (list scoped, cross-org 404) | AR-21 |
| validation 422 (name, conditionType, params bounds/unknown keys, severity, cooldown) | AR-22 |
| 50-rule org cap → 422 | AR-23 |
| update/delete mutate only target org; cascade | AR-24 |
| list exposes firing history | AR-25 |

## 8. Evidence — Full Regression Gate

### Web (omnisight-web)

```
npm run lint
→ ✖ 439 problems (0 errors, 439 warnings)      [baseline identical: +0 errors/+0 warnings]

npm run typecheck
→ exit 0 (clean-next-types ran, tsc --noEmit clean)

npm run build
→ exit 0 (production build PASS)

Full suite: 104 files run sequentially (node --import tsx --test tests/*.test.ts)
→ 104/104 suites exit 0
→ aggregate: tests 1651 · pass 1651 · fail 0 · skipped 0
```

Adjacent pinned suites run individually before the gate (all green):
`category-classification` 14/14, `admin-prod-monitoring` 15/15,
`admin-prod-settings` 6/6.

### Agent (omnisight-agent — unchanged)

```
npm run typecheck → exit 0
npm test          → ℹ tests 628 · pass 628 · fail 0
npm run build     → exit 0
```

## 9. Security Verification

- Cross-org rule access: 404 concealment + org-scoped list (AR-21); evaluation
  queries carry org scope in every predicate (AR-11).
- RBAC: viewer denied mutations, anon 401 (AR-20).
- No arbitrary code/regex: conditions are a fixed typed registry (AR-22
  rejects unknown conditionType + unknown params keys).
- Client never supplies organization identity; org from verified session.
- Consent boundaries preserved for device_offline (AR-12); notification
  preference never bypassed (AR-13).

## 10. Privacy Verification

No new collection; alerts describe existing telemetry only; raw Activity rows
verified untouched after a firing (AR-7). No screenshot/keystroke/message data
in any alert payload.

## 11. Performance

- Bounded per-org evaluation: one org-local-day Activity load (indexed),
  in-memory per-employee grouping, org Device load — no N+1 over rules or
  employees; 50-rule org cap; no unbounded scans added.
- Firing persistence is a single small transaction; unique-index arbitration
  prevents duplicate work under races.

## 12. Files Changed (Phase 5)

**Web:**
- `prisma/schema.prisma` — `AlertRule`, `AlertRuleFiring` models.
- `prisma/migrations/20260903040000_alert_rules/migration.sql` (new).
- `src/lib/alerts/conditions.ts`, `src/lib/alerts/evaluate.ts`,
  `src/lib/alerts/validation.ts` (new).
- `src/lib/jobs/alert-rules.ts` (new) + `src/lib/jobs/run.ts` (wired),
  `src/lib/jobs/settings.ts` (registry flag + resolver).
- `src/app/api/alert-rules/route.ts`, `src/app/api/alert-rules/[id]/route.ts` (new).
- `src/components/settings/alert-rules-card.tsx` (new),
  `src/components/settings/settings-page.tsx` (mount + server-side key).
- `tests/alert-rules.test.ts` (new).
- Docs: `PHASE-5-BASELINE.md`, `PHASE-5-IMPLEMENTATION.md`, `PHASE-5-REPORT.md`.

**Agent:** none.

## 13. Rollback

See `docs/PHASE-5-IMPLEMENTATION.md` §10 — disable the org flag first (rules
stop being evaluated), then revert code; the additive migration may remain or
be dropped after confirming no code path references the tables. No destructive
step touches existing telemetry.

## 14. Remaining Risks

- Rule-fired Alerts/Notifications are ordinary rows: if an org never reviews
  them they accumulate until the org's alert/notification retention purges
  them (existing retention; defaults are keep-forever like the rest of the
  alert pipeline — same policy as pre-existing anomaly alerts).
- Cooldown bounds volume but a rule with a very low threshold + very short
  cooldown can still produce more alerts than a manager wants; the UI makes
  both knobs explicit and the org can disable the rule.

## 15. Final Verdict

**GREEN**

OmniSight V1 Phase 5 (alerts, detection rules, notification pipeline) is
complete with executable evidence: 41/41 migrations apply cleanly on a scratch
DB with no drift, 21/21 new alert-rule tests pass, the full web gate is
104/104 suites · 1651/1651 tests · 0 fail with typecheck/lint(0 errors)/build
PASS, and the agent gate remains 628/628 with typecheck/build PASS.
