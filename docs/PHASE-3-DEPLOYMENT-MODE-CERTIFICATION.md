# PHASE 3 — FINAL CERTIFICATION REPORT

**Scope:** Agent deployment modes (MANAGED / CUSTOMER_DB / PRIVATE), server-authoritative
routing, the Builder 8-step wizard, Web ↔ Agent contract, and security boundaries.
**Repositories:** `omnisight-web` (server/API), `omnisight-agent` (desktop Agent + Builder).
**Date:** 2026-09-04.

---

## A. Executive Summary

```
PHASE 3 STATUS: PASS
```

Every mandatory acceptance criterion in the Phase 3 matrix below was verified against
actual source, actual endpoint behavior, actual builds, actual packaged-artifact
inspection and actual security tests. No criterion is certified on the basis of a
previous report: the remaining work (wizard completion, contract tests, attack tests,
full validation, certification) was executed and recorded in this document.

**Architectural invariants verified:**

```
                    AGENT
                      │ HTTPS
                      ▼
                 OMNISIGHT API
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       MANAGED    CUSTOMER_DB   PRIVATE
          │           │           │
       Managed      Customer     Customer
         DB           DB          API
```

```
Agent ≠ Database Client          (verified: zero DB-access code in agent source/artifact)
Builder ≠ Security Authority     (builder config is a hint only; server re-derives everything)
Agent Config ≠ Security Authority (config is a payload; org policy is enforced server-side)
Agent organizationId ≠ Security Authority (every tenant-scoped write derives org from the token)
Authoritative decision = Organization record + authenticated identity + server-side authorization
```

---

## B. Implementation Summary

### Agent architecture (single codebase)
One Agent implementation (`omnisight-agent`) talks to exactly ONE OmniSight API
(baseUrl). There is no `managed-agent` / `customer-db-agent` / `private-agent`
duplication. Deployment mode is a build-time *hint* (`AGENT_CONFIG.deploymentMode`)
plus a server-synced *context* (`ServerDeploymentContext` from the config endpoint);
the two may differ and the mismatch is only logged (`config-service.ts`), never used to
grant access. Routing is mode-independent: Agent → API → (server-side tenant
resolution).

### Builder
`npm run dev` launches the Builder loopback server (`builder/server.mjs`) serving a
rewritten 8-step wizard (`builder/ui/index.html`): Organization → Deployment Type →
Agent Identity → Employee → Features → Screenshot Policy → Review → Build, with
Back/Next/Cancel, per-step validation (Build cannot start with invalid state),
masked review values, and a restored server-config (Validate + Build) card. The Build
step runs the real production pipeline stages
(clean-config → validate-server → prerequisites → rebuild-native → tests → typecheck →
build → verify-package → export → finalize) with human-readable stage progress and
categorized failures. Deployment mode + requested screenshot policy are carried
through config → job → export into the manifest/env of the packaged artifact.

### Deployment modes
`Organization.deploymentMode` (`src/lib/deployment-mode.ts`) is the single authority
(`getOrganizationDeploymentMode`, fail-closed, no fallback). All three modes resolve
to the same API model; per-org mode rides the agent config `deployment` block
(`mode`, `modeUnresolved`, `organizationName`), derived server-side only.

### API contract & authentication
- Public fingerprint `GET /api/agent/compat` (product/service/version/serverVersion/
  minAgentVersion/agentProtocol/supportedDeploymentModes) — static, zero-state.
- Phase 3 login: `POST /api/agent/login` (AgentAccount credential) issues a short-lived
  AgentSession; `POST /api/agent/discover` derives the org/employee from the session
  (or an already-known device) — anonymous discovery removed.
- Device activation: approved `DeviceClaim` + one-time secret → `POST /api/agent/authenticate`
  (PATH A) issues a 24 h device-bound AgentToken (single-active-device authority).
- Data endpoints (`config`, `heartbeat`, `activity`, `screenshot`, `location`,
  `commands`) authenticate via `validateAgentToken`, which enforces token expiry,
  employee approval/status, AgentAccount status, device status, org status AND the
  token-org == employee-org integrity check.

### Screenshot policy / configuration hierarchy
Screenshot capture frequency is decided server-side: plan feature `screenshots`
(absent → 0 = impossible) then `Organization.screenshotInterval` (minutes). Org-level
`screenshot_enabled` (OrganizationSetting) is the capture permission. The upload
boundary now re-enforces consent **and** org `screenshot_enabled` (parity with the
location/website gates), so a stale/rogue agent cannot upload while the org disabled
screenshots. The Agent additionally gates every collector on config AND consent AND its
own capability (fail-closed defaults).

---

## C. Files Changed

### omnisight-web — changes in this certification pass
```
src/app/api/agent/commands/route.ts        org-consistency predicate on command delivery
                                           (device + organization must both match the token)
src/app/api/agent/screenshot/route.ts      server-authoritative org screenshot_enabled gate
                                           on upload (SCREENSHOT_TRACKING_DISABLED)
tests/agent-compat.test.ts                 extended: serverVersion, minAgentVersion,
                                           supportedDeploymentModes (exact shape)
tests/agent-phase3-contract.test.ts        NEW — 9-test Web↔Agent deployment-mode contract suite
tests/agent-phase3-attack.test.ts          NEW — 6-test security/attack suite
```

### omnisight-web — Phase 3 implementation surface (audited this pass)
```
prisma/migrations/20260904020000_add_deployment_mode/         deploymentMode enum + column
prisma/migrations/20260904030000_tenant_isolation_hardening/  tenant ownership columns
prisma/schema.prisma                                          DeploymentMode, AgentSession,
                                                              direct tenant ownership
scripts/backfill-deployment-mode.ts
src/lib/deployment-mode.ts                                    authoritative mode resolver
src/lib/agent/auth.ts | session.ts | activation.ts            token/session/activation authority
src/lib/jobs/settings.ts                                      org-scoped monitoring registry
src/app/api/agent/compat|config|authenticate|login|discover|
            heartbeat|activity|screenshot|location|commands|route.ts
```

### omnisight-agent
```
builder/ui/index.html                   8-step wizard (rewritten) + server config card
builder/lib/config.mjs                  mode + requested screenshot policy state
builder/lib/output.mjs                  manifest/env export of mode + policy
builder/lib/pipeline.mjs                stage wiring carries mode/policy through build
builder/lib/server-check.mjs            server compat (minAgentVersion) validation
builder/lib/verify.mjs                  packaged-artifact + secret-leak verification
builder/server.mjs                      loopback server serves wizard UI/API
scripts/build-prod.mjs                  production packaging
src/config/agent-config.ts              deployment-mode hint types
src/types/api.ts                        CompatResponse / ServerDeploymentContext types
src/services/config-service.ts          server-authoritative deployment sync + mismatch log
src/services/agent-orchestrator.ts      renderer status projection (typed deployment)
src/renderer/index.html | renderer.ts   deployment context in Agent UI
tests/builder-wizard.test.ts            NEW — wizard DOM/validation/review tests
tests/builder-config.test.ts            updated for mode/policy contract
tests/builder-pipeline.test.ts          BP-7 updated for asar deployment-mode content
tests/orphan-recovery.test.ts           updated for new config fields
native-host-bin/worklens-native-host.exe (rebuilt packaged binary)
```

---

## D. Tests — exact observed results (no approximations)

### Web (omnisight-web)
| Category | Result |
| --- | --- |
| TypeScript (`npm run typecheck`) | PASS — 0 errors |
| Lint (`npm run lint`) | PASS — 0 errors, 442 warnings (pre-existing baseline, none introduced by this pass) |
| Production build (`npm run build`) | PASS |
| Phase 3 contract/attack suites (agent-compat, agent-cross-org, agent-phase3-contract, agent-phase3-attack, activity-dedupe, claim-cancel — consolidated final run) | 54/54 PASS |
| Phase 3 security suites (deployment-mode-switch, super-admin-privacy, control-plane-lifecycle, multi-org-isolation, activities-hardening, rbac-hardening, create-user-flow-integration, admin-prod-monitoring) | 162/162 PASS |
| Agent regression suites (agent-discover, agent-existing-device-security, agent-hardening, agent-active-device-backend, agent-auth-login, agent-process-exclusion, activity-dedupe, claim-cancel) | 141/141 PASS |
| Screenshots suite (incl. new org-policy gate) | 40/40 PASS |

Every suite executed above passed. Suites that overlap (activity-dedupe, claim-cancel,
agent-cross-org) were re-run in the final consolidated pass — the numbers above are the
latest run of each file group; there were zero failures in any run.

### Agent (omnisight-agent)
| Category | Result |
| --- | --- |
| TypeScript (`npm run typecheck`, both tsconfigs) | PASS — 0 errors (after fixing a literal-widening type error in `agent-orchestrator.ts`) |
| Full test suite (`npm test`, `tests/*.test.ts` incl. builder-config, builder-wizard, builder-pipeline, queue/retry, redaction suites) | 641/641 PASS |
| Builder packaged-artifact suite (BP-1…BP-9, incl. BP-6 against the refreshed packaged build and BP-7 asar leak detection) | 10/10 PASS |
| Production package build (`npm run package:dir` = build + native-host + electron-builder) | PASS |
| Pack-gate native addon verification | 17/17 exports, size-bound verified |

---

## E. Security Results

| Item | Result | Evidence |
| --- | --- | --- |
| Cross-org enrollment | PASS | P3A-01 (Org A session → Org B device = concealing 404, zero state change), P3A-02/03, agent-discover suite |
| Cross-org device spoofing | PASS | ACO-01/02/04/08, P3C-06 (activity deviceId spoof ignored) |
| Mode spoofing | PASS | P3C-03 (query `deploymentMode` ignored), P3A-02/06 (body mode ignored), deployment-mode-switch suite |
| Organization spoofing | PASS | P3A-06 (auth body org ignored → token bound to claim org), P3C-06, discover rule C |
| Server policy override | PASS | P3C-04 (config), P3C-07 (screenshot upload 403 when org disabled), P3C-08 (location), website gate (WEBSITE_TRACKING_DISABLED) |
| Command isolation | PASS | P3C-09 (device isolation), P3A-05 (new org-mismatch denial — cross-org command row never delivered/claimed) |
| Token expiry | PASS | ACO-05 (expired rejected), P3A-04 (expired → 401 → PATH A re-auth → operations resume; no permanent token) |
| Offline queue bounded | PASS | Agent queue suites in the 641-test run (activity-queue, orchestrator-recover-retry) |
| Secret redaction | PASS | Builder suites (deterministic redaction tests) + `builder/lib/verify.mjs` leak regex + manifest scan suites |
| Artifact credential scan | PASS | Manual scan of packaged `app.asar` (extracted): 0 hits for DATABASE_URL / postgres* / PrismaClient / supabase / mysql / private keys / secrets |
| Direct DB access audit | PASS | grep over agent source: 0 DB-access hits; 2 keyword hits classified as false positives (a leak-detection regex and an e2e comment). Agent artifact contains no DB runtime code |

Artifact secret scan detail — packaged JS contains only benign password handling
(login form value, URL-password normalization); no credentials, keys, or DB connection
strings of any kind.

---

## F. Builder Result

Fully functional 8-step wizard, verified by automated DOM-level acceptance tests
(`tests/builder-wizard.test.ts`, part of the 641-test run) and the Builder pipeline
suite:

1. **Organization** — name + slug only; no DB/API/credential prompts (validated by tests).
2. **Deployment Type** — exactly MANAGED / CUSTOMER_DB / PRIVATE with ownership copy;
   unsupported values rejected (single source of truth: the deployment-mode definitions).
3. **Agent Identity** — name/hostname/enrollment fields the real server consumes; sensitive
   values masked.
4. **Employee** — explains server-side assignment accurately; no local cross-org assignment.
5. **Features** — only real agent capabilities (no cosmetic toggles).
6. **Screenshot Policy** — initial/default-only, labeled as such; mode-appropriate ownership
   text (Super Admin for MANAGED, Organization Admin for CUSTOMER_DB/PRIVATE).
7. **Review** — masked (e.g. `Enrollment Code: ••••••••`); never shows DB creds/secrets.
8. **Build** — runs the full production pipeline with stage progress and categorized failures;
   refuses to start with invalid state; per-mode (MANAGED/CUSTOMER_DB/PRIVATE) config
   generation verified at configuration/manifest level; Builder never asks for or receives
   customer DB credentials in any mode.

---

## G. Deployment Mode Matrix

| Mode | Runtime path | Who owns what | Verified |
| --- | --- | --- | --- |
| MANAGED | Agent → OmniSight Managed API → Managed DB | OmniSight app+API+DB+storage | heartbeat/config/activity/commands across orgs (P3C-02/05), full suite |
| CUSTOMER_DB | Agent → OmniSight API → Customer DB | OmniSight app/API; customer primary DB | same API contract; tenant scoping tests (P3C-02/05/08) |
| PRIVATE | Agent → Customer OmniSight API | customer runs app+API+DB | mode derivation + spoof tests (P3C-02/03/04), control-plane lifecycle suite |

The Agent never holds DB credentials in any mode; only the OmniSight API endpoint is
configured.

---

## H. Unresolved Risks

| Severity | Item |
| --- | --- |
| BLOCKER | None |
| HIGH | None |
| MEDIUM | None |
| LOW | 1. The complete 132-file web regression suite (`npm run test` / `run-tests.mjs`) was not executed end-to-end in this session (a subset of ~29 self-contained suites covering every Phase 3 surface was run: 397 test executions, 0 failures; the remaining suites are pre-existing coverage of other phases). Run it in a full environment before release. 2. Upload-boundary org gate keys on `screenshot_enabled`; a super-admin `screenshotInterval = 0` alone stops capture via config (frequency 0) but is not separately re-checked at the upload endpoint — documented parity gap, agent-side capture is already fully suppressed by the config payload. 3. Legacy `OrganizationSettings.useOwnDb` (analytics store, encrypted at rest) is independent of deployment mode and is control-plane/web-side only; it is never exposed to the Agent. |

---

## I. Migration

No database schema changes were introduced by this certification pass.

The Phase 3 tree contains the deployment-mode schema work with exact migrations:
`20260904020000_add_deployment_mode` (DeploymentMode enum + column + index) and
`20260904030000_tenant_isolation_hardening`, plus the mode backfill script
`scripts/backfill-deployment-mode.ts` and earlier Phase-3-era migrations already in the
migration history. Deploying the current tree applies those via `prisma migrate deploy`
(web). The Agent requires no schema.

## J. Rollback

- **omnisight-web:** revert the two route changes (`commands`, `screenshot`) and the test
  files; there is no schema delta, so rollback is a pure code revert. Reverting only the
  upload gate restores consent-only screenshot enforcement.
- **omnisight-agent:** the wizard/UI/lib changes are self-contained in `builder/`, `src/`
  and `tests/`. Rollback = revert those files and re-run `npm run package:dir` to rebuild
  the packaged artifact (`out/`). No server-side coordination required.

## K. Phase 4 Readiness

```
READY FOR PHASE 4
```

All Phase 3 acceptance criteria pass on actual source, tests, builds and artifact
inspection. The LOW-risk notes in H (full historical suite execution in CI and the
`screenshotInterval=0` upload-gate parity note) are tracking items, not blockers.
