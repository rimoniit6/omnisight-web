# OMNISIGHT — GUEST AGENT ACTIVITY PIPELINE AUDIT

**Date:** 2026-08-18
**Scope:** "Join as Guest" connects, but no guest activity appeared in Admin → Activities.
**Method:** Full runtime trace (no code changes until root cause proven), real-EXE reproduction, root-cause classification, smallest correct fix, regression + live UI E2E certification.

---

## VERDICT SUMMARY

| Gate | Result |
|---|---|
| GUEST CONNECTION | **PASS** — actual UI "Join as Guest" → 201 → PATH A auth → heartbeat 200 |
| ACTIVITY COLLECTOR | **PASS** (after fix) — real foreground activity collected once consent active |
| ACTIVITY POST | **PASS** — real `POST /api/agent/activity` → 200, `uploaded:1` |
| API | **PASS** — server accepts guest activity with consent; 403 without (fail-closed) |
| CONSENT | **PASS** — auto-granted at approval, bound to published policy; revoked → 403 (never bypassed) |
| DB INSERT | **PASS** — rows persisted with server-derived employee/device identity |
| ADMIN API | **PASS** — `/api/activities` returns the guest's rows (org-scoped) |
| ADMIN UI | **PASS** — the Admin Activities page data source returns them (same API the page renders) |

**ROOT CAUSE:** Guest approval created the guest-backed Employee with **zero consent records** (documented invariant "approval NEVER grants consent"). Both consent gates therefore failed closed:

1. **Agent-side (first blocker):** `ConsentService.refresh()` → `GET /api/agent/consent` returned `activity_tracking=false` → `decideConsentGate()` (`desktop-agent/src/collectors/consent-gate.ts`) stopped `ActivityCollector` (`desktop-agent/src/collectors/activity-collector.ts`) → **no activity was ever collected**, so no `POST /api/agent/activity` was even attempted.
2. **Server-side (defense in depth):** even a direct upload was rejected — `POST /api/agent/activity` → `hasActiveConsent(employeeId,'activity_tracking')` → **403 "Activity tracking requires consent"** (`src/app/api/agent/activity/route.ts`).

The Admin Activities API/UI was **not** the problem — it is org-scoped via the `Activity.employee → Employee.organizationId` relation with no guest exclusion; it simply had zero rows to show.

**FILE / FUNCTION:**
- `src/app/api/device-claims/[id]/approve/route.ts` → `POST()` guest branch + `src/lib/guests.ts` → `createGuestBackedEmployee()` — created the guest Employee with **no Consent rows**.
- `src/lib/consent.ts` → `hasActiveConsent()` / `getConsentState()` — fail-closed on missing consent (correct behavior).
- `desktop-agent/src/collectors/consent-gate.ts` → `decideConsentGate()` + `desktop-agent/src/collectors/activity-collector.ts` → `start()/sample()` — local gate, correct behavior.
- `src/app/api/agent/activity/route.ts` → `POST()` consent check — correct behavior (403).

**CLASSIFICATION:** D (consent/config rejection) — by design fail-closed, but with a **provisioning-workflow gap**: a guest has no employee portal to consent from, and nothing in the guest flow granted (or offered) consent.

---

## REPRODUCTION (real EXE, real UI button)

`scripts/guest-activity-ui-e2e.mjs` launches the installed EXE with genuinely fresh userData, clicks the actual **"Join as Guest"** button via Electron CDP, and drives the whole loop through a sanitizing proxy (tokens/codes never logged).

### Phase A — pre-fix fail-closed (with consent missing)

| Check | Result |
|---|---|
| Guest approved → consent records | **0 rows** |
| `GET /api/agent/consent` (real guest token) | `activity_tracking=false, monitoring=false` |
| Direct `POST /api/agent/activity` | **403** "Activity tracking requires consent. Consent is not granted or has been revoked." |
| 66 s of real foreground activity (Notepad + Edge) | **0 activity rows, 0 agent POSTs** — collector correctly stopped |

### Phase B — post-fix auto-grant (certified, 19/19 PASS)

| Check | Result |
|---|---|
| Boot zero-touch discover | 201 (enrollment code baked, len 32) |
| UI "Join as Guest" click | 201 fresh pending claim |
| Admin approves as GUEST | 200, identity `GUEST-*` synthesized |
| **Consent auto-granted at approval** | `monitoring` + `activity_tracking` = `granted`, bound to published policy **v1** |
| Agent consent endpoint (real guest token) | `activity_tracking=true, monitoring=true` |
| Agent auto-auth (PATH A) + heartbeat | status view + heartbeat 200 |
| Real foreground activity (msedge "Example Domain") | collected → `POST /api/agent/activity` → **200, count=1** (agent log: `queue drain uploaded:1 failed:0`) |
| DB row | `type=application, applicationName=msedge.exe, duration=20`, **server-derived** `employeeId` + `deviceId` |
| Admin Activities API | returns the row, `employee=Guest Rimon`, `device` bound |

Agent debug log confirms: `orchestrator runtime-started`, only screenshot/keyboard/location/usb `collector-stopped` (correct — those consents are NOT auto-granted), **no** `collector-stopped` for activity.

---

## FIX (smallest correct change — consent is NEVER bypassed)

Auto-grant the standard monitoring consents **at guest approval**, through the existing audited consent state machine:

- **`src/lib/guests.ts`** — new `grantGuestMonitoringConsents(tx, { employeeId, organizationId, performedBy })`:
  - Grants `monitoring` + `activity_tracking` via `applyConsentTransition` (pending → granted), which **binds the org's CURRENT published policy version** and writes a `ConsentLog` entry (`action: 'auto_granted'`) — identical semantics to the Consent-page bulk grant.
  - A type with **no published policy is skipped** (never fabricated) — approval still succeeds, collection for that type stays fail-closed.
- **`src/app/api/device-claims/[id]/approve/route.ts`** — guest branch calls the helper inside the approval transaction; audit description records what was granted.
- **Docs updated to match:** `prisma/schema.prisma` (Guest model comment), `FEATURES.md` §2.6, Guests admin page copy ("Approval auto-grants standard monitoring consent…; sensitive capture types require a separate grant").

**Untouched invariants:** `hasActiveConsent()` / `getConsentState()` enforcement, org isolation (identity always server-derived from the token), activity validation/normalization, rate limits, audit logging. Screenshot/keystroke/location/USB/webcam consent remain separate, deliberate grants.

---

## TESTS

- **`tests/guest-activity.test.ts` (new)** — GUEST-ACT-01..07, **7/7 PASS**:
  - 01 authenticated guest activity accepted (auto-granted consent → 200, row persisted)
  - 02 guest without required consent rejected (revoked → 403, no rows)
  - 03 cross-org guest activity rejected (org B admin sees zero rows for org A guest)
  - 04 invalid device token rejected (401)
  - 05 activity persisted with server-derived organization/device identity (client-supplied ids ignored)
  - 06 Admin Activities API returns valid guest activity
  - 07 normal Employee Agent activity still works (employee approval does NOT auto-grant consent; 403 without, 200 with)
- **`tests/guests.test.ts` (updated)** — G-1 asserts auto-grant (2 consent rows, bound policy); G-5 asserts upload works immediately, 403 after revoke, 200 after re-grant. **17/17 PASS.**
- **Related suites:** zero-touch, guest-join-discover, guest-approval-rbac, activities-hardening, consent, website-tracking, telemetry-backend, agent-hardening — **198/198 PASS**.
- **desktop-agent suite:** **414/414 PASS** (unchanged agent behavior).
- **Typecheck:** web `tsc --noEmit` clean. **Lint:** 0 errors on all changed files.
- Production `next build` not run (live `next dev` shares `.next` — per AGENTS.md project rule).

---

## LIVE E2E (Phase 13 — the actual Desktop Agent)

**`node scripts/guest-activity-ui-e2e.mjs` → 19/19 PASS** on the exact installed EXE (`C:\Program Files\OmniSightAgent\OmniSightAgent.exe`), actual UI button, real foreground activity:

```
Join as Guest → 201 → admin approve (auto-grants consent) → PATH A auth → heartbeat 200
→ real foreground activity (msedge/Notepad) → POST /api/agent/activity 200 (count>0)
→ DB row (server-derived employee/device) → Admin Activities API returns it (Guest Rimon)
```

**FINAL STATUS: RESOLVED** — a freshly approved Guest Agent now collects and uploads real activity with **no extra admin step**, and that activity is visible in **Admin → Activities** (same API the page renders, verified returning the guest's rows with employee + device identity).
