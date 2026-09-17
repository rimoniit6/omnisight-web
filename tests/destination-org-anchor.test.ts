/**
 * Destination Organization anchor — fail-closed safety + error diagnostics.
 *
 * The destination `Organization` anchor row is required so org-owned rows' FKs
 * resolve. The old implementation blindly ran
 * `INSERT ... ON CONFLICT ("id") DO NOTHING`, which only covers the PRIMARY KEY:
 * a destination already holding a DIFFERENT org id with the SAME unique slug
 * threw a bare SQLSTATE 23505 — surfaced only as the useless
 * "Invalid `prisma.$executeRawUnsafe()` invocation:" header. These tests pin the
 * corrected contract:
 *
 *   ANCHOR-01  empty destination → the exact platform identity is inserted.
 *   ANCHOR-02  idempotent — a matching anchor is left untouched.
 *   ANCHOR-03  a DIFFERENT org id already present → refused, nothing written.
 *   ANCHOR-04  a different id with the SAME (unique) slug → refused CLEANLY
 *              (the exact production failure mode), not a masked 23505.
 *   ANCHOR-05  the SAME id with a conflicting slug → refused.
 *   ANCHOR-06  MULTIPLE organization rows → refused.
 *   ANCHOR-07  a refusal never deletes or mutates existing destination rows.
 *   DIAG-01..05 userSafeError preserves the sanitized PostgreSQL cause.
 *
 * Runs against THROWAWAY PostgreSQL databases (platform + destination).
 *
 * Run: npx tsx --test tests/destination-org-anchor.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const PLATFORM_DB = 'workai_test_anchor_platform';
const DEST_DB = 'workai_test_anchor_dest';
const PLATFORM_URL = `${PG_TEST_BASE}/${PLATFORM_DB}?schema=public`;
const DEST_URL = `${PG_TEST_BASE}/${DEST_DB}?schema=public`;

process.env.DATABASE_URL = PLATFORM_URL;
process.env.DIRECT_URL = PLATFORM_URL;
process.env.JWT_SECRET = 'test-jwt-secret-anchor-0123456789abc';
(process.env as Record<string, string>).NODE_ENV = 'test';

function pushSchema(url: string): void {
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: 'pipe',
  });
}

before(() => {
  for (const name of [PLATFORM_DB, DEST_DB]) {
    execSync(`node scripts/pg-test-db.mjs ensure ${name}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  }
  pushSchema(PLATFORM_URL);
  pushSchema(DEST_URL);
});

after(async () => {
  const { db } = await import('../src/lib/db');
  await db.$disconnect();
  for (const name of [PLATFORM_DB, DEST_DB]) {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${name}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

type DestClient = import('@prisma/client').PrismaClient;

async function destinationClient(): Promise<DestClient> {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({ datasources: { db: { url: DEST_URL } }, log: ['error'] });
}

async function rowsOf(dest: DestClient): Promise<Array<{ id: string; slug: string; name: string }>> {
  return dest.$queryRawUnsafe<Array<{ id: string; slug: string; name: string }>>(
    `SELECT "id","slug","name" FROM "Organization" ORDER BY "id" ASC`
  );
}

let platformOrgId: string;
let platformSlug: string;

before(async () => {
  const { db } = await import('../src/lib/db');
  const slug = `anchor-org-${Date.now()}`;
  platformSlug = slug;
  const org = await db.organization.create({ data: { name: 'Anchor Org', slug } });
  platformOrgId = org.id;
});

// ── ANCHOR-01: empty destination → exact identity inserted ──────────────────
test('ANCHOR-01: empty destination → the exact platform identity is inserted', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await dest.$executeRawUnsafe(`DELETE FROM "Organization"`);
    assert.equal((await rowsOf(dest)).length, 0);

    await ensureDestinationOrgAnchor(dest, platformOrgId);

    const after = await rowsOf(dest);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, platformOrgId);
    assert.equal(after[0].slug, platformSlug);
    assert.equal(after[0].name, 'Anchor Org');
  } finally {
    await dest.$disconnect();
  }
});

// ── ANCHOR-02: idempotent ───────────────────────────────────────────────────
test('ANCHOR-02: idempotent — a matching anchor is left untouched (no duplicate)', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await ensureDestinationOrgAnchor(dest, platformOrgId);
    await ensureDestinationOrgAnchor(dest, platformOrgId);
    const after = await rowsOf(dest);
    assert.equal(after.length, 1, 'no duplicate anchor row may be created');
    assert.equal(after[0].id, platformOrgId);
    assert.equal(after[0].slug, platformSlug);
  } finally {
    await dest.$disconnect();
  }
});

// ── ANCHOR-03: a different org id already present → refused ────────────────
test('ANCHOR-03: a DIFFERENT organization already present is refused, nothing written', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await dest.$executeRawUnsafe(`DELETE FROM "Organization"`);
    await dest.organization.create({ data: { id: 'other-org-1', name: 'Other', slug: 'other-slug-1' } });

    await assert.rejects(
      () => ensureDestinationOrgAnchor(dest, platformOrgId),
      (err: Error) =>
        /not eligible for this organization/.test(err.message) && /different organization/.test(err.message),
      'must refuse with an actionable reason'
    );

    const after = await rowsOf(dest);
    assert.equal(after.length, 1, 'the foreign row is preserved');
    assert.equal(after[0].id, 'other-org-1');
    assert.equal(
      after.some((r) => r.id === platformOrgId),
      false,
      'the platform anchor must NOT be inserted alongside a foreign org'
    );
  } finally {
    await dest.$disconnect();
  }
});

// ── ANCHOR-04: the exact production failure — same unique slug, other id ────
test('ANCHOR-04: a different id with the SAME unique slug is refused cleanly (no masked 23505)', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await dest.$executeRawUnsafe(`DELETE FROM "Organization"`);
    await dest.organization.create({ data: { id: 'other-org-2', name: 'Imposter', slug: platformSlug } });

    await assert.rejects(
      () => ensureDestinationOrgAnchor(dest, platformOrgId),
      (err: Error) =>
        /not eligible for this organization/.test(err.message) &&
        /different organization/.test(err.message) &&
        !/prisma\.\$executeRawUnsafe/.test(err.message),
      'the unique-slug conflict must surface as an actionable refusal, not a masked raw-query crash'
    );

    const after = await rowsOf(dest);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, 'other-org-2');
    assert.equal(after[0].slug, platformSlug, 'the conflicting row is left exactly as it was');
  } finally {
    await dest.$disconnect();
  }
});

// ── ANCHOR-05: same id, conflicting slug → refused ─────────────────────────
test('ANCHOR-05: the SAME id with a conflicting identity slug is refused', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await dest.$executeRawUnsafe(`DELETE FROM "Organization"`);
    await dest.organization.create({ data: { id: platformOrgId, name: 'Anchor Org', slug: 'conflicting-slug' } });

    await assert.rejects(
      () => ensureDestinationOrgAnchor(dest, platformOrgId),
      (err: Error) =>
        /not eligible for this organization/.test(err.message) && /conflicting identity slug/.test(err.message)
    );

    const after = await rowsOf(dest);
    assert.equal(after.length, 1);
    assert.equal(after[0].slug, 'conflicting-slug', 'the existing row is never mutated');
  } finally {
    await dest.$disconnect();
  }
});

// ── ANCHOR-06: multiple org rows → refused ─────────────────────────────────
test('ANCHOR-06: MULTIPLE organization rows are refused', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await dest.$executeRawUnsafe(`DELETE FROM "Organization"`);
    await dest.organization.createMany({
      data: [
        { id: 'multi-1', name: 'M1', slug: 'multi-1' },
        { id: 'multi-2', name: 'M2', slug: 'multi-2' },
      ],
    });

    await assert.rejects(
      () => ensureDestinationOrgAnchor(dest, platformOrgId),
      (err: Error) =>
        /not eligible for this organization/.test(err.message) && /2 organization rows/.test(err.message)
    );
    assert.equal((await rowsOf(dest)).length, 2, 'nothing may be deleted');
  } finally {
    await dest.$disconnect();
  }
});

// ── ANCHOR-07: refusal is non-destructive ─────────────────────────────────
test('ANCHOR-07: a refusal never deletes or mutates the destination rows', async () => {
  const { ensureDestinationOrgAnchor } = await import('../src/lib/migration/db-migrate');
  const dest = await destinationClient();
  try {
    await dest.$executeRawUnsafe(`DELETE FROM "Organization"`);
    await dest.organization.create({ data: { id: 'keep-1', name: 'Keep', slug: 'keep-1' } });
    const before = await rowsOf(dest);
    await assert.rejects(() => ensureDestinationOrgAnchor(dest, platformOrgId));
    const afterRows = await rowsOf(dest);
    assert.deepEqual(afterRows, before, 'row-for-row identical after a refusal');
  } finally {
    await dest.$disconnect();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Error diagnostics — the surfaced reason must name the PostgreSQL cause
// ═══════════════════════════════════════════════════════════════════════════

test('DIAG-01: userSafeError surfaces the SQLSTATE + driver cause on a Prisma raw-query failure', async () => {
  const { userSafeError } = await import('../src/lib/migration/db-migrate');
  const err = Object.assign(new Error('Invalid `prisma.$executeRawUnsafe()` invocation:'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { code: '23505', message: 'duplicate key value violates unique constraint "Organization_slug_key"' },
  });
  const msg = userSafeError(err);
  assert.match(msg, /unique constraint violation/);
  assert.match(msg, /23505/);
  assert.match(msg, /Organization_slug_key/);
  assert.doesNotMatch(msg, /Invalid `prisma/);
});

test('DIAG-02: userSafeError handles the UNKNOWN raw-query shape (driver line embedded in the message)', async () => {
  const { userSafeError } = await import('../src/lib/migration/db-migrate');
  const err = new Error(
    'Invalid `prisma.$executeRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `23502`. Message: `null value in column "name" of relation "Organization" violates not-null constraint`'
  );
  const msg = userSafeError(err);
  assert.match(msg, /not-null constraint violation/);
  assert.match(msg, /23502/);
  assert.doesNotMatch(msg, /Invalid `prisma/);
});

test('DIAG-03: userSafeError reports a NOT NULL cause when only the driver line is present', async () => {
  const { userSafeError } = await import('../src/lib/migration/db-migrate');
  const err = new Error(
    'Invalid `prisma.$executeRawUnsafe()` invocation:\n\n\nnull value in column "slug" of relation "Organization" violates not-null constraint'
  );
  const msg = userSafeError(err);
  assert.match(msg, /violates not-null constraint/);
  assert.doesNotMatch(msg, /Invalid `prisma/);
});

test('DIAG-04: userSafeError redacts connection URLs (password) from the surfaced cause', async () => {
  const { userSafeError } = await import('../src/lib/migration/db-migrate');
  const err = new Error('connection to postgresql://user:supersecret@db.example.com:5432/app failed');
  const msg = userSafeError(err);
  assert.doesNotMatch(msg, /supersecret/);
  assert.match(msg, /REDACTED_URL/);
});

test('DIAG-05: userSafeError keeps legacy Prisma P2002 messages actionable', async () => {
  const { userSafeError } = await import('../src/lib/migration/db-migrate');
  const err = Object.assign(new Error('Unique constraint failed on the fields: (`slug`)'), {
    code: 'P2002',
    meta: { target: ['slug'] },
  });
  const msg = userSafeError(err);
  assert.match(msg, /Unique constraint failed on the fields/);
});
