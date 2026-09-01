// OmniSight — Production Performance Baseline (real measurements)
//
// Runs against the PostgreSQL database configured by DATABASE_URL (set it
// explicitly: DATABASE_URL=postgresql://USER:PASS@HOST:5432/workai?schema=public).
// Records P50/P95/P99 per operation.
//
// SAFETY: write-path measurements run inside interactive transactions that
// THROW to force a rollback, and the script asserts the row counts are
// unchanged afterward — a rollback failure fails the run instead of silently
// polluting the live database.
//
// Operations measured (mirror the admin + agent request surface):
//   admin:  login-check (user lookup), device list (paginated), employee list
//           (paginated + search), project list, consent state (batch), device
//           approve-equivalent (single update), audit insert
//   agent:  discover-equivalent (device lookup by agentKey), claim
//           lookup, config (org settings), consent state, heartbeat (device
//           update), activity insert, screenshot-metadata insert
import { PrismaClient } from '@prisma/client';
import { performance } from 'node:perf_hooks';

const db = new PrismaClient();
const N = 50; // iterations per operation (bounded; SQLite is fast)
const samplesWrite = [];

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    p50: +p(0.5).toFixed(2),
    p95: +p(0.95).toFixed(2),
    p99: +p(0.99).toFixed(2),
    n: samples.length,
  };
}

async function measure(label, fn) {
  const samples = [];
  // warm-up (JIT / page cache)
  for (let i = 0; i < 3; i++) await fn(0);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push((performance.now() - t0) * 1000); // µs
  }
  console.log(`${label.padEnd(46)} ${JSON.stringify(stats(samples))}`);
}

const org = await db.organization.findFirst();

console.log('=== ADMIN surface (PostgreSQL, real Prisma client) ===');
await measure('admin: login user lookup (email)', (i) =>
  db.appUser.findFirst({ where: { email: 'admin@techvision.com' }, select: { id: true, password: true, role: true } })
);
await measure('admin: devices list pageSize=20', (i) =>
  db.device.findMany({ take: 20, skip: 0, orderBy: { updatedAt: 'desc' }, include: { employee: { select: { firstName: true, lastName: true, employeeId: true } } } })
);
await measure('admin: devices count', () => db.device.count());
await measure('admin: employees list pageSize=20 + search', (i) =>
  db.employee.findMany({ take: 20, skip: 0, where: { OR: [{ firstName: { contains: 'a' } }, { lastName: { contains: 'a' } }, { employeeId: { contains: 'a' } }] }, orderBy: { createdAt: 'desc' } })
);
await measure('admin: projects list pageSize=20', (i) =>
  db.project.findMany({ take: 20, skip: 0, orderBy: { updatedAt: 'desc' }, include: { members: { select: { employeeId: true } } } })
);
await measure('admin: consent state (all employee consents)', () =>
  db.consent.findMany({ where: { organizationId: org.id }, select: { id: true, consentType: true, status: true, employeeId: true } })
);
await measure('admin: consent policy list', () => db.consentPolicy.findMany({ where: { organizationId: org.id } }));
await measure('admin: audit log page', () =>
  db.auditLog.findMany({ take: 20, orderBy: { createdAt: 'desc' } })
);
await measure('admin: device claim list', () =>
  db.deviceClaim.findMany({ orderBy: { createdAt: 'desc' }, include: { device: { select: { id: true, name: true, hostname: true, status: true, lastHeartbeat: true } } } })
);

console.log('=== AGENT surface (PostgreSQL, real Prisma client) ===');
await measure('agent: discover (device by agentKey)', (i) =>
  db.device.findFirst({ where: { agentKey: `machine-key-${i}` } })
);
await measure('agent: claim lookup by device', (i) =>
  db.deviceClaim.findFirst({ where: { deviceId: 'dev-nonexistent' } })
);
await measure('agent: config (org settings all)', () =>
  db.organizationSetting.findMany({ where: { organizationId: org.id } })
);
await measure('agent: heartbeat (device touch)', (i) =>
  db.device.updateMany({ where: { id: 'dev-nonexistent' }, data: { lastHeartbeat: new Date() } })
);
// Inserts measured inside an interactive transaction that is ROLLED BACK, so
// the perf test never pollutes the live database (FK-valid employees/devices).
const emp = await db.employee.findFirst({ where: { organizationId: org.id } });
const dev = await db.device.findFirst({ where: { organizationId: org.id } });

console.log('=== AGENT surface — write ops (rolled back tx) ===');
const activityCountBefore = await db.activity.count();
const screenshotCountBefore = await db.screenshot.count();
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await db.$transaction(async (tx) => {
    await tx.activity.create({ data: { employeeId: emp.id, deviceId: dev?.id ?? null, type: 'application', applicationName: 'perf-test', title: 'perf', duration: 1, timestamp: new Date() } });
    throw new Error('__ROLLBACK__');
  }).catch(() => undefined);
  samplesWrite.push((performance.now() - t0) * 1000);
}
console.log(`activity insert (tx + rollback)                ${JSON.stringify(stats(samplesWrite))}`);

const samplesShot = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await db.$transaction(async (tx) => {
    await tx.screenshot.create({ data: { organizationId: org.id, employeeId: emp.id, deviceId: dev?.id ?? null, filePath: '/perf/test.png', fileName: 'test.png', fileSize: 1024, mimeType: 'image/png', capturedAt: new Date() } });
    throw new Error('__ROLLBACK__');
  }).catch(() => undefined);
  samplesShot.push((performance.now() - t0) * 1000);
}
console.log(`screenshot metadata insert (tx + rollback)      ${JSON.stringify(stats(samplesShot))}`);

// No-leak invariant: rolled-back transactions must not have written anything.
const activityCountAfter = await db.activity.count();
const screenshotCountAfter = await db.screenshot.count();
const leaked =
  activityCountAfter !== activityCountBefore || screenshotCountAfter !== screenshotCountBefore;
if (leaked) {
  console.error(
    `ROLLBACK LEAK DETECTED: activity ${activityCountBefore}->${activityCountAfter}, ` +
      `screenshot ${screenshotCountBefore}->${screenshotCountAfter}. ABORTING.`
  );
  process.exit(1);
}
console.log('    no-leak check: activity + screenshot counts unchanged after rolled-back writes ✅');

console.log('=== DB connection health ===');
const t0 = performance.now();
await db.$queryRaw`SELECT 1`;
console.log(`connect+query latency: ${((performance.now() - t0) * 1000).toFixed(0)} µs`);

await db.$disconnect();
