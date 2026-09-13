import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

interface State {
  orgs: Record<string, { id: string; emp: string; empCode: string; dev: string }>;
  custDb: { host: string; port: number; name: string; user: string; password: string };
}

const state: State = JSON.parse(readFileSync('scripts/e2e/state.json', 'utf8'));
const cust = state.orgs.cust;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `postgresql://${encodeURIComponent(state.custDb.user)}:${encodeURIComponent(state.custDb.password)}@${state.custDb.host}:${state.custDb.port}/${state.custDb.name}`,
    },
  },
});

async function main() {
  const now = new Date();
  // Organization row exists to satisfy FK constraints on every org-owned row.
  await prisma.organization.upsert({
    where: { id: cust.id },
    create: { id: cust.id, name: 'E2E Customer-DB Org', slug: 'e2e-cust', status: 'active', timezone: 'UTC', screenshotInterval: 5, deploymentMode: 'CUSTOMER_DB' },
    update: {},
  });
  await prisma.employee.upsert({
    where: { id: cust.emp },
    create: { id: cust.emp, employeeId: cust.empCode, firstName: 'E2E', lastName: 'Customer', email: 'e2e.cust1@omnisight.test', status: 'active', organizationId: cust.id, agentApproved: true, type: 'employee' },
    update: { status: 'active', agentApproved: true, organizationId: cust.id },
  });
  await prisma.device.upsert({
    where: { id: cust.dev },
    create: { id: cust.dev, name: 'E2E Customer Laptop', hostname: 'e2e-cust-host', operatingSystem: 'Windows 11', status: 'online', organizationId: cust.id, employeeId: cust.emp, agentKey: 'e2e-agent-cust', agentVersion: 'e2e-1.0' },
    update: { status: 'online' },
  });
  const policyId = `cp-${cust.id}-screenshot`;
  await prisma.consentPolicy.upsert({
    where: { organizationId_consentType_version: { organizationId: cust.id, consentType: 'screenshot', version: 'v1' } },
    create: { id: policyId, organizationId: cust.id, consentType: 'screenshot', title: 'Screenshot Monitoring Policy (e2e)', content: 'E2E policy content.', version: 'v1', status: 'published', effectiveAt: now, publishedAt: now, publishedBy: 'system' },
    update: { status: 'published' },
  });
  await prisma.consent.upsert({
    where: { employeeId_consentType: { employeeId: cust.emp, consentType: 'screenshot' } },
    create: { id: `cons-${cust.id}`, employeeId: cust.emp, consentType: 'screenshot', status: 'granted', grantedAt: now, consentVersion: 'v1', policyId, organizationId: cust.id },
    update: { status: 'granted' },
  });
  console.log('customer-db seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });