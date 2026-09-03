# PHASE 3 IMPLEMENTATION — Server-Authoritative Productivity Classification

Status: implemented, regression gate GREEN.
Companion docs: `docs/PHASE-3-BASELINE.md` (forensic pre-change baseline),
`docs/PHASE-3-REPORT.md` (evidence + verdict).

---

## 1. Architecture

Before Phase 3 the Desktop Agent produced the `category` value on each
Activity row using its own local heuristic (server allowlisted which values
arrived). Phase 3 makes the **server authoritative** when an organization opts
in via the `server_classification` monitoring flag (default **OFF**):

```text
Agent (raw telemetry, category = hint)
  ↓ POST /api/agent/activity
Server validation + normalization (Phase 1/3 gates unchanged)
  ↓ classificationEnabled ?                    (org flag, default OFF)
  ├─ OFF → store agent category byte-for-byte  (today's behavior)
  └─ ON  → org CategoryRules, ordered precedence
           → unmatched rows fall back to the DEFAULT HEURISTIC mirror
           → row.category overwritten with the server verdict
  ↓ receipt-based dedupe when batchId present  (Phase 1, unchanged)
  ↓ Activity rows persisted
```

The agent remains a pure telemetry collector — **zero agent changes**, no new
agent version, no new payload fields. Old agents keep working unchanged.

### 1.1 Why both rules AND a default mirror?

If rules alone decided classification, enabling the flag would instantly
re-classify every unmatched row to `neutral`, visibly shifting dashboards.
Instead, the default-heuristic fallback is a server-side mirror of the agent's
`categorize()`/`categorizeDomain()` logic, so:

- rows matching an org rule → rule category (deterministic, admin-controlled);
- rows matching no rule → exactly the category the agent would have produced;
- enabling the flag with zero rules → no dashboard change at all.

### 1.2 Classification contract

Deterministic function of: `matchType`/`pattern`/`category`/`priority` rule
set + row (`type`, `applicationName`, `title`, `url`). No randomness, no
client input in the decision.

---

## 2. Database changes

### 2.1 Migration `20260903020000_category_rules` (additive)

New table `CategoryRule`:

| column          | type        | notes                                        |
|-----------------|-------------|----------------------------------------------|
| `id`            | TEXT PK     | CUID                                         |
| `organizationId`| TEXT FK     | → Organization, ON DELETE CASCADE            |
| `name`          | TEXT        | required, ≤64 chars (server-validated)       |
| `matchType`     | TEXT        | `application` \| `executable` \| `domain`    |
| `pattern`       | TEXT        | plain substring, ≤128 chars (server-validated) |
| `category`      | TEXT        | `productive` \| `neutral` \| `unproductive`  |
| `priority`      | INTEGER     | default 100; **lower number wins first**     |
| `enabled`       | BOOLEAN     | default true                                 |
| `createdAt` / `updatedAt` | TIMESTAMP |                                          |

Indexes (each maps to a real query):

- `CategoryRule_organizationId_idx` — org-scoped reads/CRUD.
- `CategoryRule_organizationId_enabled_priority_idx` — the ingestion load
  (`where organizationId, enabled=true orderBy priority asc, createdAt asc`).

Foreign key `CategoryRule_organizationId_fkey` cascades on org delete.
Verified on a scratch DB: `prisma migrate deploy` clean and
`prisma migrate diff` reported **"No difference detected"** against the
migrated scratch DB. No existing table was altered; no existing Activity row
was touched.

---

## 3. Server classification engine

### 3.1 `src/lib/classification/engine.ts` (pure, no DB/IO)

- `CATEGORY_RULE_MATCH_TYPES = ['application', 'executable', 'domain']`.
- `CATEGORY_RULE_TARGETS = ['productive', 'neutral', 'unproductive']`
  (`idle` is never assignable by a rule).
- `classifyRow(row, rules)` — rules are passed in already ordered
  (`priority asc, createdAt asc, id asc` tiebreak); first match wins; no match
  → `null` so the caller applies the default heuristic.
- **Plain-substring matching only** (case-insensitive). Deliberately **not**
  regex — no ReDoS, no arbitrary code, no SQL, no shell. A rule can never
  execute anything.
- Match targets over the stored row fields: `executable` →
  `applicationName` (process/exe name), `application` → `title` (friendly
  window title), `domain` → `url` (already-normalized bare domain).
- Purely functional → ingestion, dry-run, and tests share one code path.

### 3.2 `src/lib/classification/defaults.ts` (agent heuristic mirror)

`defaultApplicationCategory(name)` / `defaultDomainCategory(domain)` mirror
`omnisight-agent` collectors so the server fallback reproduces agent output.
Documented in-file as kept-in-sync with the agent; an org that never enables
`server_classification` never executes this path.

### 3.3 `src/lib/classification/validation.ts`

Server-side rule validation (used by the API):

- name: trimmed, non-empty, ≤64 chars;
- matchType ∈ `application | executable | domain`;
- pattern: trimmed, non-empty, ≤128 chars;
- category ∈ `productive | neutral | unproductive`;
- priority integer within `[-1000, 1000]`, default 100;
- upper bounds guard the per-org rule count (bounded evaluation).

Violations → 422 JSON (`{ error: 'validation_failed', details: [...] }`).

---

## 4. Feature flag / settings

### 4.1 `server_classification` registry entry

`src/lib/jobs/settings.ts` — added to the existing monitoring-flag registry:

- key `server_classification`, `type: 'boolean'`, `default: false`;
- `resolveServerClassificationEnabled(organizationId)` helper mirrors
  `resolveActivityDedupeEnabled` (reads an org-scoped SystemSetting row with
  the registry default fallback — same pattern, no new flag framework).

Semantics:

- OFF (default): activity ingestion stores the agent category unchanged.
- ON: ingestion loads that org's enabled rules once per request (bounded by
  `MAX_RULES_PER_ORG`) and re-classifies each `application`/`website` row.

The flag does not bypass authentication, org isolation, validation, consent,
break/working-hours suppression, or the Phase 1 dedupe path.

### 4.2 Admin visibility

`server_classification` appears in:

- Settings → Monitoring server-side flag card (Settings page).
- Organization page server-side monitoring keys (same boolean formatting as
  `activity_dedupe`).

---

## 5. Ingestion integration (`src/app/api/agent/activity/route.ts`)

After the existing validation + website-domain normalization and before the
Phase 1 insert/dedupe branch:

1. `resolveServerClassificationEnabled(organizationId)` (org from the
   authenticated agent/employee — never from the client body);
2. if enabled, load `categoryRule.findMany({ where: { organizationId,
   enabled: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })`
   — one bounded query per request, no N+1;
3. for each `application`/`website` row: `classifyRow` returns a verdict for
   every such row — a matched rule's category when a rule matches, otherwise
   the **default-heuristic mirror** output (`ruleMatched: false`). The route
   overwrites `row.category` with that verdict (counted; a single info log
   per request when any row changed). `classifyRow` returns `null` only for
   row types that are never rule-classified (`idle`, `screenshot`,
   `work_session`), which the caller leaves at the agent value.

> Why unmatched rows do not shift dashboards: the default mirror reproduces
> the agent's local categorizers, so an unmatched row's verdict equals the
> category the agent would have sent anyway. Enabling rules therefore only
> changes rows an admin explicitly matched.

4. `idle`, `screenshot`, `work_session` rows are never re-classified.

---

## 6. Admin API (`/api/category-rules`)

Organization context is **server-authoritative** everywhere (derived from the
authenticated session's selected org — never from the request body).

| Route | Method | Access | Behavior |
|---|---|---|---|
| `/api/category-rules` | GET | manager+ (RBAC, same as monitoring reads) | list org rules, ordered by priority |
| `/api/category-rules` | POST | manager+ | create (validated, 422 on bad input) |
| `/api/category-rules/[id]` | PATCH | manager+ | update name/pattern/category/priority/enabled |
| `/api/category-rules/[id]` | DELETE | manager+ | delete |
| `/api/category-rules/dry-run` | POST | manager+ | preview classification of sample rows against current (or proposed) rules — never persists |

Cross-org rule ids → 404 (resource-existence concealment convention). No rule
mutation is exposed to viewer/employee; unauthenticated → 401. RBAC verified
against the existing role/permission matrix (`super_admin`, `org_admin`,
`manager` allowed; viewer denied mutation).

### 6.1 Dry-run

Accepts sample rows + an optional rules array (with matchType/pattern/
category/priority/enabled). Evaluates the same `classifyRow` used by
ingestion, on normalized inputs (websites normalized to bare domains the same
way ingestion normalizes them), returns per-row verdicts + counts. Safe: pure
in-memory evaluation, nothing written.

---

## 7. Admin UI

### 7.1 `src/components/settings/category-rules-card.tsx` (new)

Self-contained management card mounted in **Settings → Monitoring** (existing
surface; no new nav hierarchy). Uses the existing design-system components
(Button/Input/Select/badge styles already in the project). Supports:

- list rules (name, match type, pattern, category chip, priority, enabled);
- create (pattern + match type + category + priority);
- edit (inline, same fields);
- enable/disable toggle;
- delete (confirm);
- inline `server_classification` status note — when the flag is OFF the card
  explains rules take effect once server classification is enabled.

RBAC is enforced server-side; the card renders read-only for roles without
mutation rights per the existing settings surface behavior.

### 7.2 `src/components/settings/settings-page.tsx` / `organization-page.tsx`

Added the `server_classification` label + SERVER_SIDE key so the flag renders
consistently with `activity_dedupe`/`agent_min_version`.

---

## 8. Working-hours / break semantics

Phase 3 adds no new working-hours logic — it documents and respects the
existing enforcement chain (unchanged code paths):

- The agent already suppresses collection during break mode / outside
  permitted hours (break-mode suppression and policy enforcement run in the
  agent and at the API, unchanged); classification only ever sees activity the
  existing pipeline admitted — so break/outside-hours periods naturally
  produce no rows to mis-classify.
- Classification is pure and timezone-agnostic by design (per-row
  category), so it cannot introduce hidden server-local-time behavior.
- Raw telemetry is never deleted or rewritten by classification; only the
  `category` value of in-flight ingestion rows is decided server-side when the
  org opts in.
- Tests CAT-12/CAT-13/CAT-14 pin this: classification determinism across
  timestamps/timezones, no idle re-classification, and out-of-hours offline
  replay uploads accepted + classified (telemetry never dropped).

---

## 9. Backward compatibility

- **API**: `POST /api/agent/activity` request/response contract unchanged;
  classification is an internal decision when the org flag is ON, and
  byte-for-byte today's behavior when OFF.
- **Agent**: no protocol change; old agents unaffected; new fields are
  server-side settings only.
- **Phase 1**: dedupe branch untouched (receipt transactionality, batchId
  scoping, response contract all preserved — adjacent `activity-dedupe`
  suite green).
- **Phase 2**: screenshot pipeline untouched.

---

## 10. Security review

- Org isolation: every rule query/CRUD path filters by the authenticated
  org; cross-org ids 404; ingestion org comes from the authenticated
  employee/device.
- No client-controlled org context; `organizationId` in rule/activity bodies
  is ignored where authenticated context exists.
- Rule matching is plain-substring: no regex (ReDoS-safe), no JS/SQL/shell
  execution, no arbitrary code.
- Patterns are stored as data only and bounded (128 chars, per-org rule
  count cap).
- RBAC on all rule routes; no new roles; viewer/employee cannot mutate.
- Existing auth/session/consent/break/working-hours/rate-limit paths
  untouched.

## 11. Privacy

No new telemetry; no keystroke/content collection; website classification
operates on the stored bare domain (already domain-only); `title` matching is
against the application window title the existing collector already stores
for application rows, and website rows keep domain-only semantics. Rule
patterns are visible only to org managers+.

---

## 12. Performance

- Ingestion: one bounded rule query per request only when the flag is ON
  (rules capped per org); evaluation is an in-memory loop over ≤ per-org cap
  rules with O(1) substring checks per row — no N+1, no unbounded scan.
- Rule CRUD: primary-key/id + org-scoped queries with the two added indexes.
- Benchmark (CAT-PERF-1): 100 orgs × 100 rules × 10,000 activities classified
  in ~1.65 s in-process, zero cross-org leakage, bounded memory (suite
  asserts no N+1 by construction — single rule load per org).
- No caching introduced (correctness-first; rule tables are small and the
  single query per request is cheap).

---

## 13. Rollback

1. Turn `server_classification` OFF (Settings → Monitoring) → ingestion
   stores agent categories again (previous behavior). No code revert needed
   for behavior.
2. Revert the additive code (engine/defaults/validation, API routes, card).
3. The migration is additive; the `CategoryRule` table may stay harmlessly
   (no code reads it after revert) or be dropped once no deployment depends
   on it. No Activity data is ever touched by rollback.
