/**
 * Throwaway verification against the REAL Supabase database.
 * Creates one clearly-marked temporary org, exercises CRUD/relations/
 * transactions/JSON/cascade, then deletes the org (cascade cleanup).
 * Run:  set -a; . ./.env; set +a; npx tsx scripts/supabase-verify.ts
 */
import { db } from '../src/lib/db';

function ok(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const MARK = `CERT-SUPABASE-${Date.now()}`;

async function main(): Promise<void> {
  // 1. Migration status is verified separately via `prisma migrate status`.

  // 2. Tables + indexes.
  const tables = (await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  )) as { tablename: string }[];
  ok('table count = 42', tables.length === 42, `${tables.length} tables`);

  const indexes = (await db.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public'`
  )) as { indexname: string }[];
  ok('index count = 203', indexes.length === 203, `${indexes.length} indexes`);

  const idx = new Set(indexes.map((i) => i.indexname));
  const expectedIdx = ['Activity_employeeId_timestamp_idx', 'Activity_employeeId_category_idx', 'Screenshot_employeeId_capturedAt_idx', 'Anomaly_organizationId_createdAt_idx'];
  ok('high-volume query indexes present', expectedIdx.every((i) => idx.has(i)), expectedIdx.filter((i) => !idx.has(i)).join(',') || 'all present');

  // 3. Realtime wake-up triggers (migration 20260817130000).
  const triggers = (await db.$queryRawUnsafe(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`
  )) as { tgname: string }[];
  ok('realtime notify triggers exist', triggers.some((t) => String(t.tgname).includes('notify')), triggers.map((t) => String(t.tgname)).join(', ').slice(0, 120));

  // 4. CRUD / relations / transactions / JSON / cascade in a throwaway org.
  const org = await db.organization.create({ data: { name: MARK, slug: MARK.toLowerCase() } });
  const dept = await db.department.create({ data: { name: 'Eng', organizationId: org.id } });
  const emp = await db.employee.create({
    data: {
      employeeId: `${MARK}-E1`, firstName: 'Supabase', lastName: 'Probe',
      email: `${MARK.toLowerCase()}@test.local`, organizationId: org.id, departmentId: dept.id,
    },
  });
  ok('create org/department/employee (real Supabase)', Boolean(org.id && dept.id && emp.id));

  const read = await db.employee.findUnique({ where: { id: emp.id }, include: { department: true } });
  ok('read with relation', read?.department?.name === 'Eng');

  await db.employee.update({ where: { id: emp.id }, data: { designation: 'Engineer' } });
  ok('update', (await db.employee.findUnique({ where: { id: emp.id } }))?.designation === 'Engineer');

  await db.activity.create({ data: { type: 'application', title: 'probe', duration: 30, employeeId: emp.id } });
  ok('activity insert with FK', (await db.activity.count({ where: { employeeId: emp.id } })) === 1);

  try {
    await db.$transaction(async (tx) => {
      await tx.department.create({ data: { name: 'Rollback', organizationId: org.id } });
      throw new Error('rollback probe');
    });
    ok('transaction rollback', false);
  } catch {
    ok('transaction rollback', (await db.department.count({ where: { organizationId: org.id, name: 'Rollback' } })) === 0);
  }

  await db.policyViolation.create({
    data: {
      organizationId: org.id, employeeId: emp.id, policyId: 'p-probe', executableName: 'x.exe',
      action: 'blocked', severity: 'high', dedupeKey: `probe-${Date.now()}`,
      metadata: { probed: true },
    },
  });
  const pv = await db.policyViolation.findFirst({ where: { organizationId: org.id } });
  ok('JSON field round-trip', pv?.metadata !== null && (pv?.metadata as Record<string, unknown>).probed === true);

  ok('timestamps defaults', Boolean(org.createdAt) && Boolean(emp.createdAt));

  // Cascade delete of the throwaway org.
  await db.organization.delete({ where: { id: org.id } });
  const orphans = await db.employee.count({ where: { organizationId: org.id } });
  ok('cascade delete (org → employee) cleaned up', orphans === 0);
  const leftover = await db.organization.findUnique({ where: { id: org.id } });
  ok('throwaway org fully removed', leftover === null);
}

main()
  .catch((e) => { console.error('VERIFY FAILED:', e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
