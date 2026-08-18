/**
 * Fresh-database migration verification (phase 3 gate 6, PostgreSQL edition).
 * Usage (throwaway PG database):
 *   node scripts/pg-test-db.mjs ensure workai_test_migrate
 *   DATABASE_URL='postgresql://postgres:123456@localhost:5432/workai_test_migrate?schema=public' npx prisma migrate deploy
 *   DATABASE_URL='postgresql://postgres:123456@localhost:5432/workai_test_migrate?schema=public' npx tsx scripts/migration-verify.mjs
 *   node scripts/pg-test-db.mjs drop workai_test_migrate
 * Verifies every consent-related table, index, FK constraint and the
 * RESTRICT immutability behavior on a schema produced purely by `migrate deploy`.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

let failures = 0;
function check(name, ok) {
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✖'} ${name}`);
}

const tables = (await db.$queryRawUnsafe(
  `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`
)).map((r) => r.name);
for (const t of ['ConsentPolicy', 'Consent', 'ConsentLog', 'OrganizationSetting', 'JobRun', 'Screenshot', 'Activity', 'AuditLog']) {
  check(`table ${t} exists`, tables.includes(t));
}

const consentCols = (await db.$queryRawUnsafe(
  `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'Consent'`
)).map((c) => c.name);
check('Consent has expiredAt', consentCols.includes('expiredAt'));

// ConsentLog FK delete rule: confdeltype 'r' = RESTRICT.
const clogFk = await db.$queryRawUnsafe(
  `SELECT confdeltype FROM pg_constraint WHERE conrelid = '"ConsentLog"'::regclass AND contype = 'f'`
);
check(`ConsentLog FK on_delete is RESTRICT (got ${clogFk[0]?.confdeltype})`, clogFk[0]?.confdeltype === 'r');

const jrCols = (await db.$queryRawUnsafe(
  `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'JobRun'`
)).map((c) => c.name);
check('JobRun has lastResult', jrCols.includes('lastResult'));

const consentIdx = (await db.$queryRawUnsafe(
  `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Consent'`
)).map((i) => i.name);
check('Consent has unique(employeeId,consentType)', consentIdx.includes('Consent_employeeId_consentType_key'));
check('Consent has status index', consentIdx.some((n) => n.includes('status')));
check('Consent has organizationId index', consentIdx.some((n) => n.includes('organizationId')));

const polIdx = (await db.$queryRawUnsafe(
  `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ConsentPolicy'`
)).map((i) => i.name);
check('ConsentPolicy has org+type+version unique', polIdx.some((n) => n.includes('organizationId_consentType_version')));

// RESTRICT behavior: a Consent owning ConsentLog entries cannot be deleted.
const org = await db.organization.create({ data: { name: 'mig-org', slug: 'mig-org' } });
const emp = await db.employee.create({
  data: { employeeId: 'MIG-1', firstName: 'M', lastName: 'G', email: 'mig@test.local', organizationId: org.id },
});
const c = await db.consent.create({ data: { employeeId: emp.id, consentType: 'screenshot', status: 'granted', organizationId: org.id } });
await db.consentLog.create({ data: { consentId: c.id, action: 'granted', description: 'x', organizationId: org.id } });
let blocked = false;
try {
  await db.consent.delete({ where: { id: c.id } });
} catch {
  blocked = true;
}
check('RESTRICT blocks deleting a consent that owns logs', blocked);

// A consent with no logs can still be erased.
const bare = await db.consent.create({ data: { employeeId: emp.id, consentType: 'keystroke', status: 'pending', organizationId: org.id } });
await db.consent.delete({ where: { id: bare.id } });
check('bare consent (no logs) is erasable', true);

await db.$disconnect();
console.log(failures === 0 ? 'MIGRATION VERIFY: ALL CHECKS PASSED' : `MIGRATION VERIFY: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
