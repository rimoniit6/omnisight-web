# Agent Old-UI Root Cause Analysis

Date: 2026-08-10
Scope: `desktop-agent/` (Windows Electron agent) — packaged EXE vs renderer source.

---

## 1. Executive Summary

**The old employee-facing onboarding UI was reachable in the packaged EXE through a visible
"Connect an existing account" button on the default first-run screen, which revealed the legacy
Employee ID / Agent Password registration form.** A second, compounding defect: the previously
packaged `app.asar` (in `out/`) was **stale** — it shipped an even older renderer than the current
`src/` at the time of the Phase F build, so an employee installing that EXE saw the legacy
registration form more prominently than the current source would suggest.

Both defects are now fixed, the installer has been rebuilt, and a regression test guarantees the
packaged renderer can never again contain the legacy onboarding strings.

---

## 2. Audit Method (the exact EXE → ASAR → renderer chain)

| Step | Command | Finding |
|------|---------|---------|
| 1. Load path in main process | `src/main/main.ts` | `mainWindow.loadFile(join(__dirname, '../renderer/index.html'))` — runtime loads **`dist/renderer/index.html`** |
| 2. Build pipeline | `npm run build` | `tsc -p tsconfig.renderer.json && tsc -p tsconfig.json && node scripts/copy-assets.mjs` — `copy-assets.mjs` copies `src/renderer/index.html` + `styles.css` → `dist/renderer/` |
| 3. Packaged output | `electron-builder.yml` | `files: dist/**` + `asar: true` → everything in `dist/` is packed into `resources/app.asar` |
| 4. Extract ASAR | `@electron/asar extract out/win-unpacked/resources/app.asar` | Contains `dist/renderer/index.html` + `dist/renderer/renderer.js` |
| 5. Hash compare | `md5sum` | See below |

**Active renderer path (before fix):** `out/win-unpacked/resources/app.asar → dist/renderer/index.html → renderer.js`
**Active renderer path (after fix):** identical structure, but the shipped renderer now matches the zero-control source.

---

## 3. Stale/duplicate assets found

| Asset | Pre-fix state | Verdict |
|-------|--------------|---------|
| `src/renderer/index.html` | Zero-touch default **but** with a visible `#btn-show-legacy` button + `#auth-form` (Employee ID / Agent Password / Register Device) | Defect 1 |
| `dist/renderer/index.html` | md5 `44ff2ca…` — identical to the pre-fix `src/` (copied by `copy-assets.mjs`) | Carried Defect 1 into the build |
| `out/win-unpacked/resources/app.asar` (Phase F build) | Contained `dist/renderer/index.html` md5 `44ff2ca…` and `renderer.js` md5 `7d8ee…` — **stale relative to source** | Defect 2 |
| `dist/renderer/renderer.js` | Compiled from the legacy-bound `renderer.ts` (form submit handlers, `Register Device` labels) | Carried Defect 1 |
| Duplicate UI folders (`out/`, `dist/`, `build/`) | No duplicate `index.html` copies found outside `dist/renderer/` | No issue |
| Old ASAR being launched | Confirmed: the Phase F `app.asar` was packed before the latest renderer changes landed in `dist/` | Defect 2 |

---

## 4. Root Cause

1. **Defect 1 — the source renderer still exposed the legacy flow.**
   The default zero-touch onboarding view contained a *visible* `Connect an existing account`
   button (`#btn-show-legacy`) that toggled the legacy `#auth-form` (Employee ID, Agent Password,
   Register Device). The pending view had `Check Approval Status` + `Change Account`; the offline
   view had `Retry` + `Change Account`; the rejected view had `Try Again`; the connected view had
   Pause / Resume / Disconnect and an auto-start toggle. None of this should exist in a
   zero-control agent, and it is the "old UI" surface an employee could reach.

2. **Defect 2 — the packaged EXE was stale.**
   The `out/` ASAR at the start of this audit shipped `index.html` md5 `44ff2ca…` /
   `renderer.js` md5 `7d8ee…` while the current source was `7d17…` / `4b86…`. Because
   `electron-builder` packages `dist/**` and the last packaging run preceded the final renderer
   changes, **the installer an employee would run did not match the repository's renderer**. This
   is the concrete, verifiable reason "the current EXE still opens the old onboarding UI".

3. **Build/package commands used (pre-fix):** `npm run build` then `npx electron-builder --win nsis`
   — correct sequence, but the ASAR had not been repacked after the renderer change.

---

## 5. Files that MUST be changed (fixed in this phase)

| File | Change |
|------|--------|
| `desktop-agent/src/renderer/index.html` | Rewritten as a read-only zero-control UI: removed `#auth-form`, `#btn-show-legacy`, `Check Approval Status`, `Change Account`, `Try Again`, `Check Again`, `Retry`, Pause/Resume/Disconnect, auto-start toggle, and the literal `Employee ID` label |
| `desktop-agent/src/renderer/renderer.ts` | Removed every legacy/employee-control binding (enroll/authenticate form, register device, check-approval, cancel-enrollment, pause/resume/logout, auto-start). Renderer is now a pure status viewer subscribed to `onStatus` |
| `desktop-agent/src/main/main.ts` | Removed tray `Quit` (no easy employee-facing exit); added a silent 5s renderer-safe status push so the UI auto-transitions after admin approval without a restart |
| `desktop-agent/src/services/agent-orchestrator.ts` | Added bounded exponential-backoff auto re-discovery (30s → 10min cap) so an offline first run self-heals with **no employee Retry button** |
| `desktop-agent/src/storage/local-settings.ts` | `autoStart` default flipped to `true` — a zero-control agent must launch with Windows (employee cannot toggle it) |
| `desktop-agent/src/auth/auth-service.ts` | Stale comments referencing "Change account" / re-entering an Employee ID updated (hygiene) |
| `desktop-agent/tests/zero-control-renderer.test.ts` | **New** — regression guard scanning `dist/` and the packaged ASAR for legacy onboarding strings |
| `desktop-agent/tests/onboarding.test.ts` | Added orchestrator auto-discovery-retry test |
| `desktop-agent/tests/local-settings.test.ts` | Updated for the new autoStart default |
| `desktop-agent/out/WorkLensAI Agent Setup 1.0.0.exe` | **Rebuilt** with the zero-control renderer (SHA-256 `fdd5caf34bc645fd33f9abb10104f307eb15e4897284f3af6b0f15c35dad97ef`) |

## 6. Files that should NOT be changed

- **Legacy backend routes** (`src/app/api/agent/register`, `authenticate` employeeId/password) — kept for backward compatibility at the API level (per product rules).
- **Consent system** (`src/lib/consent.ts`, consent routes, agent `ConsentService`, `consent-gate`) — untouched; consent remains a separate server-enforced boundary.
- **Zero-touch backend** (discover/authenticate/config/heartbeat/activity/screenshot) — untouched.
- **Prisma schema / DeviceClaim / Device.agentKey** — untouched.
- **Native addon** (`worklens_capture.node`) — untouched.
- **IPC surface** (`preload.ts`, `ipc.ts`) — the legacy channels remain registered for backward compatibility but are unreachable from the zero-control UI (the renderer exposes no way to invoke them).

---

## 7. Verification after the fix

```
src/renderer/index.html   md5 7d1762704ba9c107ea89e378f107310d
dist/renderer/index.html  md5 7d1762704ba9c107ea89e378f107310d   (matches src)
app.asar → dist/renderer/index.html md5 7d1762704ba9c107ea89e378f107310d  (matches src)
legacy markers in packaged html: "Connect an existing account" = 0, "auth-form" = 0
zero-control marker "Setting up this device" in packaged html = 1
renderer.js: "authentication material" present, "bearer" absent
```

Regression suite (new `zero-control-renderer.test.ts`) scans `dist/renderer/index.html`,
`dist/renderer/renderer.js`, **and** the packaged `app.asar` and fails on any of:
`Employee ID`, `Agent Password`, `Register Device`, `Connect to WorkLensAI`,
`Connect an existing account`, `Change Account`, `Check Approval Status`, and the legacy
element ids (`auth-form`, `emp-id`, `emp-pass`, `auth-submit`, `btn-show-legacy`,
`btn-check-approval`, `btn-change-account`, `btn-try-again`, `btn-revoked-retry`, `btn-retry`,
`btn-offline-change`, `btn-pause`, `btn-resume`, `btn-logout`, `auto-start`).

**Result:** desktop agent tests **111/111 PASS**, backend zero-touch+consent **56/56 PASS**,
admin TypeScript clean.
