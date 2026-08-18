/**
 * R3 — server-authoritative device-integrity (telemetry-interruption) detection.
 *
 * The server is the authority on agent health. An approved, actively-monitored
 * device whose heartbeat went silent is surfaced as a dedupe-keyed
 * `device_missing` anomaly — deliberately NOT labeled "tampered", because a
 * silent device has legitimate causes (shutdown, sleep, network outage) and
 * the admin judges.
 *
 * Cases:
 *   - DI-1: stale heartbeat + active monitoring consent → anomaly created
 *   - DI-2: fresh heartbeat → NOT flagged (no false positive)
 *   - DI-3: stale heartbeat but consent revoked → NOT flagged (silence after
 *     consent revocation is expected, not suspicious)
 *   - DI-4: same device already flagged today → dedupe key suppresses duplicates
 *   - DI-5: wired into runScheduledJobs under the shared lease with
 *     observability (JobRun.lastResult)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_deviceintegrity).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_deviceintegrity';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-deviceintegrity-0123456789abcdef';
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

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];

let orgId: string;
let empMonitoredId: string;
let empNoConsentId: string;

before(async () => {
  db = (await import('../src/lib/db')).db;
  const org = await db.organization.create({ data: { name: 'DI Org', slug: 'di-org', timezone: 'UTC', status: 'active' } });
  orgId = org.id;
  empMonitoredId = (await db.employee.create({
    data: { employeeId: 'DI-EMP-1', firstName: 'D', lastName: 'Monitored', email: 'di1@example.com', organizationId: org.id, status: 'active' },
  })).id;
  empNoConsentId = (await db.employee.create({
    data: { employeeId: 'DI-EMP-2', firstName: 'D', lastName: 'NoConsent', email: 'di2@example.com', organizationId: org.id, status: 'active' },
  })).id;
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

async function consent(employeeId: string, status: string) {
  await db.consent.create({
    data: { employeeId, consentType: 'monitoring', status, organizationId: orgId, grantedAt: status === 'granted' ? new Date() : null },
  });
}

test('DI-1: stale heartbeat with active monitoring consent → device_missing anomaly', async () => {
  await consent(empMonitoredId, 'granted');
  const staleDevice = await db.device.create({
    data: {
      name: 'Stale PC',
      hostname: 'stale-pc',
      organizationId: orgId,
      employeeId: empMonitoredId,
      status: 'online',
      lastHeartbeat: new Date(Date.now() - 30 * 60_000), // 30 min stale (> 15 min threshold)
    },
  });

  const { runDeviceIntegrityJob } = await import('../src/lib/jobs/detect-device-integrity');
  const result = await runDeviceIntegrityJob();

  assert.equal(result.missingDetected, 1, 'exactly one stale device detected');
  assert.equal(result.anomaliesCreated, 1, 'anomaly persisted');

  const anomaly = await db.anomaly.findFirst({ where: { type: 'device_missing' } });
  assert.ok(anomaly, 'device_missing anomaly row exists');
  assert.equal(anomaly.organizationId, orgId);
  assert.equal(anomaly.employeeId, empMonitoredId);
  assert.equal(anomaly.deviceId, staleDevice.id);
  assert.equal(anomaly.severity, 'low', 'silence is reported, not screamed');
  assert.ok(anomaly.metadata?.includes('heartbeat_timeout'), 'cause metadata recorded');

  // Cleanup so later tests start from a clean device set (each run re-finds
  // stale devices; only anomaly creation is deduped per day).
  await db.device.delete({ where: { id: staleDevice.id } });
});

test('DI-2: fresh heartbeat → NOT flagged', async () => {
  const freshEmp = (await db.employee.create({
    data: { employeeId: 'DI-EMP-3', firstName: 'D', lastName: 'Fresh', email: 'di3@example.com', organizationId: orgId, status: 'active' },
  })).id;
  await consent(freshEmp, 'granted');
  const freshDevice = await db.device.create({
    data: { name: 'Fresh PC', organizationId: orgId, employeeId: freshEmp, status: 'online', lastHeartbeat: new Date() },
  });

  const { runDeviceIntegrityJob } = await import('../src/lib/jobs/detect-device-integrity');
  const result = await runDeviceIntegrityJob();

  assert.equal(result.missingDetected, 0, 'fresh device not flagged');
  assert.equal(result.anomaliesCreated, 0);
  assert.equal(await db.anomaly.count({ where: { employeeId: freshEmp } }), 0, 'no anomaly for the fresh employee');

  await db.device.delete({ where: { id: freshDevice.id } });
});

test('DI-3: stale heartbeat but consent revoked → NOT flagged (expected silence)', async () => {
  await consent(empNoConsentId, 'revoked');
  const revokedDevice = await db.device.create({
    data: { name: 'Revoked PC', organizationId: orgId, employeeId: empNoConsentId, status: 'online', lastHeartbeat: new Date(Date.now() - 120 * 60_000) },
  });

  const { runDeviceIntegrityJob } = await import('../src/lib/jobs/detect-device-integrity');
  const result = await runDeviceIntegrityJob();

  assert.equal(result.missingDetected, 0, 'consent-revoked silence is not suspicious');
  assert.equal(await db.anomaly.count({ where: { employeeId: empNoConsentId } }), 0, 'no anomaly for the revoked-consent employee');

  await db.device.delete({ where: { id: revokedDevice.id } });
});

test('DI-4: same device same UTC day → dedupe key suppresses duplicates', async () => {
  const stale = await db.device.create({
    data: { name: 'Dedupe PC', organizationId: orgId, employeeId: empMonitoredId, status: 'online', lastHeartbeat: new Date(Date.now() - 45 * 60_000) },
  });
  const beforeCount = await db.anomaly.count({ where: { type: 'device_missing' } });

  const { runDeviceIntegrityJob } = await import('../src/lib/jobs/detect-device-integrity');
  const first = await runDeviceIntegrityJob();
  assert.equal(first.anomaliesCreated, 1, 'first run creates the anomaly');

  const second = await runDeviceIntegrityJob();
  assert.equal(second.anomaliesCreated, 0, 'second run same day → deduped');
  assert.equal(await db.anomaly.count({ where: { type: 'device_missing' } }), beforeCount + 1, 'exactly one anomaly row total');

  await db.device.delete({ where: { id: stale.id } });
});

test('DI-5: wired into runScheduledJobs under the shared lease + observability', async () => {
  const { runScheduledJobs } = await import('../src/lib/jobs/run');
  const result = await runScheduledJobs();

  assert.ok(result.deviceIntegrity, 'deviceIntegrity result present');
  assert.equal(result.errors.some((e) => e.startsWith('device_integrity')), false, 'job ran without error');

  const jobRun = await db.jobRun.findUnique({ where: { job: 'device_integrity' } });
  assert.ok(jobRun, 'JobRun lease row created');
  assert.equal(jobRun.status, 'completed');
  const lastResult = JSON.parse(jobRun.lastResult || '{}');
  assert.equal(typeof lastResult.devicesScanned, 'number', 'observability records the scan count');
});
