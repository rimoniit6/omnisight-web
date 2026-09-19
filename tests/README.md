# OmniSight — Test Suite Environment Contract

This repo's node test runner is `tsx --test` (see `npm run test`, `test:*`
scripts in package.json) plus Playwright for `test:e2e`. There is **no** Jest or
Vitest config; environment setup is per-file and must follow the contract below.

## 1. Never load a real `.env` in tests

Test files set the fake values they need **inline, before importing** the
module under test:

```ts
import { beforeAll } from 'node:test';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-<name>-0123456789abcdef';
  process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
  // ...additional variables the module under test reads at import time
});
```

Because `@/lib/env-validator` (and everything that imports `@/lib/env`) is
**not** invoked at import time, setting env before the `import`/require of the
unit under test is what makes validation pass inside the test — keep that
ordering.

## 2. Fake values only — never real or production secrets

- `JWT_SECRET` / `ENCRYPTION_KEY` / `SUPER_ADMIN_PASSWORD` in tests are clearly
  fake and unique to the test (`test-jwt-secret-<name>-…`, `S3cure!<Name>2026x`,
  `test-password-123`). The security scanner `scripts/secret-scan.mjs`
  deliberately ignores these deterministic test/CI fixtures.
- Industrial-strength rule: if a value would authenticate against a real
  deployment, it is not a test value. Rotate immediately if one is found.
- `.env.test.example` documents the canonical fake set. Never copy passwords
  from `.env` / `.env.production.example` into a test.

## 3. Database access

- Modules under test either **mock/stub the Prisma client** (structural test
  seams like `args: any` in `src/lib/jobs/data-integrity.ts`) or run against a
  dedicated throwaway database. Never point a test at a development or
  production database.
- `DATABASE_URL` for integration tests is a fake local URL; a test that opens a
  real connection must create/teardown its own schema.

## 4. Server-only modules

Run node-side tests with `NEXT_RUNTIME=nodejs` (all `test:*` scripts already
do) so `server-only` imports and any Node-only fs/Prisma code load correctly.

## 5. Adding a new test file

- Give it the fake-env preamble (see §1) before its first deep import.
- Follow existing naming (`*.test.ts`, `tests/api/`, `tests/unit/`).
- Add a `test:<name>` script if it has specific env/args needs, otherwise it is
  picked up by `scripts/run-tests.mjs`.