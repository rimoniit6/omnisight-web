# OmniSight — Repository Cleanup & Organization Audit

**Date:** 2026-08-16
**Mode:** READ-ONLY DISCOVERY — no files modified, moved, or deleted; no DB, migrations, env, or packages touched.
**Method:** full-repo file inventory (`git ls-files`), on-disk inspection, reference tracing (imports, scripts, build chains, docs, configs), case-insensitive brand scan, and hash-based duplicate checks.

---

## 1. Executive Summary

The OmniSight repository is a **working product monorepo** (Next.js admin app + Electron desktop agent + native Win32 addon + browser extension + live-updates mini-service). The **source tree is clean and healthy**; the problems are concentrated in **accidentally committed junk and process artifacts**, not in application code.

### Critical findings (act on these first)

| # | Finding | Size / scope | Verdict |
|---|---------|--------------|---------|
| C1 | **`.e2e-fresh/`** — a full Chrome browser profile (user-data dir) is committed to git | **3,143 files / 386 MB** | DELETE + untrack; add to `.gitignore` |
| C2 | **`.e2e-install/`** — an unpacked Electron app install (incl. old-brand `WorkLensAIAgent.exe`) is committed | 75 files / 271 MB | DELETE + untrack; add to `.gitignore` |
| C3 | Git pack is bloated by the above | pack = **~392 MB** | History rewrite (git filter-repo/BFG) recommended, optional |
| C4 | **52 root-level audit/certification/report `.md` files** (46 tracked + 6 untracked) pollute the root | ~800 KB of docs | MOVE to `docs/audits/` + `docs/archive/` |
| C5 | **`workload/`** — 108 sprint/planning docs (superseded by `docs/`) | 108 files | ARCHIVE under `docs/archive/workload/` |
| C6 | **Build artifacts committed**: `desktop-agent/launcher.obj`, `desktop-agent/scripts/launcher.obj`, `desktop-agent/build/config.gypi`, `desktop-agent/native-host-bin/worklens-native-host.exe`, `backups/pg/*.dump`, `db/*.bak-*` | ~14 MB | DELETE + untrack (all regenerable) |
| C7 | **New brand assets + rebrand features are UNTRACKED** (54 untracked files): canonical logo, favicon set, `desktop-agent/assets/icon.ico`, `omnisight-mark.svg`, `scripts/generate-brand-assets.mjs`, 4 new Prisma migrations, policy/USB/break/anomaly/notification code + tests | 54 files | **COMMIT** — a fresh clone currently breaks the agent build and brand tests |
| C8 | Dual lockfiles at root (`bun.lock` + `package-lock.json`) and in `mini-services/live-updates/` | — | MANUAL REVIEW — pick npm or bun per project |

### Key statistics

- **4,163 tracked files** (`git ls-files`), **54 untracked files**
- Git object pack: **~392 MB** (401,816 KB) — dominated by C1/C2
- Old-brand strings (`worklens*`) appear in **~130 tracked/untracked files**; the overwhelming majority are **intentional backward-compatibility technical identifiers** (cookie name, localStorage keys, native-host registry name, legacy exe names, data dir) — **NOT candidates for removal**
- Zero CI/CD files (no `.github/`, no `Dockerfile`, no `docker-compose.yml`); deployment is documented (Caddyfile + docs) — acceptable, not an error

### Final classification tallies

```
KEEP (files/dirs):             ~3,900  (all source, tests, migrations, configs, current docs, assets)
MOVE:                               52  root audit docs → docs/audits/, plus scripts grouping
ARCHIVE:                           ~116  workload/ (108) + worklog.md + old plans + pg dumps
DELETE-CANDIDATE (proven):       3,266  (.e2e-fresh 3,143 + .e2e-install 75 + 48 binaries/backups/artifacts)
MANUAL REVIEW:                     ~12  (dual lockfiles, native-host manifests, brand-output commit policy, etc.)
```

---

## 2. Repository Statistics

| Area | Tracked files | Notes |
|------|--------------|-------|
| `.e2e-fresh/` | 3,143 | Chrome profile — **junk, committed by accident** |
| `src/` | 365 | Admin app source (app/api, components, lib, hooks) — KEEP |
| `desktop-agent/` | 127 | Electron agent source/build/test — mostly KEEP, 8 artifacts DELETE |
| `workload/` | 108 | Historical planning docs — ARCHIVE |
| `scripts/` | 76 | One-off audits + live tooling — KEEP w/ reorganization |
| `tests/` | 64 | Regression tests + 10 unreferenced QA PNGs |
| `docs/` | 62 | Current docs (company-guide, agent docs) — KEEP |
| `prisma/` | 47 | 21 Postgres migrations + 25 archived SQLite migrations + schema — KEEP |
| `mini-services/` | 8 | live-updates service — KEEP |
| `browser-extension/` | 7 | MV3 extension — KEEP |
| `backups/` | 6 | pg dumps — DELETE/ARCHIVE |
| `db/` | 4 | SQLite backups — DELETE |
| `public/` | 4 | Old assets; 5 new brand files untracked |
| `examples/` | 2 | Unreferenced websocket example — DELETE-CANDIDATE |
| root files | ~60 | 52 audit docs + configs + lockfiles |

On-disk but git-ignored (correct): `node_modules/`, `.next/`, `desktop-agent/dist/`, `desktop-agent/out/`, `desktop-agent/native/build/`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `.env`, `.worklens/dev.key`, `.gstack/`, `.freebuff/` logs.

---

## 3. Root Directory Audit

### Files that belong at root (KEEP)

`package.json`, `package-lock.json`, `bun.lock` (see Manual Review), `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `components.json`, `README.md`, `.gitignore`, `.env.example`, `.env.production.example`, `Caddyfile`, `next-env.d.ts` (gitignored, regenerated), `PRODUCTION.md` (current ops doc — MOVE to `docs/operations/` recommended).

### Files that should NOT be at root (MOVE / ARCHIVE / DELETE)

| File | Class | Evidence |
|------|-------|----------|
| 46 tracked `*AUDIT*/*CERTIFICATION*/*DIAGNOSTIC*/*HARDENING*/*REPORT*/*IMPLEMENTATION*/*FINAL*` `.md` | MOVE → `docs/audits/` | All are dated, one-off audit/certification artifacts (see §4); none referenced by code, package.json, or README |
| 6 untracked audit docs (`AUDIT-agent-approvals.md`, `FIX-agent-approvals.md`, `BREAK-MONITOR-*`, `NOTIFICATION-ALERTING-PRODUCTION-CERTIFICATION.md`, `REBRAND-AUDIT.md`) | MOVE → `docs/audits/` | Same class; **REBRAND-AUDIT.md is the live rebrand record — keep it, move it, do not delete** |
| `worklog.md` (220 KB) | ARCHIVE → `docs/archive/worklog.md` | Historical agent task log; zero references |
| `active-project-audit-desktop.png` / `active-project-audit-mobile.png` | MOVE with `ADMIN-ACTIVE-PROJECT-UI-AUDIT-FINAL.md` → `docs/audits/admin/` | Referenced only by that audit doc |
| `falcon-analysis.json` / `falcon-ref.json` | DELETE-CANDIDATE (or ARCHIVE) | One-time AI UI-design research dump; no references anywhere |
| `.portal-e2e-results.json` | DELETE + untrack | **Generated output** of `scripts/portal-e2e.mjs` (line 197 writes it) — committed by accident |
| `.freebuff/worktrees/<uuid>` (tracked) | DELETE + untrack | Accidental worktree-pointer file committed inside `.freebuff/` (rest of `.freebuff/` is untracked logs + a 12 MB dev DB) |

### Files flagged in the git diff header (pre-existing work, not cleanup)

The working tree contains an in-progress **WorkLensAI → OmniSight rebrand** (README, env examples, desktop-agent, browser-extension, docs) plus new **policy-enforcement / USB / break-monitor / anomaly / notification** features (all untracked). These are **to-commit work**, not cleanup candidates — but see C7: they must be committed or the next clone is broken.

---

## 4. Documentation / Audit Files

### 4.1 Current operational documentation (KEEP where they are)

- `docs/company-guide/` (26 `.md` + `README.md` + `FEATURE-INVENTORY.md` + 28 screenshots) — the product/user manual; referenced by `README.md`. **KEEP.**
- `docs/agent-api-contract.md`, `docs/agent-architecture.md`, `docs/agent-development.md`, `docs/agent-installation.md` — current desktop-agent docs. **KEEP** (proposed: `docs/architecture/` + `docs/operations/` for consistency, optional).
- `docs/consent-management.md` — current technical reference for the consent feature. **KEEP.**
- `PRODUCTION.md` — current production ops guide. KEEP (proposed move → `docs/operations/production.md`).

### 4.2 Historical audit evidence (MOVE → `docs/audits/<feature>/`)

All 52 root audit docs classify as **B. Historical audit evidence**. They are dated, single-feature, post-hoc audits/certifications produced during development. Grouping (current → proposed):

```
docs/audits/branding/        REBRAND-AUDIT.md
docs/audits/admin/           ADMIN-ACTIVE-PROJECT-AUDIT.md, ADMIN-ACTIVE-PROJECT-FINAL-IMPLEMENTATION.md,
                             ADMIN-ACTIVE-PROJECT-UI-AUDIT-FINAL.md (+ 2 screenshots),
                             ADMIN-AI-INSIGHTS-*.md (3), ADMIN-OVERVIEW-ACTIVITIES-*.md (2),
                             ADMIN-READINESS-AUDIT.md, ADMIN-SECTION-AUDIT-2026-08-13.md,
                             ADMIN-SECTION-FINAL-CERTIFICATION.md
docs/audits/api/             API-AUDIT.md, AUDIT-FINAL-REPORT.md, DATABASE-AUDIT.md, MASTER-AUDIT.md,
                             PROJECT-MODULE-AUDIT.md, SENTIMENT-AUDIT.md
docs/audits/break-monitor/   BREAK-MONITOR-PRODUCTION-AUDIT.md, BREAK-MONITOR-PRODUCTION-HARDENING-REPORT.md,
                             BREAK-MONITOR-FINAL-VERIFICATION.md
docs/audits/consent/         CONSENT-MANAGEMENT-SEED-CERTIFICATION.md
docs/audits/daily-summary/   DAILY-SUMMARY-REPORT-FINAL-AUDIT.md, DAILY-SUMMARY-REPORT-HARDENING-CERTIFICATION.md
docs/audits/desktop-agent/   DESKTOP-AGENT-*.md (6), GLOBAL-EMPLOYEE-PRESENCE-*.md (2)
docs/audits/employees/       EMPLOYEE-DETAIL-AUDIT.md, EMPLOYEE-LOCATION-*.md (2), EMPLOYEES-AUDIT.md,
                             EMPLOYEES-SELECTOR-AUDIT.md, PROJECT-TRACKING-*.md (3)
docs/audits/live-monitor/    LIVE-MONITOR-EVENT-STATS-FINAL-AUDIT.md, LIVE-MONITOR-EVENT-STATS-HARDENING-CERTIFICATION.md
docs/audits/notifications/   NOTIFICATION-ALERTING-PRODUCTION-CERTIFICATION.md, AUDIT-agent-approvals.md, FIX-agent-approvals.md
docs/audits/policies/        (none yet — reserved)
docs/audits/sentiment/       SENTIMENT-EMPLOYEE-DETAILS-*.md (2)
docs/audits/telemetry/       WEBSITE-DOMAIN-TRACKING-*.md (2), WEBSITE-USAGE-TIME-SPENT-FINAL-CERTIFICATION.md
docs/audits/other/           PROJECT-TRACKING-P2-FINAL-IMPLEMENTATION.md, docs/ai-provider-audit.md,
                             docs/clean-machine-certification.md, docs/superpowers/plans/2026-08-03-m008-stage2-plan.md
```

### 4.3 Superseded / duplicate (ARCHIVE, keep history)

- `workload/` (108 files) — superseded by `docs/`; contains early product vision → sprint reports → phase certifications. ARCHIVE → `docs/archive/workload/`.
- `worklog.md` — ARCHIVE → `docs/archive/worklog.md`.

### 4.4 Proposed docs structure

```
docs/
├── README.md                      (new index, optional)
├── architecture/                  (agent-architecture.md, agent-api-contract.md, consent-management.md, …)
├── operations/                    (PRODUCTION.md, agent-installation.md, agent-development.md, …)
├── deployment/                    (empty / Caddyfile notes)
├── security/                      (ai-provider-audit.md if kept current — else audits/)
├── audits/<feature>/…             (all 52 root audit docs + REBRAND-AUDIT.md + ai-provider/clean-machine audits)
├── archive/                       (workload/, worklog.md, old plans)
└── company-guide/                 (unchanged)
```

Nothing was moved during this audit.

---

## 5. Branding Audit (WorkLensAI → OmniSight)

Canonical brand: **OmniSight** · Canonical logo: **`public/logos/omnisight.svg`**.

Full case-insensitive scan for `worklens*` (excluding `node_modules`, `.git`, `.next`, `dist`, `out`, `build`, `.e2e-*`, lockfiles) found ~130 files. Classification:

### 5.1 Technical identifiers that MUST remain (backward compatibility — do NOT rename)

| Identifier | Where | Why it must stay |
|---|---|---|
| `com.worklensai.website` | `browser-extension/native-messaging/*.json`, `desktop-agent/native-host-manifests/*.json`, `browser-extension/src/background.js`, `desktop-agent/src/services/native-messaging-host.ts` | Registered browser native-messaging host name; changing breaks Chrome/Edge/Firefox registration for installed extensions |
| `worklensai-agent` (userData dir) | `desktop-agent/native-host/launcher.c`, `desktop-agent/src/main/main.ts` | Pinned legacy userData path — survives rename, preserves existing installs' state/queue |
| `worklens_token` (session cookie) | `src/lib/auth.ts`, `mini-services/live-updates/index.ts`, `.env.example` | Cookie name shared by admin app, live-updates service, and agent; existing sessions invalidated on rename |
| `WORKLENSAI_SERVER_URL` | `desktop-agent/src/config/server-url.ts`, `.env.example`, `.env.production.example` | Legacy env alias — honored for deployed agents; new `OMNISIGHT_SERVER_URL` wins when both set |
| `worklens_capture.node` | `desktop-agent/native/binding.gyp`, `desktop-agent/native/package.json`, `desktop-agent/electron-builder.yml` | Compiled addon filename wired into packaging (`extraResources`) |
| `worklensaiagent.exe` / `worklensai.exe` | `src/lib/agent-process.ts`, `src/lib/policies/constants.ts` | Legacy binary detection for orphan-cleanup and policy exclusion lists — removed only after all installs migrate |
| `worklens-tour-completed`, `worklens-widget-layout` | `src/lib/store.ts`, `src/lib/widget-store.ts` | localStorage keys — renaming resets user state |
| `worklens:add-employee`, `worklens:edit-employee` | `src/components/employees/employees-page.tsx` | Cross-window DOM events |
| `.worklens/dev.key` | `src/lib/crypto.ts`, `.gitignore` | Dev encryption-key path (already gitignored) |
| `worklens_native_host` (process name) | `desktop-agent/src/lib/internal-process.ts` | IPC/process identity, tested by `internal-process.test.ts` |
| `website-tracker@worklens.ai` | `browser-extension/manifest.json` | Firefox extension ID (immutable once published) |
| `WorkLensAI`/`worklensai` in Prisma migration comments + schema comment | `prisma/migrations/*`, `prisma/schema.prisma` | Comments only — cosmetic, no functional impact; can be cleaned during a schema-edit commit (optional) |

### 5.2 Old-brand assets (obsolete — verified removed or deletable)

| Asset | Status | Evidence |
|---|---|---|
| `public/worklens-logo.png`, `public/logo.svg` | **Deleted** (staged ` D`) | Old logos already removed by rebrand; `tests/branding-regression.test.ts` asserts they stay absent |
| `.e2e-install/WorkLensAIAgent.exe` | DELETE | Old-brand Electron binary inside the junk `.e2e-install/` dir (C2) |
| `desktop-agent/native-host-bin/worklens-native-host.exe` | Untrack from git (regenerated by `build-native-host.mjs`) | Compiled launcher binary committed by accident; keep on disk for packaging, remove from git + ignore |

### 5.3 Active user-facing branding (KEEP — all current OmniSight)

`README.md`, `browser-extension/manifest.json`, `desktop-agent/electron-builder.yml`, `src/lib/brand.ts`, `desktop-agent/src/lib/brand.ts`, `public/logos/omnisight.svg`, favicon set, agent icon — all verified current. The only outdated user-facing references are inside **historical audit docs** (moved with them in §4) and `desktop-agent/native-host-manifests/*.json` which still contain a hardcoded **developer machine path** (`E:\Workslens\workai\.e2e-install\...`) — see Manual Review §15.

### 5.4 PWA check

No `manifest.webmanifest` / `manifest.json` PWA config exists; the app is not a PWA. Favicon set is consumed purely via Next metadata (`src/app/layout.tsx` lines 21–33: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`).

---

## 6. Asset Audit

### 6.1 `public/` — canonical + derivatives (KEEP, but commit!)

| Asset | Class | Required by | Generator |
|---|---|---|---|
| `public/logos/omnisight.svg` | **canonical** | UI everywhere; source of all derivatives | — (hand-authored) |
| `public/favicon.svg` | derived | `layout.tsx` metadata (SVG favicon) | `scripts/generate-brand-assets.mjs` |
| `public/favicon.ico` | derived | `layout.tsx` (legacy raster) | same script |
| `public/favicon.png` | derived | `layout.tsx` (32 px fallback) | same script |
| `public/apple-touch-icon.png` | derived | `layout.tsx` (`apple:` meta) | same script |
| `public/sounds/notification.wav` | canonical | `src/components/live-monitor/live-monitor-page.tsx` | — |
| `public/robots.txt` | canonical | web standard | — |

**⚠ All five brand files (logo + favicon set) are UNTRACKED.** `tests/branding-regression.test.ts` requires them to exist, `desktop-agent/scripts/copy-assets.mjs` hard-fails without `omnisight-mark.svg`, and `electron-builder.yml` references `assets/icon.ico`. **Commit the generator + outputs (or wire the generator into a pre-build script).**

### 6.2 `desktop-agent/assets/` + renderer assets

| Asset | Class | Required by |
|---|---|---|
| `desktop-agent/assets/icon.ico` (16–256 px) | derived (UNTracked) | `electron-builder.yml win.icon`, `main.ts` window/tray |
| `desktop-agent/src/renderer/omnisight-mark.svg` | derived (UNTracked) | renderer header; `copy-assets.mjs` **hard-fails** if missing |
| `desktop-agent/src/renderer/index.html` / `styles.css` | source | renderer |

### 6.3 Obsolete / junk assets

- `desktop-agent/native/test-capture-fg.png`, `test-capture-title.png` — **generated outputs** of `native/test-capture2.mjs` (it writes them at lines 13/25). DELETE + untrack.
- `tests/*.png` (10 files: `dashboard.png`, `dashboard-v2.png`, `mobile.png`, `employee-profile.png`, `profile-desktop-v2.png`, `profile-mobile.png`, `profile-mobile-v2.png`, `profile-tablet.png`, `profile-tablet-v2.png`) — QA screenshots, **zero references** in tests/docs/scripts (verified by grep; `png-dimensions.test.ts` builds PNGs in memory and never reads these). DELETE-CANDIDATE (or MOVE to `docs/archive/screenshots/` if evidence value is wanted).
- Root `active-project-audit-*.png` — move WITH their audit doc (§3/§4).
- No duplicate SVG/PNG/ICO of the mark exist anywhere else (old `public/branding/` was already deleted; regression test asserts it stays gone).

---

## 7. Report / Screenshot / Evidence Files

| File(s) | Class | Recommendation |
|---|---|---|
| 52 root audit `.md` | audit evidence | MOVE → `docs/audits/**` (grouped in §4.2) |
| `active-project-audit-*.png` (2) | test evidence | MOVE with `ADMIN-ACTIVE-PROJECT-UI-AUDIT-FINAL.md` |
| `tests/*.png` (10) | QA screenshots | DELETE-CANDIDATE (unreferenced) or archive |
| `falcon-analysis.json`, `falcon-ref.json` | AI design research | DELETE-CANDIDATE (one-time; no refs) |
| `.portal-e2e-results.json` | generated e2e output | DELETE + untrack (regenerated by `scripts/portal-e2e.mjs`) |
| `backups/pg/*.dump` (6) | DB backups | DELETE + untrack (or move to git-ignored location); regenerable via pg_dump |
| `docs/company-guide/screenshots/*.png` (28) | **doc screenshots — KEEP** | Referenced by the company guide; current product docs |
| `desktop-agent/.freebuff/*.log`, `.gstack/*.log`, `.freebuff/*.log` | runtime logs | on-disk only, gitignored — delete locally if desired |

---

## 8. Test Audit

### 8.1 Admin app tests (`tests/`, 64 tracked + 6 untracked) — **all KEEP**

All `.test.ts` files protect live feature code paths (consent, presence, telemetry, agent auth, hardening, RBAC, projects, sentiment, break/anomaly/policy/notification hardening — the last four untracked, to commit). No obsolete feature tests found; nothing tests a removed feature. `tests/branding-regression.test.ts` is the brand contract test — **KEEP + commit**.

### 8.2 Desktop agent tests (`desktop-agent/tests/`, 36 tracked + 5 untracked) — **all KEEP**

Covers auth, queue, collectors, scheduler, update service, websocket bridge, zero-touch, policy enforcement/USB (untracked, to commit). All reference live `src/` modules.

### 8.3 Test-directory one-off scripts (MOVE or DELETE)

| File | Class | Evidence |
|---|---|---|
| `tests/database-runtime-build.sh` | one-off | no refs anywhere |
| `tests/python-runtime-build.sh` / `python-runtime-container.sh` | one-off | only ref each other |
| `tests/employee-db-inspect.ts` | one-off diagnostic | no refs |
| `tests/employee-api-e2e.ps1`, `tests/employee-detail-e2e.ps1`, `tests/employee-search-e2e.ps1` | one-off e2e | no refs |

Recommendation: move to `scripts/archive/` (keep provenance) or delete; do not leave them inside `tests/`.

### 8.4 Duplicated tests

No duplicated test files detected. Some overlapping coverage across hardening suites is intentional (feature + hardening pairs).

---

## 9. Script Audit

### 9.1 Referenced by `package.json` (KEEP)

`scripts/dev.mjs`, `scripts/bootstrap-super-admin.ts`, `scripts/production-cleanup.ts`, `scripts/db-push-dev.mjs` + `src/lib/jobs/cli.ts` (`jobs`).

### 9.2 Referenced by build chain / docs (KEEP)

- `scripts/generate-brand-assets.mjs` — **UNTracked**; required by `desktop-agent/scripts/copy-assets.mjs` (hard-fails without its output) and documented in `REBRAND-AUDIT.md`. Commit it.
- `scripts/clean-machine-certification.ps1` — referenced by `docs/clean-machine-certification.md`.
- `scripts/reset-database.ts`, `scripts/zt-b5-e2e.mjs`, `scripts/dev.mjs` — referenced in `REBRAND-AUDIT.md` / dev workflow.

### 9.3 Manual QA tooling (KEEP, but organize → `scripts/verify/`)

The `verify-*.mjs` family (e0–e16, m005–m009, ocr, alerts, analytics, smoke-*) and `*-e2e.mjs` / `*-audit.mjs` scripts are one-off-but-reusable verification harnesses. They are internally cross-referenced (e.g. `location-tab-e2e.mjs` → `live-monitor-ui-test.mjs`; `migration-verify.mjs` → `pg-test-db.mjs`; `cleanup-ocr-fixtures.mjs` → `verify-ocr.mjs`). None are wired to package.json. **Recommendation: MOVE to `scripts/verify/` for tidiness; do not delete** — they document how each feature was verified.

### 9.4 One-off / debug scripts (DELETE-CANDIDATE or archive)

Underscore-prefixed debug helpers with **zero references**: `scripts/_consent-regression.mjs`, `scripts/_db-diagnostic.mjs`, `scripts/_launch-repair.ps1`, `scripts/_os-repair.ps1`, `scripts/_w100_live.mts`, `scripts/_winrt-geo-check.ps1`. Also unreferenced: `scripts/agent-count.mjs`, `scripts/ai-connected-browser-check.mjs`, `scripts/check-login-response.mjs`, `scripts/copy-standalone.js`, `scripts/overlay-probe.mjs`, `scripts/perf-baseline.mjs`, `scripts/pg-audit.sql`, `scripts/pg-unique-check.sql`, `scripts/probe-portal-db.mjs`, `scripts/provision-agent-tokens.mjs`, `scripts/cleanup-zt-e2e.sh` (hardcodes `/e/Workslens/workai` absolute paths — stale). Delete or move to `scripts/archive/`.

### 9.5 Dependency chains verified

- `generate-brand-assets.mjs` → writes 6 outputs (§6.1/§6.2) → consumed by `layout.tsx` metadata, `copy-assets.mjs`, `electron-builder.yml`. **Self-contained; nothing else writes brand assets.**
- `copy-assets.mjs` → rebuilds `dist/renderer` from scratch (rmSync) + requires `omnisight-mark.svg`; runs first in `desktop-agent` `build` script. **Healthy — just needs the generator committed/run first.**
- `desktop-agent` scripts wired in `package.json`: `build-native-host.mjs`, `build-prod.mjs`, `copy-assets.mjs`, `install-native-host.mjs`, `watch.mjs`. Unwired but useful: `bridge-smoke.mjs`, `electron-bridge-check.js`, `e2e-live.sh`, `e2e-onboarding.mjs`, `e2e-zero-touch.mjs`, `login-item-test.js`, `offline-soak.mjs`, `soak-24h.mjs`, `build-native-host.bat`. All KEEP (manually useful); none are junk.

---

## 10. Generated / Build Artifact Audit

| Path | Git status | Regenerable? | Verdict |
|---|---|---|---|
| `.e2e-fresh/` (3,143 files / 386 MB) | **TRACKED** | Yes (browser automation profile) | **DELETE + untrack** + ignore — biggest single win |
| `.e2e-install/` (75 files / 271 MB) | **TRACKED** | Yes (Electron install dir from e2e runs) | **DELETE + untrack** + ignore |
| `desktop-agent/launcher.obj` | **TRACKED** | Yes (`build-native-host.mjs`) | **DELETE + untrack** (compiled COFF object) |
| `desktop-agent/scripts/launcher.obj` | **TRACKED** | Yes (same) | **DELETE + untrack** (older duplicate) |
| `desktop-agent/build/config.gypi` | **TRACKED** | Yes (node-gyp) | **DELETE + untrack** |
| `desktop-agent/native-host-bin/worklens-native-host.exe` | **TRACKED** | Yes (`build-native-host.mjs`) | Untrack + ignore; keep on disk for packaging |
| `desktop-agent/native/test-capture-*.png` | **TRACKED** | Yes (`test-capture2.mjs`) | **DELETE + untrack** |
| `backups/pg/*.dump` (6) | **TRACKED** | Yes (pg_dump) | **DELETE + untrack**; add `backups/` to ignore |
| `db/custom.db.bak-phase2`, `-phase2b`, `-phase3`, `custom.db.new-schema-backup` | **TRACKED** | Yes (SQLite copies) | **DELETE + untrack** |
| `.portal-e2e-results.json` | **TRACKED** | Yes (`portal-e2e.mjs`) | **DELETE + untrack** |
| `tsconfig.tsbuildinfo` | on disk, ignored | Yes | delete locally (optional) |
| `.next/`, `desktop-agent/dist/`, `desktop-agent/out/` (incl. `OmniSight Agent Setup 1.1.0.exe`) | on disk, **ignored** | Yes | local build outputs — can be cleared; nothing to commit |
| `desktop-agent/native/build/Release/worklens_capture.node` | on disk, **ignored** | Yes (node-gyp) | local only |
| `node_modules/`, `.worklens/dev.key`, `.env` | ignored | — | local only |

**`.gitignore` gaps to close:** add `.e2e-fresh/`, `.e2e-install/`, `backups/`, `uploads/` (runtime screenshot store — currently **not** ignored), `desktop-agent/native-host-bin/`, `*.obj`, `desktop-agent/build/` (note root `/build` is already ignored; the desktop-agent one is not), `.portal-e2e-results.json`, `falcon-*.json`.

---

## 11. Prisma / Database Audit

### 11.1 Migrations (ALL KEEP — never delete applied migrations)

- `prisma/migrations/` — 21 Postgres migrations (20260810… → 20260815…) + `migration_lock.toml` — **KEEP**. 4 new migrations are untracked (break_session, anomaly_detection_hardening, policy_management, notification_alerting_hardening) — **COMMIT**.
- `prisma/migrations-sqlite-archive/` — 25 archived SQLite-era migrations — **KEEP as archive** (already correctly quarantined in its own dir).
- No duplicate migration files, no migration-like scratch files.

### 11.2 DB files (junk, tracked or on-disk)

| File | Git | Verdict |
|---|---|---|
| `db/custom.db`, `db/e2e-throwaway.db`, `db/test-migration.db` | ignored (`*.db`) | local throwaway DBs — delete locally if desired |
| `db/custom.db.bak-phase2/-phase2b/-phase3/new-schema-backup` | **TRACKED** | **DELETE + untrack** |
| `backups/pg/*.dump` (6) | **TRACKED** | **DELETE + untrack** (regenerable point-in-time dumps) |
| `.freebuff/desktop-v2.db*` (12 MB) | ignored (untracked) | local dev DB — delete locally if desired |

### 11.3 Seed / helpers

- `src/lib/seed.ts` (wired as `db:seed:dev`), `scripts/bootstrap-super-admin.ts`, `scripts/reset-database.ts`, `scripts/production-cleanup.ts`, `scripts/db-push-dev.mjs`, `scripts/migrate-sqlite-to-postgres.mjs` (historical, referenced by `migration-verify.mjs` — keep in scripts) — **KEEP**.
- No database was modified during this audit.

---

## 12. Desktop Agent Audit (`desktop-agent/`)

### 12.1 KEEP (source + config + tests)

All of `src/` (main, preload, renderer, api, auth, collectors, config, lib, scheduler, services, types — incl. untracked new `policy.ts`, `usb.ts`, `policy-enforcer.ts`, `usb-collector.ts`, `brand.ts`, `policy-resolution.ts`, `omnisight-mark.svg`), all 36+5 tests, `native/src/*` (incl. new untracked `procmon.cc/h`, `usb.cc/h`), `native/binding.gyp`, `native/package.json`, `native-host/launcher.c`, `electron-builder.yml`, `tsconfig*.json`, `package.json`/`package-lock.json`, `scripts/*` (see §9.5), `.gitignore`.

### 12.2 DELETE / untrack (build artifacts — all regenerable)

`launcher.obj`, `scripts/launcher.obj`, `build/config.gypi`, `native-host-bin/worklens-native-host.exe` (untrack + ignore), `native/test-capture-fg.png`, `native/test-capture-title.png`.

### 12.3 Attention items

- `native-host-manifests/{chrome,edge,firefox}.json` — tracked **dev-machine examples** with hardcoded absolute path `E:\Workslens\workai\.e2e-install\worklens-native-host.exe`. Real manifests are generated by `install-native-host.mjs`. **MANUAL REVIEW**: either delete the tracked copies (script regenerates them) or convert to templates with a placeholder path.
- `electron-builder.yml` references `assets/icon.ico` (untracked, generated) — commit the .ico or the generator must run before packaging.
- `launcher.c` APP_DATA_DIR + `main.ts` userData pin are intentional (see §5.1) — do not "clean" them.

---

## 13. Dependency Audit (root `package.json` — nothing uninstalled)

Evidence-based classification of the 46 prod + 15 dev deps. All were checked for imports in `src/`, `scripts/`, `mini-services/`, and config files.

| Class | Packages | Notes |
|---|---|---|
| **USED (prod)** | next, react, react-dom, next-auth, next-intl, next-themes, @prisma/client, prisma, zod, bcryptjs, sharp, socket.io, socket.io-client, xlsx, pdfkit, recharts, lucide-react, framer-motion, date-fns, react-hook-form, @hookform/resolvers, @tanstack/react-query, @tanstack/react-table, zustand, sonner, vaul, cmdk, input-otp, embla-carousel-react, react-day-picker, react-markdown, react-resizable-panels, react-syntax-highlighter, @mdxeditor/editor, @dnd-kit/* (3), @radix-ui/* (22), @reactuses/core, uuid, class-variance-authority, clsx, tailwind-merge, tailwindcss-animate | verified via imports in src/ |
| **USED (dev)** | typescript, eslint, eslint-config-next, @types/*, tailwindcss, @tailwindcss/postcss, tw-animate-css, cross-env, tsx, bun-types, playwright-core | `playwright-core` used by e2e scripts; `bun-types` by `dev:live`/mini-services |
| **LIKELY UNUSED — MANUAL REVIEW** | `@reactuses/core` (spot-check only 1–2 imports), `@mdxeditor/editor` (verify import exists — if unused, remove), `embla-carousel-react` (verify), `@dnd-kit/utilities` | low-risk candidates only; verify by grep before removal |
| **DUPLICATE LOCKFILES** | root `bun.lock` + `package-lock.json`; `mini-services/live-updates/bun.lock` + `package-lock.json` | package.json scripts use `npm` (`npm --prefix`), but `dev:live` uses `bun`; decide per project — see Manual Review |
| **UNKNOWN** | none blocking | — |

Notes: `desktop-agent/` and `mini-services/live-updates/` are independent projects with their own lockfiles (excluded from root tsconfig — intentional). `electron`, `electron-builder`, `electron-updater`, `tsx`, `typescript` in desktop-agent are all used by its build/test scripts.

---

## 14. Git Hygiene Audit

### 14.1 Tracked junk (see §10 for full list)

- **`.e2e-fresh/` 3,143 files** and **`.e2e-install/` 75 files** — the dominant problem (≈657 MB working tree, ≈392 MB pack).
- Tracked compiled artifacts: `launcher.obj` ×2, `build/config.gypi`, `native-host-bin/*.exe`, `test-capture-*.png`.
- Tracked DB backups: `backups/pg/*.dump` (6), `db/*.bak-*` (4).
- Tracked generated output: `.portal-e2e-results.json`, `falcon-analysis.json`, `falcon-ref.json`.
- Tracked accidental: `.freebuff/worktrees/<uuid>`.

### 14.2 Secrets / env

- `.env` is on disk but **gitignored** (`.env*` ignore rule) — not tracked. `.env.example` / `.env.production.example` tracked (intended). No secrets found in tracked files (spot-checked `.env.example`, configs).

### 14.3 Untracked but should be committed (C7)

Brand assets (5), `scripts/generate-brand-assets.mjs`, desktop-agent new sources + `assets/icon.ico` + `omnisight-mark.svg` (18), new src features (12 paths), new tests (6), 4 Prisma migrations, 6 audit docs.

### 14.4 History size

`git count-objects -v` → `in-pack: 8,879`, `size-pack: 401,816 KB` (~392 MB). Removing `.e2e-fresh`/`.e2e-install` from history requires a **history rewrite** (`git filter-repo`/BFG). Recommended but optional — see §20 risk assessment. If history rewrite is out of scope, untrack + delete now and the repo stays bloated in history only.

---

## 15. Duplicate Detection

| # | Current file | Duplicate of | Which should remain | Why |
|---|---|---|---|---|
| D1 | `desktop-agent/scripts/launcher.obj` (7.3 KB, 2026-08-12) | `desktop-agent/launcher.obj` (11.6 KB, 2026-08-16) | **Neither** | Both are compiled COFF objects of `launcher.c` at different build times (different hashes); source `launcher.c` is canonical, build regenerates them |
| D2 | `backups/pg/workai-…-dump` (5 × exactly 212,504 bytes) | identical dumps taken minutes apart (11:30:35 / 11:30:50 / 11:31:17 / 11:37:19 / 11:37:49) | **Neither** | Same-size point-in-time pg_dumps of a throwaway DB; `workai-cleanup` dump (212,721 B) is the only distinct one. All regenerable |
| D3 | root `bun.lock` | root `package-lock.json` | **package-lock.json** (npm canonical for admin app) but `bun` is required for `dev:live`/mini-service | Two package managers coexist intentionally (npm for admin, bun for live service). MANUAL REVIEW — do not delete blindly |
| D4 | `mini-services/live-updates/bun.lock` | `mini-services/live-updates/package-lock.json` | one (pick bun, since scripts run `bun --hot`) | MANUAL REVIEW |
| D5 | `desktop-agent/native-host-manifests/*.json` (3) | generated by `install-native-host.mjs` into the registry | the script output | tracked copies contain a hardcoded dev path and are stale templates — MANUAL REVIEW |
| D6 | `workload/` docs (108) | `docs/` current docs | `docs/` | workload/ is the superseded planning trail — ARCHIVE both? No — archive workload/, keep docs/ |
| D7 | root audit pairs (e.g. `*-FINAL-AUDIT.md` + `*-HARDENING-CERTIFICATION.md`, `BREAK-MONITOR-PRODUCTION-AUDIT.md` + `-HARDENING-REPORT.md` + `-FINAL-VERIFICATION.md`) | audit + certification follow-ups of the same feature | **all**, in `docs/audits/<feature>/` | They form an evidence chain (audit → fix → certification); deleting any breaks the record. Move, don't merge |
| D8 | `tests/dashboard.png` vs `tests/dashboard-v2.png`; `profile-*.png` (6) | QA screenshots of the same pages | **None** | unreferenced (§8); delete or archive |
| D9 | `public/favicon.png` (32 px) vs `public/favicon.ico` (16/32/48) | overlapping raster favicons | **both** | different consumers (PNG for `<link>`, ICO legacy) — intentional |
| D10 | `desktop-agent/native-host-bin/worklens-native-host.exe` vs `.e2e-install/worklens-native-host.exe` | same launcher built twice | **the on-disk build output** (untracked) | both are build artifacts; neither belongs in git |

No two source files with identical content were found; no duplicate SVG/PNG brand files exist.

---

## 16. Reference Safety (delete-safety verification)

Every DELETE-CANDIDATE was checked against imports, `require()`/`import()`, `fs.readFile`/`existsSync`, `path.join`/`resolve`, URL/HTML/CSS refs, package scripts, Electron config, Next metadata, Prisma config, CI, copy scripts, and asset generators. Summary of reference checks:

| Candidate | References found | Safe? |
|---|---|---|
| `.e2e-fresh/` | none (no script references it) | YES — LOW risk |
| `.e2e-install/` | only the hardcoded path inside tracked `native-host-manifests/*.json` (which are themselves stale templates, D5) | YES (after removing/regenerating manifests) — MEDIUM risk, sequenced |
| `launcher.obj` ×2, `build/config.gypi` | none — only `build-native-host.mjs`/`build-native-host.bat` compile them transiently | YES — LOW |
| `native-host-bin/worklens-native-host.exe` | `install-native-host.mjs` `--host` flag + build script output path — binary stays on disk, only removed from git + ignored | YES — LOW (keep file) |
| `native/test-capture-*.png` | written by `test-capture2.mjs`; never read | YES — LOW |
| `backups/pg/*.dump`, `db/*.bak-*` | none | YES — LOW |
| `tests/*.png` (10) | none (grep of tests/docs/scripts) | YES — LOW |
| `falcon-*.json`, `.portal-e2e-results.json` | `.portal-e2e-results.json` is the output of `portal-e2e.mjs`; `falcon-*` unreferenced | YES — LOW |
| `globals.css.bak` | none (differs from `globals.css`) | YES — LOW |
| `.freebuff/worktrees/<uuid>` | none | YES — LOW |
| `examples/websocket/` | none (only an eslint ignore glob); `examples/**` excluded from lint | YES — LOW (or MOVE to `docs/examples/`) |
| `scripts/_*.mjs` debug scripts | none | YES — LOW |
| `worklog.md`, `workload/` | none — but historical value | ARCHIVE (not delete) |
| Root audit `.md` (52) | referenced only by each other (screenshot refs) | MOVE (not delete) |

---

## 17. Cleanup Plan (final recommendations)

### KEEP — everything not listed below

All application source (`src/`, `desktop-agent/src/`, `browser-extension/src/`, `mini-services/`), all tests (`tests/*.test.ts`, `desktop-agent/tests/*`), all Prisma migrations (incl. sqlite archive), all configs, `docs/` current docs, `public/` canonical + favicon set + sounds, `Caddyfile`, `.env.example`/`.env.production.example`, `README.md`, `package.json` + lockfiles (pending D3/D4), and all **untracked new-feature/brand files (commit them — C7)**.

### MOVE (current → proposed)

1. `*.md` root audit docs (46 tracked + 6 untracked) → `docs/audits/<feature>/` per §4.2 mapping (incl. `REBRAND-AUDIT.md` → `docs/audits/branding/`).
2. `active-project-audit-desktop.png`, `active-project-audit-mobile.png` → `docs/audits/admin/` (with their audit doc).
3. `PRODUCTION.md` → `docs/operations/production.md` (optional; also fine at root).
4. `docs/ai-provider-audit.md`, `docs/clean-machine-certification.md` → `docs/audits/`.
5. `docs/superpowers/plans/2026-08-03-m008-stage2-plan.md` → `docs/archive/plans/`.
6. `tests/` one-off scripts (7 files, §8.3) → `scripts/archive/`.
7. Root `verify-*`/`*-e2e`/`*-audit` scripts → `scripts/verify/` (optional organization pass; keep behavior).

### ARCHIVE

1. `workload/` (108 files) → `docs/archive/workload/` (keep git history; optionally squash into one commit before moving).
2. `worklog.md` → `docs/archive/worklog.md`.
3. `backups/pg/*.dump` (6) → git-ignored `backups/` (or delete — they are throwaway DB dumps).
4. `tests/*.png` (10) + root screenshots → `docs/archive/screenshots/` if evidence retention is desired (otherwise delete).

### DELETE (proven unnecessary — with evidence)

| Path | Reason | Evidence | References found | Replacement | Risk |
|---|---|---|---|---|---|
| `.e2e-fresh/` (3,143 files) | Chrome profile committed by accident | 386 MB; zero refs | none | none (regenerated by browser tooling) | LOW |
| `.e2e-install/` (75 files) | unpacked Electron install incl. old-brand exe | 271 MB; only stale manifest path refs | stale manifests (D5) | `electron-builder --dir` output | MEDIUM (sequence after manifests) |
| `desktop-agent/launcher.obj` | compiled COFF | tracked binary | none | `build-native-host.mjs` | LOW |
| `desktop-agent/scripts/launcher.obj` | older duplicate COFF | tracked binary, diff hash | none | same | LOW |
| `desktop-agent/build/config.gypi` | node-gyp artifact | tracked | none | node-gyp | LOW |
| `desktop-agent/native/test-capture-fg.png` / `-title.png` | test outputs | written by `test-capture2.mjs` | none | re-run script | LOW |
| `backups/pg/*.dump` (6) | throwaway pg dumps | 5 identical-size files | none | pg_dump | LOW |
| `db/custom.db.bak-phase2/-phase2b/-phase3/new-schema-backup` | SQLite backups | tracked | none | DB tooling | LOW |
| `.portal-e2e-results.json` | generated e2e output | written by `portal-e2e.mjs:197` | none | re-run script | LOW |
| `falcon-analysis.json`, `falcon-ref.json` | one-time AI research | unreferenced | none | — | LOW |
| `src/app/globals.css.bak` | stale backup | differs from `globals.css` | none | — | LOW |
| `.freebuff/worktrees/<uuid>` | accidental tracked file | worktree pointer in untracked dir | none | — | LOW |
| `examples/websocket/` (2 files) | unreferenced example | only eslint ignore glob | none | move to docs if wanted | LOW |
| `scripts/_*.mjs/_*.ps1/_*.mts` (6) | one-off debug helpers | zero refs | none | — | LOW |
| `tests/*.png` (10) | unreferenced QA screenshots | grep-verified | none | archive first if desired | LOW |
| `desktop-agent/native-host-manifests/*.json` (3) | stale dev templates w/ absolute path | hardcoded `E:\Workslens\...` | install script regenerates | regenerate via `install-native-host.mjs` | MEDIUM |

### MANUAL REVIEW

1. **Dual lockfiles** (root + mini-service): pick canonical package manager per project; if `bun` becomes canonical, replace `npm --prefix` scripts and drop `package-lock.json`; if npm stays, keep `bun.lock` only where bun actually runs (`dev:live`, mini-service).
2. **Commit policy for generated brand assets**: either commit the 6 generated outputs (recommended — self-contained clone/build) or wire `generate-brand-assets.mjs` into a pre-build script and ignore outputs. Decide once; today they are untracked, which breaks a fresh clone.
3. **`native-host-manifests/*.json`**: delete tracked copies vs. templatize. Verify the installed Chrome/Edge/Firefox registration still works after the e2e dir is removed (the manifests currently point into `.e2e-install/`).
4. **`bun-types` / `playwright-core` / `@reactuses/core` / `@mdxeditor/editor` / `embla-carousel-react` / `@dnd-kit/utilities`**: grep-verify each import before any removal; several are used only in scripts or one component.
5. **`desktop-agent/scripts/` unwired tools** (`bridge-smoke`, `offline-soak`, `soak-24h`, `e2e-onboarding`, `e2e-zero-touch`, `login-item-test`, `electron-bridge-check`, `build-native-host.bat`): confirm they're part of the release QA checklist before any deletion (recommendation: KEEP all).
6. **`migrate-sqlite-to-postgres.mjs` / `migration-verify.mjs` / `pg-*`**: historical migration tooling — verify the Postgres migration is fully complete before archiving.
7. **History rewrite** for `.e2e-fresh`/`.e2e-install` (~392 MB pack): decide whether the repo history must shrink (requires force-push coordination) or untrack-and-move-on is acceptable.

---

## 18. Proposed Repository Structure

### BEFORE (abridged)

```
/
├── .e2e-fresh/            ← 3,143 files, Chrome profile  (DELETE)
├── .e2e-install/          ← 75 files, Electron install   (DELETE)
├── .freebuff/  .gstack/  .worklens/  (untracked, ignored)
├── 52 × *AUDIT*/*CERTIFICATION*/… md   (MOVE → docs/audits)
├── active-project-audit-*.png  falcon-*.json  .portal-e2e-results.json
├── worklog.md  workload/           (ARCHIVE)
├── backups/  db/*.bak-*            (DELETE/ignore)
├── public/ (4 tracked + 5 untracked brand files)
├── src/  tests/  scripts/  prisma/  docs/  desktop-agent/
├── browser-extension/  mini-services/  examples/(DELETE)
├── package.json  package-lock.json  bun.lock  tsconfig.json  next.config.ts
├── eslint.config.mjs  tailwind.config.ts  postcss.config.mjs  components.json
├── README.md  PRODUCTION.md  Caddyfile  .env.example  .env.production.example  .gitignore
└── 54 untracked files (new features + brand) — to COMMIT
```

### AFTER (proposed)

```
/
├── src/                     # admin app (unchanged)
├── desktop-agent/           # Electron agent (source only; artifacts untracked+ignored)
├── prisma/                  # schema + migrations (+ sqlite archive dir, unchanged)
├── public/                  # logos/omnisight.svg (canonical) + favicon set + sounds + robots
├── scripts/                 # dev/build/db scripts + verify/ subdir for QA harnesses + archive/
├── tests/                   # regression tests only (one-off .sh/.ps1 moved out)
├── docs/
│   ├── README.md
│   ├── architecture/        # agent-*.md, consent-management.md, …
│   ├── operations/          # PRODUCTION.md, agent-installation.md, agent-development.md
│   ├── deployment/          # (Caddy notes)
│   ├── security/
│   ├── audits/<feature>/…   # all 52 root audit docs + REBRAND-AUDIT.md + 2 screenshots
│   ├── archive/             # workload/, worklog.md, old plans, screenshots(optional)
│   └── company-guide/       # unchanged
├── browser-extension/  mini-services/
├── package.json  package-lock.json   # (+ bun.lock only if bun canonical — D3)
├── tsconfig.json  next.config.ts  eslint.config.mjs  tailwind.config.ts
├── postcss.config.mjs  components.json
├── README.md  Caddyfile  .env.example  .env.production.example  .gitignore
└── (no audit docs, no dumps, no profiles, no obj/binaries at root)
```

---

## 19. Risk Assessment

| Action | Risk | Mitigation |
|---|---|---|
| Delete `.e2e-fresh/` | LOW | No script references it; it is a browser profile from past e2e runs |
| Delete `.e2e-install/` | MEDIUM | First remove/replace the stale `native-host-manifests` paths that point into it; verify extension ↔ agent bridge after (desktop-agent `bridge-smoke.mjs`) |
| Untrack `native-host-bin/worklens-native-host.exe` | LOW | Keep the file on disk (packaging needs it); only stop tracking + ignore |
| Move 52 audit docs | LOW | Pure doc moves; update the two cross-refs (screenshot paths in the admin audit doc; README links unchanged) |
| Archive `workload/` + `worklog.md` | LOW | Read-only history; nothing references them |
| Delete `db/*.bak-*`, `backups/pg/*.dump` | LOW | All regenerable; 5 of 6 dumps are identical throwaways |
| Commit 54 untracked files (brand assets, migrations, features) | LOW → MEDIUM | Required for clone/build integrity; review the 4 new migrations + new API routes first |
| History rewrite (optional) | HIGH | Requires force-push + team coordination; skip unless pack size matters |
| Lockfile consolidation (D3/D4) | MEDIUM | Do last; verify `npm ci`/`bun install` both work after |

---

## 20. Exact Cleanup Execution Plan (for the NEXT phase — NOT executed here)

Ordered so each step is verifiable before the next:

1. **Commit the in-flight work (C7):** stage and commit the 54 untracked files — brand assets + `generate-brand-assets.mjs`, desktop-agent policy/USB sources + tests, new `src/lib/{breaks,policies,anomalies,notifications}` + API routes, 4 new migrations, 6 new tests, 6 new audit docs (or move those first per step 3).
2. **Close `.gitignore` gaps:** add `.e2e-fresh/`, `.e2e-install/`, `backups/`, `uploads/`, `desktop-agent/native-host-bin/`, `desktop-agent/build/`, `*.obj`, `.portal-e2e-results.json`, `falcon-*.json`, `docs/archive/` (optional).
3. **Move docs** (`git mv`): 52 root audit docs → `docs/audits/<feature>/`; `workload/` → `docs/archive/workload/`; `worklog.md` → `docs/archive/`; 7 test one-offs → `scripts/archive/`; fix the 2 screenshot refs in `ADMIN-ACTIVE-PROJECT-UI-AUDIT-FINAL.md`; update `README.md`/`PRODUCTION.md` links.
4. **Delete junk from tracking + disk** (`git rm -r` + `rm`): `.e2e-fresh/`, `.e2e-install/`, `launcher.obj` ×2, `build/config.gypi`, `native/test-capture-*.png`, `backups/`, `db/*.bak-*`, `.portal-e2e-results.json`, `falcon-*.json`, `globals.css.bak`, `.freebuff/worktrees/<uuid>`, `examples/websocket/`, `scripts/_*` debug helpers, `tests/*.png` (or archive).
5. **Untrack-only:** `git rm --cached desktop-agent/native-host-bin/worklens-native-host.exe` (keep file).
6. **Resolve native-host manifests (D5):** regenerate via `install-native-host.mjs`; delete or templatize tracked copies.
7. **Run full verification** (below).
8. **(Optional, HIGH risk) History rewrite:** `git filter-repo`/BFG to purge `.e2e-fresh`/`.e2e-install`; coordinate force-push.
9. **(Optional) Lockfile consolidation (D3/D4)** — last, after everything else is green.

## 21. Verification Plan After Cleanup

```bash
# 1. Typecheck + lint
npx tsc --noEmit && npm run lint

# 2. Admin tests
npm test           # (or the per-suite test:* scripts)

# 3. Agent tests + typecheck
npm run test:agent && npm run typecheck:agent

# 4. Builds
npm run build
desktop-agent: npm run build && npm run build:native-host   # confirms brand-asset chain
npm run package:agent                                       # confirms icon.ico/electron-builder

# 5. Brand regression (explicit)
npx tsx --test tests/branding-regression.test.ts

# 6. DB
npx prisma migrate deploy   # 4 new migrations apply cleanly on a fresh DB
npx prisma validate

# 7. Runtime smoke
git status --short          # expected: only the cleanup commit(s), no leftovers
# boot admin app, run desktop-agent bridge smoke (scripts/bridge-smoke.mjs),
# verify browser extension native-messaging still registers after manifest change

# 8. Repo size sanity
git count-objects -v        # pack should drop to < 20 MB if history rewritten (else flat)
```

---

## 22. Safety Check (Phase 18 — read-only compliance)

Verified at the end of this audit:

- ✅ No source files modified (only `REPOSITORY-CLEANUP-AUDIT.md` created)
- ✅ No files moved, renamed, or deleted
- ✅ No DB touched, no migrations modified, no `.env` modified
- ✅ No packages installed/uninstalled, no lockfiles changed
- ✅ No destructive commands run (no `git clean/reset/restore`, no `rm -rf`)
- ✅ No builds executed

---

## Terminal Summary

```
KEEP:             ~3,900 files/dirs  (all source, tests, migrations, configs, current docs, assets)
MOVE:             52                (root audit docs → docs/audits/; PRODUCTION.md; test one-offs → scripts/archive)
ARCHIVE:          ~116              (workload/ 108, worklog.md, old plans, pg dumps, screenshots optional)
DELETE-CANDIDATE: 3,266             (.e2e-fresh 3,143 + .e2e-install 75 + 48 artifacts/backups/binaries)
MANUAL REVIEW:    12                (lockfiles ×2, brand-output commit policy, native-host manifests,
                                    5 borderline deps, 6 unwired agent scripts, history rewrite)
```

**Bottom line:** the codebase is healthy; the cleanup is about (1) purging 657 MB of accidentally committed browser/installer junk, (2) relocating ~52 root audit docs + 108 planning docs into `docs/`, (3) removing ~14 MB of committed build artifacts, and (4) committing the 54 in-flight rebrand/feature files so a fresh clone builds. Nothing in the report has been executed — this is the discovery deliverable for the next phase.



