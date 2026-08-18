# OmniSight — Phase 0 Branding Discovery & Migration Map

**Date:** 2026-08-16 · **Scope:** entire repository (admin Next.js app, desktop Electron agent, native addon, native messaging host, browser extension, mini-services, tests, docs, scripts, configs)
**Method:** read-only full-repo scan, case-insensitive, variants: `worklensai`, `worklens`, `Work Lens`, `work-lens`, `work_lens` (all casing).

**Baseline counts (excludes node_modules/.next/dist/out/build/backups/.e2e-*):**
- Files containing old-brand strings: **274**
- Total occurrences: **928**

---

## 1. Logo / brand-asset status — DONE (canonical SVG received 2026-08-16; display-size pass 2026-08-16)

| Asset | Current | Status |
|---|---|---|
| `public/logos/omnisight.svg` | Official canonical OmniSight SVG (mark-only, verbatim, source of truth — transparent background, no `<rect>`, no forced bg) | **IN PLACE** |
| UI displays | The SVG itself is used directly everywhere (`<Image unoptimized object-contain>`): sidebar 64px expanded / 48px collapsed, mobile 48px, login + org-create 112px, loading 96px, agent renderer header 28px | IN PLACE — no raster, no tiny-icon containers, no `overflow-hidden` |
| `public/favicon.png` / `public/apple-touch-icon.png` | Mark raster (32px / 180px) — linked from layout.tsx metadata | Derived via `scripts/generate-brand-assets.mjs` |
| `desktop-agent/assets/icon.ico` | Mark .ico (16/24/32/48/64/128/256 PNG entries) — window icon, tray icon, electron-builder `win.icon` (installer / Start Menu / shortcut / exe) | IN PLACE, packaged + pixel-verified |
| `public/branding/` (old canonical + mark PNGs), `public/worklens-logo.png`, `public/logo.svg` | Superseded / old WorkLensAI artwork | **DELETED** — zero active references |

## 2. Inventory by area

### A. Admin application (`src/`) — ~95 occurrences, 13 user-facing surfaces
- **User-facing text (must change):** `layout.tsx` metadata (title/description/icon), `login-page.tsx` (h1 + footer), `create-organization-screen.tsx` (h1 + footer), `app-sidebar.tsx` (logo + name), `mobile-sidebar.tsx` (logo + name), `app/page.tsx` footer "© 2025 WorkLensAI v1.0.0", `loading.tsx` "Loading WorkLensAI…", `tour-steps.tsx` "Welcome to WorkLensAI! 👋", `settings-page.tsx` (3 strings incl. extension + server + branding line), `ai-provider-page.tsx` (2 strings incl. default system prompt placeholder), `daily-report.tsx` ("Powered by WorkLensAI intelligence engine" + generated-by footer), `consent.ts` (3 consent policy texts naming "WorkLensAI Desktop Agent"), PDF output: `pdf-generator.ts` (Creator/Producer/Title/logo text/subtitle), `api/reports/[id]/pdf` (title/subtitle/footer), 5× `api/reports/pdf/*` routes (`org?.name || 'WorkLensAI'` fallback), `api/reports/daily/ai-summary` (AI system prompt: "assistant for WorkLensAI"), `api/export/[type]` (downloaded filename `worklens-${type}-export`).
- **Code comments (product identity in headers):** ~40 files `// WorkLensAI — …` (lib/*, api/*). Low risk, bulk-updatable.
- **Technical identifiers (KEEP):** cookie `worklens_token` (auth.ts + mini-service; configurable via `SESSION_COOKIE_NAME`), localStorage `worklens-tour-completed` / `worklens-widget-layout` / `worklens-theme`, DOM events `worklens:add-employee` / `worklens:edit-employee`, `.worklens/` dev-key dir (crypto.ts), internal-process exclusion `worklensaiagent.exe` (agent-process.ts), policy self-protection list `worklensai-agent.exe`/`worklensai.exe` (policies/constants.ts), agent UA `WorkLensAgent/${agentVersion}` (authenticate route — stored telemetry).

### B. Desktop agent (`desktop-agent/`) — ~90 occurrences
- **Product identity (change):** `package.json` (name/description/author), `electron-builder.yml` (appId, productName "WorkLensAI Agent", copyright, executableName `WorkLensAIAgent`, shortcutName), renderer `index.html` (title/h1/onboarding/offline strings), `renderer.ts` (5 user-facing strings incl. "Sign in to WorkLensAI", "Unable to reach the WorkLensAI server", "no longer registered with the WorkLensAI server"), `main.ts` tray tooltip "WorkLensAI Agent", `agent-orchestrator.ts` + `auth-service.ts` (enrollment/lastError messages), `scripts/build-prod.mjs` (Setup-exe name filter), `scripts/dev.mjs`? (root), `scripts/e2e-live.sh`/`e2e-zero-touch.mjs`/`offline-soak.mjs` (headers + env var), `install-native-host.mjs` (description strings — but NOT host name), `tests/*` (user-facing message assertions — MUST be updated in lockstep with source strings), `native-host-manifests/*.json` (description fields only).
- **Technical identifiers (KEEP or lockstep):** `WORKLENSAI_SERVER_URL` env var (server-url.ts — production override; add `OMNISIGHT_SERVER_URL` alias w/ backward compat per Phase 11), `%APPDATA%\worklensai-agent` data dir (launcher.c APP_DATA_DIR, zt-b5-e2e.mjs), native addon `worklens_capture.node` (binding.gyp, native-bridge.ts, electron-builder extraResources, tests), native host binary `worklens-native-host.exe` + registry name `com.worklensai.website` (browser contract), Firefox extension id `website-tracker@worklens.ai` (browser contract), `worklensaiagent.exe` process-exclusion lists (internal-process.ts, policy-enforcer.ts) — **must gain the new exe name while KEEPING old entries** (already-installed agents + self-protection), Win32 window class `WorkLensAiKeyboardHost` (keyboard.cc), napi resource name `worklens.locationGetPosition` (location.cc), `worklens.example` test URLs (api-client.test.ts, server-url.test.ts).

### C. Native addon (`desktop-agent/native/`) — 8 occurrences
- All technical: package name `worklens-capture-native`, target `worklens_capture`, test scripts. **KEEP** (module name; not user-facing; renaming breaks `npm run rebuild-native` + packaged path).

### D. Browser extension (`browser-extension/`) — 15 occurrences
- **User-facing (change):** manifest `name` "WorkLensAI Website Tracker", `description`, native-messaging manifest descriptions (3), `background.js` header comment.
- **Technical (KEEP):** extension `key` (defines Chrome extension ID), gecko id `website-tracker@worklens.ai`, host name `com.worklensai.website`, package name `worklensai-website-tracker` (private/local — renameable, low risk).

### E. Mini-services (`mini-services/`) — 7 occurrences
- **User-facing log (change):** `index.ts:771` "⚡ WorkLensAI Live Updates WebSocket service".
- Comments (change): 5 headers. Technical (KEEP): `worklens_token` cookie default.

### F. Tests (`tests/`) — 22+ occurrences
- Header comments "WorkLensAI — …" (docs text; bulk-update).
- **Must KEEP (technical fixtures):** `agent-process-exclusion.test.ts`, `activities-hardening.test.ts` (`worklensaiagent.exe` exclusion assertions), `consent-lifecycle` window title fixture, `organization-bootstrap.test.ts` (`worklens_token` cookie), `live-monitor-event-stats.test.ts` (`WorkLensAI Agent` activity row fixture).
- Update in lockstep with source-string changes: orphan-recovery/renderer message assertions (agent tests).

### G. Prisma (`prisma/`) — 3 occurrences
- `schema.prisma` line 1 comment (change to OmniSight).
- `migration.sql` headers (20260810130000, 20260816160000) — **KEEP** (historical migration records, category 10).

### H. Docs & product guides (`docs/`, `README.md`, `PRODUCTION.md`, `workload/`, root audit MDs) — ~150 occurrences
- **Product docs (update):** `README.md`, `docs/company-guide/*` (00-overview, 02, 05, 08, 13, 15, 17, 18, 22, FEATURE-INVENTORY, README), `docs/agent-*.md`, `docs/consent-management.md`, `PRODUCTION.md`, `.env.example`, `.env.production.example`.
- **Historical records (KEEP per Phase 14):** `workload/*` (dated roadmap/progress/ADR docs), all `*-AUDIT.md` / `*-CERTIFICATION.md` / `*-DIAGNOSTIC.md` / `*-FINAL-IMPLEMENTATION.md` (dated historical records), `migration.sql` headers. Optionally add a note line "OmniSight was previously branded as WorkLensAI" in product docs.

### I. Scripts / configs (root) — ~60 occurrences
- Comments + `scripts/dev.mjs` console banner (change).
- **Technical (KEEP):** e2e scripts' `WORKLENSAI_SERVER_URL` usage, `admin@worklens.ai` test credentials (test-only), `worklens-tour-completed` localStorage, `WorkLensAIAgent.exe` taskkill/EXE_PATH references (lockstep with exe rename), `%APPDATA%\worklensai-agent` paths.

---

## 3. Classification summary (10 categories)

| Cat | Meaning | Occurrences | Action |
|---|---|---|---|
| 1 | User-facing branding | ~35 | **CHANGE** |
| 2 | Product/application identity | ~20 | **CHANGE** (appId, productName, exe name — pre-release safe) |
| 3 | Package/module identity | 6 | Rename private packages; **KEEP** `worklens_capture.node` |
| 4 | Technical identifier | ~30 | **KEEP**, document; add new exe name to exclusion lists |
| 5 | Database identifier | 0 | none branded (schema comment only) |
| 6 | API contract | 0 | none branded (routes/events/models unchanged) |
| 7 | Internal legacy identifier | ~15 | **KEEP** (cookie, localStorage, DOM events, host name, extension id, data dir) |
| 8 | Documentation/test text | ~180 | Update product docs + test headers; keep technical fixtures |
| 9 | Third-party reference | 0 | none |
| 10 | Historical/migration reference | ~25 | **KEEP** (audits, workload/, migration headers) |

## 4. Migration map (planned changes)

1. **Canonical constants:** no central brand config exists → add minimal `BRAND` constants module (or reuse existing patterns) for name/tagline/previous-name; avoid duplicating strings.
2. **Assets (BLOCKED on SVG):** `public/logo.svg` ← canonical SVG; `public/worklens-logo.png` → regenerate as `public/omnisight-logo.png` + update layout/sidebar/mobile refs; agent `.ico`/tray/window icons derived from SVG (electron-builder `win.icon`, BrowserWindow icon, Tray).
3. **Admin surfaces:** metadata, login, org-create, sidebar/header/mobile, loading, tour, footer, settings, AI provider page, daily report, consent texts, PDF generator + report routes, export filename, AI system prompt, `globals.css` token comments.
4. **Agent surfaces:** package.json, electron-builder (productName "OmniSight Agent", appId `com.omnisight.agent`, copyright, executableName `OmniSightAgent`, shortcutName), renderer strings, tray tooltip, orchestrator/auth messages, build-prod.mjs, manifests descriptions, install-native-host.mjs descriptions, e2e script headers.
5. **Lockstep renames:** `OmniSightAgent.exe` → add to `internal-process.ts` + `policy-enforcer.ts` + `agent-process.ts` exclusion lists (KEEP old names), update `zt-b5-e2e.mjs`/`login-item-test.js`/docs references.
6. **Env (Phase 11):** keep `WORKLENSAI_SERVER_URL`; add `OMNISIGHT_SERVER_URL` alias (resolution: new wins, old fallback, both documented).
7. **AI (Phase 13):** system prompt product name only (no behavior/prompt-structure change).
8. **Tests (Phase 15):** update message assertions in lockstep; add a branding regression test scanning user-facing surfaces (src strings, renderer, manifests, metadata) asserting zero unintended `WorkLensAI`; keep technical fixtures.
9. **Docs (Phase 14):** product docs + README + env examples; keep historical records; add one migration note.
10. **Verification (Phases 17–20):** tsc, eslint, admin build, agent build + typecheck, native rebuild, browser verification, agent runtime, logo verification.

## 5. Blockers / decisions needed

1. **Canonical OmniSight SVG — not provided.** All asset work (Phase 2, agent icons, favicon) is blocked. Execution rule: "Do not invent another logo."
2. Confirm exe rename `WorkLensAIAgent.exe` → `OmniSightAgent.exe` (recommended: yes, pre-release, with dual-name exclusion lists).
3. Confirm appId `com.worklensai.agent` → `com.omnisight.agent` (recommended: yes, pre-release).
4. Confirm env alias `OMNISIGHT_SERVER_URL` (recommended: yes, backward-compatible).
5. Scope of docs: update `docs/company-guide/*` + README; preserve `workload/*` and dated audit MDs verbatim (recommended).
---

## 6. Execution status (updated 2026-08-16)

**Decisions confirmed by owner:** exe rename to `OmniSightAgent.exe` (dual-name exclusions), appId `com.omnisight.agent` + package `omnisight-agent`, env alias `OMNISIGHT_SERVER_URL` (primary, legacy fallback), canonical SVG to be provided by owner (still outstanding).

**Completed phases:**
1. **Constants:** `src/lib/brand.ts` (name OmniSight, previousName WorkLensAI, tagline, agentName) + `desktop-agent/src/lib/brand.ts`.
2. **Admin surfaces:** layout metadata, login-page h1+tagline+footer, create-organization-screen, app-sidebar + mobile-sidebar (alt/name; image refs pending asset swap), page.tsx footer, loading, tour-steps, consent.ts (3 texts), settings-page (3), ai-provider-page (2), daily-report (2), pdf-generator (Creator/Producer/Title/logo/footer x2 blocks), 6 PDF routes (org fallback + [id] html), export filename `omnisight-${type}-export`, ai-summary system prompt, globals.css tokens, ~24 file-header comments (src/lib, proxy, api).
3. **Agent identity:** package.json (name omnisight-agent/description/author), package-lock (2 name fields), electron-builder.yml (appId/productName/copyright/executableName/shortcutName/signtool comments), renderer index.html (title/h1/onboarding/offline), renderer.ts (5 strings + header), main.ts tray tooltip, auth-service + orchestrator messages, policy-resolution/types/api/client/domain/native-host header prose.
4. **userData pin (safety):** `app.setPath('userData', %APPDATA%\worklensai-agent)` added in main.ts before any path use — Electron would otherwise derive userData from the new productName and silently orphan credentials/queue/bridge path on upgrade.
5. **EXE lockstep:** `omnisightagent.exe` added to internal-process.ts + agent-process.ts; `omnisight-agent.exe`/`omnisight.exe` added to policy-enforcer.ts + policies/constants.ts (all legacy names kept); build-prod.mjs Setup regex; zt-b5-e2e.mjs (EXE default + dual taskkill); clean-machine-certification.ps1 (installer path/install dir/shortcut/env var OMNISIGHT_SERVER_URL); login-item-test.js regex; launcher.c comments.
6. **Env:** server-url.ts resolution = OMNISIGHT_SERVER_URL -> WORKLENSAI_SERVER_URL -> default; .env.example + .env.production.example headers + new var documented (legacy kept).
7. **Banners/comments:** dev.mjs, reset-database.ts, mini-service index banner + 3 headers, schema.prisma header.
8. **Extension:** manifest name/description only (key + gecko id + host name kept); native-host manifests descriptions; native/package.json description.
9. **Docs:** company-guide (9 files, 19 replacements + rebrand note), root docs (9 files, 19 replacements: README, PRODUCTION, agent-*.md x4, clean-machine-certification, ai-provider-audit, consent-management).
10. **Tests:** server-url.test.ts extended (SRV-13..17: primary/legacy/precedence/fallback); zero-control-renderer + orphan-recovery assertions updated; new `tests/branding-regression.test.ts` (BRAND-1..6) scanning user-facing surfaces + technical contracts + brand assets.
11. **Assets (Phase 2, unblocked 2026-08-16; size pass 2026-08-16; agent-logo pass 2026-08-16):** canonical SVG → `public/logos/omnisight.svg` (mark-only, verbatim); favicon + apple-touch + agent `.ico` derived by `scripts/generate-brand-assets.mjs` (SVG used directly in all UI — no mark-PNG duplicates); admin surfaces enlarged (sidebar 64/48px + text-lg, mobile 48px, login/org-create 112px, loading 96px, `object-contain` + `shrink-0`, no box containers, no forced backgrounds); agent window/tray/installer icons wired (`main.ts` APP_ICON, `electron-builder.yml win.icon`, `files: assets/icon.ico`); renderer header logo uses the SVG + copy-assets; old artwork + `public/branding/` deleted; BRAND-7 size regression added. **Agent-logo pass:** root cause = 500×500 canvas whitespace (28px render → ~14×9px visible mark, same as favicon); agent header now uses `omnisight-mark.svg` (tight-crop presentation derivative, `viewBox 110 110 280 280`, generated by the script — same artwork, only the viewBox differs; canonical never edited); responsive sizing `clamp(44px, 13vw, 64px)` + `aspect-ratio 1/1` + `object-fit contain` + `flex: none`, no bg/border/rounding; agent `icon.ico` + exe/tray entries regenerated from the tight crop (mark fills 88–94% of each size vs ~50% before); `copy-assets.mjs` rebuilds `dist/renderer` from scratch so stale brand files can never ship (build order changed to copy-assets → tsc); BRAND-8 contract test added.

**Verification results (all green):**
- `tests/branding-regression.test.ts` 8/8 (BRAND-1..8; BRAND-8 covers agent derivative + clamp sizing, agent mark pixel-fill 91% @64px, ico entries 88–94% vs ~50% pre-fix); `server-url.test.ts` 17/17; zero-control-renderer 5/5 (after `npm run build`); orphan-recovery + activity-collector-internal-process + consent-lifecycle + policy-resolution all pass.
- Admin: agent-process-exclusion + activities-hardening + live-monitor-event-stats 44/44.
- Agent full suite: **393/393 pass, 0 fail** (387 + BRAND-8 additions).
- `tsc --noEmit` clean; eslint on touched files: zero problems; `next build` OK (112 pages; 3 pre-existing turbopack tracing warnings).
- Runtime: app :3000 200, mini-service :3010 socket.io handshake 200; packaged `out/win-unpacked/OmniSightAgent.exe` launches and stays alive (single-instance lock verified), `app.asar` contains only `dist/renderer/{index.html, omnisight-mark.svg, renderer.js, styles.css}` + `assets/icon.ico` (byte-identical to regenerated source, 7 entries).

**Remaining:** none — all 22 phases complete. The canonical SVG was received and every asset variant was derived from it (see section 1).
