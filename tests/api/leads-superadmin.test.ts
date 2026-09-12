// Test that leads are properly stored and queryable
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_leads';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-leads-0123456789abcdef';
process.env.NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

type DbModule = typeof import('../../src/lib/db');
let db: DbModule['db'];

before(async () => {
  const dbModule = await import('../../src/lib/db');
  db = dbModule.db;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

// Helper to create a lead directly in DB
async function createLead(data: { name: string; email: string; company?: string | null; planInterest: string; message?: string | null }) {
  return db.lead.create({ data });
}

test('Lead model stores submissions correctly', async () => {
  // Create a lead directly
  const lead = await db.lead.create({
    data: {
      name: 'Direct Lead',
      email: 'direct@example.com',
      planInterest: 'Pro',
      message: 'Test message',
      company: 'Test Co',
      status: 'NEW',
      source: 'contact_page',
    },
  });

  // Verify it's stored correctly
  const found = await db.lead.findUnique({ where: { id: lead.id } });
  assert.ok(found);
  assert.equal(found.name, 'Direct Lead');
  assert.equal(found.email, 'direct@example.com');
  assert.equal(found.planInterest, 'Pro');
  assert.equal(found.status, 'NEW');
  assert.equal(found.source, 'contact_page');
  assert.equal(found.company, 'Test Co');
  assert.equal(found.message, 'Test message');
});

test('Lead status can be updated', async () => {
  const lead = await db.lead.create({
    data: {
      name: 'Status Lead',
      email: 'status@example.com',
      planInterest: 'Free',
      status: 'NEW',
      source: 'contact_page',
    },
  });

  // Update status to CONTACTED
  await db.lead.update({
    where: { id: lead.id },
    data: { status: 'CONTACTED' },
  });

  const updated = await db.lead.findUnique({ where: { id: lead.id } });
  assert.equal(updated.status, 'CONTACTED');
});

test('Leads can be queried by status', async () => {
  await db.lead.create({
    data: { name: 'Lead 1', email: 'l1@example.com', planInterest: 'Business', company: 'C1', status: 'NEW', source: 'contact_page' },
  });
  await db.lead.create({
    data: { name: 'Lead 2', email: 'l2@example.com', planInterest: 'Enterprise', company: 'C2', status: 'NEW', source: 'contact_page' },
  });
  await db.lead.create({
    data: { name: 'Lead 3', email: 'l3@example.com', planInterest: 'Pro', company: 'C3', status: 'NEW', source: 'contact_page' },
  });

  // Mark one as CONTACTED
  const lead1 = await db.lead.findFirst({ where: { email: 'l1@example.com' } });
  if (lead1) {
    await db.lead.update({ where: { id: lead1.id }, data: { status: 'CONTACTED' } });
  }

  // Query NEW leads
  const newLeads = await db.lead.findMany({
    where: { status: 'NEW' },
    orderBy: { createdAt: 'desc' },
  });

  assert.ok(newLeads.length >= 2, 'Should have at least 2 NEW leads');
  for (const lead of newLeads) {
    assert.equal(lead.status, 'NEW');
  }
});
