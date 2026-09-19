// OmniSight — UAT support dataset seeder.
//
// Seeds a DEDICATED, throwaway UAT organization with a believable dataset that
// exercises the acceptance flows in docs/UAT-CHECKLIST.md:
//   50 employees / 3 departments, ~30 days of deterministic activity,
//   workday-summary rollups, agent accounts, devices + pending DeviceClaims
//   (older than the 2h reminder threshold), consent policies + grants (with a
//   few intentional consent gaps), notifications, and a handful of anomalies.
//   A few employees are "new hires" inside the anomaly-detection grace period.
//
// SAFETY (P0) — mirrors the demo seeder's rules:
//   • SEED_ALLOWED=1 must be set (production guard, same env var as
//     `db:seed:dev`). The CLI exits hard otherwise.
//   • ensureUatOrg() resolves the target by slug 'uat' and FAILS CLOSED on any
//     mismatch (never wipes/seeds a different org).
//   • Every delete is scoped by organizationId or by UAT employee/device ids.
//     NO unbounded deleteMany({}) anywhere.
//   • Idempotent: wipeUatData() + seedUatData() → identical results across
//     resets. No real person/customer data; emails use omnisight.example.com.
//   • Passwords are synthetic test placeholders (documented in
//     docs/UAT-CHECKLIST.md) — they are never production credentials.

import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { hashPasswordSync } from '@/lib/auth';
import { hashClaimSecret } from '@/lib/agent/auth';
import {
  WORK_START_MINUTES,
  WORK_END_MINUTES,
  dhakaDayKey,
  dhakaInstant,
  isDhakaWeekend,
  mulberry32,
  hashSeed,
  pick,
} from '@/lib/demo/fixtures';

// ─── UAT identity (the guard for every wipe/seed below) ────────────────────

export const UAT_ORG_SLUG = 'uat';
export const UAT_ORG_NAME = 'OmniSight UAT (test data)';
export const UAT_ORG_TIMEZONE = 'Asia/Dhaka';

// Synthetic test credentials — documented as test-only in UAT-CHECKLIST.md.
// Overridable via env so each environment can pin its own test password.
export const UAT_ADMIN_EMAIL = process.env.UAT_ADMIN_EMAIL || 'uat-admin@omnisight.example.com';
export const UAT_ADMIN_PASSWORD = process.env.UAT_ADMIN_PASSWORD || 'Uat@Admin2026!';
export const UAT_AGENT_PASSWORD = process.env.UAT_AGENT_PASSWORD || 'UatAgent#2026';

export const UAT_EMPLOYEE_COUNT = 50;
export const ACTIVITY_DAYS = 30;

// ─── Fixture pools (small, self-contained — no demo coupling) ──────────────

const UAT_DEPARTMENTS: ReadonlyArray<{ name: string; count: number; roles: readonly string[] }> = [
  { name: 'Engineering', count: 24, roles: ['Software Engineer', 'Senior Engineer', 'QA Engineer'] },
  { name: 'Operations', count: 14, roles: ['Operations Analyst', 'Support Specialist'] },
  { name: 'Sales', count: 12, roles: ['Account Executive', 'Sales Operations'] },
];

const FIRST_NAMES = [
  'Ayesha', 'Rafiq', 'Tahmina', 'Imran', 'Nadia', 'Farhan', 'Sharmin', 'Zubair',
  'Mishal', 'Rubina', 'Arif', 'Sadia', 'Toufiq', 'Lamia', 'Habib', 'Rumana',
  'Shahid', 'Nusrat', 'Kamal', 'Fahima',
] as const;

const LAST_NAMES = [
  'Hasan', 'Chowdhury', 'Rahman', 'Islam', 'Akter', 'Uddin', 'Karim', 'Sultana',
  'Rashid', 'Begum', 'Hossain', 'Mondol', 'Bhuiyan', 'Khatun', 'Sarker', 'Pasha',
] as const;

const UAT_SITES: { productive: readonly { title: string; url: string }[]; neutral: readonly { title: string; url: string }[]; unproductive: readonly { title: string; url: string }[] } = {
  productive: [
    { title: 'Internal Docs', url: 'https://docs.example.com' },
    { title: 'Linear', url: 'https://linear.app/example' },
    { title: 'Figma', url: 'https://figma.com/file/example' },
    { title: 'GitHub', url: 'https://github.com/example' },
  ],
  neutral: [
    { title: 'Calendar', url: 'https://calendar.example.com' },
    { title: 'Confluence', url: 'https://confluence.example.com' },
    { title: 'Jira', url: 'https://jira.example.com' },
  ],
  unproductive: [
    { title: 'Social Feed', url: 'https://social.example.com' },
    { title: 'Streaming', url: 'https://video.example.com' },
    { title: 'Shopping', url: 'https://shop.example.com' },
  ],
};

const UAT_APPS: { productive: readonly { title: string; app: string }[]; neutral: readonly { title: string; app: string }[]; unproductive: readonly { title: string; app: string }[] } = {
  productive: [
    { title: 'VS Code', app: 'Code.exe' },
    { title: 'Postman', app: 'Postman.exe' },
    { title: 'Excel', app: 'EXCEL.EXE' },
    { title: 'Terminal', app: 'WindowsTerminal.exe' },
  ],
  neutral: [
    { title: 'Outlook', app: 'OUTLOOK.EXE' },
    { title: 'Slack', app: 'slack.exe' },
    { title: 'Browser', app: 'msedge.exe' },
  ],
  unproductive: [
    { title: 'Game', app: 'GameClient.exe' },
    { title: 'Video Player', app: 'vlc.exe' },
    { title: 'Marketplace', app: 'Marketplace.exe' },
  ],
};

// Consent types used for the UAT policies/grants (subset of the schema enum).
const UAT_CONSENT_TYPES = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'location', 'webcam_access'] as const;
// Employees that intentionally MISS 'screenshot' consent, to exercise the
// consent-gap UI ("not consented" surfaces for screenshot features).
const CONSENT_GAP_EMPLOYEE_INDICES = [10, 20, 30];
// New hires: joined within the last 12 days → inside the anomaly grace period.
const NEW_HIRE_JOIN_DAYS = [5, 7, 9, 11, 12];

export interface UatSeedResult {
  organizationId: string;
  employees: number;
  agentAccounts: number;
  devices: number;
  pendingClaims: number;
  activities: number;
  workDaySummaries: number;
  consentPolicies: number;
  consentGrants: number;
  notifications: number;
  anomalies: number;
}

// ─── Guards ───────────────────────────────────────────────────────────────

export class UatOrgGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UatOrgGuardError';
  }
}

/**
 * Resolve (create if missing) the dedicated UAT organization. FAILS CLOSED:
 * an existing row with slug 'uat' is only accepted when its name carries the
 * 'OmniSight UAT' marker — anything else aborts before any write, so a real
 * customer org can never be mistaken for the test org.
 */
export async function ensureUatOrg(): Promise<{ org: { id: string; name: string }; created: boolean }> {
  const existing = await db.organization.findUnique({ where: { slug: UAT_ORG_SLUG }, select: { id: true, name: true } });
  if (existing) {
    if (!existing.name.startsWith('OmniSight UAT')) {
      throw new UatOrgGuardError(
        `slug '${UAT_ORG_SLUG}' exists with name "${existing.name}" which is NOT a UAT org — refusing to seed it.`
      );
    }
    return { org: existing, created: false };
  }
  const org = await db.organization.create({
    data: {
      name: UAT_ORG_NAME,
      slug: UAT_ORG_SLUG,
      email: UAT_ADMIN_EMAIL,
      timezone: UAT_ORG_TIMEZONE,
      language: 'en',
      currency: 'USD',
      status: 'active',
      deploymentMode: 'MANAGED',
    },
    select: { id: true, name: true },
  });
  return { org, created: true };
}

/**
 * Ensure the UAT org's admin AppUser + owner membership exist.
 * Idempotent: an existing account is left unchanged (password never
 * overwritten), but the owner membership for the UAT org is created if missing.
 */
export async function ensureUatAdmin(orgId: string): Promise<{ userId: string; created: boolean }> {
  const existing = await db.appUser.findUnique({
    where: { email: UAT_ADMIN_EMAIL },
    select: { id: true },
  });
  if (existing) {
    await db.organizationMembership.upsert({
      where: { userId_organizationId: { userId: existing.id, organizationId: orgId } },
      update: {},
      create: { userId: existing.id, organizationId: orgId, role: 'owner', status: 'ACTIVE' },
    });
    return { userId: existing.id, created: false };
  }

  const user = await db.appUser.create({
    data: {
      email: UAT_ADMIN_EMAIL,
      name: 'UAT Admin',
      password: hashPasswordSync(UAT_ADMIN_PASSWORD),
      role: 'owner',
      organizationId: orgId,
      isActive: true,
      mustChangePassword: false,
    },
    select: { id: true },
  });
  await db.organizationMembership.create({
    data: { userId: user.id, organizationId: orgId, role: 'owner', status: 'ACTIVE' },
    select: { id: true },
  });
  return { userId: user.id, created: true };
}

/**
 * Delete ALL UAT-org data, constrained row-by-row to the resolved UAT org.
 * ConsentLog holds a Restrict FK to Consent, so it is removed first. The org
 * row itself is NEVER deleted, and the platform AppUser admin is untouched
 * (platform-level identity, kept across re-seeds).
 */
export async function wipeUatData(uatOrgId: string): Promise<void> {
  const org = await db.organization.findUnique({ where: { id: uatOrgId }, select: { name: true } });
  if (!org || !org.name.startsWith('OmniSight UAT')) {
    throw new UatOrgGuardError(`Refusing to wipe non-UAT organization ${uatOrgId}`);
  }
  const { client: orgData } = await getPrismaForOrg(uatOrgId);

  const employees = await orgData.employee.findMany({
    where: { organizationId: uatOrgId },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const inEmp = { in: employeeIds.length > 0 ? employeeIds : ['__none__'] };

  await orgData.consentLog.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.consent.deleteMany({ where: { organizationId: uatOrgId } });

  await orgData.activity.deleteMany({ where: { employeeId: inEmp } });
  await orgData.activityBatchReceipt.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.workDaySummary.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.locationEvent.deleteMany({ where: { employeeId: inEmp } });
  await orgData.keyboardActivity.deleteMany({ where: { employeeId: inEmp } });
  await orgData.breakSession.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.anomaly.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.alert.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.notification.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.usbEvent.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.policyViolation.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.deviceClaim.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.deviceRouting.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.device.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.employee.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.department.deleteMany({ where: { organizationId: uatOrgId } });
  await orgData.auditLog.deleteMany({ where: { organizationId: uatOrgId } });
}

// ─── Seed ─────────────────────────────────────────────────────────────────

interface UatEmployeeFixture {
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  designation: string;
  department: string;
  joinDate: Date;
  anomalyGraceUntil: Date | null;
}

function buildEmployeeFixtures(): UatEmployeeFixture[] {
  const fixtures: UatEmployeeFixture[] = [];
  const newHireIndexes = new Set<number>();
  for (let i = 0; i < NEW_HIRE_JOIN_DAYS.length; i++) {
    newHireIndexes.add(UAT_EMPLOYEE_COUNT - NEW_HIRE_JOIN_DAYS.length + i);
  }

  const now = new Date();
  let total = 0;
  for (const dept of UAT_DEPARTMENTS) {
    const letter = dept.name[0];
    for (let j = 0; j < dept.count; j++) {
      const n = j + 1;
      const employeeId = `UAT-${letter}${String(n).padStart(3, '0')}`;
      const rng = mulberry32(hashSeed(employeeId));
      const firstName = pick(rng, FIRST_NAMES);
      const lastName = pick(rng, LAST_NAMES);

      let joinDate: Date;
      let anomalyGraceUntil: Date | null = null;
      if (newHireIndexes.has(total)) {
        const newHireIndex = total - (UAT_EMPLOYEE_COUNT - NEW_HIRE_JOIN_DAYS.length);
        joinDate = new Date(now.getTime() - NEW_HIRE_JOIN_DAYS[newHireIndex] * 24 * 60 * 60 * 1000);
        anomalyGraceUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      } else {
        const daysAgo = 60 + (hashSeed(employeeId) % 140);
        joinDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      }

      fixtures.push({
        employeeId,
        firstName,
        lastName,
        email: `${employeeId.toLowerCase()}@omnisight.example.com`,
        designation: pick(rng, dept.roles),
        department: dept.name,
        joinDate,
        anomalyGraceUntil,
      });
      total++;
    }
  }
  return fixtures;
}

export async function seedUatData(uatOrgId: string): Promise<UatSeedResult> {
  const org = await db.organization.findUnique({ where: { id: uatOrgId }, select: { name: true } });
  if (!org || !org.name.startsWith('OmniSight UAT')) {
    throw new UatOrgGuardError(`Refusing to seed non-UAT organization ${uatOrgId}`);
  }
  const { client: orgData } = await getPrismaForOrg(uatOrgId);
  const result: UatSeedResult = {
    organizationId: uatOrgId,
    employees: 0, agentAccounts: 0, devices: 0, pendingClaims: 0, activities: 0,
    workDaySummaries: 0, consentPolicies: 0, consentGrants: 0, notifications: 0, anomalies: 0,
  };

  // ── Departments ──
  const deptIds = new Map<string, string>();
  for (const dept of UAT_DEPARTMENTS) {
    const d = await orgData.department.create({
      data: { name: dept.name, description: `${dept.name} (UAT)`, status: 'active', organizationId: uatOrgId },
      select: { id: true },
    });
    deptIds.set(dept.name, d.id);
  }

  // ── Employees + agent accounts ──
  const fixtures = buildEmployeeFixtures();
  const empIds = new Map<string, string>();
  for (const e of fixtures) {
    const row = await orgData.employee.create({
      data: {
        employeeId: e.employeeId,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.email,
        designation: e.designation,
        status: 'active',
        type: 'employee',
        joinDate: e.joinDate,
        organizationId: uatOrgId,
        departmentId: deptIds.get(e.department) ?? null,
        agentApproved: true,
        anomalyGraceUntil: e.anomalyGraceUntil,
      },
      select: { id: true },
    });
    empIds.set(e.employeeId, row.id);

    // 1:1 agent login account so the agent-auth flow is testable end to end.
    await orgData.agentAccount.create({
      data: {
        employeeId: row.id,
        agentId: e.employeeId,
        passwordHash: hashPasswordSync(UAT_AGENT_PASSWORD),
        status: 'active',
      },
      select: { id: true },
    });
    result.agentAccounts++;
    result.employees++;
  }

  // ── Assigned devices + DeviceRouting index rows ──
  const now = new Date();
  const totalEmployeeCount = UAT_DEPARTMENTS.reduce((acc, d) => acc + d.count, 0);
  for (let i = 0; i < totalEmployeeCount - 10; i++) {
    const e = fixtures[i];
    const empRowId = empIds.get(e.employeeId)!;
    const online = i < 28;
    const deviceName = `Workstation-${e.employeeId}`;
    const agentKey = `uat-agentkey-${i}`;
    const device = await orgData.device.create({
      data: {
        name: deviceName,
        hostname: `uat-${i}.local`,
        operatingSystem: i % 2 === 0 ? 'Windows 11' : 'macOS 15',
        osVersion: i % 2 === 0 ? '23H2' : '15.4',
        agentVersion: '1.0.0',
        ipAddress: `10.0.${Math.floor(i / 10)}.${(i % 10) + 2}`,
        status: online ? 'online' : 'offline',
        lastHeartbeat: online
          ? new Date(now.getTime() - (i % 55) * 60 * 1000)
          : new Date(now.getTime() - (2 + (i % 40)) * 60 * 60 * 1000),
        organizationId: uatOrgId,
        employeeId: empRowId,
        agentKey,
        registeredAt: new Date(e.joinDate.getTime() + 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await orgData.deviceRouting.create({
      data: { deviceId: device.id, agentKey, organizationId: uatOrgId, dbMode: 'cloud' },
      select: { id: true },
    });
    result.devices++;
  }

  // ── Unassigned devices with PENDING claims > 2h old (reminder threshold) ──
  for (let i = 0; i < 10; i++) {
    const device = await orgData.device.create({
      data: {
        name: `New-Laptop-${i + 1}`,
        hostname: `uat-new-${i}.local`,
        operatingSystem: 'Windows 11',
        osVersion: '23H2',
        status: 'offline',
        lastHeartbeat: new Date(now.getTime() - (5 + i) * 60 * 60 * 1000),
        organizationId: uatOrgId,
        employeeId: null,
        agentKey: null,
        registeredAt: new Date(now.getTime() - (6 + i) * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await orgData.deviceRouting.create({
      data: { deviceId: device.id, agentKey: null, organizationId: uatOrgId, dbMode: 'cloud' },
      select: { id: true },
    });
    const createdAt = new Date(now.getTime() - (3 + 2 * i) * 60 * 60 * 1000);
    await orgData.deviceClaim.create({
      data: {
        organizationId: uatOrgId,
        deviceId: device.id,
        claimSecretHash: hashClaimSecret(`UAT-claim-secret-${i + 1}`),
        status: 'pending',
        expiresAt: new Date(createdAt.getTime() + 72 * 60 * 60 * 1000),
        createdAt,
      },
      select: { id: true },
    });
    result.pendingClaims++;
    result.devices++;
  }

  // ── Consent policies + per-employee grants (with intentional gaps) ──
  const policyIds = new Map<string, string>();
  for (const type of UAT_CONSENT_TYPES) {
    const policy = await orgData.consentPolicy.create({
      data: {
        organizationId: uatOrgId,
        consentType: type,
        title: `${type} monitoring policy (UAT v1)`,
        content: `UAT test policy for ${type}. Written consent is required before any ${type} data is collected.`,
        version: 'v1',
        status: 'published',
        effectiveAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000),
        publishedAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    policyIds.set(type, policy.id);
    result.consentPolicies++;
  }

  for (const [empIdx, e] of fixtures.entries()) {
    const empRowId = empIds.get(e.employeeId)!;
    for (const type of UAT_CONSENT_TYPES) {
      const isDeniedGap = CONSENT_GAP_EMPLOYEE_INDICES.includes(empIdx) && type === 'screenshot';
      await orgData.consent.create({
        data: {
          employeeId: empRowId,
          consentType: type,
          status: isDeniedGap ? 'denied' : 'granted',
          grantedAt: isDeniedGap ? null : new Date(e.joinDate.getTime() + 24 * 60 * 60 * 1000),
          consentVersion: 'v1',
          policyId: policyIds.get(type) ?? null,
          notes: isDeniedGap ? 'UAT: intentional consent gap — employee declined screenshot consent.' : null,
          organizationId: uatOrgId,
        },
        select: { id: true },
      });
      result.consentGrants++;
    }
  }

  // ── ~30 days of deterministic activity + workday rollups ──
  const todayKey = dhakaDayKey(now);
  const dayKeys: string[] = [];
  for (let back = ACTIVITY_DAYS - 1; back >= 0; back--) {
    dayKeys.push(dhakaDayKey(new Date(now.getTime() - back * 24 * 60 * 60 * 1000)));
  }

  const dayTotals = new Map<string, Map<string, { p: number; n: number; u: number; idle: number; count: number; web: number; app: number }>>();

  // Preload employee → device once (avoids a query per employee per day).
  const assignedDeviceRows = await orgData.device.findMany({
    where: { organizationId: uatOrgId, employeeId: { not: null } },
    select: { id: true, employeeId: true },
  });
  const deviceByEmp = new Map<string, string>();
  for (const d of assignedDeviceRows) {
    if (d.employeeId) deviceByEmp.set(d.employeeId, d.id);
  }

  for (const dayKey of dayKeys) {
    const weekend = isDhakaWeekend(dayKey);
    const activityBatch: Array<{
      type: string; title: string | null; url?: string | null; applicationName?: string | null;
      category: string; duration: number; employeeId: string; deviceId: string | null; organizationId: string; timestamp: Date;
    }> = [];

    for (const e of fixtures) {
      const rng = mulberry32(hashSeed(`${e.employeeId}:${dayKey}`));
      const empRowId = empIds.get(e.employeeId)!;
      const devId = deviceByEmp.get(empRowId) ?? null;

      const workMinutes = weekend ? Math.floor(rng() * 40) : 240 + Math.floor(rng() * 300);
      if (workMinutes < 20) continue;

      const productiveShare = 0.45 + ((hashSeed(e.employeeId) % 30) / 100) + rng() * 0.1;
      const dayTot = { p: 0, n: 0, u: 0, idle: 0, count: 0, web: 0, app: 0 };

      let minute = WORK_START_MINUTES + Math.floor(rng() * 30);
      const endMinute = Math.min(WORK_START_MINUTES + workMinutes, WORK_END_MINUTES);

      while (minute < endMinute) {
        const roll = rng();
        const timestamp = dhakaInstant(dayKey, minute);

        if (roll < 0.08) {
          const dur = (5 + Math.floor(rng() * 21)) * 60;
          activityBatch.push({ type: 'idle', title: 'Idle', category: 'idle', duration: dur, employeeId: empRowId, deviceId: devId, organizationId: uatOrgId, timestamp });
          dayTot.idle += dur; dayTot.count++;
          minute += 5 + Math.floor(rng() * 21);
          continue;
        }

        const dur = (10 + Math.floor(rng() * 36)) * 60;
        const isSite = rng() < 0.35;
        const cat = roll < 0.08 + productiveShare
          ? 'productive'
          : roll < 0.08 + productiveShare + (1 - productiveShare) * 0.6
            ? 'neutral'
            : 'unproductive';

        if (isSite) {
          const sitePool = cat === 'productive' ? UAT_SITES.productive : cat === 'neutral' ? UAT_SITES.neutral : UAT_SITES.unproductive;
          const s = pick(rng, sitePool);
          activityBatch.push({ type: 'website', title: s.title, url: s.url, category: cat, duration: dur, employeeId: empRowId, deviceId: devId, organizationId: uatOrgId, timestamp });
          dayTot.web++;
        } else {
          const appPool = cat === 'productive' ? UAT_APPS.productive : cat === 'neutral' ? UAT_APPS.neutral : UAT_APPS.unproductive;
          const a = pick(rng, appPool);
          activityBatch.push({ type: 'application', title: a.title, applicationName: a.app, category: cat, duration: dur, employeeId: empRowId, deviceId: devId, organizationId: uatOrgId, timestamp });
          dayTot.app++;
        }
        dayTot.count++;
        if (cat === 'productive') dayTot.p += dur;
        else if (cat === 'neutral') dayTot.n += dur;
        else dayTot.u += dur;
        minute += 10 + Math.floor(rng() * 36);
      }

      if (dayTot.count > 0) {
        let byEmp = dayTotals.get(dayKey);
        if (!byEmp) { byEmp = new Map(); dayTotals.set(dayKey, byEmp); }
        byEmp.set(empRowId, dayTot);
      }
    }

    if (activityBatch.length > 0) {
      await orgData.activity.createMany({ data: activityBatch });
      result.activities += activityBatch.length;
    }
  }

  // WorkDaySummary rollups (dashboard reads these for past days).
  for (const [dayKey, byEmp] of dayTotals) {
    for (const [empRowId, t] of byEmp) {
      const active = t.p + t.n + t.u;
      const working = Math.max(0, active - t.idle);
      await orgData.workDaySummary.upsert({
        where: { organizationId_employeeId_workDate: { organizationId: uatOrgId, employeeId: empRowId, workDate: dayKey } },
        update: {
          productiveSeconds: t.p, neutralSeconds: t.n, unproductiveSeconds: t.u,
          idleSeconds: t.idle, activeSeconds: active, workingSeconds: working,
          outsideHoursSeconds: 0, breakSeconds: 0, activityCount: t.count,
          websiteActivityCount: t.web, applicationActivityCount: t.app,
        },
        create: {
          organizationId: uatOrgId, employeeId: empRowId, workDate: dayKey,
          productiveSeconds: t.p, neutralSeconds: t.n, unproductiveSeconds: t.u,
          idleSeconds: t.idle, activeSeconds: active, workingSeconds: working,
          outsideHoursSeconds: 0, breakSeconds: 0, activityCount: t.count,
          websiteActivityCount: t.web, applicationActivityCount: t.app,
        },
      });
      result.workDaySummaries++;
    }
  }

  // Today's partial rollup so the dashboard "today" fallback is non-empty.
  for (const e of fixtures) {
    const empRowId = empIds.get(e.employeeId)!;
    const rng = mulberry32(hashSeed(`${e.employeeId}:today`));
    const p = 1800 + Math.floor(rng() * 5400);
    await orgData.workDaySummary.upsert({
      where: { organizationId_employeeId_workDate: { organizationId: uatOrgId, employeeId: empRowId, workDate: todayKey } },
      update: { productiveSeconds: { increment: 0 } },
      create: {
        organizationId: uatOrgId, employeeId: empRowId, workDate: todayKey,
        productiveSeconds: p, neutralSeconds: Math.floor(p * 0.3), unproductiveSeconds: Math.floor(p * 0.15),
        idleSeconds: Math.floor(p * 0.2), activeSeconds: p + Math.floor(p * 0.45),
        workingSeconds: p + Math.floor(p * 0.45), activityCount: 6 + Math.floor(rng() * 10),
        websiteActivityCount: 2, applicationActivityCount: 4,
      },
    });
    result.workDaySummaries++;
  }

  // ── Notifications (~6, mixed unread/read) ──
  const newHireFixture = fixtures[fixtures.length - 1];
  const newHireRowId = empIds.get(newHireFixture.employeeId)!;
  const offlineDevice = await orgData.device.findFirst({
    where: { organizationId: uatOrgId, status: 'offline' },
    select: { id: true },
  });
  await orgData.notification.createMany({
    data: [
      { title: 'New employee pending review', message: `${newHireFixture.firstName} ${newHireFixture.lastName} joined and is in the anomaly grace period.`, type: 'new_employee', priority: 'high', status: 'unread', entityType: 'employee', entityId: newHireRowId, employeeId: newHireRowId, organizationId: uatOrgId },
      { title: 'Device offline', message: 'A workstation stopped reporting heartbeats.', type: 'device_offline', priority: 'medium', status: 'unread', entityType: 'device', entityId: offlineDevice?.id ?? null, deviceId: offlineDevice?.id ?? null, organizationId: uatOrgId },
      { title: 'Pending device claim', message: 'A discovered device is waiting for approval (over 2h).', type: 'security', priority: 'medium', status: 'unread', entityType: 'device', organizationId: uatOrgId },
      { title: 'Anomaly detected', message: 'An unusual activity pattern was flagged for review.', type: 'anomaly_detected', priority: 'critical', status: 'unread', entityType: 'anomaly', organizationId: uatOrgId },
      { title: 'Consent gap', message: 'An employee has not consented to screenshot monitoring.', type: 'consent_update', priority: 'low', status: 'read', entityType: 'employee', employeeId: empIds.get(fixtures[CONSENT_GAP_EMPLOYEE_INDICES[0]].employeeId) ?? null, organizationId: uatOrgId },
      { title: 'Retention notice', message: 'Data retention window is approaching for this org.', type: 'system', priority: 'low', status: 'read', organizationId: uatOrgId },
    ],
  });
  result.notifications += 6;

  // ── Anomalies (dedupeKey null → never collides with live detection) ──
  const midEmp = fixtures[Math.floor(fixtures.length / 2)];
  const midEmpRowId = empIds.get(midEmp.employeeId)!;
  const offlineDev = await orgData.device.findFirst({ where: { organizationId: uatOrgId, status: 'offline' }, select: { id: true } });
  await orgData.anomaly.createMany({
    data: [
      { type: 'productivity_drop', severity: 'medium', status: 'detected', title: 'Productivity drop detected', description: 'Productive activity fell below the 30-day baseline for this employee.', score: 72, confidence: 0.81, employeeId: midEmpRowId, metadata: JSON.stringify({ baseline: 0.62, current: 0.41, threshold: 0.5 }), organizationId: uatOrgId },
      { type: 'excessive_idle', severity: 'low', status: 'detected', title: 'Excessive idle time', description: 'Idle blocks made up a large share of the longest active window.', score: 45, confidence: 0.66, employeeId: midEmpRowId, metadata: JSON.stringify({ baseline: 0.12, current: 0.34, threshold: 0.25 }), organizationId: uatOrgId },
      { type: 'device_missing', severity: 'high', status: 'detected', title: 'Device heartbeat silent', description: 'An approved device stopped reporting heartbeats.', score: 84, confidence: 0.9, deviceId: offlineDev?.id ?? null, metadata: JSON.stringify({ lastHeartbeatMinutesAgo: 180 }), organizationId: uatOrgId },
      { type: 'rapid_app_switch', severity: 'medium', status: 'detected', title: 'Rapid application switching', description: 'App switches exceeded the expected cadence during a work window.', score: 61, confidence: 0.74, employeeId: empIds.get(fixtures[4].employeeId) ?? null, metadata: JSON.stringify({ switchesPerHour: 41, threshold: 30 }), organizationId: uatOrgId },
    ],
  });
  result.anomalies += 4;

  // ── Audit trail (honest provenance) ──
  await orgData.auditLog.create({
    data: {
      action: 'create',
      resource: 'uat_data',
      resourceId: uatOrgId,
      description: 'UAT dataset seeded (deterministic, simulated — no real telemetry).',
      userId: null,
      organizationId: uatOrgId,
    },
  });

  return result;
}

/** Convenience: wipe + seed (mirrors the demo reset). */
export async function resetUatData(uatOrgId: string): Promise<UatSeedResult> {
  await wipeUatData(uatOrgId);
  return seedUatData(uatOrgId);
}