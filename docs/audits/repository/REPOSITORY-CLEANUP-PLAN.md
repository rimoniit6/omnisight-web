# OmniSight — Pre-Cleanup Safety Pass & Cleanup Plan

**Date:** 2026-08-16 (second pass; independently re-inventoried current state)
**Mode:** AUDIT + ORGANIZATION PLANNING ONLY — no file/dir/DB/env/package/git-history changes performed.
**Scope:** full working tree + git index verification; every previous finding re-checked against the live repo.

---

## 1. Executive Summary

The repository is a working product monorepo (Next.js admin app, Electron desktop agent, native Win32 addon, browser extension, live-updates service). The current state was re-inventoried and **confirms the prior audit's findings with no drift**: nothing was committed or changed since the first pass (HEAD `f607e27`, 4,163 tracked files, 55 untracked, 175 modified, 2 staged deletions of old logos).

The cleanup is safe because **every DELETE candidate is either (a) tracked in git and therefore recoverable via `git restore`, or (b) a regenerable build/test artifact**. No source file, active test, migration, config, or current doc is a delete candidate. The only genuinely valuable non-source material (52 audit reports, 108 planning docs) is **MOVE/ARCHIVE, never deleted**.

### Headline numbers (verified)

| Metric | Value |
|---|---|
| Tracked files | 4,163 |
| Untracked files | 55 (54 implementation/brand files + this audit's report) |
| Working-tree junk in git | `.e2e-fresh/` 3,143 files / 386 MB · `.e2e-install/` 75 files / 271 MB |
| Other committed artifacts | ~48 files / ~14 MB (`.obj`, `.dump`, `.bak-*`, `.exe`, generated JSON, QA PNGs) |
| Git pack size | 401,816 KB (~392 MB) — **will not shrink from deleting HEAD files alone** |
| Root-level audit docs | 52 (46 tracked + 6 untracked) → MOVE to `docs/audits/` |
| Planning/history files | `workload/` 108 + `worklog.md` → ARCHIVE to `docs/archive/` |

### The 4 actions that matter

1. **Untrack + delete `.e2e-fresh/` and `.e2e-install/`** (657 MB, browser profile + Electron install) and add them to `.gitignore`.
2. **Untrack + delete ~48 committed artifacts** (`.obj`, `config.gypi`, `*.dump`, `*.bak-*`, generated JSON, test PNGs, old-brand exe in `.e2e-install`).
3. **Move 52 root audit docs + 108 planning docs** into `docs/audits/**` and `docs/archive/**` (preserving history).
4. **Commit the 54 untracked required files** (brand assets, generator, 4 migrations, policy/USB/break/anomaly/notification features + tests) — a fresh clone currently fails the agent build and brand tests without them.

---

## 2. Current Repository Statistics

| Area | Tracked files | On-disk size | Class |
|---|---|---|---|
| `.e2e-fresh/` | 3,143 | 386 MB | DELETE (committed Chrome profile) |
| `src/` | 365 | — | KEEP |
| `desktop-agent/` | 127 | — | KEEP (minus 8 artifacts) |
| `workload/` | 108 | — | ARCHIVE |
| `scripts/` | 76 | — | KEEP (reorganize) |
| `.e2e-install/` | 75 | 271 MB | DELETE (committed Electron install) |
| `tests/` | 64 | — | KEEP (minus 10 QA PNGs, 7 one-off scripts) |
| `docs/` | 62 | — | KEEP (2 audit docs relocate within docs/) |
| `prisma/` | 47 | — | KEEP (incl. 4 new untracked migrations) |
| `mini-services/` | 8 | — | KEEP |
| `browser-extension/` | 7 | — | KEEP |
| `backups/` | 6 | 1.3 MB | DELETE |
| `db/` | 4 (+3 ignored DBs) | 14 MB | DELETE the 4 tracked `.bak-*` |
| `public/` | 4 tracked + 5 untracked | — | KEEP (commit the 5) |
| `examples/` | 2 | — | MANUAL_REVIEW |
| root `.md` files | 46 tracked + 6 untracked | — | MOVE (52) |
| root other | configs, lockfiles, Caddyfile, 2 old logos (staged-deleted) | — | KEEP |
| Git pack | — | 392 MB | history rewrite is OPTIONAL |

Untracked: 55 files (all verified required — §14). Ignored on disk: `node_modules/`, `.next/`, `desktop-agent/dist/`, `desktop-agent/out/`, `desktop-agent/native/build/`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `.env`, `.worklens/dev.key`, `.gstack/`, `.freebuff/` logs.

---

## 3. KEEP Inventory (source of truth — never touched)

- **`src/` (365 files)** — all app source, API routes, components, hooks, lib, jobs.
- **`desktop-agent/src/`, `native/src/`, `native/binding.gyp`, `native/package.json`, `native-host/launcher.c`, `electron-builder.yml`, `tsconfig*.json`, `package.json`, `package-lock.json`, `.gitignore`** — all agent source + build config. Includes untracked new sources: `src/api/policy.ts`, `src/api/usb.ts`, `src/collectors/policy-enforcer.ts`, `src/collectors/usb-collector.ts`, `src/lib/brand.ts`, `src/lib/policy-resolution.ts`, `native/src/procmon.{cc,h}`, `native/src/usb.{cc,h}`, `src/renderer/omnisight-mark.svg` (**commit**).
- **All tests** — `tests/*.test.ts` (64 tracked + 6 untracked) and `desktop-agent/tests/*` (36 + 5 untracked). `branding-regression.test.ts` is the brand contract — **commit**.
- **`prisma/schema.prisma` + all 21 Postgres migrations + `migrations-sqlite-archive/` (25) + `migration_lock.toml`** + 4 new untracked migrations (**commit**).
- **`public/`** — `logos/omnisight.svg` (canonical, never delete/duplicate), `favicon.{svg,ico,png}`, `apple-touch-icon.png`, `sounds/notification.wav`, `robots.txt` (**commit the 5 brand files**).
- **Configs** — `package.json`, `package-lock.json`, `bun.lock`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `components.json`, `next-env.d.ts` (generated, ignored).
- **Env templates** — `.env.example`, `.env.production.example`.
- **`docs/` current docs** — `company-guide/` (26 md + 28 screenshots), `agent-api-contract.md`, `agent-architecture.md`, `agent-development.md`, `agent-installation.md`, `consent-management.md`.
- **`browser-extension/` (7), `mini-services/` (8)** — live extension + realtime service.
- **`Caddyfile`, `README.md`, `.gitignore`, `PRODUCTION.md`** (root ops guide; optional move → `docs/operations/`).
- **`scripts/generate-brand-assets.mjs`, `scripts/backfill-break-sessions.ts`** (untracked — commit).
- **`scripts/dev.mjs`, `db-push-dev.mjs`, `bootstrap-super-admin.ts`, `production-cleanup.ts`, `src/lib/jobs/cli.ts`** — wired to `package.json`.
- **All backward-compat WorkLensAI identifiers** (§13) — keep verbatim.

---

## 4. MOVE Inventory (52 root audit docs + supporting files)

All 52 root-level audit/certification/report Markdown files are **historical audit evidence** (dated, feature-scoped, post-hoc). None are referenced by code, `package.json`, or README. They move **preserved** into `docs/audits/<category>/` (full mapping in §8). Supporting evidence files move with them.

| # | Current path | Category | Destination |
|---|---|---|---|
| 1 | `REBRAND-AUDIT.md` | branding | `docs/audits/branding/REBRAND-AUDIT.md` |
| 2 | `ADMIN-ACTIVE-PROJECT-AUDIT.md` | admin/feature | `docs/audits/feature/admin-active-project/` |
| 3 | `ADMIN-ACTIVE-PROJECT-FINAL-IMPLEMENTATION.md` | admin/feature | same |
| 4 | `ADMIN-ACTIVE-PROJECT-UI-AUDIT-FINAL.md` | admin/feature | same (with its 2 PNGs) |
| 5–7 | `ADMIN-AI-INSIGHTS-*.md` (3) | admin/feature | `docs/audits/feature/admin-ai-insights/` |
| 8–9 | `ADMIN-OVERVIEW-ACTIVITIES-*.md` (2) | admin/feature | `docs/audits/feature/admin-overview-activities/` |
| 10 | `ADMIN-READINESS-AUDIT.md` | admin/production | `docs/audits/production/admin-readiness/` |
| 11 | `ADMIN-SECTION-AUDIT-2026-08-13.md` | admin/production | `docs/audits/production/admin-section/` |
| 12 | `ADMIN-SECTION-FINAL-CERTIFICATION.md` | admin/production | same |
| 13 | `API-AUDIT.md` | security | `docs/audits/security/api/` |
| 14 | `AUDIT-FINAL-REPORT.md` | repository | `docs/audits/repository/` |
| 15 | `AUDIT-agent-approvals.md` | feature | `docs/audits/feature/agent-approvals/` |
| 16 | `FIX-agent-approvals.md` | feature | same |
| 17–19 | `BREAK-MONITOR-*.md` (3) | feature | `docs/audits/feature/break-monitor/` |
| 20 | `CONSENT-MANAGEMENT-SEED-CERTIFICATION.md` | feature | `docs/audits/feature/consent/` |
| 21–22 | `DAILY-SUMMARY-REPORT-*.md` (2) | feature | `docs/audits/feature/daily-summary/` |
| 23 | `DATABASE-AUDIT.md` | security | `docs/audits/security/database/` |
| 24–29 | `DESKTOP-AGENT-*.md` (6) | production | `docs/audits/production/desktop-agent/` |
| 30–31 | `GLOBAL-EMPLOYEE-PRESENCE-*.md` (2) | feature | `docs/audits/feature/global-employee-presence/` |
| 32 | `EMPLOYEE-DETAIL-AUDIT.md` | feature | `docs/audits/feature/employees/` |
| 33–34 | `EMPLOYEE-LOCATION-*.md` (2) | feature | same |
| 35 | `EMPLOYEES-AUDIT.md` | feature | same |
| 36 | `EMPLOYEES-SELECTOR-AUDIT.md` | feature | same |
| 37 | `LIVE-MONITOR-EVENT-STATS-FINAL-AUDIT.md` | feature | `docs/audits/feature/live-monitor/` |
| 38 | `LIVE-MONITOR-EVENT-STATS-HARDENING-CERTIFICATION.md` | feature | same |
| 39 | `MASTER-AUDIT.md` | repository | `docs/audits/repository/` |
| 40 | `NOTIFICATION-ALERTING-PRODUCTION-CERTIFICATION.md` | feature | `docs/audits/feature/notifications/` |
| 41 | `PROJECT-MODULE-AUDIT.md` | repository | `docs/audits/repository/` |
| 42–44 | `PROJECT-TRACKING-*.md` (3) | feature | `docs/audits/feature/project-tracking/` |
| 45 | `SENTIMENT-AUDIT.md` | feature | `docs/audits/feature/sentiment/` |
| 46–47 | `SENTIMENT-EMPLOYEE-DETAILS-*.md` (2) | feature | same |
| 48–49 | `WEBSITE-DOMAIN-TRACKING-*.md` (2) | feature | `docs/audits/feature/website-domain-tracking/` |
| 50 | `WEBSITE-USAGE-TIME-SPENT-FINAL-CERTIFICATION.md` | feature | same |
| 51 | `docs/ai-provider-audit.md` | security | `docs/audits/security/ai-provider/` |
| 52 | `docs/clean-machine-certification.md` | production | `docs/audits/production/clean-machine/` |

Supporting MOVE entries:

| Path | Destination | Notes |
|---|---|---|
| `active-project-audit-desktop.png`, `active-project-audit-mobile.png` | `docs/audits/feature/admin-active-project/` | referenced only by #4 above |
| `PRODUCTION.md` | `docs/operations/production.md` (optional) | current ops guide — also fine at root |
| `docs/superpowers/plans/2026-08-03-m008-stage2-plan.md` | `docs/archive/plans/` | old phase plan |
| `tests/database-runtime-build.sh`, `tests/python-runtime-build.sh`, `tests/python-runtime-container.sh`, `tests/employee-db-inspect.ts`, `tests/employee-api-e2e.ps1`, `tests/employee-detail-e2e.ps1`, `tests/employee-search-e2e.ps1` | `scripts/archive/` | one-off scripts living inside `tests/` |
| `scripts/verify-*.mjs`, `*-e2e.mjs`, `*-audit.mjs`, `smoke-*.mjs` | `scripts/verify/` (optional) | manual QA harnesses; reorganize, do not delete |

All MOVE items are tracked in git → recoverable; confidence HIGH.

---

## 5. ARCHIVE Inventory (historical but preserved)

| Path | Size | Tracked | Destination | Why archive, not delete |
|---|---|---|---|---|
| `workload/` (108 files) | ~1 MB | yes | `docs/archive/workload/` | Complete planning trail (vision → sprints → phase certifications); superseded by `docs/` but valuable project history |
| `worklog.md` | 220 KB | yes | `docs/archive/worklog.md` | Agent task log; zero references |
| `backups/pg/*.dump` (6) | 1.3 MB | yes | git-ignored location (or delete — see §18) | Point-in-time dumps; 5 of 6 byte-identical throwaways; keep only if recovery value is wanted |
| `tests/*.png` (10 QA screenshots) | ~1 MB | yes | `docs/archive/screenshots/` (or delete) | Unreferenced evidence; archive if historical UI evidence is wanted |

Confidence HIGH (all git-tracked, all preserved, nothing current).

---

## 6. DELETE Inventory (proven disposable — all recoverable or regenerable)

Legend: T=tracked · U=untracked · Ref=referenced by any source/config/script/test · Req=required by build/runtime/deploy · Safe=removal is safe.

| # | Path | Reason | Size | T/U | Ref | Req | Safe | Confidence |
|---|---|---|---|---|---|---|---|---|
| D1 | `.e2e-fresh/` (3,143 files) | Committed Chrome browser profile (user data + cache) | 386 MB | T | none | no | yes | HIGH |
| D2 | `.e2e-install/` (75 files) | Committed unpacked Electron install incl. old-brand `WorkLensAIAgent.exe` | 271 MB | T | only stale manifest paths (§MR3) | no | yes (after MR3) | MEDIUM |
| D3 | `desktop-agent/launcher.obj` | Compiled COFF object of `launcher.c` | 12 KB | T | none | no | yes | HIGH |
| D4 | `desktop-agent/scripts/launcher.obj` | Older duplicate COFF object (diff hash) | 7 KB | T | none | no | yes | HIGH |
| D5 | `desktop-agent/build/config.gypi` | node-gyp config artifact | <1 KB | T | none | no | yes | HIGH |
| D6 | `desktop-agent/native/test-capture-fg.png` | Output of `test-capture2.mjs` (line 13) | ~10 KB | T | generator only | no | yes | HIGH |
| D7 | `desktop-agent/native/test-capture-title.png` | Output of `test-capture2.mjs` (line 25) | ~10 KB | T | generator only | no | yes | HIGH |
| D8 | `backups/pg/*.dump` (6) | Throwaway pg_dump point-in-time backups | 1.3 MB | T | none | no | yes | HIGH |
| D9 | `db/custom.db.bak-phase2` | SQLite backup | 1.5 MB | T | none | no | yes | HIGH |
| D10 | `db/custom.db.bak-phase2b` | SQLite backup | 1.9 MB | T | none | no | yes | HIGH |
| D11 | `db/custom.db.bak-phase3` | SQLite backup | 2.0 MB | T | none | no | yes | HIGH |
| D12 | `db/custom.db.new-schema-backup` | SQLite backup | 2.4 MB | T | none | no | yes | HIGH |
| D13 | `.portal-e2e-results.json` | Generated output written by `scripts/portal-e2e.mjs:197` | 25 KB | T | generator only | no | yes | HIGH |
| D14 | `falcon-analysis.json` | One-time AI design-research dump | 7 KB | T | none | no | yes | HIGH |
| D15 | `falcon-ref.json` | One-time AI design-research dump | 2 KB | T | none | no | yes | HIGH |
| D16 | `src/app/globals.css.bak` | Stale CSS backup (differs from `globals.css`) | <1 KB | T | none | no | yes | HIGH |
| D17 | `.freebuff/worktrees/<uuid>` | Accidental tracked worktree-pointer file in untracked dir | <1 KB | T | none | no | yes | HIGH |
| D18–23 | `scripts/_consent-regression.mjs`, `scripts/_db-diagnostic.mjs`, `scripts/_launch-repair.ps1`, `scripts/_os-repair.ps1`, `scripts/_w100_live.mts`, `scripts/_winrt-geo-check.ps1` | Underscore-prefixed debug helpers, zero references | <50 KB total | T | none | no | yes | HIGH |
| D24–33 | `tests/*.png` (10: `dashboard.png`, `dashboard-v2.png`, `mobile.png`, `employee-profile.png`, `profile-desktop-v2.png`, `profile-mobile.png`, `profile-mobile-v2.png`, `profile-tablet.png`, `profile-tablet-v2.png`) | Unreferenced QA screenshots (grep-verified; `png-dimensions.test.ts` builds PNGs in memory) | ~1 MB | T | none | no | yes | HIGH |
| D34 | `desktop-agent/native-host-manifests/*.json` (3) | Stale dev templates w/ hardcoded absolute path `E:\Workslens\workai\.e2e-install\…`; real manifests are generated by `install-native-host.mjs` | <1 KB | T | installer script regenerates | no | yes (after MR3) | MEDIUM |
| D35 | `desktop-agent/native-host-bin/worklens-native-host.exe` | Compiled launcher binary — **untrack only, keep on disk** (packaging needs it) | 152 KB | T | `install-native-host.mjs --host`, `build-native-host.mjs` | yes (build) | untrack: yes / delete: no | HIGH (untrack) |

**Key safety argument for D1–D33:** every one is git-tracked → full recovery via `git restore --source=HEAD -- <path>`; every one is either generated, throwaway, or unreferenced. **D35** is explicitly NOT deleted from disk. **D2/D34** are sequenced behind MANUAL_REVIEW item MR3.

---

## 7. MANUAL REVIEW Inventory (do not touch without decisions)

| # | Path(s) | Why manual | Decision needed | Confidence that current state is OK |
|---|---|---|---|---|
| MR1 | root `bun.lock` + `package-lock.json` | Two package managers coexist: npm drives `package.json` scripts (`npm --prefix`), bun runs `dev:live` + mini-service | Pick canonical per project; keep both only if intentional | — |
| MR2 | `mini-services/live-updates/bun.lock` + `package-lock.json` | same dual-lockfile pattern; service runs `bun --hot` | Pick one | — |
| MR3 | `desktop-agent/native-host-manifests/*.json` + `.e2e-install/` | Tracked manifests point into the to-be-deleted `.e2e-install/`; removing the dir breaks the stale path | Delete tracked manifests (script regenerates) or templatize; verify Chrome/Edge/Firefox registration after | MEDIUM |
| MR4 | Brand-asset commit policy | 6 generated brand outputs + generator are untracked; clone/build currently depends on them existing | Commit outputs + generator, OR wire generator into pre-build and ignore outputs | — |
| MR5 | `examples/websocket/` (2 files) | Unreferenced (only an eslint ignore glob), but a usable reference for the socket service | Delete, or MOVE to `docs/examples/websocket/` | MEDIUM |
| MR6 | Deps `@reactuses/core`, `@mdxeditor/editor`, `embla-carousel-react`, `@dnd-kit/utilities`, `bun-types`, `playwright-core` | Spot-checked only; each may be used by one component/script | grep-verify imports before any removal | — |
| MR7 | `desktop-agent/scripts/` unwired tools: `bridge-smoke.mjs`, `e2e-onboarding.mjs`, `e2e-zero-touch.mjs`, `offline-soak.mjs`, `soak-24h.mjs`, `login-item-test.js`, `electron-bridge-check.js`, `build-native-host.bat` | Not in `package.json` but part of the release QA workflow (docs-reference some) | Confirm with release checklist before any deletion — recommendation: KEEP all | — |
| MR8 | `scripts/migrate-sqlite-to-postgres.mjs`, `scripts/migration-verify.mjs`, `scripts/pg-audit.sql`, `scripts/pg-unique-check.sql`, `scripts/pg-test-db.mjs`, `scripts/pg-backup-restore-certification.mjs` | Historical migration tooling; some cross-reference each other | Archive only after confirming Postgres migration is complete | MEDIUM |
| MR9 | Git history rewrite (`.e2e-fresh`/`.e2e-install`, ~392 MB pack) | Deleting files from HEAD does NOT shrink the pack | Decide: `git filter-repo`/BFG + force-push coordination, or accept history size | — |
| MR10 | `scripts/agent-count.mjs`, `ai-connected-browser-check.mjs`, `check-login-response.mjs`, `copy-standalone.js`, `overlay-probe.mjs`, `perf-baseline.mjs`, `probe-portal-db.mjs`, `provision-agent-tokens.mjs`, `cleanup-zt-e2e.sh` | Unreferenced one-offs, but could be part of ad-hoc dev workflows | Verify with dev workflow before deleting; safe to MOVE to `scripts/archive/` | LOW–MEDIUM |

---

## 8. Documentation Organization Plan

Target structure (existing docs stay; audit docs relocate):

```
docs/
├── README.md                          (optional index)
├── company-guide/                     (UNCHANGED — product manual, referenced by README)
├── architecture/                      (agent-architecture.md, agent-api-contract.md, consent-management.md, agent-development.md)
├── guides/                            (agent-installation.md, …)
├── deployment/                        (PRODUCTION.md → operations, Caddy notes)
├── development/                       (dev runbooks)
├── audits/
│   ├── production/                    (ADMIN-READINESS, ADMIN-SECTION, DESKTOP-AGENT-*, clean-machine)
│   ├── security/                      (API-AUDIT, DATABASE-AUDIT, ai-provider)
│   ├── feature/                       (agent-approvals, break-monitor, consent, employees, live-monitor,
│   │                                   notifications, project-tracking, sentiment, website-domain-tracking, …)
│   ├── branding/                      (REBRAND-AUDIT.md)
│   └── repository/                    (AUDIT-FINAL-REPORT, MASTER-AUDIT, PROJECT-MODULE-AUDIT)
└── archive/                           (workload/, worklog.md, plans/, screenshots/)
```

Rules applied: (1) audit/certification docs are preserved in full — never merged or deleted; (2) current docs (`company-guide`, agent docs, consent reference) stay; (3) the 52-file mapping in §4 is the authoritative move list; (4) each feature keeps its audit → fix → certification chain together.

---

## 9. Generated Artifact Cleanup

| Artifact class | Examples | Generator | Disposable? |
|---|---|---|---|
| Browser profile | `.e2e-fresh/` | browser automation tooling | yes — regenerated per run |
| Electron install dir | `.e2e-install/` | `electron-builder --dir` / e2e setup | yes |
| Compiled objects | `launcher.obj` ×2 | `build-native-host.mjs` / `.bat` | yes |
| node-gyp artifacts | `build/config.gypi`, `native/build/Release/*` | `node-gyp rebuild` | yes (native/build already ignored) |
| Launcher binary | `native-host-bin/worklens-native-host.exe` | `build-native-host.mjs` | untrack + ignore (keep file) |
| Capture test outputs | `native/test-capture-*.png` | `test-capture2.mjs` | yes |
| DB dumps/backups | `backups/pg/*.dump`, `db/*.bak-*` | pg_dump / SQLite copy | yes (regenerable) |
| Generated reports | `.portal-e2e-results.json` | `portal-e2e.mjs` | yes |
| QA screenshots | `tests/*.png`, root `active-project-*.png` | browser captures | yes (archive optional) |
| Brand derivatives | favicon set, `icon.ico`, `omnisight-mark.svg` | `scripts/generate-brand-assets.mjs` | **NO — required at build/runtime (MR4: commit them)** |

---

## 10. `.e2e-fresh/` Analysis

- **What it is:** a full Chrome/Chromium user-data directory (`Default/` profile, `Cache/`, `Crashpad/`, component updater state, `BrowserMetrics`, etc.) — verified by listing contents. 3,143 files, 386 MB.
- **Git status:** tracked (committed by accident — appears in `git ls-files`).
- **References:** zero (no script, config, or doc references it; grep-verified).
- **Required by build/runtime/deploy:** no.
- **Reproducible:** yes — it is recreated automatically whenever an e2e/browser-automation run starts a fresh profile.
- **Recommendation:** `git rm -r .e2e-fresh`, delete working copy, add `.e2e-fresh/` to `.gitignore`. Confidence HIGH. Restorable from git if ever needed (until history rewrite).

## 11. `.e2e-install/` Analysis

- **What it is:** an unpacked Electron application install dir (Electron runtime DLLs, `resources/`, locales) including the **old-brand `WorkLensAIAgent.exe`** and a `worklens-native-host.exe`. 75 files, 271 MB.
- **Git status:** tracked.
- **References:** only the hardcoded absolute paths inside the tracked `desktop-agent/native-host-manifests/{chrome,edge,firefox}.json` (`E:\Workslens\workai\.e2e-install\worklens-native-host.exe`) — a developer-machine path (MR3).
- **Required by build/runtime/deploy:** no — the real manifests are generated by `install-native-host.mjs`; packaged apps come from `electron-builder` output in `desktop-agent/out/` (gitignored).
- **Reproducible:** yes (`npm run package:dir` / e2e setup).
- **Recommendation:** sequence — (1) resolve MR3 (delete/templatize stale manifests), (2) `git rm -r .e2e-install`, (3) add `.e2e-install/` to `.gitignore`. Confidence MEDIUM only because of the manifest dependency; deletion itself is safe.

---

## 12. Branding / OmniSight Asset Analysis

Canonical brand: **OmniSight** · Canonical logo: **`public/logos/omnisight.svg`** (verified present, untracked — **commit; never delete/duplicate**).

### 12.1 Asset chain (all verified present on disk)

| Asset | Class | Consumed by | Generator | Action |
|---|---|---|---|---|
| `public/logos/omnisight.svg` | canonical source | all UI; source of every derivative | — | **commit** |
| `public/favicon.svg` | derived (tight-crop) | `src/app/layout.tsx` metadata | `scripts/generate-brand-assets.mjs` | commit |
| `public/favicon.ico` | derived (16/32/48) | `layout.tsx` legacy raster | same | commit |
| `public/favicon.png` | derived (32) | `layout.tsx` | same | commit |
| `public/apple-touch-icon.png` | derived (180) | `layout.tsx` `apple:` | same | commit |
| `desktop-agent/src/renderer/omnisight-mark.svg` | derived | renderer header; `copy-assets.mjs` **hard-fails** if absent | same | commit |
| `desktop-agent/assets/icon.ico` (16–256) | derived | `electron-builder.yml win.icon`, `main.ts` window/tray | same | commit |
| `public/sounds/notification.wav` | source | `live-monitor-page.tsx` | — | KEEP (tracked) |
| `public/robots.txt` | source | web standard | — | KEEP (tracked) |

**Verified dependency chain:** `generate-brand-assets.mjs` (untracked) writes all 6 outputs; `copy-assets.mjs` (tracked, runs first in agent `build`) hard-requires `omnisight-mark.svg`; `electron-builder.yml` references `assets/icon.ico`; `tests/branding-regression.test.ts` asserts all 6 outputs exist. → **A fresh clone cannot build or pass brand tests until MR4 is decided.**

### 12.2 Obsolete WorkLensAI visual assets

| Asset | Status | Action |
|---|---|---|
| `public/worklens-logo.png`, `public/logo.svg` | staged-deleted (` D`) by the in-progress rebrand | confirm deletion (already correct); regression test asserts they stay absent |
| `.e2e-install/WorkLensAIAgent.exe` | tracked junk | deleted with D2 |
| `desktop-agent/native-host-bin/worklens-native-host.exe` | tracked binary, name is legacy | untrack only (D35) — binary name is a build output, not branding |

Category mapping: A (obsolete visuals → delete) = the two staged-deleted logos + `.e2e-install` exe · B (backward-compat identifiers → keep) = §13 · C (generated derivatives → keep, required) = favicon set + icons · D (source assets → keep) = canonical SVG, `notification.wav`.

---

## 13. WorkLensAI Legacy Identifier Report

Full case-insensitive scan (`worklens*`) across tracked+untracked files (excluding `node_modules`, `.git`, `.next`, `dist`, `out`, `build`, `.e2e-*`, lockfiles) → ~130 files. **Every occurrence below is intentional and must NOT be renamed.** Renaming any of these breaks installed agents, browser extensions, sessions, or stored state.

| # | Identifier | Category | Where | Why it must stay |
|---|---|---|---|---|
| L1 | `com.worklensai.website` | hostname/protocol compat | `browser-extension/native-messaging/*.json`, `desktop-agent/native-host-manifests/*.json`, `browser-extension/src/background.js`, `desktop-agent/src/services/native-messaging-host.ts` | Registered native-messaging host name — changing breaks extension↔agent messaging for installed extensions |
| L2 | `worklensai-agent` userData dir | migration compat | `desktop-agent/native-host/launcher.c` (`APP_DATA_DIR`), `desktop-agent/src/main/main.ts` (`app.setPath('userData')`) | Pinned legacy data dir — preserves existing installs' queue/state across the rename |
| L3 | `worklens_token` cookie | migration compat | `src/lib/auth.ts`, `mini-services/live-updates/index.ts`, `.env.example` | Shared session cookie (admin app + live service + agent); rename logs everyone out |
| L4 | `WORKLENSAI_SERVER_URL` env | migration compat | `desktop-agent/src/config/server-url.ts`, `.env.example`, `.env.production.example` | Legacy alias honored for deployed agents; new `OMNISIGHT_SERVER_URL` wins when both set |
| L5 | `worklens_capture.node` | Electron/package id | `desktop-agent/native/binding.gyp`, `native/package.json`, `electron-builder.yml` (`extraResources`) | Compiled addon filename wired into packaging |
| L6 | `worklensaiagent.exe`, `worklensai.exe` | migration compat | `src/lib/agent-process.ts`, `src/lib/policies/constants.ts` | Legacy binary detection (orphan cleanup + policy exclusions) — remove only after all installs migrate |
| L7 | `worklens-tour-completed`, `worklens-widget-layout` | migration compat | `src/lib/store.ts`, `src/lib/widget-store.ts` | localStorage keys — renaming resets user UI state |
| L8 | `worklens:add-employee`, `worklens:edit-employee` | migration compat | `src/components/employees/employees-page.tsx` | Cross-window DOM events |
| L9 | `.worklens/dev.key` | technical | `src/lib/crypto.ts`, `.gitignore` | Dev encryption key path (already gitignored) |
| L10 | `worklens_native_host` process name | technical | `desktop-agent/src/lib/internal-process.ts` | IPC/process identity; covered by `internal-process.test.ts` |
| L11 | `website-tracker@worklens.ai` | Electron/package id | `browser-extension/manifest.json` | Firefox extension ID — immutable once published |
| L12 | `WorkLensAI`/`worklensai` in comments | historical | `prisma/migrations/*` comments, `prisma/schema.prisma` comment, docs | Comments only — cosmetic; optional cleanup during a schema-touching commit |
| L13 | `worklensai-website-tracker` npm name | package id | `browser-extension/package.json` | Internal-only package name; renaming is safe but optional |

**Not present in this repo:** no live code references `worklens.ai` domain, no active user-facing UI text uses WorkLensAI (all UI strings verified OmniSight via `src/lib/brand.ts`). Old-brand references appear **only** in: historical audit docs (moved with §4), the two staged-deleted logo files, `.e2e-install` exe (deleted), and `native-host-manifests` dev paths (MR3).

---

## 14. Untracked File Safety Report

All 55 untracked paths verified individually. **Every implementation/brand/migration/test file is required — KEEP.** No untracked file is disposable.

| Group | Files (verified) | Verdict | Evidence |
|---|---|---|---|
| Brand assets (5) | `public/logos/omnisight.svg`, `public/favicon.{svg,ico,png}`, `public/apple-touch-icon.png` | **KEEP** | consumed by `layout.tsx`; asserted by `branding-regression.test.ts` |
| Brand generator (1) | `scripts/generate-brand-assets.mjs` | **KEEP** | writes all 6 derivatives; `copy-assets.mjs` depends on it |
| Agent brand outputs (2) | `desktop-agent/assets/icon.ico`, `desktop-agent/src/renderer/omnisight-mark.svg` | **KEEP** | `electron-builder.yml` + `copy-assets.mjs` hard-require |
| Agent new features (8) | `src/api/policy.ts`, `src/api/usb.ts`, `src/collectors/policy-enforcer.ts`, `src/collectors/usb-collector.ts`, `src/lib/brand.ts`, `src/lib/policy-resolution.ts`, `native/src/procmon.{cc,h}`, `native/src/usb.{cc,h}` | **KEEP** | compiled by `binding.gyp`/tsc; tested by new tests |
| Agent new tests (5) | `tests/break-enforcement.test.ts`, `policy-cache.test.ts`, `policy-enforcer.test.ts`, `policy-resolution.test.ts`, `usb-collector.test.ts` | **KEEP** | active regression tests |
| Admin new features (11 paths) | `src/app/api/agent/policy-violations/`, `src/app/api/agent/usb/`, `src/app/api/break-status/history/`, `src/app/api/notifications/preferences/`, `src/app/api/policy-violations/`, `src/app/api/self/break-status/`, `src/lib/anomalies/`, `src/lib/breaks/`, `src/lib/notifications/`, `src/lib/policies/`, `src/lib/jobs/detect-anomalies.ts` + `src/lib/brand.ts` + `scripts/backfill-break-sessions.ts` | **KEEP** | feature code under the Next.js build (`@/*` imports) |
| Admin new tests (6) | `agent-registrations-admin.test.ts`, `anomaly-hardening.test.ts`, `branding-regression.test.ts`, `break-hardening.test.ts`, `notification-alerting-hardening.test.ts`, `policy-management-hardening.test.ts` | **KEEP** | active regression tests |
| Migrations (4 dirs) | `prisma/migrations/20260816…` (break_session, anomaly_detection_hardening, policy_management, notification_alerting_hardening) | **KEEP** | required by `prisma migrate deploy` on fresh DBs |
| New audit docs (6) | `AUDIT-agent-approvals.md`, `FIX-agent-approvals.md`, `BREAK-MONITOR-*.md` (3), `NOTIFICATION-ALERTING-PRODUCTION-CERTIFICATION.md`, `REBRAND-AUDIT.md` | **KEEP** → MOVE with §4 | historical audit evidence; `REBRAND-AUDIT.md` is the rebrand record |
| This audit (1) | `REPOSITORY-CLEANUP-AUDIT.md` (prior pass) | KEEP (or archive under `docs/audits/repository/`) | generated by the prior audit |

**Verdict: 0 untracked files should be deleted. 55 KEEP.** (55th file = `REPOSITORY-CLEANUP-AUDIT.md` created by the earlier read-only pass; `REPOSITORY-CLEANUP-PLAN.md` is the 56th once written.)

---

## 15. Duplicate File Report

| # | File(s) | Duplicate of | Keep | Evidence |
|---|---|---|---|---|
| Dup1 | `desktop-agent/scripts/launcher.obj` (7.3 KB) | `desktop-agent/launcher.obj` (11.6 KB) | **neither** | both compiled outputs of `launcher.c` at different times; different hashes (`8fd3…`, `10c9…`) |
| Dup2 | `backups/pg/workai-*.dump` (5 × 212,504 B) | identical dumps minutes apart (11:30–11:37) | **neither** | byte-equal throwaways; `workai-cleanup` (212,721 B) is the only distinct one |
| Dup3 | root `bun.lock` | root `package-lock.json` | one (decide) | npm scripts + bun `dev:live` coexist (MR1) |
| Dup4 | `mini-services/live-updates/bun.lock` | `mini-services/live-updates/package-lock.json` | one (decide) | service runs `bun --hot` (MR2) |
| Dup5 | `desktop-agent/native-host-manifests/*.json` (3) | generated registry manifests from `install-native-host.mjs` | script output | tracked copies are stale, hardcode a dev path (MR3) |
| Dup6 | `desktop-agent/native-host-bin/worklens-native-host.exe` | `.e2e-install/worklens-native-host.exe` | on-disk build output (untracked) | same launcher built twice; neither belongs in git (D2/D35) |
| Dup7 | `tests/dashboard.png` vs `dashboard-v2.png`; 6× `profile-*.png`; `mobile.png` | QA captures of same pages | **none** | unreferenced (§D24–33) |
| Dup8 | `public/favicon.png` vs `public/favicon.ico` | overlapping raster favicons | **both** | different consumers (PNG `<link>` vs legacy ICO) — intentional |
| Dup9 | Root audit pairs (`*-FINAL-AUDIT` + `*-HARDENING-CERTIFICATION`, `BREAK-MONITOR-*` ×3) | audit → fix → certification follow-ups | **all** | form the evidence chain; move, never merge/delete |

No duplicate source files, duplicate canonical logos, or old copies of source files found. Hash check performed on the obvious binary duplicates.

---

## 16. Git Hygiene Recommendations

### 16.1 Add to `.gitignore` (do NOT modify it in this phase)

```
.e2e-fresh/
.e2e-install/
backups/
uploads/
desktop-agent/native-host-bin/
desktop-agent/build/
*.obj
.portal-e2e-results.json
falcon-*.json
```

(`uploads/` is the runtime screenshot store — currently NOT ignored, verified. `desktop-agent/native/build/` and root `/build` are already ignored.)

### 16.2 Tracked junk to untrack/remove (full list in §6)

`.e2e-fresh/`, `.e2e-install/`, `launcher.obj` ×2, `build/config.gypi`, `native/test-capture-*.png`, `backups/pg/*.dump`, `db/*.bak-*`, `.portal-e2e-results.json`, `falcon-*.json`, `globals.css.bak`, `.freebuff/worktrees/<uuid>`, `tests/*.png`, `native-host-manifests/*.json` (after MR3).

### 16.3 History vs working tree

- Deleting files from HEAD **does not shrink git history** — the pack stays ~392 MB until a history rewrite (MR9) is performed.
- `git rm` keeps every deleted file in history → **full rollback possible** via `git restore` (see §23).
- If history size matters: run `git filter-repo`/BFG to purge `.e2e-fresh`/`.e2e-install` AFTER the working-tree cleanup is verified, with force-push coordination. This is the only HIGH-risk step and is optional.

### 16.4 Other hygiene

- Commit the 54 required untracked files (§14) — the tree is currently not clone-buildable.
- Confirm the 175 modified files (rebrand in progress) are intentional before the cleanup commit.
- `desktop-agent/native-host-manifests/*.json` hardcoded absolute paths (`E:\Workslens\workai\…`) should never be committed — templatize or regenerate (MR3).

---

## 17. Script Safety Report

| Script set | Referenced by | Verdict |
|---|---|---|
| `scripts/dev.mjs`, `db-push-dev.mjs`, `bootstrap-super-admin.ts`, `production-cleanup.ts` (+ `src/lib/jobs/cli.ts`) | `package.json` scripts | KEEP |
| `scripts/generate-brand-assets.mjs`, `scripts/backfill-break-sessions.ts` | build chain / feature (untracked) | KEEP + commit |
| `scripts/clean-machine-certification.ps1` | `docs/clean-machine-certification.md` | KEEP (moves with doc to audits/) |
| `verify-*.mjs`, `*-e2e.mjs`, `*-audit.mjs`, `smoke-*.mjs` (~30) | developer QA workflow; some cross-reference each other (`location-tab-e2e` → `live-monitor-ui-test`; `migration-verify` → `pg-test-db`; `cleanup-ocr-fixtures` → `verify-ocr`) | KEEP — optionally group under `scripts/verify/` |
| `scripts/_*.mjs/_*.ps1/_*.mts` (6) | none | DELETE (D18–23) |
| `scripts/agent-count.mjs`, `ai-connected-browser-check.mjs`, `check-login-response.mjs`, `copy-standalone.js`, `overlay-probe.mjs`, `perf-baseline.mjs`, `probe-portal-db.mjs`, `provision-agent-tokens.mjs`, `cleanup-zt-e2e.sh` | none found, but possibly ad-hoc | MANUAL_REVIEW (MR10) — archive rather than delete |
| `desktop-agent/scripts/*` (14 files) | 5 wired in `desktop-agent/package.json`; 8 unwired (MR7) | KEEP all (MR7) |
| `tests/*.sh/*.ps1/*.ts` one-offs (7) | none | MOVE → `scripts/archive/` (§4) |

Rule honored: **no script is deleted merely for being unreferenced in package.json** — unreferenced scripts are MANUAL_REVIEW or moved to `scripts/archive/`, never silently removed.

---

## 18. Database Safety Report

| Path | Verdict | Evidence |
|---|---|---|
| `prisma/schema.prisma` | **KEEP** | active schema (comment mentions legacy brand only) |
| `prisma/migrations/` (21) | **KEEP** | active Postgres migrations — never delete applied migrations |
| `prisma/migrations-sqlite-archive/` (25) | **KEEP (archive)** | correctly quarantined historical SQLite migrations |
| 4 new untracked migration dirs (`20260816…`) | **KEEP + commit** | required for `migrate deploy` on fresh DBs |
| `prisma/migration_lock.toml` | **KEEP** | required by Prisma |
| `src/lib/seed.ts`, `scripts/bootstrap-super-admin.ts`, `reset-database.ts`, `db-push-dev.mjs` | **KEEP** | wired to package.json / documented |
| `db/custom.db.bak-phase2/-phase2b/-phase3/new-schema-backup` | **DELETE** (D9–D12) | tracked SQLite copies; regenerable; no recovery requirement identified |
| `backups/pg/*.dump` (6) | **DELETE or ARCHIVE** (D8) | throwaway dumps (5 byte-identical); if any recovery value is uncertain, archive to a git-ignored path instead of deleting |
| `db/custom.db`, `db/e2e-throwaway.db`, `db/test-migration.db`, `.freebuff/desktop-v2.db*` | local-only (ignored) | delete locally if desired; not a repo concern |

No migrations executed, no DB touched, no schema modified during this pass.

---

## 19. Proposed Final Repository Tree

```
/
├── src/                        # admin app (unchanged)
├── public/
│   ├── logos/omnisight.svg     # canonical brand — committed
│   ├── favicon.svg · favicon.ico · favicon.png · apple-touch-icon.png
│   ├── sounds/notification.wav
│   └── robots.txt
├── desktop-agent/              # source + build config only
│   ├── src/  native/  native-host/  tests/  scripts/
│   ├── assets/icon.ico         # committed (generated, but required by packaging)
│   └── (no .obj / .exe / build artifacts tracked)
├── prisma/
│   ├── schema.prisma
│   ├── migrations/             # 25 (21 + 4 new committed)
│   └── migrations-sqlite-archive/   # 25, unchanged
├── tests/                      # regression tests only (no PNGs, no one-off scripts)
├── scripts/
│   ├── (dev/db/build scripts, wired to package.json)
│   ├── verify/                 # QA harnesses (verify-*, *-e2e, *-audit, smoke-*)
│   └── archive/                # one-off test scripts moved from tests/
├── docs/
│   ├── company-guide/          # unchanged
│   ├── architecture/           # agent-architecture, agent-api-contract, consent-management, agent-development
│   ├── guides/                 # agent-installation, …
│   ├── deployment/             # PRODUCTION.md → operations (or kept at root)
│   ├── audits/
│   │   ├── production/  security/  feature/  branding/  repository/
│   │   └── (52 docs + REBRAND-AUDIT + 2 screenshots)
│   └── archive/                # workload/, worklog.md, plans/, screenshots/
├── browser-extension/          # unchanged
├── mini-services/              # unchanged
├── package.json · package-lock.json · bun.lock     # lockfile decision = MR1/MR2
├── tsconfig.json · next.config.ts · eslint.config.mjs
├── tailwind.config.ts · postcss.config.mjs · components.json
├── README.md · Caddyfile · .gitignore
├── .env.example · .env.production.example
└── (no .e2e-*, no backups/, no db backups, no audit docs, no worklog at root)
```

---

## 20. Cleanup Execution Order (next phase — NOT executed now)

Each step is independently verifiable before the next begins. Steps 1–3 are zero-risk; step 4 is the bulk deletion; step 7 is the only HIGH-risk (and optional) step.

1. **Branch + baseline:** create `chore/repo-cleanup` branch; run full test suite to record a green baseline.
2. **Commit in-flight work (C7/§14):** stage the 54 required untracked files (brand assets, generator, agent+admin features, tests, 4 migrations, new audit docs). Verify with `npx tsc --noEmit`, `npm run lint`, `npm run test:agent`, `npm run typecheck:agent`, and `npx tsx --test tests/branding-regression.test.ts`.
3. **Docs reorganization (§4/§8):** `git mv` the 52 audit docs + 2 screenshots + `PRODUCTION.md` (optional) + `docs/superpowers` plan + 7 test one-offs; fix the 2 screenshot references in `ADMIN-ACTIVE-PROJECT-UI-AUDIT-FINAL.md`; update `README.md` links if affected.
4. **Archive (§5):** `git mv workload/ docs/archive/workload/`, `git mv worklog.md docs/archive/`; optionally move `tests/*.png` to `docs/archive/screenshots/` instead of deleting.
5. **Delete from tracking + disk (§6):** `git rm -r` for `.e2e-fresh/`, `.e2e-install/` (after MR3), `launcher.obj` ×2, `build/config.gypi`, `native/test-capture-*.png`, `backups/`, `db/*.bak-*`, `.portal-e2e-results.json`, `falcon-*.json`, `globals.css.bak`, `.freebuff/worktrees/<uuid>`, `examples/websocket/` (if decided), `scripts/_*` debug files, `tests/*.png` (if not archived).
6. **Untrack-only:** `git rm --cached desktop-agent/native-host-bin/worklens-native-host.exe` (keep the file on disk).
7. **`.gitignore` update (§16.1)** + resolve MR3 (regenerate native-host manifests via `install-native-host.mjs`; verify Chrome/Edge/Firefox registration).
8. **Full verification (§21):** typecheck, lint, all tests, admin build, agent build + native-host build + package:agent, `prisma migrate deploy` on a throwaway DB, runtime smoke.
9. **Optional history rewrite (MR9):** after everything is green — `git filter-repo`/BFG to purge `.e2e-fresh`/`.e2e-install`; coordinate force-push.
10. **Optional lockfile consolidation (MR1/MR2):** last, after all else is green.

## 21. Estimated Disk / Repository Impact

| Metric | Before | After (working tree) | Notes |
|---|---|---|---|
| Tracked files | 4,163 | **~897** | removes 3,266 (3,143 + 75 + ~48) |
| Working-tree junk | ~671 MB (`.e2e-fresh` 386 M + `.e2e-install` 271 M + artifacts ~14 M) | **~0 MB** | all regenerable |
| Docs moved | 0 | **~55 moved** (52 audit + 2 screenshots + PRODUCTION.md optional) + 7 test one-offs | preserved, count unchanged |
| Files archived | 0 | **~116** (workload 108 + worklog + plans + optional screenshots) | preserved |
| Manual review | — | **~10 items** (MR1–MR10) | see §7 |
| **Git repository (pack) size** | ~392 MB | **unchanged ~392 MB** | deleting HEAD files does not shrink history — only a rewrite (MR9) reduces it |
| Git pack after optional rewrite | ~392 MB | **< ~20 MB (est.)** | `.e2e-fresh`/`.e2e-install` dominate the pack |

**Working tree vs repository:** the working tree shrinks by ~671 MB immediately; the git repo only shrinks via history rewrite (separate, optional, HIGH risk). This distinction is stated explicitly so no one expects pack-size reduction from file deletion alone.

## 22. Risk Assessment

| Action | Risk | Why | Mitigation |
|---|---|---|---|
| Delete `.e2e-fresh/` | LOW | browser profile; zero refs; regenerable; git-tracked (recoverable) | none beyond standard `git rm` |
| Delete `.e2e-install/` | MEDIUM | stale manifests point into it (MR3) | resolve MR3 first; re-verify bridge (`bridge-smoke.mjs`) |
| Delete artifacts (D3–D33) | LOW | tracked + regenerable | standard `git rm` |
| Move 52 docs | LOW | pure `git mv`; fix 2 screenshot refs | update refs in same commit |
| Archive workload/worklog | LOW | read-only history; zero refs | `git mv` |
| Commit 54 untracked files | LOW–MEDIUM | required for clone/build | review 4 new migrations + new API routes in review |
| Native-host manifest regeneration | MEDIUM | touches browser registration | test extension↔agent flow after |
| Lockfile consolidation | MEDIUM | affects installs | do last; verify `npm ci`/`bun install` |
| History rewrite | HIGH | force-push + history changes | optional; coordinate; do after green tree |

No step deletes anything that is not (a) tracked in git, (b) regenerable, or (c) explicitly decided in MR1–MR10.

## 23. Rollback Strategy

| Scenario | Rollback |
|---|---|
| Wrong file deleted (all tracked candidates D1–D33) | `git restore --source=HEAD -- <path>` — every delete candidate is in HEAD history |
| Docs moved incorrectly | `git mv` back (files unchanged, only paths) |
| Archived content needed | `git mv` back from `docs/archive/` |
| Brand assets committed but wrong | `git rm` + rerun `scripts/generate-brand-assets.mjs` |
| Migrations committed but rejected in review | revert the commit before applying; never reorder existing migrations |
| Native-host registration broken (MR3) | re-run `install-native-host.mjs --uninstall` + `--host …` |
| History rewrite went wrong (MR9) | keep a full backup clone + `git reflog`; abort = restore from backup ref |
| Cleanup commit itself | `git revert` the cleanup commit (all ops are additive to HEAD) |

Because the entire cleanup is a sequence of ordinary git operations on a dedicated branch, **every step is reversible**; the only non-trivial rollback is the optional history rewrite (backup clone required).

## 24. Final Safety Certification

Verified at the end of this pass:

- ✅ **No source code removed** — all `src/`, `desktop-agent/src/`, `browser-extension/src/`, `mini-services/` untouched
- ✅ **No active tests removed** — all `*.test.ts` in `tests/` and `desktop-agent/tests/` untouched
- ✅ **No Prisma migrations removed** — 21 active + 25 archived + 4 new (to commit) all intact; schema untouched
- ✅ **Canonical brand preserved** — `public/logos/omnisight.svg` untouched; favicon/icon chain preserved
- ✅ **Desktop-agent runtime assets preserved** — `assets/icon.ico`, `omnisight-mark.svg`, `notification.wav` intact
- ✅ **Active configuration preserved** — tsconfig/next/eslint/tailwind/postcss/components.json, Caddyfile untouched
- ✅ **Required scripts preserved** — every package.json-wired script + QA tooling (MR7/MR10 = review, not delete)
- ✅ **Lockfiles + env templates preserved** — `package-lock.json`, `bun.lock`, `.env.example`, `.env.production.example` untouched
- ✅ **Current documentation preserved** — `docs/company-guide/`, agent docs, `consent-management.md`, `README.md` untouched
- ✅ **Backward-compat identifiers preserved** — all L1–L13 (§13) untouched
- ✅ **All 54 required untracked implementation files preserved** — verified individually (§14)
- ✅ **No database/config/source modification performed** — no migrations run, no DB reset, no `.env` edit, no package install, no git-history rewrite, no destructive commands

**Audit/plan only. No files moved, deleted, renamed, or modified.**



