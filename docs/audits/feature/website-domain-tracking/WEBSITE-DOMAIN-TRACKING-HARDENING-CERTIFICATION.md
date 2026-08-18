# WEBSITE / DOMAIN TRACKING — P2 HARDENING CERTIFICATION

**Date:** 2026-08-13
**Task:** Fix WT-P2-1 (server-side `website_tracking` enforcement) per `WEBSITE-DOMAIN-TRACKING-FINAL-AUDIT.md`.
**Scope:** ONLY the P2 fix — P3s (extension install state, Live Monitor title-vs-domain) intentionally untouched, incognito behavior unchanged.

---

## 1. Before → After

| Metric | Before | After |
|---|---|---|
| Score | 92/100 | **96/100** |
| P0 | 0 | 0 |
| P1 | 0 | 0 |
| P2 | 1 | **0** |
| P3 | 2 | 2 (unchanged, out of scope) |

## 2. Root Cause

`POST /api/agent/activity` enforced consent server-side but NOT the organization's `website_tracking` setting. The org setting only gated the Desktop Agent locally (via `GET /api/agent/config` → collector gate), so a stale, compromised, buggy, or rogue authenticated agent could still submit `type='website'` rows while the org had website tracking disabled. Verified live in the audit (upload accepted while `website_tracking=false`).

## 3. Files Changed

| File | Change |
|---|---|
| `src/app/api/agent/activity/route.ts` | Added server-authoritative `website_tracking` gate: after per-item validation, if any validated item is `type='website'` and the **token-derived** org's `website_tracking !== true` → **403 `{ "error": "WEBSITE_TRACKING_DISABLED" }`**, whole batch rejected, zero rows written. |
| `tests/website-tracking.test.ts` | Added WT-P2-1-01…10 (10 new tests; suite 9 → 19). |

**No schema, no agent, no extension, no auth/consent/tenant changes.**

## 4. Server-Side Enforcement Location & Shared Layer

- **Location:** `src/app/api/agent/activity/route.ts`, inserted between strict per-item validation and website-domain normalization, immediately before `db.activity.createMany`.
- **Shared resolver:** `resolveOrgMonitoring(authResult.employee!.organizationId)` — the SAME canonical resolver `GET /api/agent/config` uses, so the server and the agent can never disagree on the setting value (same `OrganizationSetting` table, same deterministic default `true`, same validation/coercion).
- **All activity writers audited:** `db.activity.create`/`createMany` call sites are (1) `POST /api/agent/activity` (external ingestion — the only path that can receive `type='website'` from a client), (2) `POST /api/agent/break` (writes `type:'idle'` only), (3) `POST /api/break-status/[id]/toggle` (writes `type:'idle'` only), (4) `src/lib/seed.ts` (seed data). The policy applies to the external ingestion path only — legitimate server-generated `idle` records and seed data are unaffected, as intended.

## 5. Error Contract

- Website disabled → **403** `{ "error": "WEBSITE_TRACKING_DISABLED" }` (stable machine-readable code; clients can distinguish it from consent 403, validation 422, auth 401).
- Consent revoked → existing **403** consent error (unchanged, checked before the tracking gate).
- Invalid payload → existing **422** (unchanged; validation still runs first).
- No secrets or config values exposed in any error.

## 6. Behavioral Matrix (live-verified)

| Case | website_tracking | consent | Result |
|---|---|---|---|
| 1 | true | granted | 200, row persisted |
| 2 | false | granted | 403 `WEBSITE_TRACKING_DISABLED`, zero rows |
| 3 | false | revoked | 403 consent error, zero rows (consent checked first) |
| 4 | false + forged organizationId | granted | 403 (token org authoritative) |
| 5 | false + mixed batch (app+website) | granted | 403 whole batch, zero rows (atomic) |
| 6 | true + forged ids | granted | 200, attributed to token employee/device |
| 7 | re-enabled | granted | 200, ingestion resumes |

## 7. Tests — 19/19 PASS (tests/website-tracking.test.ts)

| ID | Coverage | Result |
|---|---|---|
| WT-1+2+3 | domain sanitization; secrets never persisted | ✔ |
| WT-4 | 401 without token | ✔ |
| WT-5 | 403 without consent | ✔ |
| WT-6 | tenant isolation (token-derived employee) | ✔ |
| WT-7 | batch limit 100 | ✔ |
| WT-8 | non-website rows unaffected | ✔ |
| WT-9 / 9b | domain/title unit matrices | ✔ |
| WT-10 | admin aggregation domain-only | ✔ |
| **WT-P2-1-01** | tracking=true → accepted | ✔ |
| **WT-P2-1-02** | tracking=false → rejected 403 + code | ✔ |
| **WT-P2-1-03** | tracking=false → zero DB writes | ✔ |
| **WT-P2-1-04** | tracking=false + valid consent → still rejected | ✔ |
| **WT-P2-1-05** | tracking=false + forged org → ignored | ✔ |
| **WT-P2-1-06** | tracking=true + forged ids → token attribution | ✔ |
| **WT-P2-1-07** | mixed batch while disabled → atomic rejection, zero writes | ✔ |
| **WT-P2-1-08** | re-enable → resumes | ✔ |
| **WT-P2-1-09** | application/idle/session/screenshot ingestion unaffected | ✔ |
| **WT-P2-1-10** | tenant isolation (A disabled, B enabled) | ✔ |

## 8. Live Probes — 26/26 PASS (real server :3000, real dev DB)

Full supported pipeline driven: admin session → probe Employee + AgentAccount → `/api/agent/login` → `/api/agent/discover` → admin approve → `/api/agent/authenticate` → consent → uploads → settings toggle via `/api/settings/monitoring`.

- enabled → upload **200**, DB count 0→1
- disable via settings → upload **403 `WEBSITE_TRACKING_DISABLED`**, count stays 1
- disabled + forged organizationId/employeeId/deviceId → **403** (token org authoritative)
- disabled mixed batch (app+website) → **403**, zero writes (total stays 1)
- re-enable → upload **200**, count 1→2
- consent revoked → **403 consent error** (not the tracking code)
- consent re-granted + enabled → **200**, count 2→3
- no token → **401**
- cleanup: probe employee/device/account/consent/rows all removed; `website_tracking` restored to baseline `true`

## 9. DB Before/After Evidence

- During the disabled phase: pre-upload count = 1 (the enabled-phase row), post-rejected-upload count = 1 → **no website row created while disabled**.
- After re-enable: count 2, then 3 → ingestion resumed exactly as configured.
- Final residue check: `{emp:0, act:0, claims:0, accs:0, tokens:0, consents:0}`; org setting restored to `true` (baseline).

## 10. Tenant-Isolation Evidence

- Organization resolved strictly from the authenticated AgentToken (`authResult.employee!.organizationId`); forged `organizationId` in the payload never consulted (WT-P2-1-05/06, live).
- WT-P2-1-10: org A disabled rejects, org B enabled accepts; zero cross-org rows.
- No-token request → 401 (live).

## 11. Consent Interaction

- Consent gate remains FIRST (fail-closed, unchanged). Revoked consent → 403 before the tracking gate runs (live: consent error, not `WEBSITE_TRACKING_DISABLED`). Re-granted consent + enabled tracking → 200.
- No consent logic modified.

## 12. Regression Gates

| Gate | Result |
|---|---|
| Server tests (`npx tsx --test tests/*.test.ts`) | **595/595 PASS** (585 baseline + 10 new WT-P2-1) |
| Desktop Agent tests | **282/282 PASS** |
| Browser Extension tests | **7/7 PASS** |
| TypeScript (`npx tsc --noEmit`) | 0 errors |
| ESLint (changed files) | 0 errors |
| Prisma validate | valid |
| Next build | **PASS** (exit 0; 6 pre-existing Edge-Runtime warnings in untouched files, identical to prior builds) |

## 13. Cleanup Verification

```
Probe rows:        0   (verified: Employee/Activity/DeviceClaim/AgentToken/AgentSession/Device/AgentAccount/Consent/ConsentLog all 0)
Probe files:       0
Temporary scripts: 0   (scripts/_wtrk_harden_live.mts removed)
Settings restored: website_tracking → true (baseline)
Source modified:   YES (1 route + 1 test file)
Database modified: NO (probe rows only, all removed)
Schema modified:   NO
Seed modified:      NO
Committed:         NO
```

## 14. Remaining P3s (unchanged, out of scope by task)

- **WT-P3-1** — browser extension not installed in the current Chrome profile (deployment state, not a source defect). Not modified.
- **WT-P3-2** — Live Monitor `activity-ping` carries page title rather than domain. Not modified (explicitly excluded).

## 15. Honest Limitations

- Live verification used a probe employee/device through the real supported agent pipeline (not a real browser visit) — the browser→extension→host hop remains non-live on this machine (WT-P3-1). The server-side policy is transport-agnostic and was proven through the real ingestion API.
- `resolveOrgMonitoring` adds one `OrganizationSetting` query per upload request containing a website row (only when `hasWebsite`). Negligible; consistent with the route's existing per-request consent query.

## 16. Final Verdict

```
Website tracking enforced server-side:  YES (403 WEBSITE_TRACKING_DISABLED, zero rows)
Org derived from token only:            YES
Mixed-batch atomicity preserved:        YES (whole batch rejected, zero writes)
Consent behavior preserved:             YES (checked first, unchanged)
Application/idle/session/screenshot:    UNAFFECTED (verified)
Tenant isolation:                       INTACT (verified)
Tests:   Server 595/595 (19/19 website suite) · Agent 282/282 · Extension 7/7
TypeScript: 0 errors   ESLint: 0 errors   Prisma: valid   Build: PASS
Live probes: 26/26 PASS   Cleanup: 0 residue
P0: 0   P1: 0   P2: 0   P3: 2 (unchanged, out of scope)
Final score: 96/100
Final verdict: PRODUCTION READY
```
