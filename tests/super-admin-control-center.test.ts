/**
 * Super Admin Control Center — security + integrity tests.
 *
 * Two layers:
 *
 *  A) In-process API tests (throwaway PostgreSQL + local storage):
 *     - Anonymous / org_admin / manager tokens are rejected (401/403) by the
 *       four new control-plane read APIs (devices, ai-usage, storage, audit).
 *     - Org-less super_admin is accepted (200).
 *     - Responses are CONTROL-PLANE ONLY: AI usage carries no organization
 *       identity/keys/prompts; storage reports byte accounting honestly as
 *       unavailable; audit rows never serialize metadata/payloads; devices
 *       expose presence + version counts, never employee operational content.
 *
 *  B) Static contract tests (no DB):
 *     - Every Control Center page key is registered in the SPA shell
 *       (page.tsx) and gated to super_admin in navigation.ts.
 *     - The sidebar exposes the grouped Control Center structure and the
 *       header has labels for every new page.
 *
 * Run: npx tsx --test tests/super-admin-control-center.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sacc';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sacc-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@sacc.test';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';

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

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: Record<string, unknown>) => Promise<string>;

let orgManagedId: string;
let orgCustomerId: string;

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const managed = await db.organization.create({
    data: { name: 'Managed Tenant', slug: 'sacc-managed', timezone: 'UTC', deploymentMode: 'MANAGED' },
  });
  orgManagedId = managed.id;
  const customer = await db.organization.create({
    data: { name: 'Customer Tenant', slug: 'sacc-customer', timezone: 'UTC', deploymentMode: 'CUSTOMER_DB' },
  });
  orgCustomerId = customer.id;

  const emp = await db.employee.create({
    data: {
      employeeId: 'SACC-EMP-1',
      firstName: 'Ctrl',
      lastName: 'Emp',
      email: 'ctrl@sacc.test',
      organizationId: orgManagedId,
      status: 'active',
      agentApproved: true,
    },
  });
  await db.device.create({
    data: {
      name: 'Ctrl Device',
      hostname: 'ctrl-1',
      agentVersion: '1.4.2',
      osVersion: 'Windows 11',
      organizationId: orgManagedId,
      employeeId: emp.id,
      status: 'online',
      lastHeartbeat: new Date(),
    },
  });
  // One stale device for the offline count.
  await db.device.create({
    data: {
      name: 'Stale Device',
      organizationId: orgCustomerId,
      status: 'offline',
      lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  await db.screenshot.create({
    data: {
      employeeId: emp.id,
      organizationId: orgManagedId,
      filePath: '/uploads/screenshots/sacc-1.png',
      fileName: 'sacc-1.png',
      fileSize: 1024,
      mimeType: 'image/png',
      processingStatus: 'processed',
    },
  });

  await db.aiUsage.create({
    data: {
      organizationId: orgManagedId,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      operation: 'ai_insight',
      status: 'success',
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 900,
    },
  });

  // Retention config for the managed org.
  await db.organizationSetting.create({
    data: { organizationId: orgManagedId, key: 'screenshot_retention_days', value: '30', category: 'retention' },
  });

  // A completed retention cleanup run.
  await db.jobRun.create({
    data: { job: 'retention_cleanup', status: 'completed', lastRunAt: new Date(), lastDurationMs: 4200 },
  });

  // Audit row with sensitive-looking metadata that must never be serialized.
  await db.auditLog.create({
    data: {
      action: 'configure',
      resource: 'organization',
      description: 'Deployment mode updated',
      userId: null,
      ipAddress: '203.0.113.9',
      organizationId: orgManagedId,
      metadata: JSON.stringify({ apiKey: 'sk-SUPER-SECRET-NEVER-LEAK', payload: 'sensitive body' }),
    },
  });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<any> {
  return res.json();
}

const SA_TOKENS = {
  superAdmin: () => signJWT({ userId: 'sa-root', email: 'sa@sacc.test', role: 'super_admin' }),
  orgAdmin: () => signJWT({ userId: 'admin-a', email: 'admin-a@sacc.test', role: 'org_admin', organizationId: orgManagedId }),
  manager: () => signJWT({ userId: 'mgr-a', email: 'mgr-a@sacc.test', role: 'manager', organizationId: orgManagedId }),
};

// ─── A1–A4: role gating across the four control-plane reads ────────────────
const ROUTES: { name: string; mod: string }[] = [
  { name: 'devices', mod: '../src/app/api/super-admin/devices/route' },
  { name: 'ai-usage', mod: '../src/app/api/super-admin/ai-usage/route' },
  { name: 'storage', mod: '../src/app/api/super-admin/storage/route' },
  { name: 'audit', mod: '../src/app/api/super-admin/audit/route' },
];

for (const { name, mod } of ROUTES) {
  test(`SACC-A1: ${name} — anonymous → 401`, async () => {
    const route = await import(mod);
    const res = await route.GET(req(null, { url: `http://localhost:3000/api/super-admin/${name}` }));
    assert.equal(res.status, 401, `${name} must reject anonymous`);
  });

  test(`SACC-A2: ${name} — org_admin + manager → 403`, async () => {
    const route = await import(mod);
    for (const [label, mk] of [['org_admin', SA_TOKENS.orgAdmin], ['manager', SA_TOKENS.manager]]) {
      const res = await route.GET(req(await mk(), { url: `http://localhost:3000/api/super-admin/${name}` }));
      assert.equal(res.status, 403, `${name} must reject ${label}`);
    }
  });

  test(`SACC-A3: ${name} — org-less super_admin → 200`, async () => {
    const route = await import(mod);
    const res = await route.GET(req(await SA_TOKENS.superAdmin(), { url: `http://localhost:3000/api/super-admin/${name}` }));
    assert.equal(res.status, 200, `${name} must accept super_admin`);
  });
}

// ─── A5: devices — control-plane presence only ──────────────────────────────
test('SACC-A5: devices response is control-plane presence/version — no employee operational content', async () => {
  const route = await import('../src/app/api/super-admin/devices/route');
  const res = await route.GET(req(await SA_TOKENS.superAdmin(), { url: 'http://localhost:3000/api/super-admin/devices' }));
  assert.equal(res.status, 200);
  const payload = await body(res);

  const raw = JSON.stringify(payload);
  assert.ok(!/activity|screenshot|location|keystroke|mouse/i.test(raw), 'no operational content serialized');

  assert.equal(payload.total, 2);
  assert.equal(payload.online, 1);
  assert.equal(payload.offline, 1);
  assert.equal(payload.organizationsWithAgents, 2);
  assert.ok(payload.versions.some((v: { version: string; count: number }) => v.version === '1.4.2'));
  assert.ok(payload.byDeploymentMode.MANAGED >= 1);
});

// ─── A6: ai-usage — aggregates only, no tenant identity/keys ───────────────
test('SACC-A6: ai-usage response never exposes organization identity or provider keys', async () => {
  const route = await import('../src/app/api/super-admin/ai-usage/route');
  const res = await route.GET(req(await SA_TOKENS.superAdmin(), { url: 'http://localhost:3000/api/super-admin/ai-usage' }));
  assert.equal(res.status, 200);
  const json = await body(res);
  const raw = JSON.stringify(json);

  // Aggregates present and correct.
  assert.equal(json.total, 1);
  assert.equal(json.totalTokens, 150);
  assert.equal(json.inputTokens, 100);
  assert.equal(json.outputTokens, 50);
  assert.equal(json.byOperation[0].operation, 'ai_insight');

  // No tenant identity, keys, prompts or responses anywhere in the payload.
  assert.ok(!/organizationId|orgId/.test(raw), 'no org identity in AI usage payload');
  assert.ok(!/sk-|apiKey|api_key|secret|prompt|response/i.test(raw), 'no keys/prompts in AI usage payload');
});

// ─── A7: storage — honest accounting, counts + driver, never fabricated bytes ─
test('SACC-A7: storage response reports real object counts and marks byte accounting unavailable (never fabricated)', async () => {
  const route = await import('../src/app/api/super-admin/storage/route');
  const res = await route.GET(req(await SA_TOKENS.superAdmin(), { url: 'http://localhost:3000/api/super-admin/storage' }));
  assert.equal(res.status, 200);
  const json = await body(res);

  assert.equal(json.driver, 'local');
  assert.equal(json.objectCounts.screenshots, 1);
  assert.equal(json.bytesUsed, null);
  assert.equal(json.byteAccounting, 'unavailable');
  assert.ok(json.retention.organizationsConfigured >= 1);
  assert.ok(json.retention.byDays.some((r: { days: string }) => r.days === '30'));
  assert.equal(json.cleanup.length, 1);
  assert.equal(json.cleanup[0].status, 'completed');
  assert.equal(json.cleanup[0].error, null);
});

// ─── A8: audit — bounded, paginated, never metadata/payload/secrets ────────
test('SACC-A8: audit response omits metadata/payloads and keeps secrets out', async () => {
  const route = await import('../src/app/api/super-admin/audit/route');
  const res = await route.GET(
    req(await SA_TOKENS.superAdmin(), { url: 'http://localhost:3000/api/super-admin/audit?page=1&pageSize=25' })
  );
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.equal(json.data.length, 1);
  assert.equal(json.pagination.total, 1);

  const row = json.data[0];
  const raw = JSON.stringify(row);
  assert.equal(row.action, 'configure');
  assert.equal(row.organization.deploymentMode, 'MANAGED');
  assert.equal(row.ipAddress, '203.0.113.9');
  // metadata column (JSON payload) must never be serialized.
  assert.ok(!('metadata' in row), 'audit row must not include metadata');
  assert.ok(!/sk-SUPER-SECRET|NEVER-LEAK|sensitive body/.test(raw), 'secrets/payloads must never leak via audit');
});

// ─── A9: landing page content — public read, super_admin-only write ────────
test('SACC-A9: landing content is publicly readable but only super_admin can write it', async () => {
  const landing = await import('../src/app/api/landing/route');

  // Public read with no credentials.
  const pub = await landing.GET(req(null, { url: 'http://localhost:3000/api/landing' }));
  assert.equal(pub.status, 200);
  const pubBody = await body(pub);
  assert.ok(pubBody && typeof pubBody.content === 'object', 'public GET returns a content document');

  // Anonymous / org_admin writes are rejected.
  const anon = await landing.PUT(
    req(null, { url: 'http://localhost:3000/api/landing', method: 'PUT', body: { content: { hero: { title: ['Hacked'] } } } })
  );
  assert.equal(anon.status, 401, 'anonymous PUT rejected');
  const orgAdmin = await landing.PUT(
    req(await SA_TOKENS.orgAdmin(), { url: 'http://localhost:3000/api/landing', method: 'PUT', body: { content: { hero: { title: ['Hacked'] } } } })
  );
  // DB-verified role checks reject non-super-admin identities (401 when the
  // token user is absent from the fixture DB, 403 when present) — either is a
  // hard rejection.
  assert.ok([401, 403].includes(orgAdmin.status), `org_admin PUT rejected (got ${orgAdmin.status})`);

  // Super Admin write round-trips.
  const payload = {
    hero: { eyebrow: 'Platform', title: ['Line one', 'Line two'], subtitle: 'Sub', primaryCta: 'Go' },
    pricing: { title: 'Choose your plan' },
    footer: { tagline: 'OmniSight' },
  };
  const saWrite = await landing.PUT(
    req(await SA_TOKENS.superAdmin(), { url: 'http://localhost:3000/api/landing', method: 'PUT', body: { content: payload } })
  );
  assert.equal(saWrite.status, 200, 'super_admin PUT accepted');
  const after = await landing.GET(req(null, { url: 'http://localhost:3000/api/landing' }));
  const afterBody = await body(after);
  assert.equal(afterBody.content.hero.eyebrow, 'Platform');
  assert.deepEqual(afterBody.content.hero.title, ['Line one', 'Line two']);
  assert.equal(afterBody.content.pricing.title, 'Choose your plan');

  // Audited.
  const audit = await db.auditLog.findFirst({ where: { resource: 'landing_content' } });
  assert.ok(audit, 'landing content update is audited');

  // Restore empty (defaults) so other assertions see no overrides.
  await landing.PUT(
    req(await SA_TOKENS.superAdmin(), { url: 'http://localhost:3000/api/landing', method: 'PUT', body: { content: {} } })
  );
});

// ─── A10: manual payment record PATCH — super_admin only, audited ──────────
test('SACC-A10: invoice manual-payment update is super_admin-only and audited', async () => {
  const plan = await db.plan.create({
    data: { name: 'SACC-Pay', priceMonthly: 100, currency: 'BDT', maxDevices: 5, retentionDays: 30, features: [] },
  });
  const sub = await db.subscription.create({ data: { organizationId: orgManagedId, planId: plan.id, status: 'PENDING' } });
  const inv = await db.invoice.create({
    data: {
      subscriptionId: sub.id,
      organizationId: orgManagedId,
      invoiceNumber: `INV-SACC-${Date.now()}`,
      amount: 100,
      currency: 'BDT',
      status: 'PENDING',
      dueDate: new Date(Date.now() + 7 * 86_400_000),
    },
  });

  const route = await import('../src/app/api/admin/invoices/[invoiceId]/route');
  const mod = (id: string) => ({ params: Promise.resolve({ invoiceId: id }) });

  const denied = await route.PATCH(
    req(await SA_TOKENS.orgAdmin(), {
      url: `http://localhost:3000/api/admin/invoices/${inv.id}`,
      method: 'PATCH',
      body: { status: 'PAID' },
    }),
    mod(inv.id),
  );
  assert.ok([401, 403].includes(denied.status), `org_admin PATCH rejected (got ${denied.status})`);

  const invalid = await route.PATCH(
    req(await SA_TOKENS.superAdmin(), {
      url: `http://localhost:3000/api/admin/invoices/${inv.id}`,
      method: 'PATCH',
      body: { status: 'FULLY_PAID' },
    }),
    mod(inv.id),
  );
  assert.equal(invalid.status, 422, 'invalid status rejected');

  const ok = await route.PATCH(
    req(await SA_TOKENS.superAdmin(), {
      url: `http://localhost:3000/api/admin/invoices/${inv.id}`,
      method: 'PATCH',
      body: { status: 'PAID', paymentMethod: 'Bank_Transfer', transactionId: 'TXN-SACC-1', notes: 'confirmed manually' },
    }),
    mod(inv.id),
  );
  assert.equal(ok.status, 200, 'super_admin PATCH accepted');

  const row = await db.invoice.findUnique({ where: { id: inv.id } });
  assert.equal(row?.status, 'PAID');
  assert.equal(row?.paymentMethod, 'Bank_Transfer');
  assert.equal(row?.transactionId, 'TXN-SACC-1');
  assert.ok(row?.paidAt, 'paidAt stamped for PAID records');
  const audit = await db.auditLog.findFirst({ where: { resource: 'invoice', resourceId: inv.id } });
  assert.ok(audit, 'manual payment update audited');

  await db.invoice.delete({ where: { id: inv.id } });
  await db.subscription.delete({ where: { id: sub.id } });
  await db.plan.delete({ where: { id: plan.id } });
});

// ─── B1: page shell registration + navigation gating ───────────────────────
// Organizations-centric Super Admin: only Overview / Organizations / Packages
// / Landing Page are standalone pages. Subscriptions / Payments / Licenses /
// Audit are managed from the Organization (org detail) and via backend APIs —
// they are no longer SPA pages or sidebar entries.
const SA_PAGES = [
  'sa-overview',
  'super-admin-organizations',
  'super-admin-organization-detail',
  'sa-packages',
  'sa-create-organization',
  'sa-landing',
];

// Pages removed from the Super Admin product (Agents / Storage / AI Usage /
// System Health + standalone Subscriptions / Payments / Licenses / Audit) —
// their backend APIs remain infra but they are no longer SPA pages or
// sidebar entries.
const REMOVED_SA_PAGES = [
  'sa-agents',
  'sa-storage',
  'sa-ai-usage',
  'sa-health',
  'sa-subscriptions',
  'sa-payments',
  'sa-licenses',
  'sa-audit',
];

test('SACC-B1: every Control Center page is gated to super_admin in navigation.ts', async () => {
  const { canAccessPage } = await import('../src/lib/navigation');
  for (const page of SA_PAGES) {
    assert.ok(canAccessPage('super_admin', page as never), `${page} must be navigable by super_admin`);
    assert.ok(!canAccessPage('org_admin', page as never), `${page} must NOT be navigable by org_admin`);
    assert.ok(!canAccessPage('manager', page as never), `${page} must NOT be navigable by manager`);
    assert.ok(!canAccessPage('viewer', page as never), `${page} must NOT be navigable by viewer`);
    assert.ok(!canAccessPage(null, page as never), `${page} must NOT be navigable anonymously`);
  }
});

test('SACC-B2: SPA shell (page.tsx) registers every Control Center page component', () => {
  const ROOT = resolve(__dirname, '..');
  const shell = readFileSync(resolve(ROOT, 'src/app/page.tsx'), 'utf8');
  for (const page of SA_PAGES) {
    assert.ok(new RegExp(`['\"]${page}['\"]\\s*:`).test(shell), `page.tsx must register ${page}`);
  }
});

test('SACC-B3: sidebar exposes exactly Overview / Organizations / Packages / Landing Page (no Sales & Billing)', async () => {
  const ROOT = resolve(__dirname, '..');
  // Navigation structure lives in the shared sidebar data module consumed by
  // both the desktop and mobile shells (single source of truth).
  const navData = readFileSync(resolve(ROOT, 'src/lib/sidebar-nav.ts'), 'utf8');
  assert.ok(/section: 'Control Center'/.test(navData), 'Control Center group present');
  assert.ok(!/Sales & Billing/.test(navData), 'Sales & Billing section must be gone');
  for (const p of ['sa-overview', 'super-admin-organizations', 'sa-packages', 'sa-landing']) {
    assert.ok(navData.includes(`page: '${p}'`), `${p} nav item present`);
  }
  for (const p of REMOVED_SA_PAGES) {
    assert.ok(!navData.includes(`page: '${p}'`), `${p} must NOT be a sidebar item`);
  }
  // No standalone menu labels for org-scoped commercial surfaces.
  for (const label of ['Subscriptions', 'Payments', 'Licenses', 'Audit']) {
    assert.ok(!navData.includes(`label: '${label}'`), `no standalone "${label}" nav label`);
  }

  // An org-less super admin sees ONLY the Control Center group — tenant
  // operational groups require an organization context.
  const { visibleGroupsFor } = await import('../src/lib/sidebar-nav');
  const saItems = visibleGroupsFor('super_admin', false).flatMap((g) => g.items);
  assert.deepEqual(
    saItems.map((i) => i.page),
    ['sa-overview', 'super-admin-organizations', 'sa-packages', 'sa-infra-requests', 'sa-landing'],
    'org-less super_admin sidebar = Overview / Organizations / Packages / Infrastructure Requests / Landing Page',
  );

  // Both shells must consume the shared module (they may never drift).
  for (const file of ['src/components/layout/app-sidebar.tsx', 'src/components/layout/mobile-sidebar.tsx']) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    assert.ok(src.includes("from '@/lib/sidebar-nav'"), `${file} consumes shared sidebar data`);
  }
});

test('SACC-B4: header carries a label for every Control Center page', () => {
  const ROOT = resolve(__dirname, '..');
  const header = readFileSync(resolve(ROOT, 'src/components/layout/app-header.tsx'), 'utf8');
  for (const page of SA_PAGES) {
    assert.ok(new RegExp(`['\"]${page}['\"]\\s*:`).test(header), `app-header must label ${page}`);
  }
});

test('SACC-B5: control-plane pages render no fabricated/random metrics', () => {
  const ROOT = resolve(__dirname, '..');
  const sources = [
    'src/components/super-admin/sa-overview-page.tsx',
    'src/components/super-admin/sa-billing-pages.tsx',
    'src/components/super-admin/sa-landing-page.tsx',
    'src/components/super-admin/super-admin-organization-detail-page.tsx',
    'src/components/super-admin/ui.tsx',
  ];
  for (const rel of sources) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8');
    assert.ok(!/Math\.random/.test(src), `${rel} must not use Math.random`);
    assert.ok(!/Math\.floor\(Math\.random/.test(src), `${rel} must not synthesize values`);
  }
});
