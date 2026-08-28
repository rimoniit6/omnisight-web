/**
 * Location ingestion service — focused tests for the 5 KM movement filter.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_location), never
 * the production DB. Covers the critical business rules:
 *   - first location is always accepted
 *   - movement < 5 KM is ignored (no new history event)
 *   - movement >= 5 KM from the LAST ACCEPTED location is accepted
 *   - small movements cannot accumulate to cross the threshold
 *   - concurrent ingestion cannot create duplicate baseline events
 *   - per-employee isolation (no cross-employee leakage)
 *
 * Run: npm run test:location   (or npx tsx --test tests/location-service.test.ts)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ─── Test DB isolation ──────────────────────────────────────────────────────
// Must be set BEFORE any app module is imported (Prisma reads DATABASE_URL
// at client construction time).
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_location';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-location-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

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

let db: typeof import('../src/lib/db')['db'];
let recordAgentLocation: typeof import('../src/lib/location-service')['recordAgentLocation'];

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const locModule = await import('../src/lib/location-service');
  recordAgentLocation = locModule.recordAgentLocation;
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

// ─── Fixtures ───────────────────────────────────────────────────────────────
const BASE = { lat: 51.5074, lng: -0.1278 };
const KM_PER_DEG_LAT = 111.32;
// Move `km` kilometres due north so distance is purely latitude-based.
function north(base: { lat: number; lng: number }, km: number) {
  return { latitude: base.lat + km / KM_PER_DEG_LAT, longitude: base.lng };
}

async function seedEmployee(slug: string) {
  const org = await db.organization.create({ data: { name: slug, slug } });
  const emp = await db.employee.create({
    data: {
      employeeId: `${slug}-001`,
      firstName: slug,
      lastName: 'Test',
      email: `${slug.toLowerCase()}@test.local`,
      organizationId: org.id,
      status: 'active',
    },
  });
  return { org, emp };
}

async function ingest(empId: string, orgId: string, km: number, at: Date = new Date()) {
  const p = north(BASE, km);
  return recordAgentLocation({
    employeeId: empId,
    organizationId: orgId,
    deviceId: null,
    latitude: p.latitude,
    longitude: p.longitude,
    accuracy: 10,
    recordedAt: at,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('LOC-D5: first location for an employee is always accepted', async () => {
  const { org, emp } = await seedEmployee('loc-first');
  const r = await ingest(emp.id, org.id, 0);
  assert.equal(r.accepted, true);
  assert.equal(r.first, true);
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 1);
});

test('LOC-D6: movement < 5 KM is ignored (no history event)', async () => {
  const { org, emp } = await seedEmployee('loc-below');
  // baseline accepted
  const first = await ingest(emp.id, org.id, 0);
  assert.equal(first.accepted, true);

  // 3 km north — below threshold
  const r = await ingest(emp.id, org.id, 3);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'below_movement_threshold');
  assert.ok(r.distanceKm >= 2.9 && r.distanceKm <= 3.1);
  // Nothing new stored.
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 1);
});

test('LOC-D7: movement >= 5 KM from last accepted is accepted', async () => {
  const { org, emp } = await seedEmployee('loc-above');
  await ingest(emp.id, org.id, 0); // baseline

  const r = await ingest(emp.id, org.id, 6); // 6 km north
  assert.equal(r.accepted, true);
  assert.equal(r.first, false);
  assert.ok(r.distanceKm >= 5.9 && r.distanceKm <= 6.1);
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 2);
});

test('LOC-D8: next comparison is against the LAST ACCEPTED location, not the last raw reading', async () => {
  const { org, emp } = await seedEmployee('loc-lastaccepted');
  await ingest(emp.id, org.id, 0); // baseline (accepted)
  const above = await ingest(emp.id, org.id, 6); // 6 km north (accepted)
  assert.equal(above.accepted, true);

  // 6 km further north from baseline = 12 km north total. Distance from the
  // LAST ACCEPTED (6 km point) is 6 km -> accepted.
  const r = await ingest(emp.id, org.id, 12);
  assert.equal(r.accepted, true);
  assert.ok(r.distanceKm >= 5.9 && r.distanceKm <= 6.1, `expected ~6 km, got ${r.distanceKm}`);
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 3);
});

test('LOC-D9: small movements cannot accumulate to cross the threshold', async () => {
  const { org, emp } = await seedEmployee('loc-accumulate');
  await ingest(emp.id, org.id, 0); // baseline

  // A series of tiny moves (each 0.2 km), none of which alone crosses 5 km
  // from the last ACCEPTED location. Even after many of them spanning 4.8 km,
  // nothing is stored because each is measured from the baseline.
  for (let k = 1; k <= 24; k++) {
    const r = await ingest(emp.id, org.id, k * 0.2); // last is 4.8 km
    assert.equal(r.accepted, false, `step ${k} must be rejected`);
  }
  // Still only the baseline event exists.
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 1);
});

test('LOC-D10: concurrent ingestion cannot create duplicate baseline events', async () => {
  const { org, emp } = await seedEmployee('loc-concurrent');
  // Establish baseline.
  await ingest(emp.id, org.id, 0);

  // Two near-simultaneous fixes at the SAME new coordinate (5.1 km north).
  const [a, b] = await Promise.allSettled([
    ingest(emp.id, org.id, 5.1),
    ingest(emp.id, org.id, 5.1),
  ]);
  const results = [a, b].map((s) => (s.status === 'fulfilled' ? s.value : null));
  const acceptedCount = results.filter((r) => r && r.accepted).length;
  assert.equal(acceptedCount, 1, 'exactly one of the concurrent fixes is accepted');

  // Total accepted events = baseline + 1 (no duplicate baseline created).
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 2);
});

test('LOC-ISO: per-employee isolation — fixes never leak across employees', async () => {
  const { org: orgA, emp: empA } = await seedEmployee('loc-iso-a');
  const { emp: empB } = await seedEmployee('loc-iso-b');

  await ingest(empA.id, orgA.id, 0); // baseline for A
  await ingest(empB.id, orgA.id, 0); // baseline for B (same coords)

  // A moves 6 km -> accepted for A only.
  const rA = await ingest(empA.id, orgA.id, 6);
  assert.equal(rA.accepted, true);

  // B has its own timeline; A's accepted move must not appear under B.
  assert.equal(await db.locationEvent.count({ where: { employeeId: empA.id } }), 2);
  assert.equal(await db.locationEvent.count({ where: { employeeId: empB.id } }), 1);
});
