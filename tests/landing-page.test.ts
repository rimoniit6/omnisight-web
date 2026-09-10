/**
 * Landing Page content save — regression suite.
 *
 * Covers the full Super Admin save pipeline against a THROWAWAY PostgreSQL
 * database (workai_test_landing):
 *
 *   1. default content: no LandingContent row → GET returns valid empty doc
 *   2. PUT creates the record (org-less super_admin) → 200
 *   3. GET returns the saved (customized) content
 *   4. PUT again updates the SAME record → no duplicate LandingContent rows
 *   5. unauthenticated PUT → 401
 *   6. org_admin PUT → 403 (tenant can never mutate platform content)
 *   7. manager PUT → 403
 *   8. viewer PUT → 403
 *   9. sanitization: unknown keys dropped, lengths capped, XSS not weakened
 *
 * Run: node scripts/run-tests.mjs tests/landing-page.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_landing';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-landing-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'landing-root@corp.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Admin2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

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

type LandingRoute = typeof import('../src/app/api/landing/route');
let route: LandingRoute;
let db: typeof import('../src/lib/db')['db'];
let bootstrapSuperAdmin: typeof import('../src/lib/super-admin')['bootstrapSuperAdmin'];
let signJWT: typeof import('../src/lib/auth')['signJWT'];
let createUserSession: typeof import('../src/lib/session')['createUserSession'];

let saId: string;
let org: { id: string };

before(async () => {
  route = await import('../src/app/api/landing/route');
  db = (await import('../src/lib/db')).db;
  bootstrapSuperAdmin = (await import('../src/lib/super-admin')).bootstrapSuperAdmin;
  signJWT = (await import('../src/lib/auth')).signJWT;
  createUserSession = (await import('../src/lib/session')).createUserSession;

  const sa = await bootstrapSuperAdmin();
  saId = sa.user.id;
  org = await db.organization.create({ data: { name: 'Landing Org', slug: 'landing-org' } });
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

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Issue a real PUT /api/landing and return the parsed response. */
async function putLanding(token: string | null, payload: unknown) {
  const res = await route.PUT(
    req(token, { method: 'PUT', body: { content: payload }, url: 'http://localhost:3000/api/landing' })
  );
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

async function getLanding(token: string | null) {
  const res = await route.GET(
    req(token, { url: 'http://localhost:3000/api/landing' })
  );
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

async function webSession(userId: string) {
  const { id: sessionId } = await createUserSession({ userId });
  return sessionId;
}

// ─── 1–2: default content + first save creates the record ────────────────

test('LAND-1: GET with no record returns a valid empty/default document', async () => {
  const { status, body } = await getLanding(null);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.content, {}, 'default document is empty {} (sections render built-in copy)');
});

test('LAND-2: org-less super_admin can PUT → record created, 200', async () => {
  const sessionId = await webSession(saId);
  const token = await signJWT({
    userId: saId,
    email: 'landing-root@corp.local',
    role: 'super_admin',
    sessionId,
  });

  const { status, body } = await putLanding(token, {
    hero: { eyebrow: 'EYE', title: 'Hero line', subtitle: 'Sub', primaryCta: 'Start', secondaryCta: 'Learn' },
    overview: { title: 'Overview Title', subtitle: 'Overview sub' },
    footer: { tagline: 'Built for teams', copyright: '© 2026' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.content.hero.eyebrow, 'EYE');
  assert.equal(body.content.overview.title, 'Overview Title');

  const row = await db.landingContent.findUnique({ where: { key: 'site' } });
  assert.ok(row, 'LandingContent row must exist after PUT');
  assert.equal(row!.key, 'site');
  assert.ok(Array.isArray(row!.value.hero.title), 'hero title persisted as line array');
  assert.equal(row!.value.hero.title[0], 'Hero line');
  assert.equal(row!.updatedBy, saId, 'updatedBy recorded for org-less super_admin');

  const audit = await db.auditLog.findFirst({ where: { resource: 'landing_content' } });
  assert.ok(audit, 'PUT must write an audit log entry');
  assert.equal(audit!.action, 'update');
  assert.equal(audit!.organizationId, null, 'org-less super_admin audit entry carries no tenant');
  assert.equal(audit!.userId, saId);
});

// ─── 3: GET returns the customized content ───────────────────────────────

test('LAND-3: GET returns the saved customized content', async () => {
  const { status, body } = await getLanding(null);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.content.hero.eyebrow, 'EYE');
  assert.equal(body.content.overview.title, 'Overview Title');
  assert.equal(body.content.footer.tagline, 'Built for teams');
});

// ─── 4: second PUT updates the same record (no duplicate) ───────────────

test('LAND-4: second PUT updates the SAME record — no duplicate rows', async () => {
  const sessionId = await webSession(saId);
  const token = await signJWT({
    userId: saId,
    email: 'landing-root@corp.local',
    role: 'super_admin',
    sessionId,
  });

  const { status } = await putLanding(token, { hero: { title: 'Updated hero line' } });
  assert.equal(status, 200);

  const rows = await db.landingContent.findMany();
  assert.equal(rows.length, 1, 'exactly one LandingContent row');
  assert.ok(Array.isArray(rows[0].value.hero.title));
  assert.equal(rows[0].value.hero.title[0], 'Updated hero line', 'record updated in place');
});

// ─── 5–8: authorization ──────────────────────────────────────────────────

test('LAND-5: unauthenticated PUT → 401', async () => {
  const { status } = await putLanding(null, { hero: { title: 'No auth' } });
  assert.equal(status, 401);
});

test('LAND-6: org_admin PUT → 403 (tenant cannot mutate platform content)', async () => {
  const user = await db.appUser.create({
    data: {
      email: 'orgadmin@landing.local',
      name: 'Org Admin',
      password: 'x', // placeholder, unused — auth is by signed token
      role: 'org_admin',
      isActive: true,
      organizationId: org.id,
    },
  });
  const token = await signJWT({
    userId: user.id,
    email: 'orgadmin@landing.local',
    role: 'org_admin',
    organizationId: org.id,
    activeOrganizationId: org.id,
  });
  const { status } = await putLanding(token, { hero: { title: 'Nein' } });
  assert.equal(status, 403);
  const rows = await db.landingContent.findMany();
  assert.equal(rows[0].value.hero.title[0], 'Updated hero line', 'platform content unchanged by tenant');
});

test('LAND-7: manager PUT → 403', async () => {
  const user = await db.appUser.create({
    data: {
      email: 'manager@landing.local',
      name: 'Manager',
      password: 'x',
      role: 'manager',
      isActive: true,
      organizationId: org.id,
    },
  });
  const token = await signJWT({
    userId: user.id,
    email: 'manager@landing.local',
    role: 'manager',
    organizationId: org.id,
    activeOrganizationId: org.id,
  });
  const { status } = await putLanding(token, { hero: { title: 'Nein' } });
  assert.equal(status, 403);
});

test('LAND-8: viewer PUT → 403', async () => {
  const user = await db.appUser.create({
    data: {
      email: 'viewer@landing.local',
      name: 'Viewer',
      password: 'x',
      role: 'viewer',
      isActive: true,
      organizationId: org.id,
    },
  });
  const token = await signJWT({
    userId: user.id,
    email: 'viewer@landing.local',
    role: 'viewer',
    organizationId: org.id,
    activeOrganizationId: org.id,
  });
  const { status } = await putLanding(token, { hero: { title: 'Nein' } });
  assert.equal(status, 403);
});

// ─── 9: sanitization preserved ──────────────────────────────────────────

test('LAND-9: sanitization — unknown keys dropped, lengths capped, defaults survive', async () => {
  const sessionId = await webSession(saId);
  const token = await signJWT({
    userId: saId,
    email: 'landing-root@corp.local',
    role: 'super_admin',
    sessionId,
  });

  const longText = 'x'.repeat(5000);
  const htmlLike = '<script>alert(1)</script>Hello & world';
  const { status, body } = await putLanding(token, {
    evilSection: { title: 'injected' },            // unknown top-level key -> dropped
    hero: { title: `Line1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7` }, // > 6 lines -> capped
    overview: { subtitle: htmlLike },               // HTML-like text preserved (rendered escaped)
    ai: { subtitle: longText },                     // over `long` cap -> truncated
    pricing: { eyebrow: '', title: '', subtitle: '' }, // empty optional -> omitted
  });
  assert.equal(status, 200, JSON.stringify(body));

  const saved = body.content;
  assert.ok(!('evilSection' in saved), 'unknown top-level key dropped');
  const heroTitle = saved.hero.title as string[];
  assert.ok(Array.isArray(heroTitle), 'hero title is an array');
  assert.ok(heroTitle.length <= 6, 'hero title capped to 6 lines');
  assert.equal(saved.overview.subtitle, htmlLike, 'legitimate text with special chars preserved');
  assert.ok(saved.ai.subtitle.length <= 600, 'long text capped to 600');
  assert.ok(!('pricing' in saved), 'all-empty section omitted');

  const rows = await db.landingContent.findMany();
  assert.equal(rows.length, 1, 'still exactly one record');
});
