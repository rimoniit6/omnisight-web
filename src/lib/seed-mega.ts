/**
 * OmniSight MEGA Demo Seed — Multi-Organization Production-Like Dataset
 * ─────────────────────────────────────────────────────────────────────
 * Creates a large, realistic, deterministic dataset spanning 12+ organizations
 * with varied sizes, statuses, roles, and operational data.
 *
 * Targets:
 *   12–15 organizations (active/suspended/archived)
 *   150–250 AppUsers
 *   200–350 Memberships
 *   100–200 Employees
 *   50–100 Devices
 *   40–60 Projects
 *   1,000–3,000 Activities
 *   500–1,500 Locations
 *   Realistic screenshots, consents, sentiments, audit logs
 *
 * Run:  cross-env SEED_ALLOWED=1 tsx src/lib/seed-mega.ts
 * Or:   npm run db:seed:demo (if wired)
 *
 * IDEMPOTENT: running multiple times produces the same logical dataset.
 * PRODUCTION-SAFE: refuses to run in production.
 * SUPER ADMIN: uses bootstrapSuperAdmin() — never creates a duplicate.
 */
import { db } from '@/lib/db';
import { hashPasswordSync } from '@/lib/auth';
import { bootstrapSuperAdmin } from '@/lib/super-admin';

// ─── Deterministic Helpers ──────────────────────────────────────────────
// Seeded PRNG for deterministic output (same seed → same data every time)
let _seed = 42;
function srand(s: number) { _seed = s; }
function rand(): number {
  _seed = (_seed * 16807 + 0) % 2147483647;
  return (_seed - 1) / 2147483646;
}
function pick<T>(arr: T[]): T { return arr[Math.floor(rand() * arr.length)]; }
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => rand() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}
function randInt(min: number, max: number): number { return Math.floor(rand() * (max - min + 1)) + min; }
function randFloat(min: number, max: number): number { return Math.round((rand() * (max - min) + min) * 100) / 100; }
function daysAgo(n: number): Date { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function hoursAgo(n: number): Date { return new Date(Date.now() - n * 3600_000); }
function minutesAgo(n: number): Date { return new Date(Date.now() - n * 60_000); }

function deterministicCuid(index: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  let v = index;
  for (let i = 0; i < 25; i++) {
    v = (v * 16807 + i * 31) % 2147483647;
    result += chars[v % chars.length];
  }
  return result;
}

// ─── Batch Insert Helper ────────────────────────────────────────────────
async function batchCreate<T extends Record<string, unknown>>(
  table: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<{ count: number }> },
  records: T[],
  chunkSize = 200,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const result = await table.createMany({ data: records.slice(i, i + chunkSize), skipDuplicates: true });
    total += result.count;
  }
  return total;
}

// ─── Organization Definitions ───────────────────────────────────────────
interface OrgDef {
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'archived';
  timezone: string;
  currency: string;
  memberCount: number; // target number of members
  empCount: number;    // target employees
  projCount: number;   // target projects
}

const ORGS: OrgDef[] = [
  { name: 'Bangladesh Computer Council', slug: 'bng-computer-council', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 45, empCount: 30, projCount: 8 },
  { name: 'Dhaka Technology Services', slug: 'dhaka-tech-svc', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 35, empCount: 25, projCount: 6 },
  { name: 'Chattogram Digital Solutions', slug: 'chattogram-digital', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 25, empCount: 18, projCount: 5 },
  { name: 'Rajshahi Smart Systems', slug: 'rajshahi-smart', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 20, empCount: 15, projCount: 4 },
  { name: 'Khulna Enterprise Network', slug: 'khulna-enterprise', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 15, empCount: 12, projCount: 3 },
  { name: 'Sylhet Business Operations', slug: 'sylhet-biz-ops', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 12, empCount: 10, projCount: 4 },
  { name: 'Barisal Service Group', slug: 'barisal-svc', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 8, empCount: 8, projCount: 2 },
  { name: 'Rangpur Digital Works', slug: 'rangpur-digital', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 5, empCount: 5, projCount: 2 },
  { name: 'Mymensingh Technology Hub', slug: 'mymensingh-tech', status: 'suspended', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 10, empCount: 8, projCount: 3 },
  { name: 'National Data Services', slug: 'national-data', status: 'suspended', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 6, empCount: 5, projCount: 2 },
  { name: 'Enterprise Operations Ltd', slug: 'enterprise-ops', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 3, empCount: 2, projCount: 1 },
  { name: 'Smart Workforce Bangladesh', slug: 'smart-workforce', status: 'archived', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 4, empCount: 3, projCount: 1 },
  { name: 'Green Tech Innovations', slug: 'greentech-innov', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 18, empCount: 14, projCount: 5 },
  { name: 'CyberShield Security Ltd', slug: 'cybershield', status: 'active', timezone: 'Asia/Dhaka', currency: 'BDT', memberCount: 10, empCount: 8, projCount: 3 },
];

// ─── Name Pool ──────────────────────────────────────────────────────────
const FIRST_NAMES = [
  'Rahim', 'Karim', 'Salma', 'Nadia', 'Hasan', 'Mitu', 'Tanvir', 'Jahid', 'Rima', 'Tariq',
  'Farhan', 'Sabrina', 'Imran', 'Nusrat', 'Shafiq', 'Anika', 'Reza', 'Maliha', 'Kamal', 'Farzana',
  'Ashraf', 'Taslima', 'Mizan', 'Shirin', 'Alam', 'Roksana', 'Babul', 'Laila', 'Sohel', 'Nasrin',
  'Masum', 'Jesmin', 'Helal', 'Sumaiya', 'Farid', 'Ruma', 'Shamim', 'Rina', 'Manir', 'Monira',
  'Abdur', 'Jahan', 'Sharif', 'Rokshana', 'Monir', 'Anwara', 'Siraj', 'Bilkis', 'Mobarak', 'Sonia',
  'Khalid', 'Rashida', 'Samir', 'Firdous', 'Aziz', 'Nargis', 'Rafiq', 'Rashmi', 'Badal', 'Lily',
  'Habib', 'Ayesha', 'Rony', 'Tumpa', 'Bapon', 'Meghla', 'Sohag', 'Tania', 'Palash', 'Puja',
  'Sakib', 'Nisha', 'Tuhin', 'Joya', 'Rakib', 'Mou', 'Emon', 'Ratna', 'Sumon', 'Diya',
  'Shanto', 'Priti', 'Arif', 'Shamima', 'Naeem', 'Bindu', 'Rimon', 'Mita', 'Saiful', 'Rokeya',
  'Jubayer', 'Tasnia', 'Anis', 'Farhana', 'Sohel', 'Runa', 'Rubel', 'Lucky', 'Raju', 'Beauty',
  'Masud', 'Akhi', 'Selim', 'Ruma', 'Salman', 'Jharna', 'Titu', 'Papri', 'Alvee', 'Nandita',
  'Adnan', 'Bushra', 'Raihan', 'Sumona', 'Wasim', 'Taniya', 'Biswas', 'Lovely', 'Ziaul', 'Shanta',
  'Shihab', 'Tanzila', 'Amir', 'Farzana', 'Riyad', 'Monira', 'Jamal', 'Shahanaz', 'Belal', 'Ruma',
  'Naim', 'Sultana', 'Kamrul', 'Runa', 'Zahid', 'Jesmin', 'Touhid', 'Ananya', 'Hridoy', 'Priya',
  'Tanveer', 'Nabila', 'Sabbir', 'Farzana', 'Jony', 'Mumtaz', 'Shakil', 'Rina', 'Rashed', 'Sathi',
];

const LAST_NAMES = [
  'Ahmed', 'Hasan', 'Khan', 'Islam', 'Rahman', 'Akter', 'Sultana', 'Begum', 'Chowdhury', 'Hossain',
  'Uddin', 'Miah', 'Ali', 'Das', 'Sharma', 'Patel', 'Singh', 'Roy', 'Biswas', 'Mondal',
  'Islam', 'Haque', 'Molla', 'Sheikh', 'Talukdar', 'Barua', 'Chakma', 'Reza', 'Sarkar', 'Sen',
];

const DEPT_NAMES = ['IT', 'Operations', 'HR', 'Finance', 'Sales', 'Marketing', 'Customer Support', 'Administration', 'Engineering', 'Management', 'Field Operations', 'Security'];

const DESIGNATIONS = [
  'Software Engineer', 'Senior Software Engineer', 'Staff Engineer', 'QA Engineer',
  'Product Manager', 'Senior Product Manager', 'Project Manager',
  'UX Designer', 'UI Designer', 'Design Lead',
  'Marketing Manager', 'Growth Lead', 'Content Strategist',
  'HR Manager', 'Recruiter', 'Office Administrator',
  'Finance Manager', 'Accountant', 'Financial Analyst',
  'Sales Executive', 'Sales Manager', 'Business Development',
  'Customer Success Manager', 'Support Engineer', 'Technical Support',
  'DevOps Engineer', 'Site Reliability Engineer', 'System Administrator',
  'Data Engineer', 'Data Analyst', 'Business Intelligence',
  'Security Analyst', 'Compliance Officer', 'IT Manager',
  'Operations Manager', 'Field Coordinator', 'Regional Manager',
  'CEO', 'CTO', 'COO', 'VP of Engineering', 'Director of Operations',
];

const APPS = [
  { name: 'Visual Studio Code', exe: 'code.exe', cat: 'productive' },
  { name: 'Google Chrome', exe: 'chrome.exe', cat: 'productive' },
  { name: 'Slack', exe: 'slack.exe', cat: 'productive' },
  { name: 'Microsoft Teams', exe: 'teams.exe', cat: 'productive' },
  { name: 'Figma', exe: 'figma.exe', cat: 'productive' },
  { name: 'Postman', exe: 'postman.exe', cat: 'productive' },
  { name: 'Terminal', exe: 'terminal.exe', cat: 'productive' },
  { name: 'GitHub Desktop', exe: 'github-desktop.exe', cat: 'productive' },
  { name: 'Notion', exe: 'notion.exe', cat: 'productive' },
  { name: 'Jira', exe: 'jira.exe', cat: 'productive' },
  { name: 'Docker Desktop', exe: 'docker.exe', cat: 'productive' },
  { name: 'IntelliJ IDEA', exe: 'idea.exe', cat: 'productive' },
  { name: 'Spotify', exe: 'spotify.exe', cat: 'neutral' },
  { name: 'Discord', exe: 'discord.exe', cat: 'neutral' },
  { name: 'YouTube', exe: 'chrome.exe', cat: 'unproductive' },
  { name: 'Reddit', exe: 'chrome.exe', cat: 'unproductive' },
  { name: 'Facebook', exe: 'chrome.exe', cat: 'unproductive' },
];

const WEBSITES = [
  { title: 'GitHub', url: 'https://github.com', cat: 'productive' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com', cat: 'productive' },
  { title: 'Jira Board', url: 'https://jira.example.com', cat: 'productive' },
  { title: 'Gmail', url: 'https://mail.google.com', cat: 'neutral' },
  { title: 'YouTube', url: 'https://youtube.com', cat: 'unproductive' },
  { title: 'Reddit', url: 'https://reddit.com', cat: 'unproductive' },
];

const DEVICE_TEMPLATES = [
  { os: 'Windows 11', osVer: '23H2', proc: 'Intel Core i7-13700K', mem: '32GB DDR5', agent: '2.1.4' },
  { os: 'Windows 11', osVer: '22H2', proc: 'AMD Ryzen 7 7800X3D', mem: '16GB DDR5', agent: '2.1.4' },
  { os: 'Windows 10', osVer: '22H2', proc: 'Intel Core i5-12400', mem: '16GB DDR4', agent: '2.1.3' },
  { os: 'macOS Sonoma', osVer: '14.5', proc: 'Apple M2 Pro', mem: '16GB', agent: '2.1.4' },
  { os: 'Windows 11', osVer: '23H2', proc: 'Intel Core i9-14900K', mem: '64GB DDR5', agent: '2.1.4' },
  { os: 'Ubuntu 24.04', osVer: 'LTS', proc: 'Intel Xeon W5-2455X', mem: '64GB DDR4', agent: '2.1.4' },
];

const PROJECT_NAMES = [
  'Platform Migration', 'Mobile App v2', 'API Gateway', 'Data Pipeline', 'Compliance Audit',
  'Customer Portal', 'AI Analytics', 'Security Hardening', 'DevOps Automation', 'Design System',
  'Reporting Engine', 'Performance Optimization', 'Cloud Infrastructure', 'CI/CD Pipeline',
  'Monitoring Dashboard', 'Workflow Automation', 'Integration Hub', 'Data Warehouse',
  'Real-time Analytics', 'Mobile Responsive', 'Accessibility Audit', 'Load Testing',
  'Backup Strategy', 'Disaster Recovery', 'Capacity Planning', 'Cost Optimization',
  'Feature Flag System', 'A/B Testing Framework', 'Search Engine', 'Caching Layer',
];


// ─── Location Data (Bangladesh) ─────────────────────────────────────────
const BANGLADESH_LOCATIONS = [
  { lat: 23.8103, lng: 90.4125, name: 'Dhaka' },
  { lat: 22.3569, lng: 91.7832, name: 'Chattogram' },
  { lat: 24.3636, lng: 88.6241, name: 'Rajshahi' },
  { lat: 22.8456, lng: 89.5403, name: 'Khulna' },
  { lat: 24.8949, lng: 91.8687, name: 'Sylhet' },
  { lat: 22.7010, lng: 90.3535, name: 'Barisal' },
  { lat: 25.7439, lng: 89.2752, name: 'Rangpur' },
  { lat: 24.7471, lng: 90.4203, name: 'Mymensingh' },
  { lat: 23.7300, lng: 90.3900, name: 'Gulshan, Dhaka' },
  { lat: 23.7500, lng: 90.3800, name: 'Banani, Dhaka' },
  { lat: 23.7400, lng: 90.4000, name: 'Dhanmondi, Dhaka' },
  { lat: 23.7200, lng: 90.4200, name: 'Motijheel, Dhaka' },
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SEED
// ═══════════════════════════════════════════════════════════════════════════

export async function seedMega() {
  srand(42); // Deterministic seed
  const startTime = Date.now();
  console.log('🚀 Starting OmniSight MEGA demo seed...\n');

  // ── 1. Clean existing data (reverse dependency order) ──
  console.log('🧹 Cleaning existing data...');
  const deleteOrder = [
    'SentimentRecord', 'TimeEntry', 'ProjectTimeSync', 'ProjectMember', 'Project',
    'ConsentLog', 'Consent', 'ConsentPolicy', 'KeyboardActivity',
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

  // ── 2. Super Admin (preserved via bootstrap) ──
  console.log('👑 Bootstrapping Super Admin...');
  const saResult = await bootstrapSuperAdmin();
  const saUser = await db.appUser.findFirst({
    where: { email: { equals: saResult.email, mode: 'insensitive' } },
  });
  if (!saUser) throw new Error('Super Admin bootstrap failed');
  console.log(`   ✅ Super Admin: ${saUser.email} (role=${saUser.role})\n`);

  // ── 3. Create Organizations ──
  console.log('🏢 Creating organizations...');
  const orgRows: { id: string; name: string; slug: string; status: string }[] = [];
  for (const orgDef of ORGS) {
    const org = await db.organization.create({
      data: {
        name: orgDef.name, slug: orgDef.slug, status: orgDef.status,
        timezone: orgDef.timezone, currency: orgDef.currency,
        language: 'en', email: `info@${orgDef.slug}.local`,
        address: `${orgDef.name} Office, Bangladesh`,
      },
    });
    orgRows.push({ id: org.id, name: org.name, slug: org.slug, status: org.status });
  }
  console.log(`   ✅ ${orgRows.length} organizations created\n`);

  // ── 4. Create AppUsers + Memberships ──
  console.log('👤 Creating users and memberships...');
  const demoHash = hashPasswordSync('Demo@2026Pass');
  const allUsers: { id: string; email: string; name: string }[] = [];
  const allMemberships: { userId: string; organizationId: string; role: string; status: string }[] = [];

  let userIndex = 0;
  for (const org of orgRows) {
    const orgDef = ORGS.find(o => o.slug === org.slug)!;
    const memberCount = orgDef.memberCount;

    // Create org owner/admin first
    const ownerEmail = `owner@${org.slug}.local`;
    const owner = await db.appUser.create({
      data: { email: ownerEmail, name: `${FIRST_NAMES[userIndex % FIRST_NAMES.length]} ${LAST_NAMES[0]}`, password: demoHash, role: 'user', isActive: true },
    });
    allUsers.push({ id: owner.id, email: ownerEmail, name: owner.name });
    allMemberships.push({ userId: owner.id, organizationId: org.id, role: 'org_admin', status: 'ACTIVE' });
    userIndex++;

    // Create remaining members
    for (let i = 1; i < memberCount; i++) {
      const firstName = FIRST_NAMES[(userIndex + i) % FIRST_NAMES.length];
      const lastName = LAST_NAMES[(userIndex + i * 3) % LAST_NAMES.length];
      const email = `user${String(userIndex + i).padStart(3, '0')}@${org.slug}.local`;
      const user = await db.appUser.create({
        data: { email, name: `${firstName} ${lastName}`, password: demoHash, role: 'user', isActive: true },
      });
      allUsers.push({ id: user.id, email, name: user.name });

      // Assign role based on position
      let role: string;
      if (i < 2) role = 'org_admin';
      else if (i < Math.floor(memberCount * 0.3)) role = 'manager';
      else role = 'viewer';

      // For suspended/archived orgs, mix in some suspended memberships
      let status = 'ACTIVE';
      if (org.status !== 'active' && i > memberCount * 0.6) {
        status = 'SUSPENDED';
      }

      allMemberships.push({ userId: user.id, organizationId: org.id, role, status });
    }
    userIndex += memberCount;
  }

  // Multi-org users (intentional)
  const multiOrgEmails = ['multi.org.user1@omnisight.local', 'multi.org.user2@omnisight.local', 'multi.org.user3@omnisight.local'];
  for (const email of multiOrgEmails) {
    const user = await db.appUser.create({
      data: { email, name: `Multi-Org ${email.split('@')[0].replace(/\./g, ' ')}`, password: demoHash, role: 'user', isActive: true },
    });
    allUsers.push({ id: user.id, email, name: user.name });
    // Add to 2-3 random active orgs
    const activeOrgs = orgRows.filter(o => o.status === 'active');
    const targetOrgs = pickN(activeOrgs, randInt(2, 3));
    for (const org of targetOrgs) {
      allMemberships.push({ userId: user.id, organizationId: org.id, role: pick(['manager', 'viewer']), status: 'ACTIVE' });
    }
  }

  // Batch insert memberships
  await batchCreate(db.organizationMembership, allMemberships);
  console.log(`   ✅ ${allUsers.length} users, ${allMemberships.length} memberships\n`);

  // ── 5. Create Departments + Employees + Devices per org ──
  console.log('🏬 Creating departments, employees, and devices...');
  let totalEmployees = 0;
  let totalDevices = 0;
  let totalProjects = 0;
  const allActivities: any[] = [];
  const allLocations: any[] = [];
  const allScreenshots: any[] = [];
  const allAuditLogs: any[] = [];
  const allConsents: any[] = [];
  const allConsentLogs: any[] = [];
  const allConsentPolicies: any[] = [];
  const allSentiments: any[] = [];
  const allAlerts: any[] = [];
  const allAiInsights: any[] = [];
  const allReports: any[] = [];
  const allNotifications: any[] = [];
  const allOrgSettings: any[] = [];

  for (const org of orgRows) {
    const orgDef = ORGS.find(o => o.slug === org.slug)!;

    // Departments (4-8 per org)
    const deptCount = randInt(4, 8);
    const deptNames = pickN(DEPT_NAMES, deptCount);
    const deptData = deptNames.map(name => ({ name, description: `${name} department for ${org.name}`, organizationId: org.id }));
    await db.department.createMany({ data: deptData });
    const deptRows = await db.department.findMany({ where: { organizationId: org.id }, select: { id: true, name: true } });

    // Employees
    const empData: any[] = [];
    const empIds: string[] = [];
    for (let i = 0; i < orgDef.empCount; i++) {
      const idx = totalEmployees + i;
      const firstName = FIRST_NAMES[idx % FIRST_NAMES.length];
      const lastName = LAST_NAMES[(idx * 7) % LAST_NAMES.length];
      const dept = deptRows[i % deptRows.length];
      const status = i < orgDef.empCount * 0.85 ? 'active' : i < orgDef.empCount * 0.95 ? 'inactive' : 'archived';
      empData.push({
        employeeId: `EMP-${org.slug.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
        firstName, lastName,
        email: `emp${i + 1}@${org.slug}.local`,
        designation: pick(DESIGNATIONS),
        status, type: 'employee',
        joinDate: daysAgo(randInt(30, 730)),
        organizationId: org.id,
        departmentId: dept?.id,
        agentApproved: status === 'active',
        agentPassword: demoHash,
      });
    }
    await db.employee.createMany({ data: empData, skipDuplicates: true });
    const empRows = await db.employee.findMany({ where: { organizationId: org.id }, select: { id: true } });
    empIds.push(...empRows.map(e => e.id));
    totalEmployees += empRows.length;

    // Devices (60-80% of active employees)
    const activeEmpIds = empRows.slice(0, Math.floor(empRows.length * 0.75)).map(e => e.id);
    const devData: any[] = [];
    for (let i = 0; i < activeEmpIds.length; i++) {
      const tpl = DEVICE_TEMPLATES[i % DEVICE_TEMPLATES.length];
      const isOnline = rand() > 0.2;
      const emp = empData[i];
      devData.push({
        name: `${emp.firstName}-${emp.lastName}-Laptop`,
        hostname: `${org.slug.toUpperCase().slice(0, 6)}-${String(i + 1).padStart(3, '0')}`,
        operatingSystem: tpl.os, osVersion: tpl.osVer,
        processor: tpl.proc, memory: tpl.mem,
        ipAddress: `10.${randInt(1, 10)}.${randInt(1, 10)}.${randInt(10, 250)}`,
        macAddress: Array.from({ length: 6 }, () => randInt(0, 255).toString(16).padStart(2, '0')).join(':'),
        agentVersion: tpl.agent,
        status: isOnline ? 'online' : 'offline',
        lastHeartbeat: isOnline ? minutesAgo(randInt(1, 30)) : hoursAgo(randInt(2, 48)),
        organizationId: org.id,
        employeeId: activeEmpIds[i],
      });
    }
    await db.device.createMany({ data: devData });
    const devRows = await db.device.findMany({ where: { organizationId: org.id }, select: { id: true, employeeId: true } });
    totalDevices += devRows.length;

    // Map employee -> device
    const empToDev = new Map<string, string>();
    for (const d of devRows) { if (d.employeeId) empToDev.set(d.employeeId, d.id); }

    // Projects (varied per org)
    const projData: any[] = [];
    const projNames = pickN(PROJECT_NAMES, orgDef.projCount);
    for (let i = 0; i < orgDef.projCount; i++) {
      projData.push({
        name: `${projNames[i]} — ${org.name}`,
        description: `${projNames[i]} project for ${org.name}`,
        status: pick(['active', 'active', 'active', 'on_hold', 'completed']),
        priority: pick(['low', 'medium', 'high', 'critical']),
        color: pick(['#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#f59e0b']),
        budgetType: pick(['fixed', 'hourly']),
        hourlyRate: randInt(80, 200),
        startDate: daysAgo(randInt(30, 180)),
        deadline: daysAgo(-randInt(14, 90)),
        estimatedHours: randInt(100, 800),
        organizationId: org.id,
      });
    }
    await db.project.createMany({ data: projData });
    const projRows = await db.project.findMany({ where: { organizationId: org.id }, select: { id: true } });
    totalProjects += projRows.length;

    // Activities (scale with org size)
    const activityCount = Math.max(50, orgDef.empCount * 30);
    for (let i = 0; i < activityCount; i++) {
      const empId = pick(activeEmpIds);
      const devId = empToDev.get(empId);
      const dayOffset = randInt(0, 90);
      const ts = daysAgo(dayOffset);
      ts.setHours(randInt(8, 18), randInt(0, 59), 0, 0);
      const isApp = rand() > 0.3;
      if (isApp) {
        const app = pick(APPS);
        allActivities.push({
          type: 'application', title: app.name, category: app.cat,
          applicationName: app.exe, duration: randInt(60, 3600),
          employeeId: empId, deviceId: devId, timestamp: ts,
        });
      } else {
        const site = pick(WEBSITES);
        allActivities.push({
          type: 'website', title: site.title, category: site.cat,
          url: site.url, duration: randInt(60, 3600),
          employeeId: empId, deviceId: devId, timestamp: ts,
        });
      }
    }

    // Locations
    const locationCount = Math.max(30, orgDef.empCount * 15);
    for (let i = 0; i < locationCount; i++) {
      const empId = pick(activeEmpIds);
      const devId = empToDev.get(empId);
      const loc = pick(BANGLADESH_LOCATIONS);
      allLocations.push({
        employeeId: empId, deviceId: devId,
        latitude: loc.lat + (rand() - 0.5) * 0.02,
        longitude: loc.lng + (rand() - 0.5) * 0.02,
        accuracy: randFloat(5, 50),
        recordedAt: daysAgo(randInt(0, 30)),
        organizationId: org.id,
        source: pick(['native', 'ip']),
      });
    }

    // Screenshots
    const screenshotCount = Math.max(10, Math.floor(orgDef.empCount * 2.5));
    for (let i = 0; i < screenshotCount; i++) {
      const empId = pick(activeEmpIds);
      const devId = empToDev.get(empId);
      const isFlagged = rand() < 0.1;
      allScreenshots.push({
        employeeId: empId, deviceId: devId,
        filePath: `/screenshots/${org.id}/${deterministicCuid(totalEmployees + i)}.png`,
        fileName: `screenshot-${i}.png`, fileSize: randInt(100000, 500000),
        mimeType: 'image/png', width: 1920, height: 1080,
        appWindow: pick(APPS).name,
        ocrText: isFlagged ? 'Confidential data visible' : null,
        flagged: isFlagged,
        flagReason: isFlagged ? 'Potential sensitive data' : null,
        blurScore: isFlagged ? 0.3 : randFloat(0.7, 1.0),
        organizationId: org.id,
        capturedAt: hoursAgo(randInt(1, 72)),
      });
    }

    // Consent Policies + Consents
    const consentTypes = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'location'];
    for (const cType of consentTypes) {
      const policy = await db.consentPolicy.create({
        data: {
          organizationId: org.id, consentType: cType,
          title: `${cType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())} Policy`,
          content: `${cType} data collection policy for ${org.name}.`,
          version: 'v1', status: 'published',
          effectiveAt: daysAgo(90), publishedAt: daysAgo(90),
          publishedBy: saUser.id, createdBy: saUser.id,
        },
      });
      allConsentPolicies.push(policy);

      for (const empId of activeEmpIds.slice(0, Math.floor(activeEmpIds.length * 0.8))) {
        const isGranted = rand() > 0.15;
        const cid = deterministicCuid(totalEmployees + allConsents.length);
        allConsents.push({
          id: cid, employeeId: empId, consentType: cType,
          status: isGranted ? 'granted' : 'pending',
          grantedAt: isGranted ? daysAgo(randInt(10, 80)) : null,
          consentVersion: 'v1', policyId: policy.id,
          organizationId: org.id,
        });
        allConsentLogs.push({
          consentId: cid, action: isGranted ? 'granted' : 'requested',
          description: `${isGranted ? 'Granted' : 'Requested'} ${cType} consent`,
          performedBy: empId, organizationId: org.id,
        });
      }
    }

    // Audit Logs
    const auditCount = Math.max(15, orgDef.empCount * 3);
    const auditActions = ['login', 'create', 'update', 'delete', 'export', 'configure'];
    const auditResources = ['employee', 'device', 'department', 'settings', 'report', 'project'];
    for (let i = 0; i < auditCount; i++) {
      allAuditLogs.push({
        action: pick(auditActions), resource: pick(auditResources),
        description: `${pick(auditActions)} ${pick(auditResources)} operation`,
        userId: saUser.id,
        ipAddress: `10.${randInt(1, 10)}.${randInt(1, 10)}.${randInt(10, 250)}`,
        organizationId: org.id,
        createdAt: hoursAgo(randInt(1, 168)),
      });
    }

    // Alerts
    const alertSeverities = ['info', 'warning', 'error', 'critical'];
    const alertStatuses = ['pending', 'acknowledged', 'resolved'];
    const alertTitles = ['Device Offline', 'Policy Violation', 'Security Alert', 'System Warning', 'Anomaly Detected'];
    for (let i = 0; i < Math.min(5, orgDef.empCount); i++) {
      allAlerts.push({
        title: pick(alertTitles),
        description: `Alert for ${org.name}: ${pick(alertTitles)}`,
        type: pick(['device_offline', 'policy_violation', 'security', 'system']),
        severity: pick(alertSeverities),
        status: pick(alertStatuses),
        source: 'system',
        organizationId: org.id,
        createdAt: hoursAgo(randInt(1, 48)),
      });
    }

    // AI Insights
    for (let i = 0; i < Math.min(3, orgDef.empCount); i++) {
      allAiInsights.push({
        title: `Insight for ${org.name}`,
        content: `AI analysis for ${org.name} shows positive trends.`,
        type: pick(['trend', 'anomaly', 'recommendation']),
        category: pick(['team', 'department', 'organization']),
        confidence: randFloat(0.7, 0.95),
        status: 'active',
        organizationId: org.id,
        createdAt: hoursAgo(randInt(1, 72)),
      });
    }

    // Reports
    for (let i = 0; i < Math.min(3, orgDef.empCount); i++) {
      allReports.push({
        title: `Report for ${org.name}`,
        type: pick(['productivity', 'activity', 'device']),
        format: pick(['pdf', 'excel', 'csv']),
        status: 'completed',
        periodStart: daysAgo(30), periodEnd: new Date(),
        organizationId: org.id,
        generatedBy: saUser.id,
        createdAt: hoursAgo(randInt(1, 168)),
      });
    }

    // Notifications
    const notifTitles = ['Device Offline', 'New Employee', 'Policy Violation', 'Security Alert', 'System Update'];
    for (let i = 0; i < Math.min(8, orgDef.empCount); i++) {
      allNotifications.push({
        title: pick(notifTitles),
        message: `${pick(notifTitles)} in ${org.name}`,
        type: pick(['device_offline', 'new_employee', 'policy_violation', 'security', 'system']),
        priority: pick(['low', 'medium', 'high', 'critical']),
        status: pick(['unread', 'read']),
        organizationId: org.id,
        createdAt: hoursAgo(randInt(1, 72)),
      });
    }

    // Org Settings
    allOrgSettings.push(
      { organizationId: org.id, key: 'screenshot_interval', value: '300', category: 'monitoring' },
      { organizationId: org.id, key: 'activity_tracking_enabled', value: 'true', category: 'monitoring' },
      { organizationId: org.id, key: 'max_idle_minutes', value: '15', category: 'monitoring' },
      { organizationId: org.id, key: 'data_retention_days', value: '90', category: 'compliance' },
    );

    // Sentiments (per active employee)
    for (const empId of activeEmpIds) {
      const score = randFloat(25, 92);
      allSentiments.push({
        employeeId: empId, score,
        mood: score > 65 ? 'positive' : score > 40 ? 'neutral' : 'negative',
        signals: JSON.stringify({ productivityTrend: pick(['increasing', 'stable', 'decreasing']), idleRate: randFloat(5, 25) }),
        insight: `Employee sentiment: ${score > 65 ? 'positive' : score > 40 ? 'neutral' : 'negative'}`,
        periodStart: daysAgo(14), periodEnd: new Date(),
        aiProviderUsed: 'rules', organizationId: org.id,
      });
    }
  }

  // Batch insert all accumulated data
  console.log('   📊 Batch inserting activities...');
  await batchCreate(db.activity, allActivities, 300);
  console.log(`   ✅ ${allActivities.length} activities`);

  console.log('   📍 Batch inserting locations...');
  await batchCreate(db.locationEvent, allLocations, 300);
  console.log(`   ✅ ${allLocations.length} locations`);

  console.log('   📸 Batch inserting screenshots...');
  await batchCreate(db.screenshot, allScreenshots, 200);
  console.log(`   ✅ ${allScreenshots.length} screenshots`);

  console.log('   📝 Batch inserting audit logs...');
  await batchCreate(db.auditLog, allAuditLogs, 200);
  console.log(`   ✅ ${allAuditLogs.length} audit logs`);

  console.log('   🔒 Batch inserting consents...');
  await batchCreate(db.consent, allConsents, 200);
  console.log(`   ✅ ${allConsents.length} consents`);

  console.log('   📋 Batch inserting consent logs...');
  await batchCreate(db.consentLog, allConsentLogs, 200);
  console.log(`   ✅ ${allConsentLogs.length} consent logs`);

  console.log('   😊 Batch inserting sentiments...');
  await batchCreate(db.sentimentRecord, allSentiments, 200);
  console.log(`   ✅ ${allSentiments.length} sentiments`);

  console.log('   🚨 Batch inserting alerts...');
  await batchCreate(db.alert, allAlerts, 200);
  console.log(`   ✅ ${allAlerts.length} alerts`);

  console.log('   🤖 Batch inserting AI insights...');
  await batchCreate(db.aiInsight, allAiInsights, 200);
  console.log(`   ✅ ${allAiInsights.length} AI insights`);

  console.log('   📋 Batch inserting reports...');
  await batchCreate(db.report, allReports, 200);
  console.log(`   ✅ ${allReports.length} reports`);

  console.log('   🔔 Batch inserting notifications...');
  await batchCreate(db.notification, allNotifications, 200);
  console.log(`   ✅ ${allNotifications.length} notifications`);

  console.log('   ⚙️ Batch inserting org settings...');
  await batchCreate(db.organizationSetting, allOrgSettings, 200);
  console.log(`   ✅ ${allOrgSettings.length} org settings`);

  // System settings
  await db.systemSetting.createMany({
    data: [
      { key: 'app_name', value: 'OmniSight', category: 'general' },
      { key: 'app_version', value: '2.1.4', category: 'general' },
      { key: 'maintenance_mode', value: 'false', category: 'general' },
    ],
    skipDuplicates: true,
  });

  // ── 6. Final Counts ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅ MEGA seed completed in ${elapsed}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('  📊 Final counts:\n');

  const counts = {
    organizations: await db.organization.count(),
    activeOrgs: await db.organization.count({ where: { status: 'active' } }),
    suspendedOrgs: await db.organization.count({ where: { status: 'suspended' } }),
    archivedOrgs: await db.organization.count({ where: { status: 'archived' } }),
    users: await db.appUser.count(),
    superAdmins: await db.appUser.count({ where: { role: 'super_admin' } }),
    memberships: await db.organizationMembership.count(),
    employees: await db.employee.count(),
    departments: await db.department.count(),
    devices: await db.device.count(),
    projects: await db.project.count(),
    activities: await db.activity.count(),
    locations: await db.locationEvent.count(),
    screenshots: await db.screenshot.count(),
    consents: await db.consent.count(),
    consentPolicies: await db.consentPolicy.count(),
    sentiments: await db.sentimentRecord.count(),
    auditLogs: await db.auditLog.count(),
    alerts: await db.alert.count(),
    aiInsights: await db.aiInsight.count(),
    reports: await db.report.count(),
    notifications: await db.notification.count(),
    orgSettings: await db.organizationSetting.count(),
  };

  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(22)} ${String(count).padStart(6)}`);
  }

  // Role distribution
  const roleCounts = await db.organizationMembership.groupBy({
    by: ['role'],
    _count: true,
  });
  console.log('\n  📊 Membership role distribution:');
  for (const rc of roleCounts) {
    console.log(`  ${rc.role.padEnd(22)} ${String(rc._count).padStart(6)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔑 Login Credentials:');
  console.log(`  Super Admin: ${saUser.email} (use configured SUPER_ADMIN_PASSWORD)`);
  console.log(`  Demo Org Owner: owner@bng-computer-council.local / Demo@2026Pass`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  return counts;
}

// ─── Entry Point ────────────────────────────────────────────────────────
const isMainModule = process.argv[1]?.endsWith('seed-mega.ts') || process.argv[1]?.endsWith('seed-mega.js');

if (isMainModule) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Seed refused: cannot run in production');
    process.exit(1);
  }
  if (process.env.SEED_ALLOWED !== '1') {
    console.error('❌ Seed refused: SEED_ALLOWED=1 not set');
    process.exit(1);
  }
  seedMega()
    .catch((e) => { console.error('❌ MEGA seed failed:', e); process.exit(1); })
    .finally(async () => { await db.$disconnect(); });
}
