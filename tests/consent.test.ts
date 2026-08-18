/**
 * Consent Management — focused lifecycle tests (phase 2 hardening).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_consent), never
 * the production DB. Covers the critical business rules:
 *   grant, deny, revoke, expiration (lazy + processor), policy version
 *   mismatch, re-consent, screenshot/activity enforcement, tenant isolation,
 *   RBAC, retention cleanup, idempotent cleanup, audit events, and the
 *   immutable consent-history rule.
 *
 * Run: npm run test:consent   (tsx --test tests/consent.test.ts)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ConsentStatus } from '../src/lib/consent';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

// ─── Test DB isolation ──────────────────────────────────────────────────────
// Must be set BEFORE any app module is imported: the Prisma client in
// src/lib/db.ts reads DATABASE_URL at construction time.
// Each suite owns a dedicated throwaway PostgreSQL database; the schema is
// pushed with `prisma db push` (test-only convenience — production deploys
// with `prisma migrate deploy`). PG_TEST_BASE_URL overrides the default local
// instance (e.g. for CI).
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_consent';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-consent-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
// The retention section purges physical screenshot files through the storage
// driver; this suite asserts against the local filesystem, so pin the local
// driver regardless of any developer's .env.
process.env.STORAGE_DRIVER = 'local';

// Push the current schema onto the throwaway DB (full reset — it only ever
// contains test data). When CONSENT_TEST_MIGRATED_DB=1 the DB is expected to
// have been produced by `prisma migrate deploy` (the P2 migration gate) and
// the push is skipped so the suite runs against the migrated schema.
before(() => {
  if (process.env.CONSENT_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const consentModule = await import('../src/lib/consent');
  applyConsentTransition = consentModule.applyConsentTransition;
  hasActiveConsent = consentModule.hasActiveConsent;
  getPublishedPolicy = consentModule.getPublishedPolicy;
  canTransition = consentModule.canTransition;
  CONSENT_STATUSES = consentModule.CONSENT_STATUSES;
  expireConsents = (await import('../src/lib/jobs/expire-consents')).expireConsents;
  runRetentionForOrg = (await import('../src/lib/jobs/retention')).runRetentionForOrg;
  const jobsSettings = await import('../src/lib/jobs/settings');
  resolveRetentionDays = jobsSettings.resolveRetentionDays;
  retentionCutoff = jobsSettings.retentionCutoff;
  hasRolePermission = (await import('../src/lib/auth')).hasRolePermission;
});

after(async () => {
  await db.$disconnect();
  if (process.env.CONSENT_TEST_MIGRATED_DB !== '1') {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// Module handles are populated inside before() so the environment variables
// above are set before the Prisma client is constructed (CJS output does not
// support top-level await).
type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
type ConsentModule = typeof import('../src/lib/consent');
let applyConsentTransition: ConsentModule['applyConsentTransition'];
let hasActiveConsent: ConsentModule['hasActiveConsent'];
let getPublishedPolicy: ConsentModule['getPublishedPolicy'];
let canTransition: ConsentModule['canTransition'];
let CONSENT_STATUSES: ConsentModule['CONSENT_STATUSES'];
let expireConsents: (limit?: number) => Promise<number>;
let runRetentionForOrg: (orgId: string, now?: Date, limit?: number) => Promise<{
  screenshots: number;
  activities: number;
  reports: number;
  aiInsights: number;
  auditLogsAnonymized: number;
  consentLogsAnonymized: number;
  fileErrors: string[];
  errors: string[];
}>;
let resolveRetentionDays: (orgId: string, key: 'screenshot_retention_days' | 'activity_retention_days' | 'report_retention_days' | 'ai_insight_retention_days' | 'audit_log_retention_days' | 'consent_log_retention_days') => Promise<number>;
let retentionCutoff: (days: number, now?: Date) => Date;
let hasRolePermission: (userRole: string, requiredRole: string) => boolean;

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function seedOrg(slug: string) {
  return db.organization.create({ data: { name: slug, slug } });
}

async function seedEmployee(orgId: string, code: string) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
    },
  });
}

async function publishPolicy(orgId: string, consentType: string, version: string) {
  await db.consentPolicy.updateMany({
    where: { organizationId: orgId, consentType, status: 'published' },
    data: { status: 'archived' },
  });
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} policy ${version}`,
      content: `This is the ${version} policy text for ${consentType}. It describes data collection, use, retention and employee rights in sufficient detail.`,
      version,
      status: 'published',
      effectiveAt: new Date(),
      createdBy: 'test',
    },
  });
}

async function createPendingConsent(empId: string, orgId: string, consentType: string) {
  const c = await db.consent.create({
    data: { employeeId: empId, consentType, status: 'pending', organizationId: orgId },
  });
  await db.consentLog.create({
    data: {
      consentId: c.id,
      action: 'requested',
      description: `Consent for ${consentType} created as pending`,
      performedBy: 'system',
      organizationId: orgId,
    },
  });
  return c;
}

async function transition(consent: { id: string; status?: string; consentType: string; organizationId: string }, to: ConsentStatus, extra: Record<string, unknown> = {}) {
  // Routes always re-fetch the current row before writing; the optimistic
  // guard rejects stale-status writes, so mirror that here.
  const current = await db.consent.findUniqueOrThrow({ where: { id: consent.id } });
  return db.$transaction((tx) =>
    applyConsentTransition(
      tx,
      { id: consent.id, status: current.status as ConsentStatus, consentType: consent.consentType, organizationId: consent.organizationId },
      to,
      { performedBy: 'test', userId: 'test-user', ...extra }
    )
  );
}

async function countLogs(consentId: string, action?: string) {
  return db.consentLog.count({ where: { consentId, ...(action ? { action } : {}) } });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('state machine: legal statuses and transitions', () => {
  assert.deepEqual(
    [...CONSENT_STATUSES].sort(),
    ['denied', 'expired', 'granted', 'pending', 'revoked'].sort()
  );
  assert.ok(canTransition('pending', 'granted'));
  assert.ok(canTransition('pending', 'denied'));
  assert.ok(canTransition('pending', 'expired'));
  assert.ok(canTransition('granted', 'revoked'));
  assert.ok(canTransition('granted', 'expired'));
  assert.ok(canTransition('denied', 'granted')); // re-consent where policy allows
  assert.ok(canTransition('denied', 'pending'));
  assert.ok(!canTransition('revoked', 'denied'));
  assert.ok(!canTransition('granted', 'pending'));
});

test('grant: pending -> granted binds the current published policy', async () => {
  const org = await seedOrg('grant-org');
  const emp = await seedEmployee(org.id, 'G-001');
  const pol = await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');

  const updated = await transition(consent, 'granted');
  assert.equal(updated.status, 'granted');
  assert.equal(updated.consentVersion, 'v1');
  assert.equal(updated.policyId, pol.id);
  assert.equal(updated.grantedAt !== null, true);
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);
  assert.equal(await countLogs(consent.id, 'granted'), 1);
  // audit log written when a userId is supplied
  const audit = await db.auditLog.findFirst({ where: { resource: 'consent', resourceId: consent.id } });
  assert.ok(audit, 'audit log row expected');
});

test('deny: pending -> denied never counts as granted', async () => {
  const org = await seedOrg('deny-org');
  const emp = await seedEmployee(org.id, 'D-001');
  await publishPolicy(org.id, 'activity_tracking', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'activity_tracking');

  const updated = await transition(consent, 'denied');
  assert.equal(updated.status, 'denied');
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), false);
  assert.equal(await countLogs(consent.id, 'denied'), 1);
  const audit = await db.auditLog.findFirst({ where: { resource: 'consent', resourceId: consent.id } });
  assert.ok(audit, 'deny must be audited');
});

test('revoke: granted -> revoked fails closed', async () => {
  const org = await seedOrg('revoke-org');
  const emp = await seedEmployee(org.id, 'R-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  const updated = await transition(consent, 'revoked', { action: 'revoked' });
  assert.equal(updated.status, 'revoked');
  assert.equal(updated.revokedAt !== null, true);
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
  assert.equal(await countLogs(consent.id, 'revoked'), 1);
});

test('expiration: lazy path + background processor transition to expired with expiredAt + single audit event', async () => {
  const org = await seedOrg('expire-org');
  const emp = await seedEmployee(org.id, 'E-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');

  // Backdate the expiry window into the past.
  await db.consent.update({ where: { id: consent.id }, data: { expiresAt: new Date(Date.now() - 3600_000) } });

  // Lazy enforcement already fails closed before the processor runs.
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // Processor transitions Granted -> Expired and records expiredAt + log.
  const before = await countLogs(consent.id);
  const n = await expireConsents();
  assert.equal(n, 1);
  const row = await db.consent.findUnique({ where: { id: consent.id } });
  assert.equal(row!.status, 'expired');
  assert.ok(row!.expiredAt, 'expiredAt must be recorded');
  const logs = await db.consentLog.findMany({ where: { consentId: consent.id } });
  const expiredLogs = logs.filter((l) => l.action === 'expired');
  assert.equal(expiredLogs.length, 1, 'exactly one expiration audit event');
  assert.equal(expiredLogs[0].performedBy, 'system');
  assert.ok(before < logs.length, 'a log entry was added');

  // Idempotent: a second run finds nothing and adds no duplicate logs.
  const again = await expireConsents();
  assert.equal(again, 0);
  assert.equal(await countLogs(consent.id, 'expired'), 1);
});

test('re-consent after expiration clears the stale expiry window', async () => {
  const org = await seedOrg('reexpire-org');
  const emp = await seedEmployee(org.id, 'RE-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');

  // Simulate an expired consent: past window + processor transition.
  await db.consent.update({ where: { id: consent.id }, data: { expiresAt: new Date(Date.now() - 3600_000) } });
  await expireConsents();
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // Re-consent from expired is legal and must yield an ACTIVE consent.
  const updated = await transition(consent, 'granted', { action: 're_consented' });
  assert.equal(updated.status, 'granted');
  assert.equal(updated.expiresAt, null, 're-consent must clear the stale expiry');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);
  assert.equal(await countLogs(consent.id, 're_consented'), 1);
});

test('policy version mismatch: v1 consent is invalid once v2 is published (re-consent required)', async () => {
  const org = await seedOrg('version-org');
  const emp = await seedEmployee(org.id, 'V-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  // Publish v2 — the route archives v1 automatically.
  const v2 = await publishPolicy(org.id, 'screenshot', 'v2');
  const published = await getPublishedPolicy(org.id, 'screenshot');
  assert.equal(published!.version, 'v2');
  assert.equal(published!.id, v2.id);
  // Re-fetch: the grant transition wrote policyId to the DB row.
  const fresh = await db.consent.findUnique({ where: { id: consent.id } });
  const v1 = await db.consentPolicy.findFirst({ where: { id: fresh!.policyId! } });
  assert.equal(v1!.status, 'archived');

  // v1 consent must NOT be treated as current: fails closed.
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
  const row = await db.consent.findUnique({ where: { id: consent.id } });
  assert.equal(row!.consentVersion, 'v1'); // history preserved
});

test('re-consent: granting v2 binds the new version while v1 stays in history', async () => {
  const org = await seedOrg('reconsent-org');
  const emp = await seedEmployee(org.id, 'RC-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  await publishPolicy(org.id, 'screenshot', 'v2');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // Employee re-consents to the current version.
  const updated = await transition(consent, 'granted', { action: 're_consented' });
  assert.equal(updated.consentVersion, 'v2');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  // v1 remains in history; the re-consent is its own audit event.
  const logs = await db.consentLog.findMany({ where: { consentId: consent.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(logs.length, 3, 'requested + granted(v1) + re_consented(v2)');
  assert.ok(logs.some((l) => l.action === 'granted'));
  assert.ok(logs.some((l) => l.action === 're_consented'));
});

test('enforcement: screenshot and activity gates follow consent + current policy version', async () => {
  const org = await seedOrg('enforce-org');
  const emp = await seedEmployee(org.id, 'ENF-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  await publishPolicy(org.id, 'activity_tracking', 'v1');

  // Nothing granted yet -> blocked.
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), false);

  const shot = await createPendingConsent(emp.id, org.id, 'screenshot');
  const act = await createPendingConsent(emp.id, org.id, 'activity_tracking');
  await transition(shot, 'granted');
  await transition(act, 'granted');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), true);

  // Screenshot consent does not unlock activity tracking and vice versa.
  await transition(shot, 'revoked', { action: 'revoked' });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), true);

  // Denied activity consent keeps the gate closed even after a grant of screenshot.
  await transition(act, 'denied');
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), false);
});

test('tenant isolation: org A consent cannot satisfy org B, and cross-org policy binding fails closed', async () => {
  const orgA = await seedOrg('tenant-a');
  const orgB = await seedOrg('tenant-b');
  const empA = await seedEmployee(orgA.id, 'TA-001');
  const empB = await seedEmployee(orgB.id, 'TB-001');
  await publishPolicy(orgA.id, 'screenshot', 'v1');
  await publishPolicy(orgB.id, 'screenshot', 'v1');

  const consent = await createPendingConsent(empA.id, orgA.id, 'screenshot');
  await transition(consent, 'granted');

  assert.equal(await hasActiveConsent(empA.id, 'screenshot'), true);
  // Employee B has no consent — must fail closed.
  assert.equal(await hasActiveConsent(empB.id, 'screenshot'), false);

  // Defense in depth: even if a consent record were tampered to point at the
  // other organization's policy, enforcement must refuse it.
  const polB = await getPublishedPolicy(orgB.id, 'screenshot');
  await db.consent.update({ where: { id: consent.id }, data: { policyId: polB!.id } });
  assert.equal(await hasActiveConsent(empA.id, 'screenshot'), false);
});

test('RBAC: role hierarchy gates admin/manager operations', () => {
  assert.equal(hasRolePermission('admin', 'admin'), true);
  assert.equal(hasRolePermission('manager', 'admin'), false);
  assert.equal(hasRolePermission('viewer', 'admin'), false);
  assert.equal(hasRolePermission('manager', 'manager'), true);
  assert.equal(hasRolePermission('admin', 'manager'), true);
  assert.equal(hasRolePermission('viewer', 'manager'), false);
  assert.equal(hasRolePermission('super_admin', 'admin'), true);
});

test('state machine rejects illegal transitions server-side', async () => {
  const org = await seedOrg('machine-org');
  const emp = await seedEmployee(org.id, 'M-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  await transition(consent, 'revoked', { action: 'revoked' });

  await assert.rejects(
    db.$transaction((tx) =>
      applyConsentTransition(
        tx,
        { id: consent.id, status: 'revoked', consentType: 'screenshot', organizationId: org.id },
        'denied',
        { performedBy: 'test' }
      )
    ),
    /Invalid consent transition/
  );
});

test('grant without a published policy fails closed (no silent v1 binding)', async () => {
  const org = await seedOrg('nopolicy-org');
  const emp = await seedEmployee(org.id, 'NP-001');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');

  await assert.rejects(
    db.$transaction((tx) =>
      applyConsentTransition(
        tx,
        { id: consent.id, status: 'pending', consentType: 'screenshot', organizationId: org.id },
        'granted',
        { performedBy: 'test' }
      )
    ),
    /No published policy/
  );
  const row = await db.consent.findUnique({ where: { id: consent.id } });
  assert.equal(row!.status, 'pending');
});

test('consent history is immutable: consent rows with logs cannot be hard-deleted (FK RESTRICT)', async () => {
  const org = await seedOrg('immutable-org');
  const emp = await seedEmployee(org.id, 'I-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  assert.ok((await countLogs(consent.id)) > 0);

  // Deleting the parent consent must fail — the audit trail is preserved.
  await assert.rejects(db.consent.delete({ where: { id: consent.id } }));
  const stillThere = await db.consent.findUnique({ where: { id: consent.id } });
  assert.ok(stillThere, 'consent must survive');
  assert.ok((await countLogs(consent.id)) > 0, 'logs must survive');

  // A consent with zero logs is still erasable (genuine data-erasure path).
  const bare = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'keystroke', status: 'pending', organizationId: org.id },
  });
  await db.consent.delete({ where: { id: bare.id } });
});

test('retention: operational data purged (incl. physical screenshot file), compliance records anonymized', async () => {
  const org = await seedOrg('retention-org');
  const emp = await seedEmployee(org.id, 'RT-001');

  // Configure a short retention window via org settings (like the API does).
  await db.organizationSetting.createMany({
    data: [
      { organizationId: org.id, key: 'screenshot_retention_days', value: '5', category: 'monitoring' },
      { organizationId: org.id, key: 'activity_retention_days', value: '5', category: 'monitoring' },
      { organizationId: org.id, key: 'report_retention_days', value: '5', category: 'compliance' },
      { organizationId: org.id, key: 'ai_insight_retention_days', value: '5', category: 'monitoring' },
      { organizationId: org.id, key: 'audit_log_retention_days', value: '5', category: 'compliance' },
      { organizationId: org.id, key: 'consent_log_retention_days', value: '5', category: 'compliance' },
    ],
  });
  assert.equal(await resolveRetentionDays(org.id, 'screenshot_retention_days'), 5);
  assert.equal(await resolveRetentionDays(org.id, 'activity_retention_days'), 5);

  const old = new Date(Date.now() - 10 * 86400_000);
  const recent = new Date(Date.now() - 1 * 86400_000);

  // Screenshot with a real file on disk.
  const uploadDir = join(process.cwd(), 'uploads', 'screenshots');
  mkdirSync(uploadDir, { recursive: true });
  const filePath = '/uploads/screenshots/retention-test-old.png';
  writeFileSync(join(process.cwd(), filePath), 'stale-bytes');
  const oldShot = await db.screenshot.create({
    data: { employeeId: emp.id, organizationId: org.id, filePath, fileName: 'retention-test-old.png', fileSize: 11, capturedAt: old },
  });
  const recentShot = await db.screenshot.create({
    data: { employeeId: emp.id, organizationId: org.id, filePath: '/uploads/screenshots/retention-test-new.png', fileName: 'retention-test-new.png', fileSize: 11, capturedAt: recent },
  });

  await db.activity.createMany({
    data: [
      { type: 'application', title: 'Old activity', duration: 60, employeeId: emp.id, timestamp: old },
      { type: 'application', title: 'Recent activity', duration: 60, employeeId: emp.id, timestamp: recent },
    ],
  });
  const oldReport = await db.report.create({ data: { title: 'Old report', type: 'productivity', organizationId: org.id, createdAt: old } });
  const oldInsight = await db.aiInsight.create({ data: { title: 'Old insight', content: 'x', type: 'productivity', organizationId: org.id, createdAt: old } });

  // Compliance records older than the cutoff are anonymized, not deleted.
  const oldAudit = await db.auditLog.create({
    data: { action: 'login', resource: 'user', description: 'old', userId: 'u-1', ipAddress: '1.2.3.4', organizationId: org.id, createdAt: old },
  });
  const oldConsent = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'location', status: 'granted', organizationId: org.id, createdAt: old },
  });
  const oldConsentLog = await db.consentLog.create({
    data: { consentId: oldConsent.id, action: 'granted', description: 'old consent activity', performedBy: 'Employee', ipAddress: '5.6.7.8', organizationId: org.id, createdAt: old },
  });

  const result = await runRetentionForOrg(org.id, new Date());

  assert.equal(result.screenshots, 1);
  assert.equal(result.activities, 1);
  assert.equal(result.reports, 1);
  assert.equal(result.aiInsights, 1);
  assert.equal(result.auditLogsAnonymized, 1);
  assert.equal(result.consentLogsAnonymized, 1);

  // Physical screenshot artifact removed alongside the DB row.
  assert.equal(existsSync(join(process.cwd(), filePath)), false, 'stale screenshot file must be deleted');

  // Old rows gone; recent rows untouched.
  assert.equal(await db.screenshot.findUnique({ where: { id: oldShot.id } }), null);
  assert.ok(await db.screenshot.findUnique({ where: { id: recentShot.id } }));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 1);
  assert.equal(await db.report.findUnique({ where: { id: oldReport.id } }), null);
  assert.equal(await db.aiInsight.findUnique({ where: { id: oldInsight.id } }), null);

  // Compliance records survive but are anonymized.
  const aud = await db.auditLog.findUnique({ where: { id: oldAudit.id } });
  assert.ok(aud);
  assert.equal(aud!.userId, null);
  assert.equal(aud!.ipAddress, null);
  const clog = await db.consentLog.findUnique({ where: { id: oldConsentLog.id } });
  assert.ok(clog);
  assert.equal(clog!.performedBy, null);
  assert.equal(clog!.ipAddress, null);
  assert.ok(clog!.anonymizedAt, 'anonymizedAt must be set');
});

test('retention cleanup is idempotent: a second run purges nothing and anonymizes nothing twice', async () => {
  const org = await seedOrg('idem-org');
  const emp = await seedEmployee(org.id, 'ID-001');
  await db.organizationSetting.createMany({
    data: [
      { organizationId: org.id, key: 'screenshot_retention_days', value: '5', category: 'monitoring' },
      { organizationId: org.id, key: 'activity_retention_days', value: '5', category: 'monitoring' },
      { organizationId: org.id, key: 'audit_log_retention_days', value: '5', category: 'compliance' },
    ],
  });
  const old = new Date(Date.now() - 10 * 86400_000);
  await db.screenshot.create({
    data: { employeeId: emp.id, organizationId: org.id, filePath: '/uploads/screenshots/idem-old.png', fileName: 'idem-old.png', fileSize: 5, capturedAt: old },
  });
  await db.activity.create({ data: { type: 'idle', duration: 10, employeeId: emp.id, timestamp: old } });

  const first = await runRetentionForOrg(org.id, new Date());
  assert.equal(first.screenshots, 1);
  assert.equal(first.activities, 1);

  const second = await runRetentionForOrg(org.id, new Date());
  assert.equal(second.screenshots, 0);
  assert.equal(second.activities, 0);
  assert.equal(second.auditLogsAnonymized, 0);
});

test('retention cutoff boundary: strictly older than cutoff is purged; at-cutoff and newer are kept', async () => {
  const org = await seedOrg('boundary-org');
  const emp = await seedEmployee(org.id, 'BND-001');
  await db.organizationSetting.create({
    data: { organizationId: org.id, key: 'screenshot_retention_days', value: '30', category: 'monitoring' },
  });

  const now = new Date('2026-08-09T12:00:00Z');
  const cutoff = retentionCutoff(30, now); // 2026-07-10T12:00:00Z

  const justOld = new Date(cutoff.getTime() - 1000); // cutoff - 1s  -> purge
  const atCutoff = new Date(cutoff.getTime()); // cutoff          -> keep
  const justNew = new Date(cutoff.getTime() + 1000); // cutoff + 1s -> keep

  const s1 = await db.screenshot.create({ data: { employeeId: emp.id, organizationId: org.id, filePath: '/uploads/screenshots/bound-old.png', fileName: 'bound-old.png', fileSize: 5, capturedAt: justOld } });
  await db.screenshot.create({ data: { employeeId: emp.id, organizationId: org.id, filePath: '/uploads/screenshots/bound-at.png', fileName: 'bound-at.png', fileSize: 5, capturedAt: atCutoff } });
  await db.screenshot.create({ data: { employeeId: emp.id, organizationId: org.id, filePath: '/uploads/screenshots/bound-new.png', fileName: 'bound-new.png', fileSize: 5, capturedAt: justNew } });

  const result = await runRetentionForOrg(org.id, now);
  assert.equal(result.screenshots, 1, 'only the strictly-older row is purged');
  assert.equal(await db.screenshot.findUnique({ where: { id: s1.id } }), null);
  assert.equal(await db.screenshot.count({ where: { organizationId: org.id } }), 2, 'at-cutoff and newer remain');
});

test('retention file errors: a failed unlink keeps the DB row for retry and reports it', async () => {
  const org = await seedOrg('fileerr-org');
  const emp = await seedEmployee(org.id, 'FE-001');
  await db.organizationSetting.create({
    data: { organizationId: org.id, key: 'screenshot_retention_days', value: '5', category: 'monitoring' },
  });

  const old = new Date(Date.now() - 10 * 86400_000);
  // Physical file that CANNOT be removed (points at a directory, so unlink fails).
  const uploadDir = join(process.cwd(), 'uploads', 'screenshots');
  mkdirSync(uploadDir, { recursive: true });
  const dirPath = '/uploads/screenshots/retention-blocked-dir';
  mkdirSync(join(process.cwd(), dirPath), { recursive: true });
  const blocked = await db.screenshot.create({
    data: { employeeId: emp.id, organizationId: org.id, filePath: dirPath, fileName: 'retention-blocked-dir', fileSize: 5, capturedAt: old },
  });

  const result = await runRetentionForOrg(org.id, new Date());
  assert.equal(result.screenshots, 0, 'a row whose artifact cannot be deleted must not count as purged');
  assert.equal(result.fileErrors.length, 1, 'the failed unlink is reported for retry');
  const still = await db.screenshot.findUnique({ where: { id: blocked.id } });
  assert.ok(still, 'the DB row is retained so a later run can retry');
  // Cleanup the directory artifact afterwards.
  rmSync(join(process.cwd(), dirPath), { recursive: true, force: true });
});

test('job leases: active lease blocks a second worker; expired lease allows crash recovery; lastResult recorded', async () => {
  const { runScheduledJobs } = await import('../src/lib/jobs/run');
  const org = await seedOrg('lease-org');
  const emp = await seedEmployee(org.id, 'LE-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  await db.consent.update({ where: { id: consent.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

  // First run claims the lease and completes.
  const first = await runScheduledJobs();
  assert.equal(first.expiredConsents, 1);
  const run1 = await db.jobRun.findUnique({ where: { job: 'expire_consents' } });
  assert.equal(run1!.status, 'completed');
  assert.ok(run1!.lastResult, 'lastResult must be recorded');
  const parsed = JSON.parse(run1!.lastResult!);
  assert.equal(parsed.expiredConsents, 1);

  // Simulate a concurrent worker holding a LIVE lease: a second run must skip.
  const now = new Date();
  await db.jobRun.update({
    where: { job: 'expire_consents' },
    data: { status: 'running', startedAt: now, leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000) },
  });
  const second = await runScheduledJobs();
  assert.equal(second.expiredConsents, 0, 'a live lease must block re-execution');

  // Crash recovery: once the lease expires, the job can be claimed again.
  await db.jobRun.update({
    where: { job: 'expire_consents' },
    data: { status: 'running', startedAt: now, leaseExpiresAt: new Date(now.getTime() - 60_000) },
  });
  const third = await runScheduledJobs();
  assert.equal(third.expiredConsents, 0, 'nothing new to expire, but the job must run without error');
  const run3 = await db.jobRun.findUnique({ where: { job: 'expire_consents' } });
  assert.equal(run3!.status, 'completed', 'expired lease must allow recovery to completion');
});

test('retention settings resolution validates values', async () => {
  const org = await seedOrg('settings-org');
  // Defaults when nothing is configured.
  assert.equal(await resolveRetentionDays(org.id, 'screenshot_retention_days'), 30);
  assert.equal(await resolveRetentionDays(org.id, 'consent_log_retention_days'), 0); // keep forever by default
  // Non-numeric and negative values fall back to the built-in default.
  await db.organizationSetting.createMany({
    data: [
      { organizationId: org.id, key: 'screenshot_retention_days', value: 'not-a-number' },
      { organizationId: org.id, key: 'report_retention_days', value: '-3' },
    ],
  });
  assert.equal(await resolveRetentionDays(org.id, 'screenshot_retention_days'), 30);
  assert.equal(await resolveRetentionDays(org.id, 'report_retention_days'), 0);
  const cutoff = retentionCutoff(30, new Date('2026-08-09T00:00:00Z'));
  assert.equal(cutoff.toISOString(), '2026-07-10T00:00:00.000Z');
});

test('concurrency: two conflicting transitions from pending -> exactly one wins, loser gets a conflict, no false audit event', async () => {
  const org = await seedOrg('race-org');
  const emp = await seedEmployee(org.id, 'RACE-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');

  // Simulate two concurrent requests that BOTH read status=pending before
  // either writes (the route passes the stale status into the service).
  const outcomes = await Promise.allSettled([
    db.$transaction((tx) =>
      applyConsentTransition(tx, { id: consent.id, status: 'pending', consentType: 'screenshot', organizationId: org.id }, 'granted', { performedBy: 'req-A', userId: 'race-user' })
    ),
    db.$transaction((tx) =>
      applyConsentTransition(tx, { id: consent.id, status: 'pending', consentType: 'screenshot', organizationId: org.id }, 'denied', { performedBy: 'req-B', userId: 'race-user' })
    ),
  ]);

  const settled = outcomes.map((o) => o.status);
  assert.equal(settled.filter((s) => s === 'fulfilled').length, 1, 'exactly one transition wins');
  const rejected = outcomes.find((o) => o.status === 'rejected');
  if (rejected && rejected.status === 'rejected') {
    const msg = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason);
    assert.match(msg, /concurrently|Invalid consent transition/);
  }

  // The final state is deterministic and matches the winner.
  const row = await db.consent.findUnique({ where: { id: consent.id } });
  const winner = outcomes.find((o) => o.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled');
  assert.ok(winner.value, 'winner must have a resolved value');
  assert.equal(row!.status, winner.value.status);
  assert.ok(['granted', 'denied'].includes(row!.status));

  // The loser wrote NO audit event — the conflict throws before any log.
  const logs = await db.consentLog.findMany({ where: { consentId: consent.id } });
  const transitionLogs = logs.filter((l) => ['granted', 'denied'].includes(l.action));
  assert.equal(transitionLogs.length, 1, 'only the winning transition is audited');
  const audit = await db.auditLog.findMany({ where: { resource: 'consent', resourceId: consent.id } });
  assert.equal(audit.length, 1, 'only the winning transition writes the main audit log');
});

test('idempotency: repeat grant / revoke / deny of the SAME transition are no-ops with no duplicate audit events', async () => {
  const org = await seedOrg('repeat-org');
  const emp = await seedEmployee(org.id, 'IDEM-001');
  await publishPolicy(org.id, 'activity_tracking', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'activity_tracking');

  // Grant, grant, grant -> a single granted audit event.
  await transition(consent, 'granted');
  const grantedAgain = await db.$transaction((tx) =>
    applyConsentTransition(tx, { id: consent.id, status: 'granted', consentType: 'activity_tracking', organizationId: org.id }, 'granted', { performedBy: 'repeat' })
  );
  assert.equal(grantedAgain.status, 'granted');
  assert.equal(await countLogs(consent.id, 'granted'), 1, 'repeat grant must not duplicate the audit event');

  // Revoke, revoke, revoke -> a single revoked audit event.
  await transition(consent, 'revoked', { action: 'revoked' });
  const revokedAgain = await db.$transaction((tx) =>
    applyConsentTransition(tx, { id: consent.id, status: 'revoked', consentType: 'activity_tracking', organizationId: org.id }, 'revoked', { performedBy: 'repeat' })
  );
  assert.equal(revokedAgain.status, 'revoked');
  assert.equal(await countLogs(consent.id, 'revoked'), 1, 'repeat revoke must not duplicate the audit event');

  // Deny, deny -> a single denied audit event (re-consent to pending first).
  await transition(consent, 'granted');
  await transition(consent, 'denied');
  await db.$transaction((tx) =>
    applyConsentTransition(tx, { id: consent.id, status: 'denied', consentType: 'activity_tracking', organizationId: org.id }, 'denied', { performedBy: 'repeat' })
  );
  assert.equal(await countLogs(consent.id, 'denied'), 1, 'repeat deny must not duplicate the audit event');
});

test('getConsentState: bounded queries and exact parity with hasActiveConsent across all states', async () => {
  const org = await seedOrg('qs-org');
  const emp = await seedEmployee(org.id, 'QS-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  await publishPolicy(org.id, 'activity_tracking', 'v1');

  const stateModule = await import('../src/lib/consent');
  const getConsentState = stateModule.getConsentState;

  // Grant screenshot, leave activity pending, nothing for the other 6 types.
  const shot = await createPendingConsent(emp.id, org.id, 'screenshot');
  await createPendingConsent(emp.id, org.id, 'activity_tracking');
  await transition(shot, 'granted');

  const allTypes = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring'];

  // Count queries over a full 8-type evaluation (Prisma has no $off, so the
  // listener stays registered but only tallies while the flag is set).
  let queryCount = 0;
  let counting = false;
  const onQuery = () => {
    if (counting) queryCount++;
  };
  // @ts-expect-error $on is a runtime-only Prisma API
  db.$on('query', onQuery);
  counting = true;
  const state = await getConsentState(emp.id, org.id, allTypes);
  counting = false;

  assert.ok(queryCount <= 4, `bounded queries expected (got ${queryCount})`);

  // Exact parity with hasActiveConsent for every type.
  for (const t of allTypes) {
    assert.equal(state[t], await hasActiveConsent(emp.id, t), `parity for ${t}`);
  }
  assert.equal(state.screenshot, true);
  assert.equal(state.activity_tracking, false); // pending

  // Version bump: publish v2 -> both batch and single checks fail closed.
  await publishPolicy(org.id, 'screenshot', 'v2');
  const afterV2 = await getConsentState(emp.id, org.id, allTypes);
  assert.equal(afterV2.screenshot, false, 'stale v1 screenshot consent must be re-consent-required');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // Defense in depth: a consent bound to another org’s policy can never be active.
  const orgB = await seedOrg('qs-org-b');
  await publishPolicy(orgB.id, 'screenshot', 'v2');
  const polB = await getPublishedPolicy(orgB.id, 'screenshot');
  await db.consent.update({ where: { id: shot.id }, data: { policyId: polB!.id } });
  const tampered = await getConsentState(emp.id, org.id, allTypes);
  assert.equal(tampered.screenshot, false, 'cross-org policy binding must fail closed in the batch path');
});

test('policy versioning edge cases: draft-unpublished, v3 skip-ahead, archived & missing policy fail closed', async () => {
  const org = await seedOrg('edge-org');
  const emp = await seedEmployee(org.id, 'EDGE-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  const consent = await createPendingConsent(emp.id, org.id, 'screenshot');
  await transition(consent, 'granted');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  // v2 DRAFTED but not published -> v1 consent remains fully valid.
  const draftV2 = await db.consentPolicy.create({
    data: { organizationId: org.id, consentType: 'screenshot', title: 'screenshot v2 draft', content: 'draft policy text for v2 that is not yet published', version: 'v2', status: 'draft', createdBy: 'test' },
  });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true, 'unpublished draft must not invalidate v1');

  // v2 PUBLISHED (the draft is promoted, archiving v1) -> re-consent required.
  await db.consentPolicy.updateMany({ where: { organizationId: org.id, consentType: 'screenshot', status: 'published' }, data: { status: 'archived' } });
  await db.consentPolicy.update({ where: { id: draftV2.id }, data: { status: 'published', effectiveAt: new Date() } });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // v3 PUBLISHED before the employee re-consents -> employee must adopt v3, not v2.
  await publishPolicy(org.id, 'screenshot', 'v3');
  const published = await getPublishedPolicy(org.id, 'screenshot');
  assert.equal(published!.version, 'v3');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
  await transition(consent, 'granted', { action: 're_consented' });
  const row = await db.consent.findUnique({ where: { id: consent.id } });
  assert.equal(row!.consentVersion, 'v3', 're-consent must bind v3, not v2');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  // ARCHIVING the current published policy -> no published policy -> fail closed.
  await db.consentPolicy.updateMany({ where: { organizationId: org.id, consentType: 'screenshot', status: 'published' }, data: { status: 'archived' } });
  assert.equal(await getPublishedPolicy(org.id, 'screenshot'), null);
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false, 'archived current policy must fail closed');
});

test('enforcement matrix: every non-grant state fails closed (pending/denied/revoked/expired/missing-policy/old-version)', async () => {
  const org = await seedOrg('matrix-org');
  const emp = await seedEmployee(org.id, 'MAT-001');
  await publishPolicy(org.id, 'screenshot', 'v1');

  // No consent record at all.
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  const c = await createPendingConsent(emp.id, org.id, 'screenshot');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false); // pending

  await transition(c, 'denied');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false); // denied

  await transition(c, 'granted');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true); // valid grant

  await transition(c, 'revoked', { action: 'revoked' });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false); // revoked

  await transition(c, 'granted');
  await db.consent.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false); // lapsed expiry
  await expireConsents();
  assert.equal((await db.consent.findUnique({ where: { id: c.id } }))!.status, 'expired');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false); // expired

  // Old policy version after a new publication.
  await transition(c, 'granted', { action: 're_consented' });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);
  await publishPolicy(org.id, 'screenshot', 'v2');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false); // v1 consent vs v2 policy
});

test('CONSENT MATRIX: all 8 consent types follow grant -> active, revoke -> closed, independently', async () => {
  const org = await seedOrg('matrix8-org');
  const emp = await seedEmployee(org.id, 'M8-001');
  const types = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring'];

  // Publish a v1 policy for every type, then grant -> active for each.
  for (const t of types) {
    await publishPolicy(org.id, t, 'v1');
  }
  for (const t of types) {
    assert.equal(await hasActiveConsent(emp.id, t), false, `${t} must start closed (no consent)`);
  }

  // Grant each type in turn — every one becomes active independently.
  for (const t of types) {
    const c = await createPendingConsent(emp.id, org.id, t);
    await transition(c, 'granted');
    assert.equal(await hasActiveConsent(emp.id, t), true, `${t} must be active after grant`);
  }
  // All 8 active simultaneously (independent rows).
  for (const t of types) {
    assert.equal(await hasActiveConsent(emp.id, t), true, `${t} still active`);
  }

  // Revoke each type in turn — only that type closes; every not-yet-revoked
  // type remains active (independence), and revoked ones stay closed.
  const revokedSoFar = new Set<string>();
  const revokeOrder = [...types].reverse();
  for (const t of revokeOrder) {
    const row = await db.consent.findFirst({ where: { employeeId: emp.id, consentType: t } });
    await transition(row!, 'revoked', { action: 'revoked' });
    revokedSoFar.add(t);
    assert.equal(await hasActiveConsent(emp.id, t), false, `${t} must close after revoke`);
    for (const other of types) {
      if (other === t) continue;
      if (revokedSoFar.has(other)) {
        assert.equal(await hasActiveConsent(emp.id, other), false, `${other} stays closed after being revoked earlier`);
      } else {
        assert.equal(await hasActiveConsent(emp.id, other), true, `${other} must be unaffected by revoking ${t}`);
      }
    }
  }
});

test('full phase-13 scenario: v1 -> grant -> enforce -> v2 -> blocked -> re-consent -> deny -> revoke', async () => {
  const org = await seedOrg('e2e-org');
  const emp = await seedEmployee(org.id, 'E2E-001');
  await publishPolicy(org.id, 'screenshot', 'v1');
  await publishPolicy(org.id, 'activity_tracking', 'v1');

  // ADMIN created+p published v1; EMPLOYEE grants screenshot + activity.
  const shot = await createPendingConsent(emp.id, org.id, 'screenshot');
  const act = await createPendingConsent(emp.id, org.id, 'activity_tracking');
  await transition(shot, 'granted');
  await transition(act, 'granted');

  // AGENT uploads succeed.
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), true);

  // ADMIN publishes v2 for screenshot.
  await publishPolicy(org.id, 'screenshot', 'v2');

  // AGENT screenshot upload is now blocked (re-consent required).
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // EMPLOYEE re-consents to v2; upload succeeds again.
  await transition(shot, 'granted', { action: 're_consented' });
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  // EMPLOYEE denies a new request (webcam); the corresponding operation is blocked.
  const webcam = await createPendingConsent(emp.id, org.id, 'webcam_access');
  await transition(webcam, 'denied');
  assert.equal(await hasActiveConsent(emp.id, 'webcam_access'), false);

  // EMPLOYEE revokes activity consent; operation blocked.
  await transition(act, 'revoked', { action: 'revoked' });
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), false);

  // EXPIRATION: backdate screenshot expiry, run the processor.
  await db.consent.update({ where: { id: shot.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const expired = await expireConsents();
  assert.equal(expired, 1);
  const shotRow = await db.consent.findUnique({ where: { id: shot.id } });
  assert.equal(shotRow!.status, 'expired');
  assert.ok(shotRow!.expiredAt);
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);

  // v1 policy version remains in history as archived.
  const v1 = await db.consentPolicy.findFirst({ where: { organizationId: org.id, consentType: 'screenshot', version: 'v1' } });
  assert.equal(v1!.status, 'archived');
});
