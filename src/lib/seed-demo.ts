/**
 * OmniSight — Comprehensive Multi-Org Demo Data Seed
 * ───────────────────────────────────────────────────
 * Creates a large, realistic, internally consistent demo dataset that
 * exercises the full application surface:
 *
 *   • 10 organizations with different sizes and characteristics
 *   • 2 platform Super Admins
 *   • 120+ AppUsers with 180+ OrganizationMemberships
 *   • Multi-org users (belonging to 2–3 orgs)
 *   • Users without memberships (platform-only)
 *   • 80+ devices with online/offline/stale/pending states
 *   • 50+ projects with members
 *   • 2000+ activity records across 30 days
 *   • 800+ location records
 *   • 150+ screenshot records
 *   • Consent policies, consents, and consent logs
 *   • Sentiment records and project sentiment
 *   • Organization settings and policies
 *
 * Production safety: REQUIRES SEED_ALLOWED=1 and NODE_ENV !== 'production'.
 * Idempotent: safe to run multiple times — detects existing demo data.
 *
 * Run with:  SEED_ALLOWED=1 npx tsx src/lib/seed-demo.ts
 * Or via:    npm run db:seed:demo
 */

import { db } from '@/lib/db';
import { hashPasswordSync } from '@/lib/auth';

// ─── Production Safety ──────────────────────────────────────────────────────
function assertSeedAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Seed refused: cannot run in production (NODE_ENV=production)');
    process.exit(1);
  }
  if (process.env.SEED_ALLOWED !== '1') {
    console.error('❌ Seed refused: SEED_ALLOWED=1 not set');
    process.exit(1);
  }
}

// ─── Deterministic PRNG (seeded) ────────────────────────────────────────────
// Mulberry32 — fast, deterministic, good enough for demo data
function createRng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _rng = createRng(2026_08_31); // deterministic seed
function rand(min: number, max: number): number {
  return Math.floor(_rng() * (max - min + 1)) + min;
}
function randFloat(min: number, max: number): number {
  return Math.round((_rng() * (max - min) + min) * 100) / 100;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(_rng() * arr.length)];
}
function pickN<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr].sort(() => _rng() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(rand(8, 18), rand(0, 59), 0, 0);
  return d;
}
function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}
function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3600_000);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEMO_NAMESPACE = 'DEMO-2026';
const DEMO_PASSWORD = 'Demo@2026Pass'; // Dev-only, satisfies 12-char + complexity policy

// ─── Organization Definitions ───────────────────────────────────────────────

interface OrgDef {
  name: string;
  slug: string;
  timezone: string;
  status: string;
  userCount: number;
  deptCount: number;
}

const ORG_DEFS: readonly OrgDef[] = [
  { name: 'Acme Corporation', slug: 'acme-corp', timezone: 'America/New_York', status: 'active', userCount: 35, deptCount: 8 },
  { name: 'Globex International', slug: 'globex-intl', timezone: 'Europe/London', status: 'active', userCount: 25, deptCount: 6 },
  { name: 'NovaTech Solutions', slug: 'novatech-sol', timezone: 'Asia/Tokyo', status: 'active', userCount: 20, deptCount: 5 },
  { name: 'BluePeak Analytics', slug: 'bluepeak', timezone: 'America/Chicago', status: 'active', userCount: 15, deptCount: 4 },
  { name: 'Delta Systems', slug: 'delta-sys', timezone: 'America/Los_Angeles', status: 'active', userCount: 12, deptCount: 4 },
  { name: 'Vertex Labs', slug: 'vertex-labs', timezone: 'Europe/Berlin', status: 'active', userCount: 10, deptCount: 3 },
  { name: 'Horizon Research', slug: 'horizon-research', timezone: 'Asia/Singapore', status: 'active', userCount: 8, deptCount: 3 },
  { name: 'SmallBiz Demo', slug: 'smallbiz-demo', timezone: 'America/Denver', status: 'active', userCount: 5, deptCount: 2 },
  { name: 'Inactive Corp', slug: 'inactive-corp', timezone: 'UTC', status: 'suspended', userCount: 3, deptCount: 1 },
  { name: 'Archived Industries', slug: 'archived-ind', timezone: 'UTC', status: 'archived', userCount: 2, deptCount: 1 },
];

const DEPT_NAMES = [
  'Engineering', 'Product', 'Design', 'Marketing', 'Human Resources',
  'Finance', 'Customer Success', 'DevOps', 'Sales', 'Security', 'Operations', 'Legal',
];

const FIRST_NAMES = [
  'Sarah', 'Marcus', 'Priya', 'James', 'Aisha', 'David', 'Elena', 'Alex', 'Maya', 'Ryan',
  'Olivia', 'Liam', 'Sophia', 'Ethan', 'Isabella', 'Noah', 'Charlotte', 'Benjamin', 'Amelia', 'Lucas',
  'Zara', 'Michael', 'Chloe', 'Daniel', 'Nina', 'Omar', 'Fatima', 'Yusuf', 'Layla', 'Hiroshi',
  'Akiko', 'Takeshi', 'Wei', 'Mei', 'Raj', 'Ananya', 'Sanjay', 'Priyanka', 'Chen', 'Li',
  'Anna', 'Viktor', 'Klaus', 'Eva', 'Hans', 'Ingrid', 'Lars', 'Freya', 'Olaf', 'Sigrid',
  'Tom', 'Jerry', 'Mike', 'Kate', 'Sam', 'Jess', 'Dan', 'Amy', 'Leo', 'Mia',
  'Carlos', 'Maria', 'Juan', 'Ana', 'Luis', 'Rosa', 'Pedro', 'Carmen', 'Miguel', 'Isabel',
  'Hassan', 'Nadia', 'Tariq', 'Leila', 'Karim', 'Salma', 'Jahid', 'Rima', 'Tanvir', 'Mitu',
];

const LAST_NAMES = [
  'Chen', 'Rodriguez', 'Patel', 'Wilson', 'Okafor', 'Kim', 'Volkov', 'Thompson', 'Singh', 'Garcia',
  'Brown', 'Nakamura', 'Martinez', 'Wright', 'Davis', 'Anderson', 'Taylor', 'Lee', 'Clark', 'Müller',
  'Hassan', 'OBrien', 'Young', 'Sato', 'Petrov', 'Ibrahim', 'Khan', 'Rahman', 'Sultana', 'Tanaka',
  'Yamamoto', 'Suzuki', 'Wang', 'Zhang', 'Sharma', 'Mehta', 'Reddy', 'Nair', 'Liu', 'Zhou',
  'Mueller', 'Schmidt', 'Fischer', 'Weber', 'Schneider', 'Bergmann', 'Hoffmann', 'Koch', 'Richter', 'Wolf',
  'Smith', 'Johnson', 'Williams', 'Jones', 'Brown', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Moore',
  'Lopez', 'Gonzalez', 'Hernandez', 'Perez', 'Sanchez', 'Ramirez', 'Torres', 'Flores', 'Rivera', 'Gomez',
  'Ahmed', 'Islam', 'Mahmud', 'Ali', 'Hossein', 'Begum', 'Hossain', 'Akter', 'Uddin', 'Chowdhury',
];

const JOB_TITLES = [
  'Senior Software Engineer', 'Staff Engineer', 'Software Engineer', 'Junior Software Engineer',
  'QA Engineer', 'DevOps Engineer', 'Site Reliability Engineer', 'Data Engineer',
  'VP of Product', 'Senior Product Manager', 'Product Manager', 'Product Analyst',
  'Design Lead', 'UX Designer', 'Visual Designer', 'Graphic Designer',
  'Marketing Director', 'Growth Marketing Manager', 'Content Strategist', 'SEO Specialist',
  'HR Manager', 'People Operations Lead', 'Recruiter', 'HR Coordinator',
  'Finance Manager', 'Accountant', 'Financial Analyst', 'Controller',
  'Customer Success Lead', 'Support Engineer', 'Account Manager', 'Onboarding Specialist',
  'Sales Director', 'Account Executive', 'Sales Representative', 'Business Development',
  'Security Engineer', 'Compliance Officer', 'IT Manager', 'System Administrator',
];

const PROJECT_NAMES = [
  'Website Redesign', 'Mobile App v2', 'API Gateway Migration', 'SOC 2 Compliance',
  'Data Pipeline v2', 'Customer Portal', 'Internal Automation', 'AI Research',
  'Infrastructure Upgrade', 'Cloud Migration', 'Marketing Campaign Q3', 'Security Hardening',
  'ERP Integration', 'Analytics Dashboard', 'Employee Portal', 'Document Management',
  'CI/CD Pipeline', 'Monitoring Overhaul', 'Performance Optimization', 'Tech Debt Sprint',
  'Onboarding Flow', 'Reporting Engine', 'Integration Hub', 'Mobile Push Notifications',
  'Accessibility Audit', 'Cost Optimization', 'Data Lake', 'ML Feature Store',
  'Webhooks System', 'Rate Limiter', 'Cache Layer', 'Search Engine',
  'Payment Integration', 'Email Service', 'Notification System', 'Audit Trail',
  'Backup Strategy', 'Disaster Recovery', 'Load Testing', 'Chaos Engineering',
  'Feature Flags', 'A/B Testing', 'Personalization Engine', 'Recommendation System',
  'Chat Bot', 'Knowledge Base', 'Status Page', 'API Documentation',
  'SDK Release', 'CLI Tool', 'Admin Dashboard', 'Client Portal',
  'Inventory System', 'Order Management', 'Supply Chain', 'Vendor Portal',
];

const APP_LIST = [
  { name: 'Visual Studio Code', exe: 'code.exe', cat: 'productive', publisher: 'Microsoft' },
  { name: 'Google Chrome', exe: 'chrome.exe', cat: 'productive', publisher: 'Google' },
  { name: 'Slack', exe: 'slack.exe', cat: 'productive', publisher: 'Slack' },
  { name: 'Microsoft Teams', exe: 'teams.exe', cat: 'productive', publisher: 'Microsoft' },
  { name: 'Figma', exe: 'figma.exe', cat: 'productive', publisher: 'Figma' },
  { name: 'Postman', exe: 'postman.exe', cat: 'productive', publisher: 'Postman' },
  { name: 'Terminal', exe: 'terminal.exe', cat: 'productive', publisher: 'Microsoft' },
  { name: 'GitHub Desktop', exe: 'github-desktop.exe', cat: 'productive', publisher: 'GitHub' },
  { name: 'Notion', exe: 'notion.exe', cat: 'productive', publisher: 'Notion' },
  { name: 'Jira', exe: 'jira.exe', cat: 'productive', publisher: 'Atlassian' },
  { name: 'Zoom', exe: 'zoom.exe', cat: 'productive', publisher: 'Zoom' },
  { name: 'Docker Desktop', exe: 'docker.exe', cat: 'productive', publisher: 'Docker' },
  { name: 'IntelliJ IDEA', exe: 'idea.exe', cat: 'productive', publisher: 'JetBrains' },
  { name: 'Spotify', exe: 'spotify.exe', cat: 'neutral', publisher: 'Spotify' },
  { name: 'Discord', exe: 'discord.exe', cat: 'neutral', publisher: 'Discord' },
  { name: 'YouTube', exe: 'chrome.exe', cat: 'unproductive', publisher: 'Google' },
  { name: 'Reddit', exe: 'chrome.exe', cat: 'unproductive', publisher: 'Reddit' },
];

const WEBSITE_LIST = [
  { title: 'GitHub', url: 'https://github.com', cat: 'productive' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com', cat: 'productive' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org', cat: 'productive' },
  { title: 'AWS Console', url: 'https://console.aws.amazon.com', cat: 'productive' },
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

const CONSENT_TYPES = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'location'] as const;

const PROJECT_STATUSES = ['active', 'active', 'active', 'on_hold', 'completed'] as const;
const PROJECT_PRIORITIES = ['low', 'medium', 'medium', 'high', 'critical'] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function deterministicCuid(index: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'c';
  for (let i = 0; i < 24; i++) {
    result += chars[Math.floor((_rng() * 26 + index * 7 + i * 13) % chars.length)];
  }
  return result;
}

// ─── Main Seed ──────────────────────────────────────────────────────────────

interface SeedCounts {
  organizations: number;
  users: number;
  memberships: number;
  departments: number;
  employees: number;
  devices: number;
  projects: number;
  projectMembers: number;
  activities: number;
  locations: number;
  screenshots: number;
  consents: number;
  consentLogs: number;
  consentPolicies: number;
  sentimentRecords: number;
  notifications: number;
  alerts: number;
  auditLogs: number;
  appListEntries: number;
  anomalies: number;
  reports: number;
  orgSettings: number;
  systemSettings: number;
  breakSessions: number;
  usbEvents: number;
  timeEntries: number;
  aiInsights: number;
}

async function seedDemoFull(): Promise<SeedCounts> {
  const startTime = Date.now();
  console.log('🚀 Starting OmniSight comprehensive demo seed...\n');
  console.log(`   Namespace: ${DEMO_NAMESPACE}`);
  console.log(`   Password: ${DEMO_PASSWORD} (development only)\n`);

  const counts: SeedCounts = {
    organizations: 0, users: 0, memberships: 0, departments: 0, employees: 0,
    devices: 0, projects: 0, projectMembers: 0, activities: 0, locations: 0,
    screenshots: 0, consents: 0, consentLogs: 0, consentPolicies: 0,
    sentimentRecords: 0, notifications: 0, alerts: 0, auditLogs: 0,
    appListEntries: 0, anomalies: 0, reports: 0, orgSettings: 0,
    systemSettings: 0, breakSessions: 0, usbEvents: 0, timeEntries: 0,
    aiInsights: 0,
  };

  // ── Check for existing demo data (idempotent) ──
  const existingOrgCount = await db.organization.count({
    where: { slug: { startsWith: 'demo-' } },
  });
  if (existingOrgCount > 0) {
    console.log(`⚠️  Found ${existingOrgCount} existing demo organizations.`);
    console.log('   Skipping creation. Seed is idempotent — no duplicates created.\n');
    // Still print summary of existing data
    await printSummary(counts, startTime);
    return counts;
  }

  const hashedPassword = hashPasswordSync(DEMO_PASSWORD);
  let globalUserIndex = 0;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. ORGANIZATIONS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣  Creating organizations...');
  const orgRows = await db.organization.createMany({
    data: ORG_DEFS.map((o) => ({
      name: o.name,
      slug: `demo-${o.slug}`,
      timezone: o.timezone,
      language: 'en',
      currency: 'USD',
      status: o.status,
      email: `info@${o.slug}.local`,
      phone: `+1-555-${String(counts.organizations).padStart(4, '0')}`,
    })),
    skipDuplicates: true,
  });
  counts.organizations = orgRows.count;
  const allOrgs = await db.organization.findMany({
    where: { slug: { startsWith: 'demo-' } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`   ✅ ${counts.organizations} organizations\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 2. SUPER ADMINS (platform-level, no org)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('2️⃣  Creating Super Admins...');
  const saData = [
    { email: 'demo.superadmin@omnisight.local', name: 'Super Admin Alpha' },
    { email: 'demo.superadmin2@omnisight.local', name: 'Super Admin Beta' },
  ];
  await db.appUser.createMany({
    data: saData.map((sa) => ({
      email: sa.email, name: sa.name, password: hashedPassword,
      role: 'super_admin', organizationId: null, isActive: true,
    })),
    skipDuplicates: true,
  });
  const superAdmins = await db.appUser.findMany({ where: { role: 'super_admin' } });
  console.log(`   ✅ ${superAdmins.length} Super Admins\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 3. ORGANIZATION USERS + MEMBERSHIPS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('3️⃣  Creating organization users and memberships...');
  const allUserRecords: { id: string; email: string; orgIndex: number }[] = [];
  const membershipRecords: { userId: string; organizationId: string; role: string; status: string }[] = [];

  for (let oi = 0; oi < allOrgs.length; oi++) {
    const org = allOrgs[oi];
    const orgDef = ORG_DEFS[oi];
    if (orgDef.status !== 'active') continue; // skip suspended/archived for user creation

    const userCount = orgDef.userCount;
    const usersForOrg: { email: string; name: string }[] = [];

    // Owner (1)
    usersForOrg.push({
      email: `demo.${orgDef.slug}.owner@omnisight.local`,
      name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    });

    // Org Admins (1-2)
    for (let i = 0; i < rand(1, 2); i++) {
      usersForOrg.push({
        email: `demo.${orgDef.slug}.admin${i + 1}@omnisight.local`,
        name: `${FIRST_NAMES[globalUserIndex % FIRST_NAMES.length]} ${LAST_NAMES[globalUserIndex % LAST_NAMES.length]}`,
      });
      globalUserIndex++;
    }

    // Managers (2-4)
    const managerCount = rand(2, 4);
    for (let i = 0; i < managerCount; i++) {
      usersForOrg.push({
        email: `demo.${orgDef.slug}.manager${i + 1}@omnisight.local`,
        name: `${FIRST_NAMES[globalUserIndex % FIRST_NAMES.length]} ${LAST_NAMES[globalUserIndex % LAST_NAMES.length]}`,
      });
      globalUserIndex++;
    }

    // Viewers (1-3)
    const viewerCount = rand(1, 3);
    for (let i = 0; i < viewerCount; i++) {
      usersForOrg.push({
        email: `demo.${orgDef.slug}.viewer${i + 1}@omnisight.local`,
        name: `${FIRST_NAMES[globalUserIndex % FIRST_NAMES.length]} ${LAST_NAMES[globalUserIndex % LAST_NAMES.length]}`,
      });
      globalUserIndex++;
    }

    // Fill remaining with regular users
    while (usersForOrg.length < Math.min(userCount, 15)) {
      usersForOrg.push({
        email: `demo.${orgDef.slug}.user${usersForOrg.length + 1}@omnisight.local`,
        name: `${FIRST_NAMES[globalUserIndex % FIRST_NAMES.length]} ${LAST_NAMES[globalUserIndex % LAST_NAMES.length]}`,
      });
      globalUserIndex++;
    }

    // Create AppUsers
    const userData = usersForOrg.map((u, idx) => ({
      email: u.email, name: u.name, password: hashedPassword,
      role: 'user' as const, organizationId: null as string | null,
      isActive: idx < usersForOrg.length - 1 || _rng() > 0.3, // last user may be inactive
    }));
    await db.appUser.createMany({ data: userData, skipDuplicates: true });

    // Fetch created users
    const emails = usersForOrg.map((u) => u.email);
    const createdUsers = await db.appUser.findMany({
      where: { email: { in: emails } },
    });

    // Assign membership roles
    const roleAssignments: string[] = [];
    roleAssignments.push('org_admin'); // owner → org_admin membership
    for (let i = 1; i <= rand(1, 2); i++) roleAssignments.push('org_admin');
    for (let i = 0; i < managerCount; i++) roleAssignments.push('manager');
    for (let i = 0; i < viewerCount; i++) roleAssignments.push('viewer');
    while (roleAssignments.length < createdUsers.length) roleAssignments.push('viewer');

    for (let i = 0; i < createdUsers.length; i++) {
      const user = createdUsers[i];
      const role = roleAssignments[i] || 'viewer';
      membershipRecords.push({
        userId: user.id, organizationId: org.id,
        role, status: 'ACTIVE',
      });
      allUserRecords.push({ id: user.id, email: user.email, orgIndex: oi });
    }
  }

  // Bulk insert memberships
  if (membershipRecords.length > 0) {
    await db.organizationMembership.createMany({
      data: membershipRecords, skipDuplicates: true,
    });
  }
  counts.users = await db.appUser.count();
  counts.memberships = await db.organizationMembership.count();
  console.log(`   ✅ ${counts.users} users, ${counts.memberships} memberships\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 3b. MULTI-ORG USERS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('4️⃣  Creating multi-org users...');
  const activeOrgs = allOrgs.filter((o) => o.status === 'active');
  if (activeOrgs.length >= 3) {
    const multiOrgEmails = [
      'demo.multi.org.user1@omnisight.local',
      'demo.multi.org.user2@omnisight.local',
      'demo.multi.org.user3@omnisight.local',
    ];
    await db.appUser.createMany({
      data: multiOrgEmails.map((email) => ({
        email, name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
        password: hashedPassword, role: 'user', organizationId: null, isActive: true,
      })),
      skipDuplicates: true,
    });
    const multiUsers = await db.appUser.findMany({
      where: { email: { in: multiOrgEmails } },
    });
    const multiMemberships: { userId: string; organizationId: string; role: string; status: string }[] = [];
    if (multiUsers[0]) {
      multiMemberships.push(
        { userId: multiUsers[0].id, organizationId: activeOrgs[0].id, role: 'org_admin', status: 'ACTIVE' },
        { userId: multiUsers[0].id, organizationId: activeOrgs[1].id, role: 'viewer', status: 'ACTIVE' },
      );
    }
    if (multiUsers[1]) {
      multiMemberships.push(
        { userId: multiUsers[1].id, organizationId: activeOrgs[1].id, role: 'manager', status: 'ACTIVE' },
        { userId: multiUsers[1].id, organizationId: activeOrgs[2].id, role: 'viewer', status: 'ACTIVE' },
      );
    }
    if (multiUsers[2] && activeOrgs.length >= 4) {
      multiMemberships.push(
        { userId: multiUsers[2].id, organizationId: activeOrgs[2].id, role: 'org_admin', status: 'ACTIVE' },
        { userId: multiUsers[2].id, organizationId: activeOrgs[3].id, role: 'manager', status: 'ACTIVE' },
        { userId: multiUsers[2].id, organizationId: activeOrgs[0].id, role: 'viewer', status: 'ACTIVE' },
      );
    }
    await db.organizationMembership.createMany({ data: multiMemberships, skipDuplicates: true });
    counts.memberships = await db.organizationMembership.count();
    console.log(`   ✅ ${multiOrgEmails.length} multi-org users\n`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3c. USERS WITHOUT MEMBERSHIP
  // ══════════════════════════════════════════════════════════════════════════
  console.log('5️⃣  Creating users without memberships...');
  const orphanEmails = [
    'demo.platform.user1@omnisight.local',
    'demo.platform.user2@omnisight.local',
    'demo.platform.pending@omnisight.local',
  ];
  await db.appUser.createMany({
    data: orphanEmails.map((email, i) => ({
      email, name: `Platform User ${i + 1}`, password: hashedPassword,
      role: 'user', organizationId: null, isActive: i < 2,
    })),
    skipDuplicates: true,
  });
  counts.users = await db.appUser.count();
  console.log(`   ✅ ${orphanEmails.length} users without memberships\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 4. DEPARTMENTS + EMPLOYEES + DEVICES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('6️⃣  Creating departments, employees, and devices...');
  const allEmployeeIds: { id: string; orgId: string; empIndex: number }[] = [];
  const allDeviceIds: { id: string; orgId: string; empId?: string }[] = [];
  let empGlobalIndex = 0;

  for (let oi = 0; oi < allOrgs.length; oi++) {
    const org = allOrgs[oi];
    const orgDef = ORG_DEFS[oi];
    if (orgDef.status !== 'active') continue;

    // Departments
    const deptCount = orgDef.deptCount;
    const deptData = DEPT_NAMES.slice(0, deptCount).map((name) => ({
      name, description: `${name} department for ${org.name}`,
      organizationId: org.id,
    }));
    await db.department.createMany({ data: deptData, skipDuplicates: true });
    const depts = await db.department.findMany({ where: { organizationId: org.id } });
    counts.departments += depts.length;

    // Employees (2-4 per department)
    const empData: {
      employeeId: string; firstName: string; lastName: string; email: string;
      designation: string; status: string; type: string; joinDate: Date;
      organizationId: string; departmentId: string; agentApproved: boolean;
    }[] = [];
    const deptEmployeeMap: { deptId: string; empIds: string[] }[] = [];

    for (const dept of depts) {
      const empPerDept = rand(2, 4);
      const deptEmps: string[] = [];
      for (let e = 0; e < empPerDept; e++) {
        const empNum = String(empGlobalIndex + 1).padStart(4, '0');
        const empEmail = `demo.emp${empNum}@${orgDef.slug}.local`;
        const status = empGlobalIndex % 20 === 19 ? 'inactive' : 'active';
        const empId = deterministicCuid(empGlobalIndex);
        deptEmps.push(empId);
        empData.push({
          employeeId: `EMP-${empNum}`,
          firstName: FIRST_NAMES[empGlobalIndex % FIRST_NAMES.length],
          lastName: LAST_NAMES[empGlobalIndex % LAST_NAMES.length],
          email: empEmail,
          designation: pick(JOB_TITLES),
          status, type: 'employee',
          joinDate: daysAgo(rand(30, 730)),
          organizationId: org.id, departmentId: dept.id,
          agentApproved: _rng() > 0.15,
        });
        empGlobalIndex++;
      }
      deptEmployeeMap.push({ deptId: dept.id, empIds: deptEmps });
    }

    if (empData.length > 0) {
      // Use individual creates to get IDs (createMany doesn't return IDs in all drivers)
      for (const e of empData) {
        const created = await db.employee.create({
          data: { ...e, id: deterministicCuid(empGlobalIndex - empData.length + empData.indexOf(e)) },
        });
        allEmployeeIds.push({ id: created.id, orgId: org.id, empIndex: empGlobalIndex - empData.length + empData.indexOf(e) });
      }
    }

    // Devices (1 per employee, varying states)
    const deviceData: {
      name: string; hostname: string; operatingSystem: string; osVersion: string;
      processor: string; memory: string; agentVersion: string;
      status: string; lastHeartbeat: Date | null;
      organizationId: string; employeeId: string;
      ipAddress: string; macAddress: string;
    }[] = [];

    const orgEmpIds = allEmployeeIds.filter((e) => e.orgId === org.id);
    for (let i = 0; i < orgEmpIds.length; i++) {
      const empId = orgEmpIds[i].id;
      const tpl = pick(DEVICE_TEMPLATES);
      const stateRoll = _rng();
      let status: string;
      let heartbeat: Date | null;
      if (stateRoll < 0.55) { status = 'online'; heartbeat = minutesAgo(rand(1, 30)); }
      else if (stateRoll < 0.75) { status = 'offline'; heartbeat = hoursAgo(rand(2, 72)); }
      else if (stateRoll < 0.90) { status = 'online'; heartbeat = minutesAgo(rand(1, 15)); }
      else { status = 'offline'; heartbeat = daysAgo(rand(3, 14)); }

      deviceData.push({
        name: `${pick(FIRST_NAMES)}-${pick(LAST_NAMES)}-Laptop`,
        hostname: `${orgDef.slug.toUpperCase().slice(0, 6)}-${String(i + 1).padStart(3, '0')}`,
        operatingSystem: tpl.os, osVersion: tpl.osVer,
        processor: tpl.proc, memory: tpl.mem, agentVersion: tpl.agent,
        status, lastHeartbeat: heartbeat,
        organizationId: org.id, employeeId: empId,
        ipAddress: `10.${oi}.${rand(1, 254)}.${rand(1, 254)}`,
        macAddress: Array.from({ length: 6 }, () => rand(0, 255).toString(16).padStart(2, '0')).join(':'),
      });
    }

    if (deviceData.length > 0) {
      await db.device.createMany({ data: deviceData, skipDuplicates: true });
      const orgDevices = await db.device.findMany({
        where: { organizationId: org.id },
        select: { id: true, employeeId: true },
      });
      for (const d of orgDevices) {
        allDeviceIds.push({ id: d.id, orgId: org.id, empId: d.employeeId || undefined });
      }
      counts.devices += orgDevices.length;
    }
  }
  counts.employees = allEmployeeIds.length;
  console.log(`   ✅ ${counts.departments} departments, ${counts.employees} employees, ${counts.devices} devices\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 5. PROJECTS + PROJECT MEMBERS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('7️⃣  Creating projects and project members...');
  const allProjectIds: { id: string; orgId: string }[] = [];

  for (let oi = 0; oi < allOrgs.length; oi++) {
    const org = allOrgs[oi];
    if (ORG_DEFS[oi].status !== 'active') continue;

    const projCount = rand(4, 8);
    const projNames = pickN(PROJECT_NAMES, projCount);
    const orgEmpIds = allEmployeeIds.filter((e) => e.orgId === org.id);

    const projData = projNames.map((name) => ({
      name: `${name} — ${ORG_DEFS[oi].name.split(' ')[0]}`,
      description: `Demo project: ${name}`,
      status: pick(PROJECT_STATUSES),
      priority: pick(PROJECT_PRIORITIES),
      color: pick(['#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#f59e0b', '#06b6d4']),
      budgetType: pick(['fixed', 'hourly', 'fixed', 'hourly']),
      hourlyRate: rand(80, 200),
      estimatedHours: rand(100, 800),
      startDate: daysAgo(rand(30, 180)),
      deadline: daysAgo(-rand(7, 90)),
      tags: JSON.stringify(pickN(['web', 'mobile', 'api', 'ai', 'security', 'infra', 'data', 'ux', 'compliance', 'devops'], rand(2, 4))),
      organizationId: org.id,
    }));

    await db.project.createMany({ data: projData, skipDuplicates: true });
    const orgProjects = await db.project.findMany({ where: { organizationId: org.id } });
    for (const p of orgProjects) allProjectIds.push({ id: p.id, orgId: org.id });
    counts.projects += orgProjects.length;

    // Project members
    const pmData: { projectId: string; employeeId: string; role: string; hoursPerWeek: number; organizationId: string }[] = [];
    for (const proj of orgProjects) {
      const members = pickN(orgEmpIds, rand(3, Math.min(8, orgEmpIds.length)));
      for (let j = 0; j < members.length; j++) {
        pmData.push({
          projectId: proj.id, employeeId: members[j].id,
          role: j === 0 ? 'lead' : j < 3 ? 'member' : 'reviewer',
          hoursPerWeek: rand(10, 40), organizationId: org.id,
        });
      }
    }
    if (pmData.length > 0) {
      await db.projectMember.createMany({ data: pmData, skipDuplicates: true });
      counts.projectMembers += pmData.length;
    }
  }
  console.log(`   ✅ ${counts.projects} projects, ${counts.projectMembers} project members\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 6. ACTIVITIES (bulk — 2000+ records)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('8️⃣  Creating activities (~2500 records)...');
  const activityBatch: {
    type: string; title?: string; url?: string; applicationName?: string;
    category: string; duration: number; employeeId: string; deviceId?: string;
    timestamp: Date; createdAt: Date;
  }[] = [];

  const activeEmps = allEmployeeIds.filter((_, i) => i % 20 !== 19); // exclude inactive
  for (let i = 0; i < 2500; i++) {
    const emp = pick(activeEmps);
    const dev = allDeviceIds.find((d) => d.empId === emp.id);
    const dayOffset = rand(0, 29);
    const ts = daysAgo(dayOffset);
    ts.setHours(rand(8, 19), rand(0, 59), 0, 0);

    const isApp = _rng() > 0.3;
    if (isApp) {
      const app = pick(APP_LIST);
      activityBatch.push({
        type: 'application', title: app.name, applicationName: app.exe,
        category: app.cat, duration: rand(60, 3600),
        employeeId: emp.id, deviceId: dev?.id,
        timestamp: ts, createdAt: ts,
      });
    } else {
      const site = pick(WEBSITE_LIST);
      activityBatch.push({
        type: 'website', title: site.title, url: site.url,
        category: site.cat, duration: rand(60, 3600),
        employeeId: emp.id, deviceId: dev?.id,
        timestamp: ts, createdAt: ts,
      });
    }
  }

  // Batch insert activities
  for (let i = 0; i < activityBatch.length; i += 500) {
    const chunk = activityBatch.slice(i, i + 500);
    const result = await db.activity.createMany({ data: chunk, skipDuplicates: true });
    counts.activities += result.count;
  }
  console.log(`   ✅ ${counts.activities} activities\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 7. LOCATIONS (800+ records)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('9️⃣  Creating location records (~800)...');
  const locationBatch: {
    employeeId: string; deviceId?: string; latitude: number; longitude: number;
    accuracy: number; recordedAt: Date; organizationId: string; source: string;
  }[] = [];

  // Fictional office coordinates
  const offices = [
    { lat: 40.7128, lng: -74.0060, name: 'NYC' },
    { lat: 51.5074, lng: -0.1278, name: 'London' },
    { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
    { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
    { lat: 34.0522, lng: -118.2437, name: 'LA' },
    { lat: 52.5200, lng: 13.4050, name: 'Berlin' },
    { lat: 1.3521, lng: 103.8198, name: 'Singapore' },
  ];

  for (let i = 0; i < 800; i++) {
    const emp = pick(activeEmps);
    const dev = allDeviceIds.find((d) => d.empId === emp.id);
    const org = allOrgs.find((o) => o.id === emp.orgId);
    const oi = allOrgs.indexOf(org!);
    const office = offices[oi % offices.length];
    const dayOffset = rand(0, 29);
    const ts = daysAgo(dayOffset);
    ts.setHours(rand(8, 19), rand(0, 59), 0, 0);

    locationBatch.push({
      employeeId: emp.id, deviceId: dev?.id,
      latitude: office.lat + randFloat(-0.05, 0.05),
      longitude: office.lng + randFloat(-0.05, 0.05),
      accuracy: rand(5, 50),
      recordedAt: ts, organizationId: emp.orgId,
      source: _rng() > 0.3 ? 'native' : 'ip',
    });
  }

  for (let i = 0; i < locationBatch.length; i += 500) {
    const chunk = locationBatch.slice(i, i + 500);
    const result = await db.locationEvent.createMany({ data: chunk, skipDuplicates: true });
    counts.locations += result.count;
  }
  console.log(`   ✅ ${counts.locations} locations\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 8. SCREENSHOTS (150+ records)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('🔟 Creating screenshots (~150)...');
  const screenshotBatch: {
    employeeId: string; deviceId?: string; filePath: string; fileName: string;
    fileSize: number; mimeType: string; width: number; height: number;
    appWindow?: string; ocrText?: string; flagged: boolean; flagReason?: string;
    blurScore: number; organizationId: string; capturedAt: Date;
  }[] = [];

  for (let i = 0; i < 150; i++) {
    const emp = pick(activeEmps);
    const dev = allDeviceIds.find((d) => d.empId === emp.id);
    const isFlagged = _rng() < 0.08;
    const dayOffset = rand(0, 29);
    const capAt = daysAgo(dayOffset);
    capAt.setHours(rand(9, 17), rand(0, 59), 0, 0);

    screenshotBatch.push({
      employeeId: emp.id, deviceId: dev?.id,
      filePath: `/screenshots/${emp.id}/${dayOffset}-${i}.png`,
      fileName: `screenshot-${dayOffset}-${i}.png`,
      fileSize: rand(80000, 600000),
      mimeType: 'image/png', width: 1920, height: 1080,
      appWindow: pick(APP_LIST).name,
      ocrText: isFlagged ? 'Confidential: financial report Q3' : undefined,
      flagged: isFlagged,
      flagReason: isFlagged ? 'Contains potential sensitive data' : undefined,
      blurScore: isFlagged ? 0.3 : randFloat(0.7, 1.0),
      organizationId: emp.orgId, capturedAt: capAt,
    });
  }

  for (let i = 0; i < screenshotBatch.length; i += 100) {
    const chunk = screenshotBatch.slice(i, i + 100);
    const result = await db.screenshot.createMany({ data: chunk, skipDuplicates: true });
    counts.screenshots += result.count;
  }
  console.log(`   ✅ ${counts.screenshots} screenshots\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 9. CONSENT POLICIES + CONSENTS + CONSENT LOGS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣1️⃣ Creating consent policies, consents, and logs...');
  const consentLogBatch: { consentId: string; action: string; description: string; performedBy: string; organizationId: string }[] = [];

  for (let oi = 0; oi < allOrgs.length; oi++) {
    const org = allOrgs[oi];
    if (ORG_DEFS[oi].status !== 'active') continue;
    const orgEmps = allEmployeeIds.filter((e) => e.orgId === org.id);

    // Consent policies
    for (const ct of CONSENT_TYPES) {
      await db.consentPolicy.create({
        data: {
          organizationId: org.id, consentType: ct,
          title: `${ct.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Policy`,
          content: `Policy for ${ct.replace(/_/g, ' ')} consent in ${org.name}`,
          version: 'v1', status: 'published',
          effectiveAt: daysAgo(90), publishedAt: daysAgo(90),
          publishedBy: superAdmins[0]?.id, createdBy: superAdmins[0]?.id,
        },
      }).catch(() => {}); // skip if exists
      counts.consentPolicies++;
    }

    // Consents for each employee — create individually to capture IDs for logs
    for (const emp of orgEmps) {
      for (const ct of CONSENT_TYPES) {
        const status = _rng() > 0.15 ? 'granted' : _rng() > 0.5 ? 'pending' : 'denied';
        const consent = await db.consent.create({
          data: {
            employeeId: emp.id, consentType: ct, status,
            grantedAt: status === 'granted' ? daysAgo(rand(10, 80)) : null,
            consentVersion: 'v1', organizationId: org.id,
          },
        }).catch(() => null);
        if (consent) {
          counts.consents++;
          consentLogBatch.push({
            consentId: consent.id,
            action: status === 'granted' ? 'granted' : status === 'pending' ? 'requested' : 'denied',
            description: `${status === 'granted' ? 'Granted' : status === 'pending' ? 'Requested' : 'Denied'} ${ct} consent`,
            performedBy: emp.id, organizationId: org.id,
          });
        }
      }
    }
  }

  for (let i = 0; i < consentLogBatch.length; i += 500) {
    const chunk = consentLogBatch.slice(i, i + 500);
    const result = await db.consentLog.createMany({ data: chunk, skipDuplicates: true });
    counts.consentLogs += result.count;
  }
  console.log(`   ✅ ${counts.consentPolicies} policies, ${counts.consents} consents, ${counts.consentLogs} logs\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 10. SENTIMENT RECORDS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣2️⃣ Creating sentiment records...');
  const sentimentBatch: {
    employeeId: string; score: number; mood: string; signals: string;
    insight: string; riskFactors: string; recommendation: string;
    periodStart: Date; periodEnd: Date; aiProviderUsed: string;
    organizationId: string;
  }[] = [];

  for (const emp of activeEmps) {
    const score = randFloat(20, 95);
    const mood = score > 65 ? 'positive' : score > 40 ? 'neutral' : score > 20 ? 'negative' : 'critical';
    sentimentBatch.push({
      employeeId: emp.id, score, mood,
      signals: JSON.stringify({
        productivityTrend: pick(['increasing', 'stable', 'decreasing']),
        idleRate: randFloat(5, 30), overtimeHours: randFloat(0, 15),
        breakFrequency: rand(2, 8), loginConsistency: pick(['high', 'medium', 'low']),
      }),
      insight: `Employee shows ${mood} sentiment patterns.`,
      riskFactors: score < 40 ? JSON.stringify(['burnout_risk', 'overtime']) : '[]',
      recommendation: score < 40 ? 'Schedule a wellness check-in' : 'Continue current work patterns',
      periodStart: daysAgo(14), periodEnd: new Date(),
      aiProviderUsed: 'rules', organizationId: emp.orgId,
    });
  }

  for (let i = 0; i < sentimentBatch.length; i += 500) {
    const chunk = sentimentBatch.slice(i, i + 500);
    const result = await db.sentimentRecord.createMany({ data: chunk, skipDuplicates: true });
    counts.sentimentRecords += result.count;
  }
  console.log(`   ✅ ${counts.sentimentRecords} sentiment records\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 11. NOTIFICATIONS + ALERTS + AUDIT LOGS + ANOMALIES + REPORTS + AI INSIGHTS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣3️⃣ Creating notifications, alerts, audit logs, anomalies, reports, AI insights...');
  const notifBatch: { title: string; message: string; type: string; priority: string; status: string; actionUrl: string; employeeId: string; deviceId?: string; organizationId: string; createdAt: Date }[] = [];
  const alertBatch: { title: string; description: string; type: string; severity: string; status: string; source: string; organizationId: string; createdAt: Date }[] = [];
  const auditBatch: { action: string; resource: string; description: string; userId: string; ipAddress: string; organizationId: string; createdAt: Date }[] = [];
  const anomalyBatch: { type: string; severity: string; title: string; description: string; score: number; confidence: number; status: string; employeeId: string; organizationId: string; createdAt: Date }[] = [];
  const reportBatch: { title: string; type: string; format: string; status: string; organizationId: string; generatedBy: string; createdAt: Date }[] = [];
  const insightBatch: { title: string; content: string; type: string; category: string; confidence: number; status: string; organizationId: string; createdAt: Date }[] = [];

  for (let oi = 0; oi < allOrgs.length; oi++) {
    const org = allOrgs[oi];
    if (ORG_DEFS[oi].status !== 'active') continue;
    const orgEmps = allEmployeeIds.filter((e) => e.orgId === org.id);
    const orgAdmin = membershipRecords.find((m) => m.organizationId === org.id && m.role === 'org_admin');

    // Notifications (10-20 per org)
    for (let i = 0; i < rand(10, 20); i++) {
      const emp = pick(orgEmps);
      const dev = allDeviceIds.find((d) => d.empId === emp.id);
      const isRead = _rng() > 0.4;
      notifBatch.push({
        title: pick(['Device Offline', 'New Employee', 'Policy Violation', 'High Inactivity', 'AI Recommendation', 'Security Alert', 'System Update', 'Anomaly Detected']),
        message: `Demo notification for ${ORG_DEFS[oi].name}`,
        type: pick(['device_offline', 'new_employee', 'policy_violation', 'high_inactivity', 'ai_recommendation', 'security', 'system', 'anomaly_detected']),
        priority: pick(['low', 'medium', 'high', 'critical']),
        status: isRead ? 'read' : 'unread',
        actionUrl: pick(['/employees', '/devices', '/policies', '/insights', '/security']),
        employeeId: emp.id, deviceId: dev?.id,
        organizationId: org.id, createdAt: hoursAgo(rand(1, 72)),
      });
    }

    // Alerts (3-6 per org)
    for (let i = 0; i < rand(3, 6); i++) {
      alertBatch.push({
        title: pick(['Device Offline', 'Policy Violation Spike', 'Security Breach', 'License Warning', 'System Health']),
        description: `Demo alert for ${ORG_DEFS[oi].name}`,
        type: pick(['device_offline', 'policy_violation', 'security', 'license', 'system']),
        severity: pick(['info', 'warning', 'error', 'critical']),
        status: pick(['pending', 'acknowledged', 'resolved']),
        source: 'system', organizationId: org.id,
        createdAt: hoursAgo(rand(1, 48)),
      });
    }

    // Audit logs (5-15 per org)
    for (let i = 0; i < rand(5, 15); i++) {
      auditBatch.push({
        action: pick(['login', 'create', 'update', 'delete', 'export', 'configure']),
        resource: pick(['employee', 'device', 'department', 'settings', 'report', 'project']),
        description: `Audit event in ${ORG_DEFS[oi].name}`,
        userId: orgAdmin?.userId || superAdmins[0]?.id,
        ipAddress: `10.${oi}.${rand(1, 254)}.${rand(1, 254)}`,
        organizationId: org.id, createdAt: hoursAgo(rand(1, 168)),
      });
    }

    // Anomalies (2-5 per org)
    for (let i = 0; i < rand(2, 5); i++) {
      const emp = pick(orgEmps);
      anomalyBatch.push({
        type: pick(['productivity_drop', 'excessive_idle', 'unusual_login', 'rapid_app_switch', 'overtime_work', 'policy_breach']),
        severity: pick(['low', 'medium', 'high', 'critical']),
        title: `Anomaly detected in ${ORG_DEFS[oi].name}`,
        description: `Automated anomaly detection triggered`,
        score: rand(30, 95), confidence: randFloat(0.6, 0.99),
        status: pick(['detected', 'investigating', 'resolved']),
        employeeId: emp.id, organizationId: org.id,
        createdAt: hoursAgo(rand(1, 72)),
      });
    }

    // Reports (2-4 per org)
    for (let i = 0; i < rand(2, 4); i++) {
      reportBatch.push({
        title: `${pick(['Productivity', 'Activity', 'Device', 'Compliance'])} Report — ${ORG_DEFS[oi].name}`,
        type: pick(['productivity', 'activity', 'device', 'organization']),
        format: pick(['pdf', 'excel', 'csv']),
        status: 'completed', organizationId: org.id,
        generatedBy: orgAdmin?.userId || superAdmins[0]?.id,
        createdAt: hoursAgo(rand(24, 168)),
      });
    }

    // AI insights (2-4 per org)
    for (let i = 0; i < rand(2, 4); i++) {
      insightBatch.push({
        title: `${pick(['Productivity Trend', 'Burnout Risk', 'Workload Balance', 'Anomaly Pattern'])} — ${ORG_DEFS[oi].name}`,
        content: `AI-generated insight for ${ORG_DEFS[oi].name}. This is a demo insight.`,
        type: pick(['trend', 'risk', 'recommendation', 'anomaly']),
        category: pick(['employee', 'team', 'department', 'organization']),
        confidence: randFloat(0.65, 0.98),
        status: 'active', organizationId: org.id,
        createdAt: hoursAgo(rand(1, 72)),
      });
    }
  }

  // Batch insert all
  if (notifBatch.length > 0) { const r = await db.notification.createMany({ data: notifBatch, skipDuplicates: true }); counts.notifications = r.count; }
  if (alertBatch.length > 0) { const r = await db.alert.createMany({ data: alertBatch, skipDuplicates: true }); counts.alerts = r.count; }
  if (auditBatch.length > 0) { const r = await db.auditLog.createMany({ data: auditBatch, skipDuplicates: true }); counts.auditLogs = r.count; }
  if (anomalyBatch.length > 0) { const r = await db.anomaly.createMany({ data: anomalyBatch, skipDuplicates: true }); counts.anomalies = r.count; }
  if (reportBatch.length > 0) { const r = await db.report.createMany({ data: reportBatch, skipDuplicates: true }); counts.reports = r.count; }
  if (insightBatch.length > 0) { const r = await db.aiInsight.createMany({ data: insightBatch, skipDuplicates: true }); counts.aiInsights = r.count; }
  console.log(`   ✅ ${counts.notifications} notifications, ${counts.alerts} alerts, ${counts.auditLogs} audit logs`);
  console.log(`   ✅ ${counts.anomalies} anomalies, ${counts.reports} reports, ${counts.aiInsights} AI insights\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 12. APP LIST ENTRIES + ORG SETTINGS + SYSTEM SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣4️⃣ Creating app list entries, org settings, system settings...');
  const appListBatch: { appName: string; executableName: string; listType: string; reason: string; publisher: string; isActive: boolean; organizationId: string }[] = [];
  const orgSettingBatch: { organizationId: string; key: string; value: string; category: string }[] = [];

  for (let oi = 0; oi < allOrgs.length; oi++) {
    const org = allOrgs[oi];
    if (ORG_DEFS[oi].status !== 'active') continue;

    // App list (subset for each org)
    for (const app of pickN(APP_LIST, rand(5, 9))) {
      appListBatch.push({
        appName: app.name, executableName: app.exe,
        listType: app.cat === 'unproductive' ? 'blacklist' : 'whitelist',
        reason: `Demo policy for ${ORG_DEFS[oi].name}`,
        publisher: app.publisher, isActive: true, organizationId: org.id,
      });
    }

    // Org settings
    orgSettingBatch.push(
      { organizationId: org.id, key: 'screenshot_enabled', value: 'true', category: 'monitoring' },
      { organizationId: org.id, key: 'location_tracking', value: _rng() > 0.3 ? 'true' : 'false', category: 'monitoring' },
      { organizationId: org.id, key: 'keystroke_logging', value: 'false', category: 'security' },
      { organizationId: org.id, key: 'usb_monitoring', value: 'true', category: 'security' },
      { organizationId: org.id, key: 'data_retention_days', value: String(pick([60, 90, 120, 180])), category: 'compliance' },
    );
  }

  if (appListBatch.length > 0) { const r = await db.appListEntry.createMany({ data: appListBatch, skipDuplicates: true }); counts.appListEntries = r.count; }
  if (orgSettingBatch.length > 0) { const r = await db.organizationSetting.createMany({ data: orgSettingBatch, skipDuplicates: true }); counts.orgSettings = r.count; }

  await db.systemSetting.createMany({
    data: [
      { key: 'app_name', value: 'OmniSight', category: 'general' },
      { key: 'app_version', value: '0.2.1', category: 'general' },
      { key: 'maintenance_mode', value: 'false', category: 'general' },
      { key: 'rate_limit_enabled', value: 'true', category: 'security' },
    ],
    skipDuplicates: true,
  });
  counts.systemSettings = 4;
  console.log(`   ✅ ${counts.appListEntries} app list entries, ${counts.orgSettings} org settings, ${counts.systemSettings} system settings\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 13. BREAK SESSIONS + USB EVENTS + TIME ENTRIES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('1️⃣5️⃣ Creating break sessions, USB events, time entries...');
  const breakBatch: { organizationId: string; employeeId: string; deviceId?: string; startedAt: Date; endedAt: Date | null; source: string; startedBy: string; endedBy: string | null; endReason: string }[] = [];
  const usbBatch: { eventType: string; deviceName: string; vendorName: string; serialNumber: string; employeeId: string; blocked: boolean; organizationId: string; createdAt: Date }[] = [];
  const timeEntryBatch: { projectId: string; employeeId: string; date: Date; hours: number; description: string; category: string; billable: boolean; source: string; organizationId: string }[] = [];

  const categories = ['development', 'design', 'meeting', 'research', 'testing', 'review', 'admin'];

  for (const emp of activeEmps) {
    const dev = allDeviceIds.find((d) => d.empId === emp.id);
    // Break sessions (2-5 per employee)
    for (let b = 0; b < rand(2, 5); b++) {
      const start = daysAgo(rand(0, 6));
      start.setHours(rand(10, 16), rand(0, 59));
      breakBatch.push({
        organizationId: emp.orgId, employeeId: emp.id, deviceId: dev?.id,
        startedAt: start, endedAt: new Date(start.getTime() + rand(5, 45) * 60_000),
        source: pick(['employee', 'admin', 'agent']),
        startedBy: emp.id, endedBy: emp.id, endReason: 'employee_ended',
      });
    }

    // USB events (1-3 per employee)
    for (let u = 0; u < rand(0, 3); u++) {
      usbBatch.push({
        eventType: pick(['usb_insert', 'usb_remove', 'usb_blocked']),
        deviceName: pick(['USB Mass Storage', 'USB Flash Drive', 'External HDD', 'USB Keyboard']),
        vendorName: pick(['SanDisk', 'Kingston', 'Seagate', 'Logitech', 'Samsung']),
        serialNumber: Array.from({ length: 16 }, () => rand(0, 15).toString(16)).join(''),
        employeeId: emp.id, blocked: _rng() < 0.2,
        organizationId: emp.orgId, createdAt: hoursAgo(rand(1, 168)),
      });
    }
  }

  // Time entries (from project members)
  for (const proj of allProjectIds) {
    const orgEmpsForProj = allEmployeeIds.filter((e) => e.orgId === proj.orgId);
    const members = pickN(orgEmpsForProj, rand(3, 6));
    for (const m of members) {
      for (let day = 0; day < 14; day++) {
        if (_rng() < 0.3) continue;
        timeEntryBatch.push({
          projectId: proj.id, employeeId: m.id,
          date: daysAgo(day), hours: randFloat(1, 8),
          description: `Work on ${PROJECT_NAMES[rand(0, PROJECT_NAMES.length - 1)]}`,
          category: pick(categories), billable: _rng() > 0.15,
          source: _rng() > 0.5 ? 'ACTIVITY_AUTO' : 'MANUAL',
          organizationId: proj.orgId,
        });
      }
    }
  }

  if (breakBatch.length > 0) { const r = await db.breakSession.createMany({ data: breakBatch, skipDuplicates: true }); counts.breakSessions = r.count; }
  if (usbBatch.length > 0) { const r = await db.usbEvent.createMany({ data: usbBatch, skipDuplicates: true }); counts.usbEvents = r.count; }
  if (timeEntryBatch.length > 0) {
    for (let i = 0; i < timeEntryBatch.length; i += 500) {
      const chunk = timeEntryBatch.slice(i, i + 500);
      const r = await db.timeEntry.createMany({ data: chunk, skipDuplicates: true });
      counts.timeEntries += r.count;
    }
  }
  console.log(`   ✅ ${counts.breakSessions} break sessions, ${counts.usbEvents} USB events, ${counts.timeEntries} time entries\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  await printSummary(counts, startTime);
  return counts;
}

async function printSummary(counts: SeedCounts, startTime: number): Promise<void> {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🎉 OmniSight Demo Seed Complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Count from DB for accuracy
  const dbCounts = {
    organizations: await db.organization.count({ where: { slug: { startsWith: 'demo-' } } }),
    users: await db.appUser.count(),
    memberships: await db.organizationMembership.count(),
    departments: await db.department.count(),
    employees: await db.employee.count(),
    devices: await db.device.count(),
    projects: await db.project.count(),
    projectMembers: await db.projectMember.count(),
    activities: await db.activity.count(),
    locations: await db.locationEvent.count(),
    screenshots: await db.screenshot.count(),
    consents: await db.consent.count(),
    consentLogs: await db.consentLog.count(),
    consentPolicies: await db.consentPolicy.count(),
    sentimentRecords: await db.sentimentRecord.count(),
    notifications: await db.notification.count(),
    alerts: await db.alert.count(),
    auditLogs: await db.auditLog.count(),
    anomalies: await db.anomaly.count(),
    reports: await db.report.count(),
    aiInsights: await db.aiInsight.count(),
    appListEntries: await db.appListEntry.count(),
    orgSettings: await db.organizationSetting.count(),
    breakSessions: await db.breakSession.count(),
    usbEvents: await db.usbEvent.count(),
    timeEntries: await db.timeEntry.count(),
  };

  console.log('  📊 Dataset Summary (from database):');
  console.log('');
  console.log(`  Organizations:        ${dbCounts.organizations}`);
  console.log(`  App Users:            ${dbCounts.users}`);
  console.log(`  Memberships:          ${dbCounts.memberships}`);
  console.log(`  Departments:          ${dbCounts.departments}`);
  console.log(`  Employees:            ${dbCounts.employees}`);
  console.log(`  Devices:              ${dbCounts.devices}`);
  console.log(`  Projects:             ${dbCounts.projects}`);
  console.log(`  Project Members:      ${dbCounts.projectMembers}`);
  console.log(`  Activities:           ${dbCounts.activities}`);
  console.log(`  Locations:            ${dbCounts.locations}`);
  console.log(`  Screenshots:          ${dbCounts.screenshots}`);
  console.log(`  Consent Policies:     ${dbCounts.consentPolicies}`);
  console.log(`  Consents:             ${dbCounts.consents}`);
  console.log(`  Consent Logs:         ${dbCounts.consentLogs}`);
  console.log(`  Sentiment Records:    ${dbCounts.sentimentRecords}`);
  console.log(`  Notifications:        ${dbCounts.notifications}`);
  console.log(`  Alerts:               ${dbCounts.alerts}`);
  console.log(`  Audit Logs:           ${dbCounts.auditLogs}`);
  console.log(`  Anomalies:            ${dbCounts.anomalies}`);
  console.log(`  Reports:              ${dbCounts.reports}`);
  console.log(`  AI Insights:          ${dbCounts.aiInsights}`);
  console.log(`  App List Entries:     ${dbCounts.appListEntries}`);
  console.log(`  Org Settings:         ${dbCounts.orgSettings}`);
  console.log(`  Break Sessions:       ${dbCounts.breakSessions}`);
  console.log(`  USB Events:           ${dbCounts.usbEvents}`);
  console.log(`  Time Entries:         ${dbCounts.timeEntries}`);
  console.log('');
  console.log(`  ⏱️  Completed in ${elapsed}s`);
  console.log('');

  // Demo accounts
  const superAdmins = await db.appUser.findMany({ where: { role: 'super_admin' }, select: { email: true } });
  console.log('  🔑 Demo Accounts:');
  console.log('');
  console.log('  Super Admin:');
  for (const sa of superAdmins) console.log(`    ${sa.email}`);
  console.log('');
  console.log('  Organization Admin (Acme):');
  console.log('    demo.acme-corp.owner@omnisight.local');
  console.log('');
  console.log('  Manager (Acme):');
  console.log('    demo.acme-corp.manager1@omnisight.local');
  console.log('');
  console.log('  Viewer (Acme):');
  console.log('    demo.acme-corp.viewer1@omnisight.local');
  console.log('');
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log('  ⚠️  Development only — do not use in production!');
  console.log('');
  console.log('  Multi-org users:');
  console.log('    demo.multi.org.user1@omnisight.local (Acme: Admin, Globex: Viewer)');
  console.log('    demo.multi.org.user2@omnisight.local (Globex: Manager, NovaTech: Viewer)');
  console.log('    demo.multi.org.user3@omnisight.local (NovaTech: Admin, BluePeak: Manager, Acme: Viewer)');
  console.log('');
  console.log('  Users without membership:');
  console.log('    demo.platform.user1@omnisight.local (active)');
  console.log('    demo.platform.user2@omnisight.local (active)');
  console.log('    demo.platform.pending@omnisight.local (inactive)');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─── Run ────────────────────────────────────────────────────────────────────

assertSeedAllowed();

seedDemoFull()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
