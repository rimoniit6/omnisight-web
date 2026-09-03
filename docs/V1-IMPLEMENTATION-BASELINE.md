# OMNISIGHT V1 — IMPLEMENTATION BASELINE

Forensic baseline captured before Phase 0 changes. Source of truth for what
exists, what the contracts are, and what a green regression gate looks like.

---

## 1. Repositories

| Repo | Path | Role |
| ---- | ---- | ---- |
| omnisight-web | `E:\Live project\omnisight\omnisight-web` | Admin Console, APIs, PostgreSQL (Prisma), storage, realtime, jobs |
| omnisight-agent | `E:\Live project\omnisight\omnisight-agent` | Electron endpoint agent: collectors, encrypted queue/spool, uploader |

---

## 2. Web — Platform

| Item | Value / Evidence |
| ---- | ---------------- |
| Framework | Next.js 16 (App Router, `src/app`) |
| Language | TypeScript strict |
| Database | PostgreSQL via Prisma ORM |
| Prisma version | per `package.json` lockfile |
| Auth (admin) | JWT sessions + RBAC (`src/lib/auth`, permission registry) |
| Auth (agent) | AgentSession (login) + AgentToken (device-bound, `src/lib/agent/auth.ts`, `src/lib/agent/session.ts`) |
| Realtime | `mini-services/live-updates` (Socket.io) + durable-cursor polling fallback |
| Feature/settings registry | `src/lib/jobs/settings.ts` (agent-facing settings sync) |
| Test runner | `node:test` via `tsx` (`tests/*.test.ts`), throwaway per-suite Postgres DBs (`scripts/pg-test-db.mjs`) |
| Build | `next build` (requires clean `.next/dev/types` — corrupted stale artifact breaks builds) |
| Lint | ESLint flat config (`eslint.config.mjs`); `.claude/` excluded |
| Lockfile | **bun.lock** (canonical; bun is prod runtime for `mini-services/live-updates`) |

### API route inventory (agent-facing + core admin)

Agent ingestion (all validate the agent token, re-derive org/employee from the
server session, never trust client IDs):

- `POST /api/agent/heartbeat` — presence + break/state ride-back
- `POST /api/agent/activity` — batched activity slices (batch-atomic, validated)
- `POST /api/agent/screenshot` — multipart upload, magic-byte validation
- `POST /api/agent/location` — coordinate-only location
- `POST /api/agent/login` — AgentSession (uniform 401)
- `POST /api/agent/discover` — device registration (session-authenticated only; anonymous → 422 `AUTHENTICATION_REQUIRED`)
- `POST /api/agent/authenticate` — PATH A device claim → AgentToken
- `GET /api/agent/config` — policy/config sync
- Command + webcam + audio endpoints (existing)

Admin/UI (representative):

- `/api/device-claims` + `[id]/approve|reject|cancel`
- `/api/screenshots` + `[id]/image`
- `/api/export/[type]`
- org/user/member/RBAC/policy/analytics routes per `docs/API.md`

### Storage abstraction

`src/lib/storage/index.ts` — driver interface; local filesystem or Supabase
(S3-compatible) object storage. Screenshot binaries live OUTSIDE the
relational DB (metadata only in `Screenshot`).

### Jobs / retention

- `src/lib/jobs/retention.ts` — two-phase file-first retention sweep
- `src/lib/screenshots/sweep.ts` — orphan sweep
- Delete path is scheduled, idempotent, org-aware.

### Consent / privacy

- `src/lib/consent.ts` — `hasActiveConsent` fails closed; policy version must
  match org's published policy; 8 consent types.
- Break mode + working-hours (org timezone) enforcement ride on agent config.

---

## 3. Agent — Platform

| Item | Value / Evidence |
| ---- | ---------------- |
| Runtime | Electron + TypeScript (`tsconfig.json` + `tsconfig.renderer.json`) |
| Collectors | `src/collectors/activity-collector.ts` (10s foreground slices), `website-collector.ts`, `screenshot-collector.ts`, `consent-gate.ts` |
| Local queue | `src/storage/activity-queue.ts` — encrypted-at-rest, bounded |
| Transport | `src/services/queue-uploader.ts` — at-least-once, retry, 401 = recover + retain |
| Auth | AgentToken bearer; login via AgentSession |
| Version | `package.json` 1.1.0; `agentVersion` in payloads |
| Tests | 625 `node:test` cases (`npm test`) — baseline 625/625 PASS |
| Build | `npm run build` (copy-assets + tsc both projects) — baseline PASS |
| Typecheck | `npm run typecheck` — baseline PASS |

### Agent → web payload contracts (baseline)

- **Heartbeat**: `{ timestamp }` + token → presence + settings ride-back.
- **Activity**: `{ activities: [{ app, title?, domain?, windowTitle?, startedAt, durationMs, ... }] }` — one upload batch per drain. **No `batchId` today** — retries can duplicate (documented at-least-once).
- **Screenshot**: multipart `screenshot` file + `timestamp` + `appWindow`.
- **Location**: coordinate-only.
- **Config**: `GET /api/agent/config` returns policies + gates + break state.

---

## 4. Cross-repo contract notes

1. Old agents (no `batchId`) MUST remain accepted after Phase 1.
2. New `batchId`/`batchSeq` fields are OPTIONAL additions — server ignores unknown fields and preserves behavior when absent.
3. Agent API auth is device-token based; org/employee are server-derived.
4. Error responses use `{ error, code? }` shapes; uniform 401 for credential failures (no account enumeration).

---

## 5. Regression gate commands (baseline)

### Web (`omnisight-web`)

1. `node scripts/clean-next-types.mjs` (added Phase 0 — clears corrupt `.next/dev/types`)
2. `npm run typecheck`
3. `npm run lint` (0 errors in product source)
4. `npm run build`
5. Boot dev server on :3000, then `node scripts/run-tests.mjs` (or per-file `npx tsx --test tests/<file>.test.ts`)

### Agent (`omnisight-agent`)

1. `npm run typecheck`
2. `npm test`
3. `npm run build`

### Baseline results (pre-Phase-0 audit)

- Web typecheck: PASS
- Web lint: 0 errors product source (8 pre-existing errors confined to `.claude/helpers/*.cjs`)
- Web build: PASS after clearing one corrupted generated `.next/dev/types/validator.ts`
- Web tests: 82/96 suites pass; 14 failures classified (6 test-helper GET+body bug; remainder stale assertions/data drift) — **zero confirmed product regressions**
- Agent typecheck/tests/build: PASS (625/625)

---

## 6. Known Phase 0 blockers (the reason this doc exists)

1. `req()` test helper defaults to GET with a body → Next 16/undici throws.
2. Stale tests asserting removed anonymous-discover behavior or stale seed data.
3. `rbac-hardening` / `rbac-forensic-regression` embed real-looking passwords.
4. Corrupted `.next/dev/types` breaks builds (environment artifact).
5. Lockfile authority was split (`package-lock.json` 88-byte stub vs `bun.lock`).
6. ESLint errors under `.claude/` unignored.
7. No reproducible CI sequence.

Phase 0 resolves all seven; this baseline plus the Phase-0 report form the
regression contract for Phases 1–8.
