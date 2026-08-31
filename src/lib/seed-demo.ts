/**
 * OmniSight Demo Seed (Optimized — batch inserts)
 * ─────────────────────────────────────────────────
 * Creates a realistic demo organization with employees, departments, devices,
 * activities, projects, and all supporting data for showcase purposes.
 *
 * Uses createMany for bulk inserts to complete quickly against remote databases.
 *
 * Run with:  npm run db:seed:demo
 * Requires:  SEED_ALLOWED=1 and a running PostgreSQL database.
 */
import { db } from '@/lib/db';
import { hashPasswordSync } from '@/lib/auth';
import { randomBytes } from 'crypto';
import { bootstrapSuperAdmin } from '@/lib/super-admin';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFloat(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3600_000);
}
function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}
function macAddress(): string {
  return Array.from({ length: 6 }, () =>
    randInt(0, 255).toString(16).padStart(2, '0')
  ).join(':');
}
function ipAddress(): string {
  return `10.0.${randInt(1, 10)}.${randInt(10, 250)}`;
}
function randomCuid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 25; i++) result += chars[randInt(0, chars.length - 1)];
  return result;
}

// Batch insert helper — creates records in chunks to avoid parameter limits
async function batchCreate<T extends Record<string, unknown>>(
  tx: typeof db,
  table: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<{ count: number }> },
  records: T[],
  chunkSize = 100
): Promise<number> {
  let total = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const result = await table.createMany({ data: chunk, skipDuplicates: true });
    total += result.count;
  }
  return total;
}

// ─── Static Data ──────────────────────────────────────────────────────────────
const ORG = {
  name: 'Acme Technologies',
  slug: 'acme-tech',
  email: 'info@acmetech.com',
  phone: '+1-555-0100',
  timezone: 'America/New_York',
  address: '350 Fifth Avenue, New York, NY 10118',
};

const DEPARTMENTS = [
  { name: 'Engineering', description: 'Software development and infrastructure' },
  { name: 'Product', description: 'Product management and strategy' },
  { name: 'Design', description: 'UI/UX design and creative' },
  { name: 'Marketing', description: 'Marketing, growth, and brand' },
  { name: 'Human Resources', description: 'People operations and culture' },
  { name: 'Finance', description: 'Financial planning and accounting' },
  { name: 'Customer Success', description: 'Customer support and onboarding' },
  { name: 'DevOps', description: 'Infrastructure, CI/CD, and reliability' },
];

const EMPLOYEES_RAW = [
  { firstName: 'Sarah', lastName: 'Chen', email: 'sarah.chen@acmetech.com', designation: 'Senior Software Engineer', dept: 'Engineering', phone: '+1-555-0101' },
  { firstName: 'Marcus', lastName: 'Rodriguez', email: 'marcus.rodriguez@acmetech.com', designation: 'Staff Engineer', dept: 'Engineering', phone: '+1-555-0102' },
  { firstName: 'Priya', lastName: 'Patel', email: 'priya.patel@acmetech.com', designation: 'Software Engineer', dept: 'Engineering', phone: '+1-555-0103' },
  { firstName: 'James', lastName: 'Wilson', email: 'james.wilson@acmetech.com', designation: 'Junior Software Engineer', dept: 'Engineering', phone: '+1-555-0104' },
  { firstName: 'Aisha', lastName: 'Okafor', email: 'aisha.okafor@acmetech.com', designation: 'Software Engineer', dept: 'Engineering', phone: '+1-555-0105' },
  { firstName: 'David', lastName: 'Kim', email: 'david.kim@acmetech.com', designation: 'Senior Software Engineer', dept: 'Engineering', phone: '+1-555-0106' },
  { firstName: 'Elena', lastName: 'Volkov', email: 'elena.volkov@acmetech.com', designation: 'Software Engineer', dept: 'Engineering', phone: '+1-555-0107' },
  { firstName: 'Alex', lastName: 'Thompson', email: 'alex.thompson@acmetech.com', designation: 'VP of Product', dept: 'Product', phone: '+1-555-0108' },
  { firstName: 'Maya', lastName: 'Singh', email: 'maya.singh@acmetech.com', designation: 'Senior Product Manager', dept: 'Product', phone: '+1-555-0109' },
  { firstName: 'Ryan', lastName: 'Garcia', email: 'ryan.garcia@acmetech.com', designation: 'Product Manager', dept: 'Product', phone: '+1-555-0110' },
  { firstName: 'Olivia', lastName: 'Brown', email: 'olivia.brown@acmetech.com', designation: 'Design Lead', dept: 'Design', phone: '+1-555-0111' },
  { firstName: 'Liam', lastName: 'Nakamura', email: 'liam.nakamura@acmetech.com', designation: 'UX Designer', dept: 'Design', phone: '+1-555-0112' },
  { firstName: 'Sophia', lastName: 'Martinez', email: 'sophia.martinez@acmetech.com', designation: 'Marketing Director', dept: 'Marketing', phone: '+1-555-0113' },
  { firstName: 'Ethan', lastName: 'Wright', email: 'ethan.wright@acmetech.com', designation: 'Growth Marketing Manager', dept: 'Marketing', phone: '+1-555-0114' },
  { firstName: 'Isabella', lastName: 'Davis', email: 'isabella.davis@acmetech.com', designation: 'HR Manager', dept: 'Human Resources', phone: '+1-555-0115' },
  { firstName: 'Noah', lastName: 'Anderson', email: 'noah.anderson@acmetech.com', designation: 'Finance Manager', dept: 'Finance', phone: '+1-555-0116' },
  { firstName: 'Charlotte', lastName: 'Taylor', email: 'charlotte.taylor@acmetech.com', designation: 'Customer Success Lead', dept: 'Customer Success', phone: '+1-555-0117' },
  { firstName: 'Benjamin', lastName: 'Lee', email: 'benjamin.lee@acmetech.com', designation: 'Support Engineer', dept: 'Customer Success', phone: '+1-555-0118' },
  { firstName: 'Amelia', lastName: 'Clark', email: 'amelia.clark@acmetech.com', designation: 'DevOps Engineer', dept: 'DevOps', phone: '+1-555-0119' },
  { firstName: 'Lucas', lastName: 'Müller', email: 'lucas.muller@acmetech.com', designation: 'Site Reliability Engineer', dept: 'DevOps', phone: '+1-555-0120' },
  { firstName: 'Zara', lastName: 'Hassan', email: 'zara.hassan@acmetech.com', designation: 'QA Engineer', dept: 'Engineering', phone: '+1-555-0121' },
  { firstName: 'Michael', lastName: 'O\'Brien', email: 'michael.obrien@acmetech.com', designation: 'Software Engineer', dept: 'Engineering', phone: '+1-555-0122' },
  { firstName: 'Chloe', lastName: 'Young', email: 'chloe.young@acmetech.com', designation: 'Product Analyst', dept: 'Product', phone: '+1-555-0123' },
  { firstName: 'Daniel', lastName: 'Sato', email: 'daniel.sato@acmetech.com', designation: 'Visual Designer', dept: 'Design', phone: '+1-555-0124' },
  { firstName: 'Nina', lastName: 'Petrov', email: 'nina.petrov@acmetech.com', designation: 'Data Engineer', dept: 'Engineering', phone: '+1-555-0125' },
];

const DEVICE_TEMPLATES = [
  { os: 'Windows 11', osVer: '23H2', processor: 'Intel Core i7-13700K', memory: '32GB DDR5', agent: '2.1.4' },
  { os: 'Windows 11', osVer: '22H2', processor: 'AMD Ryzen 7 7800X3D', memory: '16GB DDR5', agent: '2.1.4' },
  { os: 'Windows 10', osVer: '22H2', processor: 'Intel Core i5-12400', memory: '16GB DDR4', agent: '2.1.3' },
  { os: 'macOS Sonoma', osVer: '14.5', processor: 'Apple M2 Pro', memory: '16GB', agent: '2.1.4' },
  { os: 'Windows 11', osVer: '23H2', processor: 'Intel Core i9-14900K', memory: '64GB DDR5', agent: '2.1.4' },
  { os: 'macOS Ventura', osVer: '13.6', processor: 'Apple M1 Max', memory: '32GB', agent: '2.1.3' },
  { os: 'Windows 11', osVer: '23H2', processor: 'AMD Ryzen 9 7950X', memory: '32GB DDR5', agent: '2.1.4' },
  { os: 'Ubuntu 24.04', osVer: 'LTS', processor: 'Intel Xeon W5-2455X', memory: '64GB DDR4', agent: '2.1.4' },
];

const APPS_PRODUCTIVE = [
  { name: 'Visual Studio Code', exe: 'code.exe', category: 'productive' },
  { name: 'Google Chrome', exe: 'chrome.exe', category: 'productive' },
  { name: 'Slack', exe: 'slack.exe', category: 'productive' },
  { name: 'Microsoft Teams', exe: 'teams.exe', category: 'productive' },
  { name: 'Figma', exe: 'figma.exe', category: 'productive' },
  { name: 'Postman', exe: 'postman.exe', category: 'productive' },
  { name: 'Terminal', exe: 'terminal.exe', category: 'productive' },
  { name: 'GitHub Desktop', exe: 'github-desktop.exe', category: 'productive' },
  { name: 'Notion', exe: 'notion.exe', category: 'productive' },
  { name: 'Jira', exe: 'jira.exe', category: 'productive' },
  { name: 'Confluence', exe: 'confluence.exe', category: 'productive' },
  { name: 'Zoom', exe: 'zoom.exe', category: 'productive' },
  { name: 'Docker Desktop', exe: 'docker.exe', category: 'productive' },
  { name: 'DataGrip', exe: 'datagrip.exe', category: 'productive' },
  { name: 'IntelliJ IDEA', exe: 'idea.exe', category: 'productive' },
];

const APPS_NEUTRAL = [
  { name: 'Spotify', exe: 'spotify.exe', category: 'neutral' },
  { name: 'Discord', exe: 'discord.exe', category: 'neutral' },
  { name: 'Microsoft Outlook', exe: 'outlook.exe', category: 'neutral' },
];

const APPS_UNPRODUCTIVE = [
  { name: 'YouTube', exe: 'chrome.exe', category: 'unproductive' },
  { name: 'Reddit', exe: 'chrome.exe', category: 'unproductive' },
  { name: 'Twitter/X', exe: 'chrome.exe', category: 'unproductive' },
  { name: 'Facebook', exe: 'chrome.exe', category: 'unproductive' },
];

const ALL_APPS = [...APPS_PRODUCTIVE, ...APPS_NEUTRAL, ...APPS_UNPRODUCTIVE];

const WEBSITES = [
  { title: 'GitHub', url: 'https://github.com', category: 'productive' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com', category: 'productive' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org', category: 'productive' },
  { title: 'Jira Board', url: 'https://acme-tech.atlassian.net', category: 'productive' },
  { title: 'AWS Console', url: 'https://console.aws.amazon.com', category: 'productive' },
  { title: 'Gmail', url: 'https://mail.google.com', category: 'neutral' },
  { title: 'Google Calendar', url: 'https://calendar.google.com', category: 'neutral' },
  { title: 'YouTube', url: 'https://youtube.com', category: 'unproductive' },
  { title: 'Reddit', url: 'https://reddit.com', category: 'unproductive' },
  { title: 'Twitter', url: 'https://twitter.com', category: 'unproductive' },
];

const PROJECTS_DATA = [
  { name: 'OmniSight v3.0', desc: 'Next-generation workforce intelligence platform with AI-powered analytics', status: 'active', priority: 'high', color: '#10b981', budget: 'fixed', rate: 150, tags: '["platform","ai","v3"]' },
  { name: 'Mobile App Redesign', desc: 'Complete overhaul of the mobile companion app with new design system', status: 'active', priority: 'high', color: '#3b82f6', budget: 'hourly', rate: 120, tags: '["mobile","redesign","ux"]' },
  { name: 'API Gateway Migration', desc: 'Migrate from legacy REST to GraphQL API gateway', status: 'active', priority: 'medium', color: '#8b5cf6', budget: 'fixed', rate: 140, tags: '["api","migration","graphql"]' },
  { name: 'SOC 2 Compliance', desc: 'Achieve SOC 2 Type II certification for enterprise customers', status: 'active', priority: 'critical', color: '#ef4444', budget: 'fixed', rate: 200, tags: '["security","compliance","soc2"]' },
  { name: 'Data Pipeline v2', desc: 'Real-time event streaming infrastructure for live monitoring', status: 'active', priority: 'medium', color: '#f59e0b', budget: 'hourly', rate: 130, tags: '["data","streaming","infrastructure"]' },
  { name: 'Customer Portal', desc: 'Self-service portal for customer onboarding and support', status: 'on_hold', priority: 'low', color: '#06b6d4', budget: 'hourly', rate: 110, tags: '["portal","customer","self-service"]' },
];

const APP_LIST_ENTRIES = [
  { appName: 'Visual Studio Code', executableName: 'code.exe', listType: 'whitelist', reason: 'Primary development IDE', publisher: 'Microsoft' },
  { appName: 'Google Chrome', executableName: 'chrome.exe', listType: 'whitelist', reason: 'Approved browser', publisher: 'Google' },
  { appName: 'Slack', executableName: 'slack.exe', listType: 'whitelist', reason: 'Team communication', publisher: 'Slack Technologies' },
  { appName: 'Microsoft Teams', executableName: 'teams.exe', listType: 'whitelist', reason: 'Communication and meetings', publisher: 'Microsoft' },
  { appName: 'Figma', executableName: 'figma.exe', listType: 'whitelist', reason: 'Design tool', publisher: 'Figma Inc' },
  { appName: 'Notion', executableName: 'notion.exe', listType: 'whitelist', reason: 'Documentation and notes', publisher: 'Notion Labs' },
  { appName: 'BitTorrent', executableName: 'bittorrent.exe', listType: 'blacklist', reason: 'File sharing policy violation', publisher: 'BitTorrent Inc' },
  { appName: 'Tor Browser', executableName: 'tor.exe', listType: 'blacklist', reason: 'Unapproved anonymous browsing', publisher: 'Tor Project' },
  { appName: 'Cheat Engine', executableName: 'cheatengine.exe', listType: 'blacklist', reason: 'Memory manipulation tool', publisher: 'Unknown' },
];

// ─── Main Seed ────────────────────────────────────────────────────────────────
async function seedDemo() {
  const startTime = Date.now();
  console.log('🚀 Starting OmniSight demo seed (batch mode)...\n');

  // ── 1. Clean existing data ──
  console.log('🧹 Cleaning existing data...');
  const deleteOrder = [
    'SentimentRecord', 'TimeEntry', 'ProjectTimeSync', 'ProjectMember', 'Project',
    'ConsentLog', 'Consent', 'ConsentPolicy', 'PolicyViolation', 'KeyboardActivity',
    'LocationEvent', 'BreakSession', 'WebcamSession', 'AgentCommand', 'UsbEvent',
    'AppListEntry', 'Screenshot', 'Anomaly', 'Notification', 'NotificationPreference',
    'Alert', 'AiInsight', 'AuditLog', 'Report', 'Activity', 'DeviceClaim',
    'AgentToken', 'Device', 'OrganizationSetting', 'Employee',
    'Department', 'UserSession', 'OrganizationMembership', 'AppUser', 'Organization',
  ];
  for (const model of deleteOrder) {
    await (db as any)[model].deleteMany();
  }
  console.log('   ✅ All tables cleared\n');

  // ── 2. Create Organization ──
  console.log('🏢 Creating organization...');
  const org = await db.organization.create({
    data: {
      name: ORG.name, slug: ORG.slug, email: ORG.email, phone: ORG.phone,
      timezone: ORG.timezone, language: 'en', currency: 'USD', address: ORG.address, status: 'active',
    },
  });
  const orgId = org.id;
  console.log(`   ✅ ${ORG.name} (${orgId})\n`);

  // ── 3. Create Admin Users ──
  console.log('👤 Creating admin users...');
  const demoHash = hashPasswordSync('demo1234');

  // Use the existing Super Admin bootstrap mechanism — never create a duplicate.
  const superAdminResult = await bootstrapSuperAdmin();
  const superAdminUser = await db.appUser.findFirst({
    where: { email: { equals: superAdminResult.email, mode: 'insensitive' } },
  });
  if (!superAdminUser) throw new Error('Super Admin bootstrap failed — user not found after bootstrap');
  if (superAdminResult.created) {
    console.log(`   ✅ Super Admin created: ${superAdminUser.email}`);
  } else {
    console.log(`   ℹ️  Super Admin already exists — left unchanged: ${superAdminUser.email} (role=${superAdminUser.role})`);
  }

  // Organization-level admin users (platform role remains 'user')
  await db.appUser.createMany({
    data: [
      { email: 'org.admin@acmetech.com', name: 'Jordan Blake', password: demoHash, role: 'user', organizationId: null, isActive: true },
      { email: 'manager@acmetech.com', name: 'Casey Rivera', password: demoHash, role: 'user', organizationId: null, isActive: true },
      { email: 'viewer@acmetech.com', name: 'Pat Morgan', password: demoHash, role: 'user', organizationId: null, isActive: true },
    ],
    skipDuplicates: true,
  });
  const users = await db.appUser.findMany({ where: { organizationId: orgId } });
  const orgAdminUser = (await db.appUser.findFirst({ where: { email: 'org.admin@acmetech.com' } }))!;
  const managerUser = (await db.appUser.findFirst({ where: { email: 'manager@acmetech.com' } }))!;
  const viewerUser = (await db.appUser.findFirst({ where: { email: 'viewer@acmetech.com' } }))!;
  console.log(`   ✅ 3 organization admin users created\n`);

  // ── 3b. Create OrganizationMemberships (authoritative role source) ──
  console.log('🔗 Creating organization memberships...');
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: orgAdminUser.id, organizationId: orgId } },
    create: { userId: orgAdminUser.id, organizationId: orgId, role: 'org_admin', status: 'ACTIVE' },
    update: { role: 'org_admin', status: 'ACTIVE' },
  });
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: managerUser.id, organizationId: orgId } },
    create: { userId: managerUser.id, organizationId: orgId, role: 'manager', status: 'ACTIVE' },
    update: { role: 'manager', status: 'ACTIVE' },
  });
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: viewerUser.id, organizationId: orgId } },
    create: { userId: viewerUser.id, organizationId: orgId, role: 'viewer', status: 'ACTIVE' },
    update: { role: 'viewer', status: 'ACTIVE' },
  });
  console.log(`   ✅ 3 organization memberships created\n`);

  // ── 4. Create Departments ──
  console.log('🏬 Creating departments...');
  await db.department.createMany({
    data: DEPARTMENTS.map(d => ({ name: d.name, description: d.description, organizationId: orgId })),
  });
  const deptRows = await db.department.findMany({ where: { organizationId: orgId } });
  const deptMap = new Map(deptRows.map(d => [d.name, d.id]));
  console.log(`   ✅ ${deptRows.length} departments\n`);

  // ── 5. Create Employees ──
  console.log('👥 Creating employees...');
  const empHash = hashPasswordSync('agent1234');
  const empIds = new Map<string, string>(); // email -> id
  const empByDept = new Map<string, string[]>(); // deptName -> [empId, ...]

  await db.employee.createMany({
    data: EMPLOYEES_RAW.map((e, i) => {
      const empNum = String(i + 1).padStart(4, '0');
      const status = i < 22 ? 'active' : i < 23 ? 'inactive' : 'archived';
      return {
        employeeId: `EMP${empNum}`,
        firstName: e.firstName, lastName: e.lastName, email: e.email,
        phone: e.phone, designation: e.designation, status, type: 'employee',
        joinDate: daysAgo(randInt(30, 730)),
        organizationId: orgId, departmentId: deptMap.get(e.dept)!,
        agentApproved: i < 22, agentPassword: empHash,
      };
    }),
  });

  const empRows = await db.employee.findMany({ where: { organizationId: orgId }, select: { id: true, email: true, departmentId: true } });
  for (const e of empRows) { empIds.set(e.email, e.id); }
  for (const e of empRows) {
    const deptId = e.departmentId;
    if (deptId) {
      if (!empByDept.has(deptId)) empByDept.set(deptId, []);
      empByDept.get(deptId)!.push(e.id);
    }
  }

  // Set department managers: first employee in each dept
  const deptManagerMap: Record<string, string> = {
    'Engineering': 'sarah.chen@acmetech.com',
    'Product': 'alex.thompson@acmetech.com',
    'Design': 'olivia.brown@acmetech.com',
    'Marketing': 'sophia.martinez@acmetech.com',
    'Human Resources': 'isabella.davis@acmetech.com',
    'Finance': 'noah.anderson@acmetech.com',
    'Customer Success': 'charlotte.taylor@acmetech.com',
    'DevOps': 'amelia.clark@acmetech.com',
  };
  for (const [deptName, email] of Object.entries(deptManagerMap)) {
    const empId = empIds.get(email);
    const deptId = deptMap.get(deptName);
    if (empId && deptId) {
      await db.department.update({ where: { id: deptId }, data: { managerId: empId } });
    }
  }
  console.log(`   ✅ ${empRows.length} employees\n`);

  // ── 6. Create Devices ──
  console.log('💻 Creating devices...');
  const activeEmpIds = empRows.filter((_, i) => i < 22).map(e => e.id);
  const deviceIds: string[] = [];
  const empToDevice = new Map<string, string>(); // empId -> deviceId

  const deviceData = activeEmpIds.map((empId, i) => {
    const tpl = DEVICE_TEMPLATES[i % DEVICE_TEMPLATES.length];
    const isOnline = i % 8 !== 4; // all online except ~1 in 8
    const devNum = String(i + 1).padStart(3, '0');
    const emp = EMPLOYEES_RAW[i];
    return {
      name: `${emp.firstName}-${emp.lastName}-Laptop`,
      hostname: `ACME-${devNum}`,
      operatingSystem: tpl.os, osVersion: tpl.osVer,
      processor: tpl.processor, memory: tpl.memory,
      ipAddress: ipAddress(), macAddress: macAddress(),
      agentVersion: tpl.agent,
      status: isOnline ? 'online' : 'offline',
      lastHeartbeat: isOnline ? minutesAgo(randInt(1, 30)) : hoursAgo(randInt(2, 48)),
      organizationId: orgId, employeeId: empId,
    };
  });

  await db.device.createMany({ data: deviceData });
  const devRows = await db.device.findMany({ where: { organizationId: orgId }, select: { id: true, employeeId: true } });
  for (const d of devRows) {
    deviceIds.push(d.id);
    if (d.employeeId) empToDevice.set(d.employeeId, d.id);
  }
  console.log(`   ✅ ${devRows.length} devices\n`);

  // ── 7. Create Activities (batch) ──
  console.log('📊 Creating activities (500 records, batched)...');
  const activityRecords: any[] = [];
  for (let i = 0; i < 500; i++) {
    const empIdx = randInt(0, activeEmpIds.length - 1);
    const empId = activeEmpIds[empIdx];
    const devId = empToDevice.get(empId);
    const dayOffset = randInt(0, 6);
    const ts = daysAgo(dayOffset);
    ts.setHours(randInt(8, 18), randInt(0, 59), 0, 0);

    const isApp = Math.random() > 0.3;
    if (isApp) {
      const app = pick(ALL_APPS);
      activityRecords.push({
        type: 'application', title: app.name, category: app.category,
        applicationName: app.exe, duration: randInt(60, 3600),
        employeeId: empId, deviceId: devId, timestamp: ts,
      });
    } else {
      const site = pick(WEBSITES);
      activityRecords.push({
        type: 'website', title: site.title, category: site.category,
        url: site.url, duration: randInt(60, 3600),
        employeeId: empId, deviceId: devId, timestamp: ts,
      });
    }
  }
  const actCount = await batchCreate(db, db.activity, activityRecords, 200);
  console.log(`   ✅ ${actCount} activities\n`);

  // ── 8. Create Projects + Members ──
  console.log('📁 Creating projects and members...');
  await db.project.createMany({
    data: PROJECTS_DATA.map(p => ({
      name: p.name, description: p.desc, status: p.status, priority: p.priority,
      color: p.color, budgetType: p.budget, hourlyRate: p.rate, tags: p.tags,
      startDate: daysAgo(randInt(30, 90)), deadline: daysAgo(-randInt(14, 60)),
      estimatedHours: randInt(200, 800), organizationId: orgId,
    })),
  });
  const projRows = await db.project.findMany({ where: { organizationId: orgId } });

  const memberRecords: any[] = [];
  for (const proj of projRows) {
    const memberEmpIds = pickN(activeEmpIds, randInt(4, 8));
    for (let j = 0; j < memberEmpIds.length; j++) {
      memberRecords.push({
        projectId: proj.id, employeeId: memberEmpIds[j],
        role: j === 0 ? 'lead' : j < 3 ? 'member' : 'reviewer',
        hoursPerWeek: randInt(10, 40), organizationId: orgId,
      });
    }
  }
  await db.projectMember.createMany({ data: memberRecords, skipDuplicates: true });
  console.log(`   ✅ ${projRows.length} projects, ${memberRecords.length} members\n`);

  // ── 9. Create Time Entries (batch) ──
  console.log('⏰ Creating time entries...');
  const timeEntryRecords: any[] = [];
  const categories = ['development', 'design', 'meeting', 'research', 'testing', 'review', 'admin'];
  for (const proj of projRows) {
    const members = memberRecords.filter(m => m.projectId === proj.id);
    for (const m of members) {
      for (let day = 0; day < 14; day++) {
        if (Math.random() < 0.3) continue;
        timeEntryRecords.push({
          projectId: proj.id, employeeId: m.employeeId,
          date: daysAgo(day), hours: randFloat(1, 8),
          description: `${pick(categories)} work on ${proj.name}`,
          category: pick(categories), billable: Math.random() > 0.15,
          source: Math.random() > 0.5 ? 'ACTIVITY_AUTO' : 'MANUAL',
          organizationId: orgId,
        });
      }
    }
  }
  const teCount = await batchCreate(db, db.timeEntry, timeEntryRecords, 200);
  console.log(`   ✅ ${teCount} time entries\n`);

  // ── 10. Create Notifications (batch) ──
  console.log('🔔 Creating notifications...');
  const notifTemplates = [
    { title: 'Device Offline', message: 'Marcus Rodriguez-Laptop has been offline for 2 hours', type: 'device_offline', priority: 'medium', actionUrl: '/devices' },
    { title: 'New Employee Registered', message: 'James Wilson has been added to Engineering department', type: 'new_employee', priority: 'low', actionUrl: '/employees' },
    { title: 'Policy Violation Detected', message: 'BitTorrent application was blocked on David Kim\'s device', type: 'policy_violation', priority: 'high', actionUrl: '/policies' },
    { title: 'High Inactivity Alert', message: 'Elena Volkov has shown 45 minutes of inactivity today', type: 'high_inactivity', priority: 'medium', actionUrl: '/employees' },
    { title: 'AI Recommendation', message: 'Consider redistributing workload in Engineering team', type: 'ai_recommendation', priority: 'low', actionUrl: '/insights' },
    { title: 'Security Alert', message: 'Unusual login location detected for Priya Patel', type: 'security', priority: 'critical', actionUrl: '/security' },
    { title: 'System Update', message: 'OmniSight v2.1.4 has been deployed successfully', type: 'system', priority: 'low', actionUrl: '/settings' },
    { title: 'Anomaly Detected', message: 'Productivity drop detected for Ryan Garcia (30% below baseline)', type: 'anomaly_detected', priority: 'high', actionUrl: '/anomalies' },
    { title: 'Consent Updated', message: 'Olivia Brown has granted screenshot monitoring consent', type: 'consent_update', priority: 'low', actionUrl: '/consent' },
    { title: 'Project Deadline', message: 'SOC 2 Compliance deadline approaching in 7 days', type: 'project_deadline', priority: 'high', actionUrl: '/projects' },
    { title: 'Overtime Alert', message: 'Sarah Chen has worked 52 hours this week', type: 'overtime_alert', priority: 'medium', actionUrl: '/employees' },
    { title: 'USB Event Detected', message: 'USB storage device connected on Aisha Okafor\'s laptop', type: 'security', priority: 'high', actionUrl: '/policies' },
  ];

  const notifRecords: any[] = [];
  for (let i = 0; i < 30; i++) {
    const tmpl = pick(notifTemplates);
    const empId = pick(activeEmpIds);
    const devId = empToDevice.get(empId) || pick(deviceIds);
    const isRead = Math.random() > 0.5;
    notifRecords.push({
      title: tmpl.title, message: tmpl.message, type: tmpl.type, priority: tmpl.priority,
      status: isRead ? 'read' : 'unread', actionUrl: tmpl.actionUrl,
      entityType: 'employee', entityId: empId,
      readAt: isRead ? hoursAgo(randInt(1, 24)) : null,
      employeeId: empId, deviceId: devId, organizationId: orgId,
      createdAt: hoursAgo(randInt(1, 72)),
    });
  }
  await db.notification.createMany({ data: notifRecords });
  console.log(`   ✅ 30 notifications\n`);

  // ── 11. Create Alerts (batch) ──
  console.log('🚨 Creating alerts...');
  const alertData = [
    { title: 'Multiple Devices Offline', description: '3 devices have been offline for more than 4 hours', type: 'device_offline', severity: 'warning', status: 'pending' },
    { title: 'Policy Violation Spike', description: '12 policy violations detected in the last 24 hours', type: 'policy_violation', severity: 'error', status: 'acknowledged' },
    { title: 'Excessive Idle Time', description: 'Average idle time increased by 40% this week', type: 'high_inactivity', severity: 'warning', status: 'pending' },
    { title: 'Security Breach Attempt', description: 'Multiple failed login attempts detected from IP 203.0.113.42', type: 'security', severity: 'critical', status: 'pending' },
    { title: 'License Expiring', description: 'Enterprise license expires in 30 days', type: 'license', severity: 'info', status: 'resolved' },
    { title: 'System Health Warning', description: 'Database connection pool utilization at 85%', type: 'system', severity: 'warning', status: 'acknowledged' },
    { title: 'Unusual Login Pattern', description: 'Employee accessed system from 3 different countries in 1 hour', type: 'security', severity: 'critical', status: 'pending' },
    { title: 'Data Export Detected', description: 'Bulk data export initiated by admin user', type: 'security', severity: 'warning', status: 'acknowledged' },
  ];
  await db.alert.createMany({
    data: alertData.map(a => ({
      ...a, source: 'system', deviceId: pick(deviceIds),
      organizationId: orgId, createdAt: hoursAgo(randInt(1, 48)),
    })),
  });
  console.log(`   ✅ ${alertData.length} alerts\n`);

  // ── 12. Create AI Insights (batch) ──
  console.log('🤖 Creating AI insights...');
  const insights = [
    { title: 'Engineering Team Productivity Trend', content: 'The Engineering team shows a 15% increase in productive hours over the past 2 weeks. VS Code usage is up 22%, indicating deeper code work.', type: 'trend', category: 'team', confidence: 0.87 },
    { title: 'Burnout Risk — Sarah Chen', content: 'Sarah has worked overtime for 5 consecutive days with an average of 10.2 hours/day. Keyboard activity shows increased error rates in late hours.', type: 'risk', category: 'employee', confidence: 0.92 },
    { title: 'Optimal Meeting Windows', content: 'Tuesday and Thursday 10AM-12PM have the lowest meeting density across all departments.', type: 'recommendation', category: 'organization', confidence: 0.78 },
    { title: 'Productivity Anomaly — Ryan Garcia', content: 'Ryan\'s productive time dropped from 6.2h/day to 4.1h/day this week. Website tracking shows increased non-work browsing.', type: 'anomaly', category: 'employee', confidence: 0.85 },
    { title: 'Department Comparison', content: 'Engineering leads in overall productivity (78%), followed by Product (72%) and Design (68%).', type: 'trend', category: 'department', confidence: 0.81 },
    { title: 'Workload Imbalance Detected', content: 'Marcus Rodriguez and Sarah Chen handle 40% of the team\'s high-priority tasks. Consider redistributing.', type: 'risk', category: 'team', confidence: 0.88 },
  ];
  await db.aiInsight.createMany({
    data: insights.map(i => ({ ...i, status: 'active', organizationId: orgId, createdAt: hoursAgo(randInt(1, 72)) })),
  });
  console.log(`   ✅ ${insights.length} AI insights\n`);

  // ── 13. Create Reports (batch) ──
  console.log('📋 Creating reports...');
  await db.report.createMany({
    data: [
      { title: 'Weekly Productivity Report — Week 34', type: 'productivity', format: 'pdf', status: 'completed', periodStart: daysAgo(7), periodEnd: new Date(), organizationId: orgId, generatedBy: orgAdminUser.id, createdAt: hoursAgo(48) },
      { title: 'Monthly Activity Summary — August 2026', type: 'activity', format: 'pdf', status: 'completed', periodStart: daysAgo(30), periodEnd: new Date(), organizationId: orgId, generatedBy: orgAdminUser.id, createdAt: hoursAgo(72) },
      { title: 'Device Fleet Status Report', type: 'device', format: 'excel', status: 'completed', periodStart: daysAgo(14), periodEnd: new Date(), organizationId: orgId, generatedBy: orgAdminUser.id, createdAt: hoursAgo(96) },
      { title: 'Department Performance Comparison', type: 'productivity', format: 'pdf', status: 'completed', periodStart: daysAgo(30), periodEnd: new Date(), organizationId: orgId, generatedBy: orgAdminUser.id, createdAt: hoursAgo(120) },
      { title: 'Compliance Audit Report — Q3 2026', type: 'organization', format: 'pdf', status: 'completed', periodStart: daysAgo(90), periodEnd: new Date(), organizationId: orgId, generatedBy: superAdminUser.id, createdAt: hoursAgo(144) },
      { title: 'Employee Attendance Report — August', type: 'attendance', format: 'csv', status: 'completed', periodStart: daysAgo(30), periodEnd: new Date(), organizationId: orgId, generatedBy: orgAdminUser.id, createdAt: hoursAgo(168) },
    ],
  });
  console.log('   ✅ 6 reports\n');

  // ── 14. Create Audit Logs (batch) ──
  console.log('📝 Creating audit logs...');
  const auditActions = [
    { action: 'login', resource: 'auth', description: 'User logged in successfully' },
    { action: 'create', resource: 'employee', description: 'New employee created' },
    { action: 'update', resource: 'department', description: 'Department settings updated' },
    { action: 'configure', resource: 'settings', description: 'System settings modified' },
    { action: 'export', resource: 'report', description: 'Report exported as PDF' },
    { action: 'update', resource: 'policy', description: 'App whitelist updated' },
    { action: 'delete', resource: 'notification', description: 'Notifications cleared' },
    { action: 'create', resource: 'project', description: 'New project created' },
  ];
  const auditRecords: any[] = [];
  for (let i = 0; i < 50; i++) {
    const a = pick(auditActions);
    auditRecords.push({
      ...a, userId: pick([superAdminUser.id, orgAdminUser.id, managerUser.id]),
      ipAddress: ipAddress(), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0',
      organizationId: orgId, createdAt: hoursAgo(randInt(1, 168)),
    });
  }
  await db.auditLog.createMany({ data: auditRecords });
  console.log('   ✅ 50 audit logs\n');

  // ── 15. Create Consent Policies + Consents ──
  console.log('🔒 Creating consent policies and consents...');
  const consentTypes = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'location'];
  const policyIds = new Map<string, string>();

  for (const cType of consentTypes) {
    const policy = await db.consentPolicy.create({
      data: {
        organizationId: orgId, consentType: cType,
        title: `${cType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Policy`,
        content: `This policy outlines ${cType.replace(/_/g, ' ')} data collection for Acme Technologies.`,
        version: 'v1', status: 'published',
        effectiveAt: daysAgo(90), publishedAt: daysAgo(90),
        publishedBy: superAdminUser.id, createdBy: superAdminUser.id,
      },
    });
    policyIds.set(cType, policy.id);
  }

  // Grant consents for 18 of 22 active employees
  const consentRecords: any[] = [];
  const consentLogRecords: any[] = [];
  for (let i = 0; i < 18; i++) {
    const empId = activeEmpIds[i];
    for (const cType of consentTypes) {
      const isGranted = Math.random() > 0.15;
      const consentId = randomCuid();
      consentRecords.push({
        id: consentId, employeeId: empId, consentType: cType,
        status: isGranted ? 'granted' : 'pending',
        grantedAt: isGranted ? daysAgo(randInt(10, 80)) : null,
        consentVersion: 'v1', policyId: policyIds.get(cType),
        organizationId: orgId,
      });
      consentLogRecords.push({
        consentId, action: isGranted ? 'granted' : 'requested',
        description: `${isGranted ? 'Granted' : 'Requested'} ${cType} consent`,
        performedBy: empId, organizationId: orgId,
      });
    }
  }
  await db.consent.createMany({ data: consentRecords });
  await db.consentLog.createMany({ data: consentLogRecords, skipDuplicates: true });
  console.log(`   ✅ ${consentTypes.length} policies, ${consentRecords.length} consents, ${consentLogRecords.length} logs\n`);

  // ── 16. Create App List Entries (batch) ──
  console.log('📱 Creating app list entries...');
  await db.appListEntry.createMany({
    data: APP_LIST_ENTRIES.map(e => ({
      appName: e.appName, executableName: e.executableName,
      listType: e.listType, reason: e.reason, publisher: e.publisher,
      isActive: true, organizationId: orgId,
    })),
  });
  console.log(`   ✅ ${APP_LIST_ENTRIES.length} app list entries\n`);

  // ── 17. Create Anomalies (batch) ──
  console.log('⚠️ Creating anomalies...');
  const anomalyData = [
    { type: 'productivity_drop', severity: 'high', title: 'Significant Productivity Drop', description: 'Ryan Garcia\'s productive hours dropped 33%', score: 78, confidence: 0.89 },
    { type: 'excessive_idle', severity: 'medium', title: 'Extended Idle Period Detected', description: 'Lucas Müller showed 2.5 hours of continuous idle time', score: 55, confidence: 0.82 },
    { type: 'unusual_login', severity: 'critical', title: 'Unusual Login Location', description: 'Priya Patel logged in from Moscow, Russia', score: 92, confidence: 0.95 },
    { type: 'rapid_app_switch', severity: 'low', title: 'High App Switching Rate', description: 'James Wilson switched 147 times in one hour', score: 35, confidence: 0.71 },
    { type: 'overtime_work', severity: 'medium', title: 'Excessive Overtime Detected', description: 'Sarah Chen logged 55 hours this week', score: 62, confidence: 0.91 },
    { type: 'policy_breach', severity: 'high', title: 'Blocked Application Attempted', description: 'BitTorrent was launched and blocked on David Kim\'s device', score: 85, confidence: 0.98 },
    { type: 'low_activity_spike', severity: 'medium', title: 'Activity Spike After Low Period', description: 'Elena Volkov showed 300% activity spike after 3 hours idle', score: 48, confidence: 0.76 },
    { type: 'unusual_screenshot', severity: 'low', title: 'Sensitive Data in Screenshot', description: 'Screenshot from Aisha Okafor may contain financial data', score: 42, confidence: 0.65 },
  ];
  await db.anomaly.createMany({
    data: anomalyData.map((a, i) => ({
      ...a, status: Math.random() > 0.6 ? 'resolved' : 'detected',
      employeeId: activeEmpIds[i % activeEmpIds.length],
      deviceId: empToDevice.get(activeEmpIds[i % activeEmpIds.length]) || pick(deviceIds),
      aiAnalysis: `AI analysis confirms ${Math.round(a.confidence * 100)}% confidence. Recommended: ${a.severity === 'critical' ? 'Immediate review' : 'Monitor'}.`,
      resolvedAt: Math.random() > 0.6 ? hoursAgo(randInt(1, 24)) : null,
      resolvedBy: Math.random() > 0.6 ? orgAdminUser.id : null,
      organizationId: orgId, createdAt: hoursAgo(randInt(1, 72)),
    })),
  });
  console.log(`   ✅ ${anomalyData.length} anomalies\n`);

  // ── 18. Create Sentiment Records (batch) ──
  console.log('😊 Creating sentiment records...');
  const sentimentRecords: any[] = [];
  for (const empId of activeEmpIds) {
    const score = randFloat(25, 92);
    sentimentRecords.push({
      employeeId: empId, score,
      mood: score > 65 ? 'positive' : score > 40 ? 'neutral' : 'negative',
      signals: JSON.stringify({
        productivityTrend: pick(['increasing', 'stable', 'decreasing']),
        idleRate: randFloat(5, 25), overtimeHours: randFloat(0, 12),
        breakFrequency: randInt(2, 8), loginConsistency: pick(['high', 'medium', 'low']),
      }),
      insight: `Employee shows ${score > 65 ? 'positive' : score > 40 ? 'neutral' : 'negative'} sentiment.`,
      riskFactors: score < 50 ? JSON.stringify(['burnout_risk']) : '[]',
      recommendation: score < 50 ? 'Consider scheduling a check-in' : 'Continue current patterns',
      periodStart: daysAgo(14), periodEnd: new Date(),
      aiProviderUsed: 'rules', organizationId: orgId,
    });
  }
  await db.sentimentRecord.createMany({ data: sentimentRecords });
  console.log(`   ✅ ${sentimentRecords.length} sentiment records\n`);

  // ── 19. Create Break Sessions (batch) ──
  console.log('☕ Creating break sessions...');
  const breakRecords: any[] = [];
  for (const empId of activeEmpIds) {
    const breakCount = randInt(2, 5);
    for (let b = 0; b < breakCount; b++) {
      const start = daysAgo(randInt(0, 6));
      start.setHours(randInt(10, 16), randInt(0, 59));
      const endedAt = new Date(start.getTime() + randInt(5, 45) * 60_000);
      breakRecords.push({
        organizationId: orgId, employeeId: empId,
        deviceId: empToDevice.get(empId),
        startedAt: start, endedAt,
        source: pick(['employee', 'admin', 'agent']),
        startedBy: empId, endedBy: empId, endReason: 'employee_ended',
      });
    }
  }
  await db.breakSession.createMany({ data: breakRecords });
  console.log(`   ✅ ${breakRecords.length} break sessions\n`);

  // ── 20. Create Organization Settings (batch) ──
  console.log('⚙️ Creating organization settings...');
  await db.organizationSetting.createMany({
    data: [
      { organizationId: orgId, key: 'screenshot_interval', value: '300', category: 'monitoring' },
      { organizationId: orgId, key: 'activity_tracking_enabled', value: 'true', category: 'monitoring' },
      { organizationId: orgId, key: 'max_idle_minutes', value: '15', category: 'monitoring' },
      { organizationId: orgId, key: 'data_retention_days', value: '90', category: 'compliance' },
      { organizationId: orgId, key: 'enable_usb_monitoring', value: 'true', category: 'security' },
      { organizationId: orgId, key: 'enable_keystroke_monitoring', value: 'false', category: 'security' },
      { organizationId: orgId, key: 'auto_anomaly_detection', value: 'true', category: 'monitoring' },
      { organizationId: orgId, key: 'notification_email_enabled', value: 'true', category: 'notification' },
    ],
  });
  console.log('   ✅ 8 organization settings\n');

  // ── 21. Create System Settings (batch) ──
  console.log('🔧 Creating system settings...');
  await db.systemSetting.createMany({
    data: [
      { key: 'app_name', value: 'OmniSight', category: 'general' },
      { key: 'app_version', value: '2.1.4', category: 'general' },
      { key: 'maintenance_mode', value: 'false', category: 'general' },
      { key: 'rate_limit_enabled', value: 'true', category: 'security' },
      { key: 'max_login_attempts', value: '5', category: 'security' },
    ],
    skipDuplicates: true,
  });
  console.log('   ✅ 5 system settings\n');

  // ── 22. Create USB Events (batch) ──
  console.log('🔌 Creating USB events...');
  await db.usbEvent.createMany({
    data: [
      { eventType: 'usb_insert', deviceName: 'USB Mass Storage', vendorName: 'SanDisk', serialNumber: randomBytes(8).toString('hex'), employeeId: pick(activeEmpIds), blocked: false, organizationId: orgId, createdAt: hoursAgo(5) },
      { eventType: 'usb_insert', deviceName: 'USB Flash Drive', vendorName: 'Kingston', serialNumber: randomBytes(8).toString('hex'), employeeId: pick(activeEmpIds), blocked: true, organizationId: orgId, createdAt: hoursAgo(12) },
      { eventType: 'usb_remove', deviceName: 'USB Mass Storage', vendorName: 'SanDisk', serialNumber: randomBytes(8).toString('hex'), employeeId: pick(activeEmpIds), blocked: false, organizationId: orgId, createdAt: hoursAgo(24) },
      { eventType: 'usb_blocked', deviceName: 'External HDD', vendorName: 'Seagate', serialNumber: randomBytes(8).toString('hex'), employeeId: pick(activeEmpIds), blocked: true, organizationId: orgId, createdAt: hoursAgo(36) },
      { eventType: 'usb_insert', deviceName: 'USB Keyboard', vendorName: 'Logitech', serialNumber: randomBytes(8).toString('hex'), employeeId: pick(activeEmpIds), blocked: false, organizationId: orgId, createdAt: hoursAgo(48) },
    ],
  });
  console.log('   ✅ 5 USB events\n');

  // ── 24. Create Screenshots (batch) ──
  console.log('📸 Creating screenshot metadata...');
  const screenshotRecords: any[] = [];
  for (let i = 0; i < 40; i++) {
    const empId = pick(activeEmpIds);
    const isFlagged = Math.random() < 0.1;
    screenshotRecords.push({
      employeeId: empId, deviceId: empToDevice.get(empId),
      filePath: `/screenshots/${empId}/${Date.now()}-${i}.png`,
      fileName: `screenshot-${i}.png`, fileSize: randInt(100000, 500000),
      mimeType: 'image/png', width: 1920, height: 1080,
      appWindow: pick(ALL_APPS).name,
      ocrText: isFlagged ? 'Confidential financial data visible' : null,
      flagged: isFlagged,
      flagReason: isFlagged ? 'Contains potential sensitive data' : null,
      blurScore: isFlagged ? 0.3 : randFloat(0.7, 1.0),
      organizationId: orgId, capturedAt: hoursAgo(randInt(1, 72)),
    });
  }
  await db.screenshot.createMany({ data: screenshotRecords });
  console.log('   ✅ 40 screenshots\n');

  // ── Verify ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅ Demo seed completed in ${elapsed}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📊 Verifying counts...\n');

  const counts = {
    organizations: await db.organization.count(),
    users: await db.appUser.count(),
    departments: await db.department.count(),
    employees: await db.employee.count(),
    devices: await db.device.count(),
    activities: await db.activity.count(),
    projects: await db.project.count(),
    projectMembers: await db.projectMember.count(),
    timeEntries: await db.timeEntry.count(),
    notifications: await db.notification.count(),
    alerts: await db.alert.count(),
    aiInsights: await db.aiInsight.count(),
    reports: await db.report.count(),
    auditLogs: await db.auditLog.count(),
    consentPolicies: await db.consentPolicy.count(),
    consents: await db.consent.count(),
    consentLogs: await db.consentLog.count(),
    appListEntries: await db.appListEntry.count(),
    anomalies: await db.anomaly.count(),
    sentiments: await db.sentimentRecord.count(),
    breakSessions: await db.breakSession.count(),
    orgSettings: await db.organizationSetting.count(),
    sysSettings: await db.systemSetting.count(),

    usbEvents: await db.usbEvent.count(),
    screenshots: await db.screenshot.count(),
  };

  for (const [table, count] of Object.entries(counts)) {
    const label = table.padEnd(22);
    console.log(`  ${label} ${String(count).padStart(6)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔑 Login Credentials:');
  console.log(`  Super Admin: ${superAdminUser.email} (use configured SUPER_ADMIN_PASSWORD)`);
  console.log(`  Org Admin:   org.admin@acmetech.com / demo1234`);
  console.log(`  Manager:     manager@acmetech.com / demo1234`);
  console.log(`  Viewer:      viewer@acmetech.com / demo1234`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
const isMainModule = process.argv[1]?.endsWith('seed-demo.ts') || process.argv[1]?.endsWith('seed-demo.js');

if (isMainModule) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Seed refused: cannot run in production');
    process.exit(1);
  }
  if (process.env.SEED_ALLOWED !== '1') {
    console.error('❌ Seed refused: SEED_ALLOWED=1 not set');
    process.exit(1);
  }
  seedDemo()
    .catch((e) => {
      console.error('❌ Demo seed failed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await db.$disconnect();
    });
}

export { seedDemo };
