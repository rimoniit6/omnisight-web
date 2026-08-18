// Provisions throwaway agent tokens + a cross-org fixture for the E2E consent
// smoke test, and writes scripts/.smoke-fixtures.json describing which
// employees back each scenario. Runs against whatever DATABASE_URL is set
// (the smoke harness uses a throwaway copy of the demo DB). The live demo DB
// is never modified by the smoke run itself.
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPasswordSync } from '../src/lib/auth';

const db = new PrismaClient();

async function main() {
  // Discover an approved, active employee with BOTH screenshot and activity
  // consent granted (scenario: agent uploads succeed), and one with the
  // screenshot consent REVOKED (scenario: uploads blocked).
  const approved = await db.employee.findMany({
    where: { status: 'active', agentApproved: true },
    select: { id: true, employeeId: true, organizationId: true },
  });
  const consents = await db.consent.findMany({
    where: { consentType: { in: ['screenshot', 'activity_tracking'] } },
    select: { employeeId: true, consentType: true, status: true },
  });
  const byType = new Map();
  for (const c of consents) {
    if (!byType.has(c.employeeId)) byType.set(c.employeeId, {});
    byType.get(c.employeeId)[c.consentType] = c.status;
  }

  const grantedBoth = approved.filter(
    (e) => byType.get(e.id)?.screenshot === 'granted' && byType.get(e.id)?.activity_tracking === 'granted'
  );
  const revokedShot = approved.filter((e) => byType.get(e.id)?.screenshot === 'revoked');

  if (grantedBoth.length === 0 || revokedShot.length === 0) {
    throw new Error(`Scenario employees not found in data (grantedBoth=${grantedBoth.length}, revokedShot=${revokedShot.length}). Re-seed the demo DB first.`);
  }

  const empGranted = grantedBoth[0];
  const empRevoked = revokedShot[0];

  const tokens = [
    { token: `smoke-token-${empGranted.employeeId.toLowerCase()}-0123456789abcdef`, employee: empGranted },
    { token: `smoke-token-${empRevoked.employeeId.toLowerCase()}-0123456789abcdef`, employee: empRevoked },
  ];
  for (const t of tokens) {
    await db.agentToken.upsert({
      where: { token: t.token },
      update: { employeeId: t.employee.id, expiresAt: new Date(Date.now() + 3600_000) },
      create: {
        token: t.token,
        employeeId: t.employee.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
  }

  // Cross-org fixture: a second organization with its own admin + employee +
  // consent, so the smoke test can verify org A cannot touch org B data.
  const orgB = await db.organization.upsert({
    where: { slug: 'smoke-org-b' },
    update: {},
    create: { name: 'Smoke Org B', slug: 'smoke-org-b' },
  });
  await db.appUser.upsert({
    where: { email: 'adminb@smoke.test' },
    update: { role: 'admin', organizationId: orgB.id, isActive: true },
    create: {
      email: 'adminb@smoke.test',
      name: 'Org B Admin',
      role: 'admin',
      password: hashPasswordSync('adminb123'),
      organizationId: orgB.id,
      isActive: true,
    },
  });
  const empB = await db.employee.upsert({
    where: { employeeId: 'SMOKE-B-001' },
    update: { organizationId: orgB.id },
    create: {
      employeeId: 'SMOKE-B-001',
      firstName: 'Org',
      lastName: 'B',
      email: 'smokeb001@smoke.test',
      organizationId: orgB.id,
      status: 'active',
    },
  });
  await db.consentPolicy.upsert({
    where: { organizationId_consentType_version: { organizationId: orgB.id, consentType: 'screenshot', version: 'v1' } },
    update: {},
    create: {
      organizationId: orgB.id,
      consentType: 'screenshot',
      title: 'Org B screenshot policy',
      content: 'Org B policy content for screenshot capture with retention and rights details.',
      version: 'v1',
      status: 'published',
      effectiveAt: new Date(),
      createdBy: 'smoke',
    },
  });
  const consentB = await db.consent.upsert({
    where: { employeeId_consentType: { employeeId: empB.id, consentType: 'screenshot' } },
    update: {},
    create: {
      employeeId: empB.id,
      consentType: 'screenshot',
      status: 'granted',
      grantedAt: new Date(),
      consentVersion: 'v1',
      organizationId: orgB.id,
    },
  });

  writeFileSync(
    join(process.cwd(), 'scripts', '.smoke-fixtures.json'),
    JSON.stringify({
      tokenGranted: tokens[0].token,
      tokenRevoked: tokens[1].token,
      empGrantedId: empGranted.employeeId,
      empRevokedId: empRevoked.employeeId,
      orgBId: orgB.id,
      consentBId: consentB.id,
    })
  );
  console.log(`Fixtures: granted=${empGranted.employeeId}, revoked=${empRevoked.employeeId}, orgB=${orgB.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
