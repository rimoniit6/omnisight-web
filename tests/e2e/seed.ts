/**
 * E2E seed — prepares a dedicated throwaway PostgreSQL database for the
 * Playwright browser suite and seeds deterministic fixtures:
 *
 *   Org A ("Acme E2E")  → owner / admin / manager / viewer users, department,
 *                         employees, device, activities, screenshot, project
 *   Org B ("Beta E2E")  → separate tenant used by cross-tenant assertions
 *   Super admin         → org-less platform administrator
 *
 * Run: npx tsx tests/e2e/seed.ts
 * Env: PG_TEST_BASE_URL (default postgresql://postgres:123456@localhost:5432)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import bcrypt from 'bcryptjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const DB_NAME = 'workai_test_e2e';
export const DATABASE_URL = `${PG_TEST_BASE}/${DB_NAME}?schema=public`;

const CREDENTIALS = {
  superAdmin: { email: 'super@e2e.local', password: 'Super!E2e-1234' },
  owner: { email: 'owner@acme-e2e.test', password: 'Owner!E2e-1234' },
  admin: { email: 'admin@acme-e2e.test', password: 'Admin!E2e-1234' },
  manager: { email: 'manager@acme-e2e.test', password: 'Manager!E2e-1234' },
  viewer: { email: 'viewer@acme-e2e.test', password: 'Viewer!E2e-1234' },
  // Owner of the SECOND organization — used for cross-tenant isolation checks.
  betaOwner: { email: 'owner@beta-e2e.test', password: 'Beta!E2e-1234' },
};

async function main() {
  process.env.PG_TEST_BASE_URL = PG_TEST_BASE;
  execSync(`node scripts/pg-test-db.mjs ensure ${DB_NAME}`, {
    cwd: ROOT,
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'inherit',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    cwd: ROOT,
    // Both URLs must be overridden: the Prisma CLI auto-loads ./.env, and the
    // schema's directUrl would otherwise win over our throwaway DATABASE_URL.
    env: { ...process.env, DATABASE_URL, DIRECT_URL: DATABASE_URL },
    stdio: 'inherit',
  });

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.DIRECT_URL = DATABASE_URL;
  process.env.JWT_SECRET = 'e2e-jwt-secret-0123456789abcdef-test';
  process.env.SUPER_ADMIN_EMAIL = CREDENTIALS.superAdmin.email;
  process.env.SUPER_ADMIN_PASSWORD = CREDENTIALS.superAdmin.password;
  process.env.STORAGE_DRIVER = 'local';
  const { db } = await import('../../src/lib/db');

  const password = (plain: string) => bcrypt.hashSync(plain, 10);
  const now = new Date();

  // ─── Organizations ────────────────────────────────────────────────────────
  const orgA = await db.organization.create({
    data: {
      name: 'Acme E2E',
      slug: 'acme-e2e',
      email: 'contact@acme-e2e.test',
      status: 'active',
      timezone: 'Asia/Dhaka',
      currency: 'USD',
    },
  });
  const orgB = await db.organization.create({
    data: {
      name: 'Beta E2E',
      slug: 'beta-e2e',
      email: 'contact@beta-e2e.test',
      status: 'active',
    },
  });

  // ─── Users (all five roles) ───────────────────────────────────────────────
  await db.appUser.create({
    data: {
      email: CREDENTIALS.superAdmin.email,
      name: 'Sasha Super',
      password: password(CREDENTIALS.superAdmin.password),
      role: 'super_admin',
      isActive: true,
    },
  });
  for (const [role, creds] of Object.entries(CREDENTIALS).filter(
    ([r]) => r !== 'superAdmin' && r !== 'betaOwner'
  )) {
    await db.appUser.create({
      data: {
        email: creds.email,
        name: `${role[0].toUpperCase()}${role.slice(1)} User`,
        password: password(creds.password),
        role,
        organizationId: orgA.id,
        isActive: true,
      },
    });
  }
  // A second-org owner — proves cross-tenant boundaries at the UI/API level.
  const betaOwnerUser = await db.appUser.create({
    data: {
      email: CREDENTIALS.betaOwner.email,
      name: 'Beta Owner',
      password: password(CREDENTIALS.betaOwner.password),
      role: 'owner',
      organizationId: orgB.id,
      isActive: true,
    },
  });

  // ─── OrganizationMemberships (RBAC source of truth) ──────────────────
  // The RBAC system resolves effective roles from OrganizationMembership,
  // not AppUser.role. Without these rows, login falls back to the legacy
  // AppUser.role field which may not match the membership hierarchy.
  const orgAUsers = await db.appUser.findMany({ where: { organizationId: orgA.id } });
  const roleMap: Record<string, string> = {
    owner: 'admin',
    admin: 'admin',
    manager: 'manager',
    viewer: 'viewer',
  };
  for (const u of orgAUsers) {
    const memRole = roleMap[u.role] ?? 'viewer';
    await db.organizationMembership.create({
      data: { userId: u.id, organizationId: orgA.id, role: memRole, status: 'ACTIVE' },
    });
  }
  await db.organizationMembership.create({
    data: { userId: betaOwnerUser.id, organizationId: orgB.id, role: 'admin', status: 'ACTIVE' },
  });

  // ─── Departments / Employees / Devices ────────────────────────────────────
  const engA = await db.department.create({ data: { name: 'Engineering', organizationId: orgA.id } });
  const salesB = await db.department.create({ data: { name: 'Sales', organizationId: orgB.id } });

  const emp1 = await db.employee.create({
    data: {
      employeeId: 'EMP-E2E-001',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@acme-e2e.test',
      designation: 'Senior Engineer',
      organizationId: orgA.id,
      departmentId: engA.id,
      status: 'active',
      joinDate: new Date('2025-01-15'),
    },
  });
  const emp2 = await db.employee.create({
    data: {
      employeeId: 'EMP-E2E-002',
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@acme-e2e.test',
      designation: 'Engineer',
      organizationId: orgA.id,
      departmentId: engA.id,
      status: 'inactive',
      joinDate: new Date('2025-02-01'),
    },
  });
  await db.employee.create({
    data: {
      employeeId: 'EMP-BETA-001',
      firstName: 'Bob',
      lastName: 'Beta',
      email: 'bob@beta-e2e.test',
      organizationId: orgB.id,
      departmentId: salesB.id,
      status: 'active',
    },
  });

  const devA = await db.device.create({
    data: {
      name: 'ACME-WS-01',
      hostname: 'ACME-WS-01',
      operatingSystem: 'Windows 11 Pro',
      status: 'online',
      lastHeartbeat: now,
      organizationId: orgA.id,
      employeeId: emp1.id,
      agentVersion: '1.0.0-e2e',
    },
  });
  await db.device.create({
    data: {
      name: 'ACME-WS-OFFLINE',
      hostname: 'ACME-WS-OFFLINE',
      operatingSystem: 'Windows 10',
      status: 'offline',
      lastHeartbeat: new Date(now.getTime() - 48 * 3600 * 1000),
      organizationId: orgA.id,
      employeeId: emp2.id,
    },
  });
  const devB = await db.device.create({
    data: {
      name: 'BETA-WS-01',
      hostname: 'BETA-WS-01',
      operatingSystem: 'Windows 11',
      status: 'online',
      lastHeartbeat: now,
      organizationId: orgB.id,
    },
  });

  // ─── Activities (today) ───────────────────────────────────────────────────
  const base = new Date(now.getTime() - 3600 * 1000);
  for (const [i, a] of [
    { type: 'website', title: 'GitHub — Pull Requests', url: 'github.com', category: 'productive', duration: 900 },
    { type: 'application', title: 'Visual Studio Code', applicationName: 'Code.exe', category: 'productive', duration: 2400 },
    { type: 'website', title: 'Example News', url: 'example-news.test', category: 'unproductive', duration: 300 },
  ].entries()) {
    await db.activity.create({
      data: {
        type: a.type,
        title: a.title,
        url: a.url ?? null,
        applicationName: a.applicationName ?? null,
        category: a.category,
        duration: a.duration,
        employeeId: emp1.id,
        deviceId: devA.id,
        timestamp: new Date(base.getTime() + i * 10 * 60 * 1000),
      },
    });
  }
  await db.activity.create({
    data: {
      type: 'application',
      title: 'Beta CRM',
      applicationName: 'crm.exe',
      category: 'neutral',
      duration: 600,
      employeeId: (await db.employee.findFirstOrThrow({ where: { employeeId: 'EMP-BETA-001' } })).id,
      deviceId: devB.id,
      timestamp: base,
    },
  });

  // ─── Screenshot metadata + physical file (local driver layout) ────────────
  // A real 1x1 PNG so the screenshots page can render an actual image.
  const PNG_1X1 = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082',
    'hex'
  );
  const shotName = `${now.getTime()}-e2e-shot.png`;
  const shotsDir = join(ROOT, 'uploads', 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(join(shotsDir, shotName), PNG_1X1);
  await db.screenshot.create({
    data: {
      employeeId: emp1.id,
      deviceId: devA.id,
      filePath: `/uploads/screenshots/${shotName}`,
      fileName: shotName,
      fileSize: PNG_1X1.length,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      appWindow: 'Visual Studio Code',
      organizationId: orgA.id,
      capturedAt: now,
    },
  });

  // ─── Project with member + time entry ─────────────────────────────────────
  const project = await db.project.create({
    data: {
      name: 'Apollo Migration',
      description: 'E2E fixture project',
      status: 'active',
      priority: 'high',
      estimatedHours: 120,
      startDate: new Date(now.getTime() - 14 * 86400e3),
      deadline: new Date(now.getTime() + 30 * 86400e3),
      organizationId: orgA.id,
    },
  });
  await db.projectMember.create({
    data: { projectId: project.id, employeeId: emp1.id, role: 'lead', organizationId: orgA.id },
  });
  await db.project.create({
    data: {
      name: 'Beta Website Revamp',
      description: 'E2E fixture project for the second tenant',
      status: 'active',
      organizationId: orgB.id,
    },
  });

  await db.$disconnect();

  // Machine-readable credentials for the Playwright helpers.
  const outPath = join(ROOT, 'tests/e2e/.auth/credentials.json');
  mkdirSync(join(ROOT, 'tests/e2e/.auth'), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ baseUrl: process.env.E2E_BASE_URL || 'http://localhost:3100', credentials: CREDENTIALS }, null, 2)
  );
  console.log(`E2E seed complete → ${DB_NAME} (credentials manifest written)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
