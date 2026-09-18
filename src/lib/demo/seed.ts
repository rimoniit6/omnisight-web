// OmniSight — Demo-First Experience: deterministic dataset seeder.
//
// Populates the demo organization with a believable, deterministic dataset:
// departments, employees, devices, 14 days of activity, workday summary
// rollups, sentiment records, alerts, projects, manual time entries,
// fictional location events and synthetic screenshots.
//
// SAFETY (P0):
//   • assertDemoOrg() guards the target — ALWAYS the resolved demo org,
//     fail-closed on any mismatch (DemoOrgError aborts before writes).
//   • Every delete/create below is scoped by organizationId or by demo-org
//     employee/device ids. NO unbounded deleteMany({}) anywhere.
//   • Idempotent: wipeDemoData() + seed → identical results across resets.
//   • No real person/customer data; emails use demo.example.com.

import { randomUUID } from 'crypto';
import { getPrismaForOrg } from '@/lib/org-db';
import { putScreenshot } from '@/lib/storage';
import { assertDemoOrg } from './guards';
import {
  DEMO_DEPARTMENTS,
  DEMO_EMPLOYEES,
  DEMO_DEVICES,
  DEMO_APPS,
  DEMO_SITES,
  DEMO_LOCATIONS,
  DEMO_ALERTS,
  DEMO_PROJECTS,
  DEMO_SCREENSHOT_SCENES,
  TIME_ENTRY_CATEGORIES,
  WORK_START_MINUTES,
  WORK_END_MINUTES,
  dhakaDayKey,
  dhakaInstant,
  isDhakaWeekend,
  mulberry32,
  hashSeed,
  pick,
} from './fixtures';
import { renderDemoScreenshot } from './screenshot-art';

const ACTIVITY_DAYS = 14;

// ─── Wipe (demo-scoped only) ───────────────────────────────────────────────

/**
 * Delete ALL demo-org data, constrained row-by-row to the demo organization.
 * Order matters: ConsentLog holds a Restrict FK to Consent; everything else
 * cascades from Organization but is deleted explicitly (demo org row itself
 * is NEVER deleted). Storage objects are removed by the caller (reset job)
 * or by retention sweeps — DB rows here are authoritative for re-seed.
 */
export async function wipeDemoData(demoOrgId: string): Promise<void> {
  await assertDemoOrg(demoOrgId);
  const { client: orgData } = await getPrismaForOrg(demoOrgId);

  const employees = await orgData.employee.findMany({
    where: { organizationId: demoOrgId },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const inEmp = { in: employeeIds.length > 0 ? employeeIds : ['__none__'] };

  // Restrict-FK children first (consent logs → consents), then the rest.
  await orgData.consentLog.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.consent.deleteMany({ where: { organizationId: demoOrgId } });

  await orgData.activity.deleteMany({ where: { employeeId: inEmp } });
  await orgData.activityBatchReceipt.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.workDaySummary.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.sentimentRecord.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.locationEvent.deleteMany({ where: { employeeId: inEmp } });
  await orgData.keyboardActivity.deleteMany({ where: { employeeId: inEmp } });
  await orgData.breakSession.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.alert.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.notification.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.anomaly.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.policyViolation.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.usbEvent.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.timeEntry.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.projectMember.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.project.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.screenshot.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.auditLog.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.device.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.employee.deleteMany({ where: { organizationId: demoOrgId } });
  await orgData.department.deleteMany({ where: { organizationId: demoOrgId } });
}

// ─── Seed ──────────────────────────────────────────────────────────────────

export interface DemoSeedResult {
  departments: number;
  employees: number;
  devices: number;
  activities: number;
  workDaySummaries: number;
  screenshots: number;
  sentimentRecords: number;
  alerts: number;
  projects: number;
  timeEntries: number;
  locationEvents: number;
}

export async function seedDemoData(demoOrgId: string): Promise<DemoSeedResult> {
  const demo = await assertDemoOrg(demoOrgId);
  const { client: orgData } = await getPrismaForOrg(demoOrgId);
  const result: DemoSeedResult = {
    departments: 0, employees: 0, devices: 0, activities: 0, workDaySummaries: 0,
    screenshots: 0, sentimentRecords: 0, alerts: 0, projects: 0, timeEntries: 0, locationEvents: 0,
  };

  // ── Departments ──
  const deptIds = new Map<string, string>();
  for (const name of DEMO_DEPARTMENTS) {
    const d = await orgData.department.create({
      data: { name, description: `${name} (demo)`, status: 'active', organizationId: demo.id },
      select: { id: true },
    });
    deptIds.set(name, d.id);
    result.departments++;
  }

  // ── Employees ──
  const empIds = new Map<string, string>(); // employeeId code → row id
  for (const e of DEMO_EMPLOYEES) {
    const row = await orgData.employee.create({
      data: {
        employeeId: e.employeeId,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.email,
        designation: e.designation,
        status: 'active',
        type: 'employee',
        joinDate: new Date('2026-01-05T03:00:00.000Z'),
        organizationId: demo.id,
        departmentId: deptIds.get(e.department) ?? null,
        // Demo employees are NOT agent-approved: no real agent can ever
        // authenticate as them (Phase 18 — agent safety by construction).
        agentApproved: false,
      },
      select: { id: true },
    });
    empIds.set(e.employeeId, row.id);
    result.employees++;
  }

  // ── Devices (no agent keys → no real agent can ever bind) ──
  const devIds = new Map<string, string>(); // hostname → row id
  for (const d of DEMO_DEVICES) {
    const row = await orgData.device.create({
      data: {
        name: d.name,
        hostname: d.hostname,
        operatingSystem: d.operatingSystem,
        osVersion: d.osVersion,
        status: 'offline', // simulator flips to online via heartbeats
        organizationId: demo.id,
        employeeId: d.employeeCode ? empIds.get(d.employeeCode) ?? null : null,
        // agentKey deliberately NULL: a real desktop agent's machine identity
        // can never collide with or bind to a demo device.
        agentKey: null,
      },
      select: { id: true },
    });
    devIds.set(d.hostname, row.id);
    result.devices++;
  }

  // ── Activity history (14 org-local days, deterministic per employee/day) ──
  const now = new Date();
  const todayKey = dhakaDayKey(now);
  const dayKeys: string[] = [];
  for (let back = ACTIVITY_DAYS - 1; back >= 0; back--) {
    const day = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    dayKeys.push(dhakaDayKey(day));
  }

  // Per-day per-employee totals for the WorkDaySummary rollup.
  const dayTotals = new Map<string, Map<string, { p: number; n: number; u: number; idle: number; count: number; web: number; app: number }>>();

  for (const dayKey of dayKeys) {
    const weekend = isDhakaWeekend(dayKey);
    for (const e of DEMO_EMPLOYEES) {
      const rng = mulberry32(hashSeed(`${e.employeeId}:${dayKey}`));
      const empRowId = empIds.get(e.employeeId)!;
      const devRowId = devIds.get(`${e.firstName}-Workstation`)!;

      // Weekend → little/no activity; workdays → 5-9 hour spread.
      const workMinutes = weekend ? Math.floor(rng() * 40) : 240 + Math.floor(rng() * 300);
      if (workMinutes < 20) continue;

      // Behavior profile: stable per employee, slight daily noise.
      const productiveShare = 0.45 + ((hashSeed(e.employeeId) % 30) / 100) + rng() * 0.1; // ~45-85%
      const dayTot = { p: 0, n: 0, u: 0, idle: 0, count: 0, web: 0, app: 0 };

      let minute = WORK_START_MINUTES + Math.floor(rng() * 30);
      const endMinute = Math.min(WORK_START_MINUTES + workMinutes, WORK_END_MINUTES);

      while (minute < endMinute) {
        const roll = rng();
        if (roll < 0.08) {
          // Idle block (5-25 min) — Activity type 'idle'.
          const dur = (5 + Math.floor(rng() * 21)) * 60;
          await orgData.activity.create({
            data: {
              type: 'idle',
              title: 'Idle',
              category: 'idle',
              duration: dur,
              employeeId: empRowId,
              deviceId: devRowId,
              organizationId: demo.id,
              timestamp: dhakaInstant(dayKey, minute),
            },
          });
          dayTot.idle += dur; dayTot.count++;
          minute += 5 + Math.floor(rng() * 21);
          continue;
        }

        // Categorized block (10-45 min): application or website.
        const dur = (10 + Math.floor(rng() * 36)) * 60;
        const isSite = rng() < 0.35;
        const cat = roll < 0.08 + productiveShare
          ? 'productive'
          : roll < 0.08 + productiveShare + (1 - productiveShare) * 0.6
            ? 'neutral'
            : 'unproductive';

        if (isSite) {
          // Widen the union of readonly tuples so pick<T> unifies T.
          const sitePool: readonly { title: string; url: string }[] =
            cat === 'productive' ? DEMO_SITES.productive : cat === 'neutral' ? DEMO_SITES.neutral : DEMO_SITES.unproductive;
          const s = pick(rng, sitePool);
          await orgData.activity.create({
            data: {
              type: 'website',
              title: s.title,
              url: s.url,
              category: cat,
              duration: dur,
              employeeId: empRowId,
              deviceId: devRowId,
              organizationId: demo.id,
              timestamp: dhakaInstant(dayKey, minute),
            },
          });
          dayTot.web++;
        } else {
          const appPool: readonly { title: string; app: string }[] =
            cat === 'productive' ? DEMO_APPS.productive : cat === 'neutral' ? DEMO_APPS.neutral : DEMO_APPS.unproductive;
          const a = pick(rng, appPool);
          await orgData.activity.create({
            data: {
              type: 'application',
              title: a.title,
              applicationName: a.app,
              category: cat,
              duration: dur,
              employeeId: empRowId,
              deviceId: devRowId,
              organizationId: demo.id,
              timestamp: dhakaInstant(dayKey, minute),
            },
          });
          dayTot.app++;
        }
        dayTot.count++;
        if (cat === 'productive') dayTot.p += dur;
        else if (cat === 'neutral') dayTot.n += dur;
        else dayTot.u += dur;
        result.activities++;
        minute += 10 + Math.floor(rng() * 36);
      }

      if (dayTot.count > 0) {
        let byEmp = dayTotals.get(dayKey);
        if (!byEmp) { byEmp = new Map(); dayTotals.set(dayKey, byEmp); }
        byEmp.set(empRowId, dayTot);
      }
    }
  }

  // ── WorkDaySummary rollups (dashboard reads these for past days) ──
  for (const [dayKey, byEmp] of dayTotals) {
    for (const [empRowId, t] of byEmp) {
      const active = t.p + t.n + t.u;
      const working = Math.max(0, active - t.idle);
      await orgData.workDaySummary.upsert({
        where: { organizationId_employeeId_workDate: { organizationId: demo.id, employeeId: empRowId, workDate: dayKey } },
        update: {
          productiveSeconds: t.p, neutralSeconds: t.n, unproductiveSeconds: t.u,
          idleSeconds: t.idle, activeSeconds: active, workingSeconds: working,
          outsideHoursSeconds: 0, breakSeconds: 0, activityCount: t.count,
          websiteActivityCount: t.web, applicationActivityCount: t.app,
        },
        create: {
          organizationId: demo.id, employeeId: empRowId, workDate: dayKey,
          productiveSeconds: t.p, neutralSeconds: t.n, unproductiveSeconds: t.u,
          idleSeconds: t.idle, activeSeconds: active, workingSeconds: working,
          outsideHoursSeconds: 0, breakSeconds: 0, activityCount: t.count,
          websiteActivityCount: t.web, applicationActivityCount: t.app,
        },
      });
      result.workDaySummaries++;
    }
  }

  // Today's partial rollup row so the dashboard "today" fallback is non-empty
  // even before the simulator runs.
  for (const e of DEMO_EMPLOYEES) {
    const empRowId = empIds.get(e.employeeId)!;
    const rng = mulberry32(hashSeed(`${e.employeeId}:today`));
    const p = 1800 + Math.floor(rng() * 5400);
    await orgData.workDaySummary.upsert({
      where: { organizationId_employeeId_workDate: { organizationId: demo.id, employeeId: empRowId, workDate: todayKey } },
      update: { productiveSeconds: { increment: 0 } },
      create: {
        organizationId: demo.id, employeeId: empRowId, workDate: todayKey,
        productiveSeconds: p, neutralSeconds: Math.floor(p * 0.3), unproductiveSeconds: Math.floor(p * 0.15),
        idleSeconds: Math.floor(p * 0.2), activeSeconds: p + Math.floor(p * 0.45),
        workingSeconds: p + Math.floor(p * 0.45), activityCount: 6 + Math.floor(rng() * 10),
        websiteActivityCount: 2, applicationActivityCount: 4,
      },
    });
  }

  // ── Synthetic screenshots (last 3 days, one per employee per day) ──
  for (let back = 2; back >= 0; back--) {
    const day = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    const dayKey = dhakaDayKey(day);
    for (const e of DEMO_EMPLOYEES) {
      const rng = mulberry32(hashSeed(`shot:${e.employeeId}:${dayKey}`));
      if (isDhakaWeekend(dayKey) && rng() < 0.8) continue;
      const sceneIdx = hashSeed(`${e.employeeId}:${dayKey}:scene`) % DEMO_SCREENSHOT_SCENES.length;
      const scene = DEMO_SCREENSHOT_SCENES[sceneIdx];
      const empRowId = empIds.get(e.employeeId)!;
      const devRowId = devIds.get(`${e.firstName}-Workstation`)!;

      const png = await renderDemoScreenshot(scene);
      const filename = `${e.employeeId}_${randomUUID()}.png`;
      // Org-scoped storage helper — the physical key is derived server-side
      // from demoOrgId + basename (never a hand-built path).
      await putScreenshot(demo.id, filename, png, 'image/png');

      const capturedAt = dhakaInstant(dayKey, WORK_START_MINUTES + 60 + Math.floor(rng() * 300));
      await orgData.screenshot.create({
        data: {
          employeeId: empRowId,
          deviceId: devRowId,
          filePath: `/uploads/screenshots/${filename}`,
          fileName: `${scene.title.replace(/\s+/g, '_')}.png`,
          fileSize: png.length,
          mimeType: 'image/png',
          width: 1280,
          height: 800,
          appWindow: scene.title,
          organizationId: demo.id,
          capturedAt,
          processingStatus: 'processed', // pre-processed: no thumbnail needed for the synthetic asset
        },
      });
      result.screenshots++;
    }
  }

  // ── Sentiment records (deterministic, rules-style — never AI) ──
  const periodStart = dhakaInstant(dayKeys[0], WORK_START_MINUTES);
  const periodEnd = dhakaInstant(todayKey, WORK_END_MINUTES);
  for (const e of DEMO_EMPLOYEES) {
    const rng = mulberry32(hashSeed(`sentiment:${e.employeeId}`));
    const empRowId = empIds.get(e.employeeId)!;
    const score = Math.round(35 + rng() * 50); // 35-85
    const mood = score > 70 ? 'positive' : score >= 40 ? 'neutral' : score >= 25 ? 'negative' : 'critical';
    const risks: string[] = [];
    if (score < 45) risks.push('disengaged');
    if (rng() < 0.25) risks.push('burnout_risk');
    await orgData.sentimentRecord.create({
      data: {
        employeeId: empRowId,
        projectId: null,
        score,
        mood,
        signals: JSON.stringify({
          productivityTrend: (rng() * 24 - 8).toFixed(1),
          idleRate: (rng() * 18).toFixed(1),
          overtimeHours: (rng() * 6).toFixed(1),
          loginConsistency: (70 + rng() * 30).toFixed(0),
        }),
        insight:
          mood === 'positive'
            ? 'Engagement is stable and productivity signals are healthy (demo data).'
            : 'Activity patterns show mixed engagement this period (demo data).',
        riskFactors: JSON.stringify(risks),
        recommendation: mood === 'positive' ? 'Continue current cadence.' : 'Schedule a check-in this week.',
        periodStart,
        periodEnd,
        aiProviderUsed: 'rules',
        aiModel: null,
        organizationId: demo.id,
      },
    });
    result.sentimentRecords++;
  }

  // ── Alerts ──
  for (const a of DEMO_ALERTS) {
    const rng = mulberry32(hashSeed(`alert:${a.title}`));
    const empIdx = Math.floor(rng() * DEMO_EMPLOYEES.length);
    const emp = DEMO_EMPLOYEES[empIdx];
    const status = a.severity === 'error' ? 'pending' : rng() < 0.5 ? 'acknowledged' : 'pending';
    await orgData.alert.create({
      data: {
        title: a.title,
        description: a.description,
        type: a.type,
        severity: a.severity,
        status,
        source: 'demo_seed',
        employeeId: empIds.get(emp.employeeId) ?? null,
        organizationId: demo.id,
        createdAt: dhakaInstant(todayKey, WORK_START_MINUTES + 30 + Math.floor(rng() * 240)),
      },
    });
    result.alerts++;
  }

  // ── Projects + members + manual time entries ──
  const projectIds: string[] = [];
  let pIdx = 0;
  for (const p of DEMO_PROJECTS) {
    const proj = await orgData.project.create({
      data: {
        name: p.name,
        description: `${p.name} — demo project with simulated time tracking.`,
        status: p.status,
        priority: p.priority,
        startDate: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        deadline: new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000),
        estimatedHours: 320 + pIdx * 120,
        color: p.color,
        organizationId: demo.id,
      },
      select: { id: true },
    });
    projectIds.push(proj.id);
    result.projects++;

    // Members: rotating assignment of the 8 demo employees.
    for (let m = 0; m < 4; m++) {
      const emp = DEMO_EMPLOYEES[(pIdx * 3 + m) % DEMO_EMPLOYEES.length];
      await orgData.projectMember.create({
        data: {
          projectId: proj.id,
          employeeId: empIds.get(emp.employeeId)!,
          role: m === 0 ? 'lead' : 'member',
          hoursPerWeek: 20 + m * 5,
          organizationId: demo.id,
        },
      });
    }
    pIdx++;
  }

  // Manual time entries over the last 14 days (deterministic, believable).
  for (const dayKey of dayKeys) {
    if (isDhakaWeekend(dayKey)) continue;
    const rng = mulberry32(hashSeed(`time:${dayKey}`));
    for (const projId of projectIds) {
      const entries = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < entries; i++) {
        const emp = pick(rng, DEMO_EMPLOYEES);
        await orgData.timeEntry.create({
          data: {
            projectId: projId,
            employeeId: empIds.get(emp.employeeId)!,
            date: dhakaInstant(dayKey, WORK_START_MINUTES),
            hours: Math.round((1 + rng() * 5) * 4) / 4, // 0.25h steps
            description: null,
            category: pick(rng, TIME_ENTRY_CATEGORIES),
            billable: rng() < 0.8,
            source: 'MANUAL',
            organizationId: demo.id,
          },
        });
        result.timeEntries++;
      }
    }
  }

  // ── Fictional location events (yesterday + today, Dhaka-area points) ──
  for (const e of DEMO_EMPLOYEES.slice(0, 5)) {
    const empRowId = empIds.get(e.employeeId)!;
    const devRowId = devIds.get(`${e.firstName}-Workstation`)!;
    const rng = mulberry32(hashSeed(`loc:${e.employeeId}`));
    for (let back = 1; back >= 0; back--) {
      const day = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
      const dayKey = dhakaDayKey(day);
      const loc = DEMO_LOCATIONS[Math.floor(rng() * DEMO_LOCATIONS.length)];
      await orgData.locationEvent.create({
        data: {
          employeeId: empRowId,
          deviceId: devRowId,
          latitude: loc.lat + (rng() - 0.5) * 0.004,
          longitude: loc.lng + (rng() - 0.5) * 0.004,
          accuracy: 12 + Math.floor(rng() * 30),
          recordedAt: dhakaInstant(dayKey, WORK_START_MINUTES + 60 + Math.floor(rng() * 300)),
          source: 'native',
          organizationId: demo.id,
        },
      });
      result.locationEvents++;
    }
  }

  // ── Demo audit trail (one entry, honest provenance) ──
  await orgData.auditLog.create({
    data: {
      action: 'create',
      resource: 'demo_data',
      resourceId: demo.id,
      description: 'Demo dataset seeded (deterministic, simulated — no real telemetry).',
      userId: null,
      organizationId: demo.id,
    },
  });

  return result;
}

/** Convenience: wipe + seed (used by the reset job and the CLI). */
export async function resetDemoData(demoOrgId: string): Promise<DemoSeedResult> {
  await wipeDemoData(demoOrgId);
  return seedDemoData(demoOrgId);
}

// ─── CLI entry (scripts/seed-demo.ts is the canonical wrapper) ─────────────
// Direct execution support is intentionally not implemented here: importing
// scripts/ from src/ breaks the typechecker's project graph. Run:
//   npx tsx scripts/seed-demo.ts
