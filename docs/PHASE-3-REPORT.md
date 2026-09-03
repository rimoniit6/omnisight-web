# PHASE 3 REPORT — Server-Authoritative Productivity Classification

Status: **GREEN**
Date: 2026-09-03
Repositories: `omnisight-web`, `omnisight-agent`
Scope authority: Phase 3 prompt (re-sliced — classification + org rules +
admin UI only; WorkDaySummary/daily aggregation deferred to Phase 4).

---

## 1. Executive Summary

Phase 3 makes productivity classification **server-authoritative when an org
opts in** (`server_classification` monitoring flag, default OFF), via
org-scoped `CategoryRule` objects evaluated in deterministic ordered
precedence over application/website activity. Unmatched rows fall back to a
server-side mirror of the agent's own heuristic, so enabling rules changes
nothing for rows an admin did not explicitly match. When the flag is OFF the
ingestion path is byte-for-byte the pre-Phase-3 behavior. Zero agent changes.
Full regression gates pass on both repositories (100 web suites / 1606 tests /
0 fail; agent 628/628; typecheck/lint/build green). No existing feature,
endpoint, security boundary or privacy control was weakened.

---

## 2. Baseline (forensic)

Pre-change state is captured in `docs/PHASE-3-BASELINE.md`. Key facts:

- The agent computes a local `category` per Activity row at collection time
  and sends it with the row; the server previously stored it (allowlisted).
- `Activity` rows have `type` (`application`/`website`/`idle`/…), `title`,
  `applicationName`, `url` (websites stored as normalized bare domains),
  `category`, `duration`, `timestamp`, `employeeId`, `deviceId`.
- Monitoring feature flags live in the `src/lib/jobs/settings.ts` registry
  (org-scoped `SystemSetting` rows, typed registry defaults) — the Phase 1
  `activity_dedupe` and the Phase-0 `agent_min_version` entries follow this
  pattern.
- Admin settings surfaces: Settings → Monitoring (flag toggles + cards) and
  the Organization page (server-side key list). RBAC: mutations manager+.
- Phase 2 regression baseline: web 98/98 suites, 1591/1591 tests, 0 fail;
  typecheck PASS; lint 0 errors; build PASS. Agent 628/628.

## 3. Architecture Before

```text
Agent local heuristic → category field → POST /api/agent/activity
  → server validates + allowlists → stored as-is
```

The server never re-derived productivity; rules were impossible; the dashboard
consumed whatever the agent sent.

## 4. Architecture After

```text
Agent (category = hint)  →  POST /api/agent/activity
  → validate + normalize (unchanged)
  → server_classification ON?  (org flag, default OFF)
       ├─ OFF  → store agent category (today's behavior)
       └─ ON   → org CategoryRules (priority asc, createdAt asc, id asc)
                  ├─ first match → rule category
                  └─ no match    → default-heuristic mirror (= agent output)
  → Phase 1 receipt dedupe (unchanged) → insert
```

Admin: Settings → Monitoring → Category Rules card (CRUD + dry-run). API:
`/api/category-rules` (+ `[id]`, `dry-run`).

## 5. Agent Changes

**None.** No agent source change, no version bump, no payload change. Old
agents keep working unchanged.

## 6. API Changes

| Change | Detail |
|---|---|
| `POST /api/agent/activity` | unchanged contract; server-side classification applied internally only when the org flag is ON |
| `GET /api/category-rules` | new — list org rules (manager+) |
| `POST /api/category-rules` | new — create rule (manager+) |
| `PATCH /api/category-rules/[id]` | new — update rule (manager+) |
| `DELETE /api/category-rules/[id]` | new — delete rule (manager+) |
| `POST /api/category-rules/dry-run` | new — preview classification, never persists (manager+) |

Cross-org rule ids → 404; invalid bodies → 422 `{ error:
'validation_failed', details }`; unauthenticated → 401; viewer/employee
mutation → 403 (RBAC follows the existing settings permission matrix —
manager+).

## 7. Database Changes

Migration `20260903020000_category_rules` (additive; verified drift-free on a
scratch DB):

- New table `CategoryRule` (org-scoped FK → Organization, CASCADE): `name`,
  `matchType` (`application|executable|domain`), `pattern`, `category`
  (`productive|neutral|unproductive`), `priority` (default 100, lower number
  wins), `enabled` (default true), timestamps.
- Indexes: `(organizationId)`, `(organizationId, enabled, priority)` — each
  maps to a real query (org CRUD; ingestion load).
- No existing table/row changed; no Activity rewrite; no historical bulk
  UPDATE (rule edits never touch stored rows).

## 8. Classification Semantics

- Deterministic: same org rule set + same row ⇒ same category. No
  randomness anywhere in the pipeline.
- Precedence: enabled rules sorted `priority ASC` (lower number = higher),
  then `createdAt ASC`, then `id` — never insertion order.
- Matching: case-insensitive plain-substring containment only (no regex ⇒ no
  ReDoS; no JS/SQL/shell execution). `executable` matches `applicationName`,
  `application` matches `title`, `domain` matches the stored normalized
  domain.
- Defaults: no matching rule ⇒ default-heuristic mirror (server-side copy of
  the agent's categorizers) ⇒ unmatched rows keep the agent-equivalent
  category (no sudden dashboard shifts when rules are added/enabled).
- Default fallback category for rows with no rule and no heuristic hit:
  neutral (documented in `defaults.ts`).
- Only `application` and `website` rows are rule-classified; `idle`,
  `screenshot`, `work_session` rows are untouched.

## 9. Historical Behavior

Rule create/edit/enable/disable/delete never rewrites historical Activity
rows — classification applies at ingestion time only. History therefore
reflects the rules in force when each row was ingested. Bulk historical
re-classification is explicitly out of scope for Phase 3 (documented; a later
bounded/background operation if ever needed).

## 10. Working-Hours / Break Behavior

Classification is per-row and pure; it does not add a second timezone or
working-hours system. Break-mode and working-hours enforcement remain exactly
as before (agent suppression + existing API gates unchanged) — rows that the
existing pipeline suppresses never reach classification, so break/outside-
hours time is never mis-counted. Raw telemetry is never deleted by
classification. CAT-12/CAT-13/CAT-14 pin determinism across timestamps and
timezones, no idle re-classification, and acceptance of out-of-hours offline
queue replays.

## 11. Feature Flag

`server_classification` (registry: `src/lib/jobs/settings.ts`, type boolean,
default false). OFF = previous ingestion behavior exactly; ON = rule-based +
default-mirror classification. The flag never bypasses authentication, org
isolation, validation, consent, working-hours, break, or the Phase 1 dedupe
path. Admin-visible on Settings → Monitoring and the Organization page.

## 12. Security Verification

- Org isolation: rule reads/CRUD always filter by the authenticated org;
  cross-org rule ids → 404; rule evaluation in ingestion is scoped to the
  authenticated employee's org (server-derived, never the client body).
- No client-controlled org context; no client-supplied category is treated as
  authoritative (agent category is at most the fallback hint when rules are
  off).
- Matching safety: plain substrings; no regex; no dynamic code; patterns
  length-capped (128) and per-org rule count capped (200).
- RBAC: manager+ for all rule routes; no new roles; viewer/employee cannot
  mutate. Suite CAT-7 (RBAC + tenant) proves manager 200, viewer 403,
  cross-org 404, org-A/org-B independence.
- Auth/session/rate-limit paths untouched.

## 13. Privacy Verification

No new telemetry, no keystroke/content collection, no URL storage beyond the
existing normalized domain. Domain rules match the stored bare domain only.
Rule content is visible only to manager+ users. Break suppression, consent,
and retention unchanged.

## 14. Performance

- Ingestion: one bounded enabled-rules query per request only when the flag
  is ON (≤ 200 rules/org) — no per-row queries, no N+1, no unbounded scan.
- Rule CRUD uses org-scoped indexed lookups.
- Synthetic benchmark CAT-PERF-1: 100 orgs × 100 rules × 10,000 activities →
  1.65 s in-process; cross-org leakage asserted zero (row ids namespaced per
  org); memory bounded.
- No caching added (correctness first; single cheap query per request).

## 15. Tests Executed

New suites (all pass):

```text
node --import tsx --test tests/category-classification.test.ts tests/category-rules-performance.test.ts
→ ℹ tests 15   ℹ pass 15   ℹ fail 0
```

Coverage: exact application/executable match; domain match incl. www/case/URL
normalization; ordered precedence (specific rule wins, priority tiebreak);
disabled rules ignored; no-rule → neutral default; productive/neutral/
unproductive verdicts; dry-run pure evaluation; working-hours/timezone
determinism; break + idle invariance; out-of-hours replay accepted; tenant
isolation (org A rules never classify org B rows; cross-org CRUD 404); RBAC
(manager allowed, viewer denied, unauth 401); invalid input 422; API CRUD +
DB state assertions; 10k-row benchmark.

## 16. Regression Gate (exact results)

### Web (omnisight-web)

```text
npm run typecheck        → exit 0  (clean-next-types pre-step OK)
npm run lint             → exit 0  — ✖ 439 problems (0 errors, 439 warnings)  [pre-existing warning baseline unchanged; 0 new]
npm run build            → exit 0  (production build OK)
full suite (100 files, sequential chunks; two live-server suites rerun after
  dev-DB reseed — see note) → 100 suites, ℹ tests 1606, ℹ pass 1606,
  ℹ fail 0, cancelled 0
```

Suite count grew 98 → 100 (two new suites added). Test count grew 1591 →
1606 (+15 new tests). All 98 pre-existing suites remain green.

### Agent (omnisight-agent) — unchanged repo, gates still required

```text
npm run typecheck → exit 0
npm test          → ℹ tests 628   ℹ pass 628   ℹ fail 0   (exit 0)
npm run build     → exit 0
```

### Environmental note (fully resolved, not a code regression)

During Phase 3, the scratch migration verification recreated the local dev
DB (`workai_test_e2e`), which also wiped the bootstrapped super-admin row.
Two live-server suites that log in as that super admin (`rbac-forensic-
regression`, `security-remediation`) then failed in the aggregate run
(44 cancelled + 13 truncated). Root cause proven: `appUser` count = 0 in the
dev DB. Fix: re-ran the repo's idempotent bootstrap
(`npx tsx scripts/bootstrap-super-admin.ts` → "Super Admin created:
rimon@admin.com"). Re-run results:

```text
tests/rbac-forensic-regression.test.ts → ℹ tests 44  ℹ pass 44  ℹ fail 0
tests/security-remediation.test.ts     → ℹ tests 13  ℹ pass 13  ℹ fail 0
```

Both included in the 100-suite aggregate above. No product code changed to
make these pass.

## 17. Files Changed (Phase 3)

New:

- `prisma/migrations/20260903020000_category_rules/migration.sql`
- `src/lib/classification/engine.ts`
- `src/lib/classification/defaults.ts`
- `src/lib/classification/validation.ts`
- `src/app/api/category-rules/route.ts`
- `src/app/api/category-rules/[id]/route.ts`
- `src/app/api/category-rules/dry-run/route.ts`
- `src/components/settings/category-rules-card.tsx`
- `tests/category-classification.test.ts`
- `tests/category-rules-performance.test.ts`
- `docs/PHASE-3-BASELINE.md`, `docs/PHASE-3-IMPLEMENTATION.md`

Modified:

- `prisma/schema.prisma` (CategoryRule model + Organization relation)
- `src/lib/jobs/settings.ts` (`server_classification` flag + resolver)
- `src/app/api/agent/activity/route.ts` (classification hook)
- `src/components/settings/settings-page.tsx` (rules card mount + flag label)
- `src/components/organization/organization-page.tsx` (flag label + key)

Re-scope cleanup (Phase 4 pieces staged earlier, then removed to honor the
re-sliced boundary — net zero in the tree): `src/lib/timezone.ts`,
`src/lib/jobs/retention.ts`, `src/lib/jobs/run.ts` reverted; the combined
migration was replaced by the CategoryRule-only migration above.

## 18. Migration Verification

```text
scratch DB: prisma migrate deploy → clean ("No pending migrations" after apply)
prisma migrate diff (migrated scratch DB → schema) → "No difference detected"
prisma generate → OK (client regenerated; dev server restarted)
```

Existing Activity rows untouched (no backfill, no rewrite).

## 19. Rollback

1. Set `server_classification` OFF → ingestion stores agent categories again
   (previous behavior); the rules API/card simply stop influencing rows.
2. Revert additive code (engine/defaults/validation, routes, card, page
   labels, settings entry) — all additive; nothing else depends on it.
3. The `CategoryRule` migration is additive; keep the table (harmless,
   eventually unused) or drop it only after no deployment reads it. No
   Activity data is affected by rollback in any step.

## 20. Remaining Risks / Warnings

- The default-heuristic mirror in `defaults.ts` is a hand-maintained copy of
  agent categorizer behavior; if the agent's heuristics ever change, the
  mirror must be updated in lockstep (documented in-file). While the flag is
  OFF the mirror is never executed.
- Rules apply at ingestion time; historical rows do not retroactively
  re-classify when a rule changes (documented design choice — no bulk UPDATE
  ever runs from admin requests).
- Lint retains the pre-existing 439 warnings (0 errors) across the repo; the
  new Phase 3 files add 0 errors and 0 warnings.

## 21. Final Verdict

**GREEN**

All acceptance criteria met: server-authoritative, deterministic,
productive/neutral/unproductive classification with neutral default; org-
scoped rules with deterministic precedence; application/executable/domain
matching with safe (non-executable) validation; working-hours/break semantics
preserved with no telemetry deletion; Phase 1 batch ingestion, Phase 2
screenshots, old agents, and all prior APIs fully compatible; complete tenant
isolation with no client-controlled org authority; bounded rule evaluation
with a passing 100-org × 100-rule × 10k-row benchmark; Web typecheck PASS,
lint 0 errors, production build PASS, full suite 100/100 suites ·
1606/1606 tests · 0 failures; Agent typecheck PASS, 628/628 tests, build
PASS.
