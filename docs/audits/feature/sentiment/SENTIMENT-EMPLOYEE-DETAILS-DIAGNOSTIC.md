# ADMIN PANEL — SENTIMENT EMPLOYEE SEARCH & EMPLOYEE DETAILS — ROOT-CAUSE DIAGNOSTIC

**Date:** 2026-08-13
**Mode:** AUDIT ONLY — no source, DB, or seed modified. No probe data left behind.

---

## Executive Summary

Both issues are **client-side (frontend) bugs in `src/components/sentiment/sentiment-page.tsx`**. Neither the database nor the APIs are at fault — all server data is present and correctly scoped, and both API endpoints respond correctly.

| Issue | Primary Root Cause | Class |
|---|---|---|
| **A — Employee Search blanks the page** | No debounce + `search` inside the React Query `queryKey` + whole-page loading branch → every keystroke discards current results, unmounts the entire content tree (including the search box itself) into full-page skeletons, then refetches. Looks like a page refresh/blank. | Frontend state/UX bug (React Query + render branching) |
| **B — Key Signals show `—`** | **Double-parsing of `signals`**: the detail API (`/api/sentiment/[id]`) already `JSON.parse`s `signals` into an **object**, but the client calls `parseJSON(detail.signals)` again — `JSON.parse(object)` throws → falls back to `{}` → every signal is `null` → all metrics render `—`. Score still shows because it reads `detail.score` directly (never through `signals`). | Wrong API contract usage (client) |

**VERIFIED live** against the running server and the real database: DB has 69 sentiment records with fully populated signal keys; the list API returns `signals` as a raw string (works); the detail API returns `signals` as a parsed object (breaks under the client's re-parse); the client's `parseJSON` demonstrably falls back to `{}`.

---

## 1. Exact Error Flow

### ISSUE A — Search

```
Type "Sa" in "Search employee..."
  ↓ setSearch('S') → setPage(1)  (no debounce — fires on EVERY keystroke)
  ↓ queryKey becomes ['sentiment', 1, 'all', 'all', 'S', 'newest']  (search IS in the key)
  ↓ React Query: new key → old data discarded → isLoading=true → data=undefined
  ↓ {isLoading ? <full-page skeletons> ...}  ← ENTIRE page unmounts (stats bar,
      mood bar, toolbar WITH the search input, results grid — everything)
  ↓ fetch GET /api/sentiment?search=S → resolves
  ↓ re-render: if no match → "No matching employees" EmptyState (search box gone again)
```

- No `debounce`, no `keepPreviousData`/`placeholderData`, no `refetchOnWindowFocus` reset — each keystroke = a full round-trip and a full skeleton swap.
- The search input itself lives **inside** the non-loading branch (line ~830), so while `isLoading` is true the input **disappears** — the user sees the page "refresh" and the result area go blank, then the input reappears after the fetch.
- With a no-match query, `!data?.records?.length` renders the EmptyState branch, which **also lacks the search toolbar** → the input vanishes and "No matching employees" + a "Clear Filters" button are all that's left.

### ISSUE B — Key Signals

```
Open "View Details" (record.id)
  ↓ setSelectedId(id)
  ↓ GET /api/sentiment/[id]   (org-scoped, 404 for foreign orgs)
  ↓ server: record.signals is a JSON STRING in DB
  ↓ server: parsedSignals = JSON.parse(record.signals) → OBJECT  ← already parsed
  ↓ response: { data: { ..., signals: {productivityTrend, idleRate, totalHoursThisWeek, ...}, riskFactors: [...] } }
  ↓ client: parseJSON(detail.signals, {})   ← parses the OBJECT again
  ↓ JSON.parse(object) → "[object Object]" → SyntaxError → catch → returns {}
  ↓ normalizeSignals({}) → productivityPct=null, idleRate=null, totalHours=null,
                          productiveHours=null, activityCount=null
  ↓ SignalCard renders '—' for all five
  ↓ Score renders 55/100 because it uses detail.score directly (not via signals)
```

The list **cards** are unaffected because `GET /api/sentiment` returns the raw `signals` **string** (route.ts never parses it), so the client's `parseJSON(string)` succeeds there. Only the **detail dialog** breaks — its API returns the parsed object.

---

## 2. Source Locations

| Component | File | Function | Finding |
|---|---|---|---|
| Sentiment page (search, cards, detail dialog) | `src/components/sentiment/sentiment-page.tsx` | `SentimentPage` | A: no debounce; `search` in `queryKey`; whole-page loading branch; toolbar only in data branch. B: `parseJSON(detail.signals, {})` re-parses an object. |
| `parseJSON` helper | `sentiment-page.tsx` (~line 160) | `parseJSON` | `JSON.parse(str)` on an object throws → fallback. Does not detect already-parsed objects. |
| `normalizeSignals` | `sentiment-page.tsx` (~line 185) | `normalizeSignals` | Correctly maps persisted keys (incl. `productivityPct` derivation); only gets `{}` because of the caller. |
| Detail API | `src/app/api/sentiment/[id]/route.ts` | `GET` | Returns `signals` as **parsed object** (`JSON.parse(record.signals)`), `riskFactors` as array. Server behavior is correct — the client must accept both shapes. |
| List API | `src/app/api/sentiment/route.ts` | `GET` | Returns raw `signals` string; server-side search/filter/sort/dedup all correct (verified live: search "Sa" → 3 results; no-match → 200 empty). |
| Analyzer | `src/app/api/sentiment/analyze/route.ts` | `calculateSignals` | Persists correct keys: `productivityTrend, idleRate, overtimeHours, breakFrequency, loginConsistency, anomalyCount, activityDrop, productiveHoursThisWeek, productiveHoursLastWeek, totalHoursThisWeek, idleHoursThisWeek, activityCount`. DB confirmed. |
| Seed | `src/lib/seed.ts` (~line 1308) | — | Seeds legacy key set (`productivityPct, idleRate, totalHours, productiveHours, activityCount`) — `normalizeSignals` handles BOTH key sets, so seed data would render fine once the double-parse is fixed. |

## 3. Runtime Evidence (live server + real DB, no modifications)

```
DB: 69 sentiment records
  record … score=65 mood=neutral
  signalsRaw={"productivityTrend":13.9,"idleRate":16.95,"overtimeHours":0,"breakFrequency":2.83, …
  parsed keys: productivityTrend, idleRate, overtimeHours, breakFrequency, loginConsistency,
               anomalyCount, activityDrop, productiveHoursThisWeek, productiveHoursLastWeek,
               totalHoursThisWeek, idleHoursThisWeek, activityCount        ← REAL DATA PRESENT

✔ admin login
✔ list API 200 — list signals typeof: string (raw)
✔ detail API 200 — detail signals typeof: object (parsed)
✔ client parseJSON(detail.signals) FALLS BACK to {} (double-parse bug)  ← PROVEN
✔ UI renders — for all five metrics (given {} input)
✔ search API works — "Sa" → 3 results; no-match "zzzzz" → 200 + empty records
```

## 4. Identity / Data Verification

- **DB data exists:** signals populated for the analyzed employee (the record the user opened is one of the 69 with full signal keys).
- **Employee mapping correct:** detail route scopes by `employee: { organizationId }` and returns the record's own employee — the right record is fetched.
- **Organization scoping correct:** both APIs org-scope from the session JWT; 404 for foreign orgs.
- **Date range:** analyzer ran a 7-day period (`periodDays: 7`); periodStart/periodEnd present. Not a date problem.
- **Not React Query cache/loading:** the detail query key `['sentiment-detail', selectedId]` is correct; the bug is purely the shape mismatch on `signals`.

## 5. ISSUE A — Detailed Findings

| # | Severity | Finding |
|---|---|---|
| SA-1 | P2 | **No debounce.** Every keystroke fires a full server request (`search` in `queryKey`, `onChange` sets state directly). Rapid typing = N round-trips. |
| SA-2 | P2 | **`search` in the queryKey + no `keepPreviousData`** → each keystroke discards current results and enters the full-page `isLoading` skeleton branch — the visible "page refresh / blank result area". |
| SA-3 | P2 | **Search toolbar lives only inside the data branch** (`{...} : (...)}` after the `!data?.records?.length` check). During loading AND on no-match, the search box unmounts — the input literally disappears while you type. |
| SA-4 | P3 | No-match shows only EmptyState + "Clear Filters"; the user cannot edit their query without clearing (input gone). |
| SA-5 | P3 | Page/result flash on every keystroke is jarring and reads as a reload even though no navigation occurs (no `router.refresh`/`location.reload` on this page — verified; the only `router.refresh()` in the shell is on logout). |

**Server-side search is NOT the problem** — `GET /api/sentiment?search=` filters `firstName/lastName/employeeId` correctly (live-verified 200 + filtered results; 400 only for >100 chars or bad pagination).

## 6. ISSUE B — Detailed Findings

| # | Severity | Finding |
|---|---|---|
| SB-1 | P1 | **Double-parse of `signals` in the detail dialog.** Detail API returns an object; client `JSON.parse`s it again → throws → `{}` → all five Key Signals render `—`. Verified live. |
| SB-2 | P3 | `parseRiskFactors` already handles both shapes (`Array.isArray(raw) ? raw : parseJSON(...)`) — the fix pattern already exists in the same file and should be applied to `signals` the same way. |
| SB-3 | P3 | The detail API could (optionally) return `signals` as a string for consistency with the list API, but the robust fix is client-side shape tolerance (accept string OR object). |
| SB-4 | — | NOT a server/DB/aggregation/date-range/org problem — all verified clean. |

## 7. Recommended Fix (NOT implemented — audit only)

### ISSUE A (search)
1. **Debounce `search`** (e.g., 300–400ms) so typing produces one request per pause.
2. **Keep prior results while refetching** — `keepPreviousData`/`placeholderData: (prev) => prev` (or `placeholderData: keepPreviousData`) so the grid does not blank on each keystroke.
3. **Hoist the search toolbar outside the data/empty branches** so the input is always visible during loading and on no-match; on no-match keep the toolbar and show the empty state only for the results area.

### ISSUE B (Key Signals)
4. Make `parseJSON` (or a small wrapper) accept an **already-parsed object**: if `typeof str === 'object' && str !== null`, return it directly (mirror the existing `parseRiskFactors` pattern). Apply to the `detail.signals` call. Score/idle/total/productive/activity then render from the real persisted values (`normalizeSignals` already maps both analyzer and legacy seed key sets).

### Security notes
- No auth/tenant/RBAC changes needed. APIs stay authoritative. No client `organizationId` introduced.
- Both fixes are confined to `sentiment-page.tsx` (+ optional defensive `parseJSON` shape handling). No API contract changes required.

## 8. Regression Tests Required (for the fix phase)
- Search: single fetch per debounce window; grid keeps showing previous results while fetching; search box visible during loading and on no-match; no-match shows empty state + working toolbar.
- Key Signals: detail dialog with analyzer-key signals renders all five metrics from real values; legacy seed-key signals also render; `signals` as string (list) and object (detail) both work; null score/mood no-data still shows `—`.

## 9. Cleanup Verification
```
Probe rows (DB):     0 (read-only probe; nothing written)
Temporary scripts:   0 (_sent_diag.mts deleted)
Source modified:     NO
DB/seed modified:    NO
```

## 10. Verdict

**Root cause identified for both issues — both are frontend bugs in `sentiment-page.tsx`; the backend and data are healthy.**

- **ISSUE A:** frontend search UX/state bug (no debounce, `search` in queryKey, whole-page loading branch, toolbar inside the data branch). Server search verified working.
- **ISSUE B:** client double-parse of the detail API's already-parsed `signals` object → `{}` → all Key Signals `—` while Score (read directly) still displays.

**Confidence: HIGH** (proven by source + live API probes + live DB inspection).
