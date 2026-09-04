# Release Process

OmniSight follows **Keep a Changelog** + **Semantic Versioning**. This document
describes how a change moves from a branch to a tagged production release.

## 1. Versioning

- **Major** — breaking changes / platform milestones.
- **Minor** — new features (backwards-compatible).
- **Patch** — bug fixes.

The current version lives in `package.json` (`version`) and is mirrored in
`CHANGELOG.md`. Keep both in sync.

## 2. Before release: verification gates

Run the full quality gate locally (the CI workflow `.github/workflows/ci.yml`
runs the same steps on every PR to `main`):

```bash
bun run lint          # ESLint — 0 errors in product source
bun run typecheck     # tsc --noEmit (with generated-types clean)
bun run test          # existing suite (starts a dev server against a temp DB)
bun run test:unit     # pure unit tests (licenses, subscription helpers)
bun run test:integration  # license, subscription, invoices, data-expiry
bun run test:e2e      # Playwright, if the change touches user flows
bun run build         # production build (standalone output)
```

For self-hosted license changes also verify:

```bash
# 1. prisma migrate deploy on a throwaway DB
# 2. SEED_ALLOWED=1 npx tsx scripts/ensure-self-hosted-plan.ts
# 3. npx tsx --test tests/api/license.test.ts
```

## 3. Changelog

Add an entry under a new `## [x.y.z] - YYYY-MM-DD` heading, grouped under
`Added` / `Changed` / `Fixed` / `Removed` / `Security`. Note any **migrations**
that must be deployed and any **new required environment variables** (they are
applied by `prisma migrate deploy`; env vars are documented in
`.env.production.example`).

## 4. Ship

Create the version bump + changelog as its own commit, push, open a PR, and get
it merged once CI is green. Tag the release commit:

```bash
git tag v0.2.1
git push origin v0.2.1
```

## 5. Deploy

- **Self-hosted (VPS):** `git pull && npx prisma migrate deploy && npm run build
  && sudo systemctl restart omnisight omnisight-live`.
- **Docker:** `docker compose up -d --build` (entrypoint applies migrations and
  bootstraps the self-hosted plan).
- **Vercel + Supabase:** push to the connected GitHub branch; migrations run via
  the configured deploy hook.

## 6. Post-release verification

After deploy confirm:

- `GET /api/health` returns `status: ok` with `database`/`storage` ok.
- A metrics scrape against `GET /api/metrics` (with `METRICS_TOKEN`) succeeds.
- In self-hosted mode, `SELF_HOSTED_REQUIRE_LICENSE=true` refuses to start with
  a bad/expired `LICENSE_KEY`, and the `Enterprise_SelfHosted` plan exists.
- Smoke-test login, an org-scoped page, and the license status page.
