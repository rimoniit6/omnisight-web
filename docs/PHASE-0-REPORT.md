# PHASE 0 REPORT — EXISTING SYSTEM STABILIZATION

**Status: GREEN** — every Phase 0 definition-of-done item verified with an actual run on 2026-09-03.
**Repos:** `omnisight-web` (this repo) and `omnisight-agent` (sibling checkout).
**Evidence logs:** `phase0-verify.log`, `fullsuite-{1..5}.log`, `build-verify.log`, `typecheck-verify.log`, `lint-verify.log`, `audio-rerun*.log`, `/tmp/agent-*.log` (kept in the repo root for re-inspection).

---

## 1. Summary

The Phase 0 blockers identified in `docs/V1-FORENSIC-AUDIT.md` are resolved:

1. The shared test `req()` helper no longer constructs `GET` requests carrying a body (Next 16/undici spec enforcement). 28+ suites migrated to one canonical helper; a dedicated regression suite proves the property.
2. All 13 stale/broken web suites from the audit now pass.
3. The two open adjudications (unauth device rediscovery semantics; schema-drift test expectations) were decided deliberately and aligned (route unchanged, tests + docs updated).
4. No hardcoded administrator password remains anywhere in tracked source.
5. Corrupted `.next/dev/types` can no longer block `typecheck`/`build` (clean step wired into both scripts and CI).
6. Lockfile authority is canonical (bun); all three misleading `package-lock.json` stubs removed (repo root, nested `mini-services/live-updates`, and the parent-dir stub outside the repo).
7. Product-source lint: **0 errors** (439 warnings); `.claude/` explicitly excluded.
8. One additional pre-existing flake found and fixed: `tests/audio.test.ts` crashed the `node:test` runner IPC ~33% of the time (`Unable to deserialize cloned data`); root cause = `console.log` noise racing the runner at exit. Log lines removed (assertions unchanged); 10/10 stable after the fix.
9. CI (` .github/workflows/ci.yml`) now reproduces the full web gate: clean types → typecheck → lint → build → boot server → full suite.

Regression gate results (this working tree):

| Gate | Command | Result |
|---|---|---|
| Web lint | `npm run lint` | PASS — 0 errors, 439 warnings |
| Web typecheck | `npm run typecheck` | PASS (includes `clean-next-types`) |
| Web production build | `npm run build` | PASS |
| Web test suite (96 files) | per-file `node --import tsx --test tests/<file>.test.ts` (the exact command `scripts/run-tests.mjs` spawns) | **96/96 suites pass** — 1561 subtests pass, 0 fail |
| Request-helper guard | `tests/request-helper.test.ts` | PASS 7/7 |
| Agent typecheck | `npm run typecheck` | PASS |
| Agent tests | `npm test` | PASS 625/625 |
| Agent build | `npm run build` | PASS |

---

## 2. Files changed (this working tree, uncommitted)

### Test-harness fix (GET+body)
- `tests/helpers/request.ts` — **new** canonical `req()` helper. Semantics: `body` + no `method` → POST; no `body` + no `method` → GET; explicit `method` always wins. Public signature unchanged.
- `tests/request-helper.test.ts` — **new** regression guard (RH-1..RH-7), including a static scan proving no migrated suite still contains the old `method: opts.method || 'GET'` default.
- 28+ suites migrated to `import { req } from './helpers/request'` and had their per-file broken helper removed (`agent-hardening`, `telemetry-backend`, `screenshots`, `claim-cancel`, `agent-active-device-backend`, `super-admin`, `super-admin-organizations`, `agent-discover`, `agent-existing-device-security`, `rbac-hardening`, `hardening`, `projects*`, `presence-hardening`, `multi-org-isolation`, `security*`, etc. — see full `git status` list).

### Stale-test corrections
- `tests/admin-prod-sidebar.test.ts` — NAV-1 allowed-role list now includes `super_admin` (valid `NavMinRole` used by the nav implementation).
- `tests/role-rbac-nav-fix.test.ts` — ROLE-20 replaced prose-comment assertion with a stable behavioral assertion: super-admin pages pinned to exactly `super_admin` in `PAGE_MIN_ROLE`; `org_admin`/`admin`/`manager`/`viewer` denied via `canAccessPage`.
- `tests/branding-regression.test.ts` — BRAND-6 legacy `/branding/` check narrowed from a bare substring to real asset-reference shapes (`src=`, `href=`, `fetch('...')`), excluding the legitimate component import path; legacy artwork checks unchanged.
- `tests/rbac-hardening.test.ts` — self-seeds its own super admin + org users with clearly test-only credentials in `before`; no dependency on a seeded dev database or hardcoded admin password.
- `tests/agent-discover.test.ts` — updated to the current schema (post-`20260828000000_remove_agent_registration`): authenticated discovery through `AgentAccount`/`AgentSession`; cross-org/cross-employee denial asserted as uniform 404; concurrent races via authenticated flow. No removed schema reintroduced.
- `tests/super-admin-organizations.test.ts` — restore step made idempotent and collision-safe (uses full CUIDs in test-org slugs); the actual organization-isolation assertion (SA-ORG-06) is unchanged and passes.
- `tests/agent-existing-device-security.test.ts` — see Security decision below.
- `tests/audio.test.ts` — removed pure `console.log` progress noise (13 in-test lines + 1 trailing top-level log) that intermittently crashed the `node:test` runner IPC. All assertions preserved.

### Framework-mismatch resolution
- `tests/sound-live-monitor-browser.test.ts` — **deleted** (obsolete orphan: Jest globals + raw `playwright` import, no runner).
- `tests/e2e/live-monitor-sound.spec.ts` — **new** Playwright conversion using `@playwright/test` + the shared `tests/e2e/fixtures.ts`; wired via existing `npm run test:e2e` (`playwright test`).
- `package.json` — `test:e2e` script restored.

### Build / typecheck hardening
- `scripts/clean-next-types.mjs` — **new**: removes stale generated `.next/dev/types` (and `.next-audit/dev/types`) that a crashed `next dev` can leave truncated (TS1128).
- `package.json` — `clean:types`, `typecheck` (`clean + tsc --noEmit`), `test` (`scripts/run-tests.mjs`), `test:e2e` scripts added; `build` now runs the clean step before `next build`.
- `scripts/run-tests.mjs` — **new** cross-platform per-file runner (glob expansion + `--import tsx --test`), non-zero exit on any suite failure.

### Lockfile canonicalization (bun)
- `bun.lock` — committed, authoritative (root + `mini-services/live-updates/bun.lock`).
- `package-lock.json` (repo root) — **deleted** (was an 88-byte stub).
- `mini-services/live-updates/package-lock.json` — **deleted** (second, conflicting npm lock in a bun-run service).
- Parent-dir `E:\Live project\omnisight\package-lock.json` — confirmed already removed (88-byte stub no longer exists).
- `.gitignore` — ignores `package-lock.json`; comments document bun as the canonical manager.
- `.github/workflows/ci.yml` — switched to `oven-sh/setup-bun` + `bun install --frozen-lockfile`; env (`SUPER_ADMIN_EMAIL/PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`) are CI-only test values.

### Lint
- `eslint.config.mjs` — `.claude/**` explicitly ignored (repo-local Claude Code helper hooks, not product source). Product source: 0 errors.

### Credential hygiene
- `tests/rbac-runtime-verification.mjs` — manual RBAC probe now reads credentials from env (`SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD`, `ORG_*_EMAIL/ORG_*_PASSWORD`) with clearly fake fallbacks; the real-looking `rimon@admin.com`/`Rimon2714` literals removed.
- `scripts/capture-docs-screenshots.mjs` — super-admin login for docs capture now reads `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD` from env, falling back to the gitignored `.env`; the embedded dev password literal removed.
- Verified: `grep -rniE "Rimon2714|Rimon0000000"` over `tests/ src/ scripts/` → clean.

### Docs
- `docs/V1-IMPLEMENTATION-BASELINE.md` — forensic baseline (written pre-change; verified accurate during this phase).
- `docs/V1-IMPLEMENTATION-PLAN.md`, `docs/V1-FORENSIC-AUDIT.md` — planning/audit artifacts.

---

## 3. Root causes and fixes

| # | Root cause | Fix |
|---|---|---|
| 1 | `req()` helpers defaulted `method: opts.method || 'GET'`; Next 16/undici throw on `GET`+`body` | Canonical helper defaults to POST when a body exists; explicit method wins (`tests/helpers/request.ts`) |
| 2 | Stale expectations (role list, prose comments, legacy asset check) | Behavioral/stale assertions updated to current source |
| 3 | `rbac-hardening` used a hardcoded dev bootstrap password | Self-seeding test users with fabricated credentials |
| 4 | Tests queried pre-`remove_agent_registration` schema | Rewritten to the current authenticated-discover model |
| 5 | Restore-step slug collisions in SA-ORG-06 | Idempotent restore with collision-safe unique slugs |
| 6 | Orphan suite mixing Jest + Playwright with no runner | Converted to `tests/e2e/live-monitor-sound.spec.ts` (Playwright) |
| 7 | `.next/dev/types/validator.ts` truncated by a crashed dev server broke `tsc`/`next build` | `clean-next-types.mjs` wired into `typecheck` + `build` + CI |
| 8 | 88-byte `package-lock.json` stub vs real `bun.lock`; split authority incl. nested mini-service | bun canonical; stub locks deleted; `.gitignore` + CI + docs aligned |
| 9 | 8 ESLint errors under `.claude/helpers/*.cjs` | `.claude/**` explicitly ignored; product source has 0 errors |
| 10 | `audio.test.ts` ~33% runner crash (`Unable to deserialize cloned data`) | Removed `console.log` noise racing `node:test` IPC at exit — 10/10 stable after fix (this run's environment: Node v24.14.0) |

---

## 4. Security behavior decision — unauthenticated device rediscovery

**Adjudicated: keep the route as-is; do NOT return 404 for a brand-new anonymous registration.**

Decision (documented in `src/app/api/agent/discover/route.ts` header, `docs/V1-IMPLEMENTATION-BASELINE.md` §2, and enforced by the aligned tests):

- A brand-new device with **no session and no existing identity** gets **422 `AUTHENTICATION_REQUIRED`** (registration requires an employee sign-in). Rationale: 401 would be misinterpreted by agents as "token expired → re-auth loop"; the registration endpoint discloses nothing about other tenants (the caller is asking about *its own* new device), so concealment buys nothing; a distinct explicit code is the least-ambiguous client contract. This matches the pre-existing architecture (anonymous device creation was removed in an earlier milestone) and the audit's "Option A" intent.
- An **existing device** reached by a session that does not own it (cross-org, cross-employee, deleted) returns a **uniform concealing 404** `{ error: 'Device not found' }` — never an ID, claim state, or ownership hint (rules B/C; `DENIED` sentinel mapped to 404). Unauthenticated *re-discovery of an existing device* falls back to the device-key identity path for old agents polling a claim (no mutation, no secret re-issue) — preserved for backward compatibility.
- Tests updated to assert the actual contract (AUTH-EXIST-09/17b/25, agent-discover SEC-1..4, CONC-1), including "no mutation by an expired session" and "one owner, one 404, no duplicate claim" concurrency.
- The route was **not** modified to make tests pass.

---

## 5. Tests executed (exact commands and results)

Web suite run method: `node --import tsx --test tests/<file>.test.ts` per file (identical to what `scripts/run-tests.mjs` spawns), against the booted dev server (`:3000`) and throwaway per-suite Postgres DBs (`scripts/pg-test-db.mjs`).

- 13 audit-failing suites, re-run after fixes (`phase0-verify.log`): `agent-hardening`, `telemetry-backend`, `screenshots`, `claim-cancel`, `agent-active-device-backend`, `super-admin`, `admin-prod-sidebar`, `role-rbac-nav-fix`, `branding-regression`, `rbac-hardening`, `agent-discover`, `agent-existing-device-security`, `super-admin-organizations` → **all exit 0**.
- Full suite, 96 files in 5 sequential chunks (`fullsuite-1..5.log`): **1561 subtests pass, 0 fail** across 96/96 suites. (The single runner-level audio flake observed mid-run is the fixed item #10; post-fix `audio.test.ts` passes 10/10 and `request-helper.test.ts` passes 7/7.)
- Web gates: `npm run lint` → 0 errors / 439 warnings; `npm run typecheck` → exit 0; `npm run build` → exit 0 (route table emitted; build includes the type clean).
- Agent (`omnisight-agent`): `npm run typecheck` → exit 0; `npm test` → **625 pass / 0 fail**; `npm run build` → exit 0.

Playwright E2E (`tests/e2e/*.spec.ts`) is wired to `npm run test:e2e` but was **not** executed in this phase (requires browser install + full app boot; not part of the Phase 0 gate, which the audit scoped to unit/integration).

---

## 6. Remaining warnings / risks

- **439 lint warnings** (unused vars, `any`-adjacent) under product source — tracked separately, not errors. No warning blocks the gate.
- **Node test-runner IPC fragility**: the audio flake was one instance of `node:test`'s serialization channel being sensitive to high-volume console output near process exit. The suite no longer triggers it; other suites print little to nothing. If new suites add heavy top-level `console.log`, prefer assertions over progress logging.
- **Playwright E2E not run in this phase** (see above). `live-monitor-sound.spec.ts` is wired but unexecuted here.
- `.claude/`, `install.ps1`, `.mcp.json`, `.ignore` are untracked local/tooling artifacts — not part of the deployable bundle.
- 58+ files are modified/untracked in the working tree and **uncommitted**; the green state above is the working tree, not `HEAD`.

---

## 7. Rollback instructions

The full phase is a working-tree diff on top of `HEAD` (`c30e818`); nothing is committed.

1. **Discard everything:** `git checkout -- . && git clean -fd` in `omnisight-web` (restores `package-lock.json`, `tests/sound-live-monitor-browser.test.ts`, old test helpers; removes new scripts/helpers/docs). This returns the repo to the audit's pre-Phase-0 state (red baseline).
2. **Selective rollback:**
   - Helper behavior: revert `tests/helpers/request.ts` + suite migrations (test baseline breaks again — not recommended).
   - Clean-types step: remove `clean:types` from the `typecheck`/`build` scripts; delete `scripts/clean-next-types.mjs` (watch for stale `.next/dev/types`).
   - Lockfile: `git checkout -- package-lock.json mini-services/live-updates/package-lock.json` and drop the `.gitignore` bun note (restores dual authority — not recommended).
   - ESLint: remove the `.claude/**` ignore from `eslint.config.mjs` (8 errors return).
   - Credential hygiene: `git checkout -- tests/rbac-runtime-verification.mjs scripts/capture-docs-screenshots.mjs` (restores embedded dev credentials — not recommended).
   - Audio fix: `git checkout -- tests/audio.test.ts` (flake returns).
3. **CI:** no rollback needed — `ci.yml` is only exercised on push; reverting it restores the old npm-based workflow.
4. No database migrations were run in Phase 0; there is no data to roll back.
5. To re-verify after any rollback, run the web gate (clean types → typecheck → lint → build → boot dev server → full suite) and the agent gate (typecheck → tests → build) per §5.
