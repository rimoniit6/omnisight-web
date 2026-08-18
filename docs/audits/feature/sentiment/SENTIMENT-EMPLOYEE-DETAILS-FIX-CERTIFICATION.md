# SENTIMENT — EMPLOYEE SEARCH & EMPLOYEE DETAILS FIX CERTIFICATION

**Date:** 2026-08-13
**Scope:** The two frontend bugs from `SENTIMENT-EMPLOYEE-DETAILS-DIAGNOSTIC.md` only.
**Files changed:** `src/components/sentiment/sentiment-page.tsx` (single file). No API, DB, schema, auth, tenant, or RBAC changes.

---

## Before

- **ISSUE A:** Every keystroke fired `GET /api/sentiment` (no debounce); `search` was in the React Query key; previous results discarded; full-page skeleton on each keystroke; search toolbar inside the data branch (disappeared during loading and on no-match).
- **ISSUE B:** Detail API returns `signals` as a parsed object; the client `JSON.parse`'d it again → throw → `{}` → all five Key Signals rendered `—`. Score rendered because it reads `detail.score` directly.

## After

- **ISSUE A:** 350ms debounce; `placeholderData: keepPreviousData`; results/toolbar/stats/mood bar stay mounted while searching; subtle "Updating…" indicator during refetch; filter-aware empty state ("No matching employees" vs "No sentiment data yet"); error banner + Retry when a refetch fails over held data; pagination hidden at 0 pages.
- **ISSUE B:** New `parseSignals()` accepts both the raw JSON string (list API) and the already-parsed object (detail API), mirroring the existing `parseRiskFactors` pattern; `normalizeSignals` then yields real persisted values.

## Fix Matrix

| Issue | Root cause | Fix | Verification | Status |
|---|---|---|---|---|
| A | No debounce; `search` in query key; whole-page skeleton; toolbar in data branch | 350ms debounce (`debouncedSearch`), `placeholderData: keepPreviousData`, `isLoading && !data` skeleton gate, toolbar always mounted, filter-aware empty state, "Updating…" indicator, error banner | Live search probes (filtered + no-match), tsc, eslint, next build | **PASS** |
| B | Double-parse: client `JSON.parse`s the detail API's already-parsed `signals` object → `{}` | `parseSignals()` accepts string OR object (same shape-tolerance as `parseRiskFactors`), used for both list cards and detail dialog | Live probe: detail signals object → real values (`productivityPct=16, idleRate=0, totalHours=0.23h, activityCount=22`); list string path also parses | **PASS** |

## Race-condition safety (ISSUE A req #11)

React Query keys requests by the **debounced** search value (`['sentiment', page, moodFilter, deptFilter, debouncedSearch, sort]`). Typing `Sa` then `Sam` creates distinct keys; each resolves into its own cache slot and the component renders only the active key's data — a stale `Sa` response can never overwrite the `Sam` result. Debounce also coalesces keystrokes into a single request.

## Security

- No auth/tenant/RBAC change. `requireSessionOrg` on the APIs untouched.
- No client-supplied `organizationId`; no hardcoded metrics; no fake/default values (no-data records still render `—`, driven by `score === null`).
- Error states are truthful: initial-load error → EmptyState + Retry; refetch-over-data error → inline banner + Retry (previous data stays visible, labeled as such).

## Test Results

```
Server tests (full suite):    543/543 PASS (unchanged — no API/DB changes)
Desktop Agent:                282/282 PASS
Browser Extension:            7/7 PASS
TypeScript (npx tsc --noEmit): 0 errors
ESLint (changed file):         0 errors
next build:                   PASS
```

## Live Verification

```
10/10 PASS (real server + real DB, read-only)
  ✔ admin login; list API 200 + scored record
  ✔ detail API 200; detail.signals is an OBJECT (the contract that broke before)
  ✔ fixed parseSignals(detail.signals) → real values
      productivityPct=16 · idleRate=0 · totalHours=0.23h · productiveHours=0.04h · activityCount=22
  ✔ Key Signals now populated from REAL data (no more all-—)
  ✔ score renders independently (unchanged)
  ✔ list-path (raw string) parse also yields values
  ✔ no-data record parses without crash (score=null drives the gauge)
  ✔ search "Sa" → filtered results; no-match → 200 + empty records
```

## Cleanup

```
Probe rows:      0 (read-only probe, nothing written)
Temp scripts:    0 (_sent_fix_probe.mts deleted)
Source modified: src/components/sentiment/sentiment-page.tsx only
DB/seed modified: NO
```

## Files Changed

| File | Change |
|---|---|
| `src/components/sentiment/sentiment-page.tsx` | Debounced search (350ms), `placeholderData: keepPreviousData`, `isLoading && !data` skeleton gate, toolbar always mounted, filter-aware empty state, "Updating…" indicator, refetch-error banner, `parseSignals()` accepting string OR object for list + detail. |

## Remaining notes

- No component-level unit tests were added because `parseSignals`/`normalizeSignals` are module-private inside a `'use client'` page component (not importable); regression coverage is the live probe (10/10) plus the server-side sentiment suite (20 tests, unchanged and green). The server-side behavior (`GET /api/sentiment`, `GET /api/sentiment/[id]`, search, filters, org scoping) was already covered and remains untouched.

**Verdict: PASS** — both confirmed frontend bugs fixed; no security regression; all suites green; cleanup verified.
