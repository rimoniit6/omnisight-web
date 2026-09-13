import 'dotenv/config';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { db } from '@/lib/db';
import { encryptSecret } from '@/lib/crypto';
import { hashPasswordSync } from '@/lib/auth';

// Identifiers (deterministic — re-runnable/idempotent).
const ORGS = {
  mgmt: { id: 'org-e2e-mgmt', slug: 'e2e-mgmt', name: 'E2E Managed Org', plan: 'e2e-plan-pro', sub: 'sub-e2e-mgmt', emp: 'emp-e2e-mgmt', empCode: 'E2E-MGMT-1', dev: 'dev-e2e-mgmt', agentKey: 'e2e-agent-mgmt', interval: 5 },
  cust: { id: 'org-e2e-cust', slug: 'e2e-cust', name: 'E2E Customer-DB Org', plan: 'e2e-plan-biz', sub: 'sub-e2e-cust', emp: 'emp-e2e-cust', empCode: 'E2E-CUST-1', dev: 'dev-e2e-cust', agentKey: 'e2e-agent-cust', interval: 5 },
  disabled: { id: 'org-e2e-disabled', slug: 'e2e-disabled', name: 'E2E Screenshots-Disabled Org', plan: 'e2e-plan-biz', sub: 'sub-e2e-disabled', emp: 'emp-e2e-disabled', empCode: 'E2E-DISABLED-1', dev: 'dev-e2e-disabled', agentKey: 'e2e-agent-disabled', interval: 0 },
};

const CUST_DB_DSN = {
  host: '127.0.0.1',
  port: 5433,
  name: 'omnisight_e2e_customer',
  user: 'omnisight_user',
  password: 'omnisight_password',
};

const ctx = { now: new Date(), in24h: new Date(Date.now() + 24 * 3600e3), in30d: new Date(Date.now() + 30 * 86400e3) };

async function upsertPlan(id: string, name: string, features: string[], price: number) {
  await db.plan.upsert({
    where: { name },
    create: { id, name, description: 'E2E test plan (seeded by scripts/e2e)', priceMonthly: price, currency: 'USD', maxDevices: 10, retentionDays: 30, features: JSON.stringify(features), isActive: true },
    update: { features: JSON.stringify(features), isActive: true, maxDevices: 10 },
  });
}

async function upsertOrg(o: (typeof ORGS)['mgmt'], deploymentMode: 'MANAGED' | 'CUSTOMER_DB') {
  await db.organization.upsert({
    where: { slug: o.slug },
    create: {
      id: o.id, name: o.name, slug: o.slug, status: 'active', timezone: 'UTC',
      screenshotInterval: o.interval, deploymentMode, trialEndsAt: null,
    },
    update: { status: 'active', timezone: 'UTC', screenshotInterval: o.interval, deploymentMode },
  });
  await db.subscription.upsert({
    where: { id: o.sub },
    create: {
      id: o.sub, organizationId: o.id, planId: o.plan, status: 'ACTIVE',
      startDate: new Date(Date.now() - 86400e3), endDate: ctx.in30d,
      billingPeriod: 'MONTHLY', deploymentModeSnapshot: deploymentMode, deviceQuantity: 10,
    },
    update: { status: 'ACTIVE', planId: o.plan, endDate: ctx.in30d, deploymentModeSnapshot: deploymentMode },
  });
  await db.organization.update({
    where: { id: o.id },
    data: { subscriptionId: o.sub },
  });
  await db.organizationSettings.upsert({
    where: { organizationId: o.id },
    create: { organizationId: o.id, useOwnDb: false },
    update: {},
  });
  if (deploymentMode === 'CUSTOMER_DB') {
    await db.organizationSettings.update({
      where: { organizationId: o.id },
      data: {
        useOwnDb: true,
        dbHost: CUST_DB_DSN.host,
        dbPort: CUST_DB_DSN.port,
        dbName: CUST_DB_DSN.name,
        dbUser: CUST_DB_DSN.user,
        dbPassword: encryptSecret(CUST_DB_DSN.password),
        dbSsl: false,
      },
    });
  }
  const settings: Array<[string, string, string]> = [
    ['screenshot_enabled', 'true', 'monitoring'],
    ['working_hours_only', 'false', 'monitoring'],
  ];
  if (o.interval > 0) settings.push(['screenshot_frequency', String(o.interval), 'monitoring']);
  for (const [key, value, category] of settings) {
    await db.organizationSetting.upsert({
      where: { organizationId_key: { organizationId: o.id, key } },
      create: { organizationId: o.id, key, value, category },
      update: { value, category },
    });
  }
}

async function upsertEmployeeConsentOrg(o: (typeof ORGS)['mgmt']) {
  await db.employee.upsert({
    where: { employeeId: o.empCode },
    create: {
      id: o.emp, employeeId: o.empCode, firstName: 'E2E', lastName: o.name.replace(/E2E | Org/g, '').trim() || 'User',
      email: `${o.empCode.toLowerCase()}@omnisight.test`, status: 'active', organizationId: o.id,
      agentApproved: true, type: 'employee',
    },
    update: { status: 'active', agentApproved: true, organizationId: o.id },
  });
  await db.device.upsert({
    where: { agentKey: o.agentKey },
    create: {
      id: o.dev, name: o.name + ' Laptop', hostname: 'e2e-host', operatingSystem: 'Windows 11',
      status: 'online', organizationId: o.id, employeeId: o.emp, agentKey: o.agentKey, agentVersion: 'e2e-1.0',
    },
    update: { status: 'online', organizationId: o.id, employeeId: o.emp },
  });
  await db.agentAccount.upsert({
    where: { employeeId: o.emp },
    create: { employeeId: o.emp, agentId: o.empCode.toLowerCase(), passwordHash: hashPasswordSync('e2e-password'), status: 'active' },
    update: { status: 'active' },
  });
  // Consent policy + granted consent for screenshots.
  const policyId = `cp-${o.id}-screenshot`;
  await db.consentPolicy.upsert({
    where: { organizationId_consentType_version: { organizationId: o.id, consentType: 'screenshot', version: 'v1' } },
    create: {
      id: policyId, organizationId: o.id, consentType: 'screenshot',
      title: 'Screenshot Monitoring Policy (e2e)', content: 'E2E policy content.', version: 'v1',
      status: 'published', effectiveAt: ctx.now, publishedAt: ctx.now, publishedBy: 'system',
    },
    update: { status: 'published', effectiveAt: ctx.now, publishedAt: ctx.now },
  });
  await db.consent.upsert({
    where: { employeeId_consentType: { employeeId: o.emp, consentType: 'screenshot' } },
    create: {
      id: `cons-${o.id}`, employeeId: o.emp, consentType: 'screenshot', status: 'granted',
      grantedAt: ctx.now, consentVersion: 'v1', policyId, organizationId: o.id,
    },
    update: { status: 'granted', grantedAt: ctx.now, consentVersion: 'v1', policyId, organizationId: o.id },
  });
}

async function seedTokens() {
  const tokens: Record<string, string> = {};
  for (const key of ['mgmt', 'cust', 'disabled']) {
    const o = ORGS[key as keyof typeof ORGS];
    const token = `tok_${o.slug.replace('e2e-', '')}_${randomBytes(24).toString('base64url')}`;
    await db.agentToken.create({ data: { token, employeeId: o.emp, organizationId: o.id, deviceId: o.dev, expiresAt: ctx.in24h, userAgent: 'e2e-harness' } });
    tokens[key] = token;
  }
  writeFileSync('scripts/e2e/state.json', JSON.stringify({ tokens, orgs: Object.fromEntries(Object.entries(ORGS).map(([k, v]) => [k, { id: v.id, emp: v.emp, dev: v.dev, empCode: v.empCode }])), custDb: CUST_DB_DSN }, null, 2));
}

async function seedAppUser() {
  const userId = 'user-e2e-mgr';
  await db.appUser.upsert({
    where: { email: 'e2e.manager@omnisight.test' },
    create: {
      id: userId, email: 'e2e.manager@omnisight.test', name: 'E2E Manager', role: 'manager',
      password: hashPasswordSync('E2e!password'), isActive: true, organizationId: ORGS.mgmt.id,
    },
    update: { role: 'manager', isActive: true },
  });
  for (const o of [ORGS.mgmt, ORGS.cust]) {
    await db.organizationMembership.upsert({
      where: { userId_organizationId: { userId, organizationId: o.id } },
      create: { userId, organizationId: o.id, role: 'manager', status: 'ACTIVE' },
      update: { role: 'manager', status: 'ACTIVE' },
    });
  }
  await db.userSession.deleteMany({ where: { userId } });
  await db.userSession.createMany({
    data: [
      { id: 'ws-sess-mgmt', userId, organizationId: ORGS.mgmt.id, activeOrganizationId: ORGS.mgmt.id, expiresAt: ctx.in24h },
      { id: 'ws-sess-cust', userId, organizationId: ORGS.cust.id, activeOrganizationId: ORGS.cust.id, expiresAt: ctx.in24h },
    ],
  });
}

async function main() {
  await upsertPlan('e2e-plan-pro', 'e2e-plan-pro', ['screenshots'], 299);
  await upsertPlan('e2e-plan-biz', 'e2e-plan-biz', ['screenshots'], 599);
  await upsertPlan('e2e-plan-lite', 'e2e-plan-lite', [], 99);

  await upsertOrg(ORGS.mgmt, 'MANAGED');
  await upsertOrg(ORGS.cust, 'CUSTOMER_DB');
  await upsertOrg(ORGS.disabled, 'MANAGED');

  await upsertEmployeeConsentOrg(ORGS.mgmt);
  await upsertEmployeeConsentOrg(ORGS.cust);
  await upsertEmployeeConsentOrg(ORGS.disabled);

  // Disabled org: screenshot + consent policy still granted, but org interval = 0 AND plan has no screenshots gate check on upload.
  await seedTokens();
  await seedAppUser();

  console.log('platform seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });