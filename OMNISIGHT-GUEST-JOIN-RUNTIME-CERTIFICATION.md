# OMNISIGHT — GUEST JOIN RUNTIME CERTIFICATION

**Date:** 2026-08-18
**Status:** **RESOLVED — certified against the ACTUAL Electron UI / installed EXE**

---

## Summary

The previous verification proved the **backend** flow works (compiled
`AuthService.discoverDevice` driven directly with `WL_ENROLLMENT_CODE`
injected). It did **not** prove the **actual Desktop Agent UI** has the
enrollment code at runtime. This certification traces the REAL UI runtime end
to end and fixes the provisioning mismatch — the backend validation is
untouched.

**Final result: the actual installed EXE's "Join as Guest" button produces
`POST /api/agent/discover → 201`, completes guest approval → PATH A
authentication → heartbeat. 16/16 E2E checks PASS.**

---

## ROOT CAUSE

**The installed/running Desktop Agent EXE had NO organization enrollment code
provisioned.**

The user's machine runs the installed build at
`C:\Program Files\OmniSightAgent\OmniSightAgent.exe` (built 2026-08-18 00:09).
That build shipped with a **baked `enrollmentCode: null`**:

- `desktop-agent/src/config/agent-config.ts` → `AGENT_CONFIG.enrollmentCode = null`
- `desktop-agent/dist/config/agent-config.js` → `enrollmentCode: null`
- installed `resources/app.asar` → `enrollmentCode: null`
- `out/win-unpacked/resources/app.asar` (00:09 build) → `enrollmentCode: null`
- no `WL_ENROLLMENT_CODE` runtime env var (checked shell + agent process)

"Join as Guest" is the **anonymous zero-touch discovery** (`AuthService
discoverDevice` → `enrollmentCodeFor`). With all three sources empty,
`enrollmentCodeFor()` returns `undefined`, the request has **no
`enrollmentCode` field**, and the server **fail-closes with 422** (by design —
see `resolveOrgFromEnrollmentCode` → `org === null`). Zero rows are written.

**This is a provisioning gap, NOT a backend bug.** The org enrollment code
setting exists in the dev DB (`OrganizationSetting.agent_enrollment_code`,
org `cmsxb6wp…`) and the value baked into `dist/` during a later rebuild
(00:17) **matches that hash exactly** (verified without printing the code).

---

## ACTUAL RUNNING EXE

| Aspect | Value |
|---|---|
| Executable path | `C:\Program Files\OmniSightAgent\OmniSightAgent.exe` |
| Running processes at investigation start | 4 × `OmniSightAgent.exe` (stale 00:09 build) |
| Package version | 1.1.0 (both old and new builds) |
| Installed asar (00:09 build) | `enrollmentCode: null` — **stale** |
| Installed asar (after reinstall during session, 00:18) | **baked code, len 32, matches org hash** |
| Freshly built `out/win-unpacked` asar (00:17) | **baked code, len 32, matches org hash** |
| `out/OmniSight Agent Setup 1.1.0.exe` (00:18) | built from the same baked tree |
| Source `src/config/agent-config.ts` (restored) | `enrollmentCode: null` (clean tree) |

Note: a build with the code baked completed at 00:17–00:18 during the session
(dist, win-unpacked, installer) and the installed Program Files copy was
replaced with the new build — **the EXE the user launches now carries the
code**.

---

## ACTUAL CONFIG SOURCE

`AuthService.enrollmentCodeFor()` (`desktop-agent/src/auth/auth-service.ts`)
resolution order:

1. `info.enrollmentCode` — explicit value passed to discover (tests / future
   provisioning only; the UI never sets it)
2. `process.env.WL_ENROLLMENT_CODE` — runtime (MDM / installer / dev)
3. `AGENT_CONFIG.enrollmentCode` — build-time baked value
   (`src/config/agent-config.ts`, patched by `scripts/build-prod.mjs` from
   `AGENT_ENROLLMENT_CODE`)

**Before the fix:** all three empty → `undefined` → 422.
**After the fix:** source #3 is baked into the EXE (len 32) → code sent → 201.

---

## ENROLLMENT_CODE_PRESENT

- **Stale installed EXE (00:09):** `false` (asar shows `enrollmentCode: null`)
- **Freshly built / reinstalled EXE:** `true` — baked, length 32
- **Runtime `WL_ENROLLMENT_CODE` env:** `false` (absent — the baked build no
  longer needs it)
- Never logged; only presence + length were reported.

---

## REQUEST_CONTAINS_CODE

Captured via a local sanitizing proxy (field presence/lengths only) while
driving the REAL renderer:

```
POST /api/agent/discover
  deviceKey:               true (>= 16 chars)
  hostname:                true (non-empty)
  reRegister:              true
  enrollmentCodePresent:   true
  enrollmentCodeLength:    32
```

## API RESULT

`POST /api/agent/discover → 201` (fresh pending claim + one-time secret) —
**NOT 422**.

---

## UI E2E RESULT — REAL Electron UI BUTTON

`scripts/guest-join-ui-e2e.mjs` (new) drives the actual packaged EXE with a
genuinely fresh userData (the pre-existing `%APPDATA%\worklensai-agent` is
moved aside for the run and restored afterwards — Electron on Windows ignores
the `APPDATA` env var, so an env override cannot isolate state). The ACTUAL
renderer buttons are clicked via Electron remote debugging — the same
`#btn-show-login` / `#btn-join-guest` handlers a mouse click runs, through the
same preload → IPC → main-process → `AuthService.discoverDevice` chain. No
direct `discoverDevice()` invocation.

**Ran against BOTH the freshly built win-unpacked EXE and the exact installed
EXE (`C:\Program Files\OmniSightAgent\OmniSightAgent.exe`): 16/16 PASS each.**

| # | Check | Result |
|---|---|---|
| 1 | EXE launched, renderer reachable via CDP | ✅ |
| 2 | boot zero-touch discovery → 201 (code baked, NOT 422) | ✅ |
| 2b | boot discover carried the enrollment code (len 32) | ✅ |
| 3 | boot claim cancelled server-side (official cancel API, fresh-claim reset) | ✅ |
| 4 | "Sign in with Agent ID" clicked (real handler fired) | ✅ |
| 5 | **"Join as Guest" button clicked in the real renderer** | ✅ |
| 6 | UI click produced `POST /api/agent/discover` | ✅ |
| 6b | click request carries deviceKey + hostname | ✅ |
| 6c | click request carries the enrollment code (len 32) | ✅ |
| 7 | **"Join as Guest" click → server 201 (fresh pending claim, NOT 422)** | ✅ |
| 8 | admin session obtained | ✅ |
| 9 | admin sees the pending guest device claim | ✅ |
| 10 | admin approves as GUEST | ✅ |
| 10b | guest identity synthesized (`GUEST-*`) | ✅ |
| 11 | agent auto-detected approval → authenticated (status view) | ✅ |
| 12 | heartbeat succeeds with the guest token | ✅ |

Verified guests created by the certification runs (visible in the admin Guests
page): `GUEST-2E540BE5D921` (win-unpacked build) and `GUEST-9EA3B6E2B754`
(installed EXE).

---

## DEV RESULT

- `npm run dev` / dev-mode agent (source `agent-config.ts` = `null`, no env
  var) → discover has **no code** → server 422 (the pre-fix behavior).
- The correct dev provisioning path is `WL_ENROLLMENT_CODE` in the launching
  shell, or a build with `AGENT_ENROLLMENT_CODE` (see below).

## PACKAGED EXE RESULT

- Stale build (00:09): **no code** → 422.
- Fresh build (00:17/00:18) and the reinstalled Program Files EXE: **code
  baked** → actual UI button → **201** → guest approval → PATH A auth →
  heartbeat. 16/16.

---

## FIX

**Provision the enrollment code into the agent build** — the documented
mechanism (`Settings → Agent Software → build`, or
`AGENT_ENROLLMENT_CODE=… AGENT_SERVER_URL=… node scripts/build-prod.mjs` in
`desktop-agent/`). `scripts/build-prod.mjs` bakes `AGENT_CONFIG.enrollmentCode`
at build time and **restores the dev defaults in `finally`** (source tree never
left baked; verified: `src/config/agent-config.ts` back to `null`, no `.bak`
leftovers).

- The freshly built installer `desktop-agent/out/OmniSight Agent Setup 1.1.0.exe`
  (00:18) contains the code (its win-unpacked asar is verified baked; the
  installer packages that same app).
- The installed Program Files copy was replaced with the new build during the
  session (installed asar 00:18) — **the user's EXE now has the code**.
- Runtime `WL_ENROLLMENT_CODE` remains supported as the MDM/ops alternative;
  it is not required for this build.

## FILES CHANGED

| File | Change |
|---|---|
| `src/app/api/agent/discover/route.ts` | (pre-existing) malformed/non-JSON body → 400 instead of 500 — validation otherwise untouched |
| `scripts/guest-join-ui-e2e.mjs` | **NEW** — real-UI certification harness (CDP + sanitizing proxy + fresh-userData isolation + full guest loop) |
| `OMNISIGHT-GUEST-JOIN-DISCOVER-DEBUG.md` | prior debug report (kept) |

No backend validation weakened: missing code → 422, invalid code → 422,
expired/revoked/rejected guests → rejected, cross-org → concealed 404,
replay → ignored, valid provisioned agent → 201 (all re-verified below).

---

## TESTS

| Suite | Result |
|---|---|
| `desktop-agent` `npm test` (414 tests) | ✅ 414/414 |
| `tests/guest-join-discover.test.ts` (GUEST-01..09) | ✅ 9/9 |
| `tests/zero-touch.test.ts` | ✅ |
| `tests/guest-approval-rbac.test.ts` | ✅ |
| `tests/guests.test.ts` | ✅ |
| `tests/agent-hardening.test.ts` | ✅ (89/89 across the 4 server suites) |
| web `tsc --noEmit` | ✅ 0 errors |
| desktop-agent `tsc --noEmit` | ✅ 0 errors |
| `eslint` on changed files | ✅ 0 errors (1 pre-existing warning) |
| `next build` | ⏭️ intentionally skipped — the dev server (live `next dev`) shares `.next`; running a production build would pollute it (project rule). |

## BUILD

- Fresh EXE: `desktop-agent/out/win-unpacked/OmniSightAgent.exe` (00:17) —
  asar **baked**, `DEFAULT_SERVER_URL = http://localhost:3000`.
- Installer: `desktop-agent/out/OmniSight Agent Setup 1.1.0.exe` (00:18).
- Installed EXE replaced with the baked build (00:18) — verified asar content
  matches the org hash.
- Source tree restored to dev defaults; no stale `.bak` files; no agent
  processes left running after certification.

## LIVE VERIFICATION

**The final verification originated from the actual UI button** of the actual
EXE (both win-unpacked and the installed Program Files copy): "Join as Guest"
→ `POST /api/agent/discover 201` → pending claim → admin guest approval →
PATH A device-credential auth → heartbeat 200. No manual
`AuthService.discoverDevice()` invocation was used for the final pass.

---

## FINAL STATUS

**RESOLVED.** Root cause = the running Desktop Agent EXE had no org enrollment
code provisioned (baked `null`, no env var); "Join as Guest" is anonymous
zero-touch discovery, which the server fail-closes (422) without a valid code —
by design. Fix = provision the code into the agent build (the documented
`build-prod.mjs` / Settings → Agent Software path); the reinstalled EXE now
carries it. The actual Electron UI button produces **201** end to end (16/16),
with all security behavior preserved (missing/invalid code → 422, revoked /
expired / rejected / cross-org / replay all still rejected).
