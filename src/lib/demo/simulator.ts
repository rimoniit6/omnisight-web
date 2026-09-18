// OmniSight — Demo-First Experience: activity simulator.
//
// Generates the demo's "live" behavior by WRITING DATABASE ROWS into the demo
// organization's own tables. Realtime delivery is NOT done here — rows flow
// through the existing pg_notify / 5s-poll pipeline of the live-updates
// service, which broadcasts org-room events exactly like real telemetry:
//
//   simulator → DB rows → pg_notify/poll → live-updates → WebSocket → UI
//
// SAFETY (P0 + Phase 9/10):
//   • Every run resolves the demo org via assertDemoOrg() — fail-closed when
//     the demo tenant is missing/misconfigured (never falls back to another
//     organization).
//   • Every write carries organizationId = demo org (or a demo-org employee/
//     device id verified from that org).
//   • Runs under the JobRun lease (claimJob) so multiple replicas never
//     double-run; repeated runs are idempotent-ish by design (they append
//     plausible rows, never corrupt state).

import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { putScreenshot } from '@/lib/storage';
import { claimJob, finishJob } from '@/lib/jobs/run';
import { assertDemoOrg, DEMO_SIMULATOR_JOB_NAME } from './guards';
import { renderDemoScreenshot } from './screenshot-art';
import {
  DEMO_APPS,
  DEMO_SITES,
  DEMO_LOCATIONS,
  DEMO_SCREENSHOT_SCENES,
  WORK_START_MINUTES,
  dhakaDayKey,
  dhakaInstant,
  mulberry32,
  hashSeed,
  pick,
} from './fixtures';

export interface DemoSimulatorResult {
  ran: boolean;          // false when the lease was held elsewhere
  activities: number;
  heartbeats: number;
  alerts: number;
  screenshots: number;
  locations: number;
  sentiment: number;
  errors: string[];
}

/** One simulated tick — bounded writes only. Call under the lease. */
export async function runDemoSimulatorOnce(now = new Date()): Promise<Omit<DemoSimulatorResult, 'ran'>> {
  const result = { activities: 0, heartbeats: 0, alerts: 0, screenshots: 0, locations: 0, sentiment: 0, errors: [] as string[] };
  const demo = await assertDemoOrg((await resolveDemoId()));
  const { client: orgData } = await getPrismaForOrg(demo.id);

  // Load the demo org's own employees + devices (org-scoped; ids are re-
  // verified against the demo org on every run — never cached across runs).
  const [employees, devices] = await Promise.all([
    orgData.employee.findMany({
      where: { organizationId: demo.id },
      select: { id: true, firstName: true, employeeId: true },
    }),
    orgData.device.findMany({
      where: { organizationId: demo.id },
      select: { id: true, name: true, employeeId: true },
    }),
  ]);
  if (employees.length === 0 || devices.length === 0) {
    result.errors.push('demo org has no employees/devices — run the seeder first');
    return result;
  }
  const devByEmp = new Map<string, string>(); // employee row id → device row id
  for (const d of devices) {
    if (d.employeeId) devByEmp.set(d.employeeId, d.id);
  }

  const rng = mulberry32(hashSeed(`sim:${Math.floor(now.getTime() / 60000)}`)); // per-minute deterministic

  // ── Heartbeats: bring ~70% of devices online (presence + live monitor) ──
  for (const d of devices) {
    if (rng() < 0.7) {
      await orgData.device.update({
        where: { id: d.id },
        data: { status: 'online', lastHeartbeat: now },
      });
      result.heartbeats++;
    }
  }

  // ── Activities: 3-8 rows per tick across active employees ──
  const nowMinutesUtc = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dhakaMinutes = (nowMinutesUtc + 360) % 1440; // UTC+6
  const inWorkHours = dhakaMinutes >= WORK_START_MINUTES && dhakaMinutes <= 18 * 60;
  const todayKey = dhakaDayKey(now);

  const writers = employees.filter((e) => devByEmp.has(e.id));
  const activeCount = Math.min(writers.length, 3 + Math.floor(rng() * 6));
  const activeSet = new Set<string>();
  while (activeSet.size < activeCount && writers.length > 0) {
    activeSet.add(pick(rng, writers).id);
  }

  const dayTotalsAcc = new Map<string, { p: number; n: number; u: number; idle: number; count: number; web: number; app: number }>();

  for (const empRowId of activeSet) {
    const isSite = rng() < 0.35;
    const catRoll = rng();
    const cat = catRoll < 0.6 ? 'productive' : catRoll < 0.85 ? 'neutral' : 'unproductive';
    const dur = (5 + Math.floor(rng() * 20)) * 60;

    if (catRoll < 0.12 && inWorkHours === false) {
      // Off-hours → idle rows instead of app/site activity.
      await orgData.activity.create({
        data: {
          type: 'idle', title: 'Idle', category: 'idle', duration: dur,
          employeeId: empRowId, deviceId: devByEmp.get(empRowId) ?? null,
          organizationId: demo.id, timestamp: now,
        },
      });
      result.activities++;
      continue;
    }

    if (isSite) {
      const sitePool: readonly { title: string; url: string }[] =
        cat === 'productive' ? DEMO_SITES.productive : cat === 'neutral' ? DEMO_SITES.neutral : DEMO_SITES.unproductive;
      const s = pick(rng, sitePool);
      await orgData.activity.create({
        data: {
          type: 'website', title: s.title, url: s.url, category: cat, duration: dur,
          employeeId: empRowId, deviceId: devByEmp.get(empRowId) ?? null,
          organizationId: demo.id, timestamp: now,
        },
      });
      const t = dayTotalsAcc.get(empRowId) ?? { p: 0, n: 0, u: 0, idle: 0, count: 0, web: 0, app: 0 };
      t.web++; t.count++; if (cat === 'productive') t.p += dur; else if (cat === 'neutral') t.n += dur; else t.u += dur;
      dayTotalsAcc.set(empRowId, t);
    } else {
      const appPool: readonly { title: string; app: string }[] =
        cat === 'productive' ? DEMO_APPS.productive : cat === 'neutral' ? DEMO_APPS.neutral : DEMO_APPS.unproductive;
      const a = pick(rng, appPool);
      await orgData.activity.create({
        data: {
          type: 'application', title: a.title, applicationName: a.app, category: cat, duration: dur,
          employeeId: empRowId, deviceId: devByEmp.get(empRowId) ?? null,
          organizationId: demo.id, timestamp: now,
        },
      });
      const t = dayTotalsAcc.get(empRowId) ?? { p: 0, n: 0, u: 0, idle: 0, count: 0, web: 0, app: 0 };
      t.app++; t.count++; if (cat === 'productive') t.p += dur; else if (cat === 'neutral') t.n += dur; else t.u += dur;
      dayTotalsAcc.set(empRowId, t);
    }
    result.activities++;
  }

  // Fold simulator activity into TODAY's WorkDaySummary (keeps the dashboard
  // KPI/trend live without waiting for the nightly aggregation job).
  for (const [empRowId, t] of dayTotalsAcc) {
    const existing = await orgData.workDaySummary.findUnique({
      where: { organizationId_employeeId_workDate: { organizationId: demo.id, employeeId: empRowId, workDate: todayKey } },
      select: { id: true, productiveSeconds: true, neutralSeconds: true, unproductiveSeconds: true, idleSeconds: true, activeSeconds: true, workingSeconds: true, activityCount: true, websiteActivityCount: true, applicationActivityCount: true },
    });
    const p = existing ? existing.productiveSeconds + t.p : t.p;
    const n = existing ? existing.neutralSeconds + t.n : t.n;
    const u = existing ? existing.unproductiveSeconds + t.u : t.u;
    const idle = existing ? existing.idleSeconds + t.idle : t.idle;
    const active = p + n + u;
    await orgData.workDaySummary.upsert({
      where: { organizationId_employeeId_workDate: { organizationId: demo.id, employeeId: empRowId, workDate: todayKey } },
      update: {
        productiveSeconds: p, neutralSeconds: n, unproductiveSeconds: u, idleSeconds: idle,
        activeSeconds: active, workingSeconds: Math.max(0, active - idle),
        activityCount: (existing?.activityCount ?? 0) + t.count,
        websiteActivityCount: (existing?.websiteActivityCount ?? 0) + t.web,
        applicationActivityCount: (existing?.applicationActivityCount ?? 0) + t.app,
      },
      create: {
        organizationId: demo.id, employeeId: empRowId, workDate: todayKey,
        productiveSeconds: p, neutralSeconds: n, unproductiveSeconds: u, idleSeconds: idle,
        activeSeconds: active, workingSeconds: Math.max(0, active - idle),
        outsideHoursSeconds: 0, breakSeconds: 0, activityCount: t.count,
        websiteActivityCount: t.web, applicationActivityCount: t.app,
      },
    });
  }

  // ── Occasional alert (≈8% of ticks) ──
  if (rng() < 0.08) {
    const emp = pick(rng, writers.length > 0 ? writers : employees);
    const alertDefs = [
      { title: 'High inactivity detected', type: 'high_inactivity', severity: 'info', description: 'Simulated idle period exceeded the threshold.' },
      { title: 'Off-hours activity', type: 'security', severity: 'warning', description: 'Simulated session detected outside working hours.' },
      { title: 'Context switching spike', type: 'system', severity: 'warning', description: 'Simulated rapid app switching above baseline.' },
    ];
    const def = pick(rng, alertDefs);
    await orgData.alert.create({
      data: {
        title: def.title, description: def.description, type: def.type,
        severity: def.severity, status: 'pending', source: 'demo_simulator',
        employeeId: emp.id, organizationId: demo.id,
      },
    });
    result.alerts++;
  }

  // ── Occasional synthetic screenshot (≈20% of ticks) ──
  if (rng() < 0.2) {
    const emp = pick(rng, writers.length > 0 ? writers : employees);
    const scene = pick(rng, DEMO_SCREENSHOT_SCENES);
    try {
      const png = await renderDemoScreenshot(scene);
      const filename = `${emp.employeeId}_${randomUUID()}.png`;
      await putScreenshot(demo.id, filename, png, 'image/png');
      const devRowId = devByEmp.get(emp.id) ?? null;
      await orgData.screenshot.create({
        data: {
          employeeId: emp.id, deviceId: devRowId,
          filePath: `/uploads/screenshots/${filename}`,
          fileName: `${scene.title.replace(/\s+/g, '_')}.png`,
          fileSize: png.length, mimeType: 'image/png',
          width: 1280, height: 800, appWindow: scene.title,
          organizationId: demo.id, capturedAt: now,
          processingStatus: 'processed',
        },
      });
      result.screenshots++;
    } catch (e) {
      result.errors.push(`screenshot: ${String(e)}`);
    }
  }

  // ── Occasional location update (≈30% of ticks) ──
  if (rng() < 0.3) {
    const emp = pick(rng, writers.length > 0 ? writers : employees);
    const loc = pick(rng, DEMO_LOCATIONS);
    await orgData.locationEvent.create({
      data: {
        employeeId: emp.id, deviceId: devByEmp.get(emp.id) ?? null,
        latitude: loc.lat + (rng() - 0.5) * 0.004,
        longitude: loc.lng + (rng() - 0.5) * 0.004,
        accuracy: 10 + Math.floor(rng() * 40),
        recordedAt: now, source: 'native', organizationId: demo.id,
      },
    });
    result.locations++;
  }

  // ── Daily sentiment refresh (first tick of the local day) ──
  const dayMarker = `sent:${todayKey}`;
  const marker = await db.systemSetting.findUnique({ where: { key: `demo_${dayMarker}` } });
  if (!marker && dhakaMinutes < WORK_START_MINUTES + 30) {
    await db.systemSetting.upsert({
      where: { key: `demo_${dayMarker}` },
      create: { key: `demo_${dayMarker}`, value: new Date().toISOString(), category: 'demo' },
      update: { value: new Date().toISOString() },
    });
    for (const e of employees) {
      const rngS = mulberry32(hashSeed(`${e.employeeId}:sent:${todayKey}`));
      const score = Math.round(35 + rngS() * 50);
      const mood = score > 70 ? 'positive' : score >= 40 ? 'neutral' : 'negative';
      await orgData.sentimentRecord.create({
        data: {
          employeeId: e.id, projectId: null, score, mood,
          signals: JSON.stringify({ productivityTrend: (rngS() * 20 - 5).toFixed(1), idleRate: (rngS() * 15).toFixed(1) }),
          insight: 'Daily simulated sentiment update (demo data).',
          riskFactors: JSON.stringify(score < 45 ? ['disengaged'] : []),
          recommendation: mood === 'positive' ? 'Continue current cadence.' : 'Schedule a check-in this week.',
          periodStart: dhakaInstant(todayKey, WORK_START_MINUTES),
          periodEnd: dhakaInstant(todayKey, 18 * 60),
          aiProviderUsed: 'rules', organizationId: demo.id,
        },
      });
      result.sentiment++;
    }
  }

  return result;
}

/** Resolve the demo org id for this run (single lookup, fail-closed). */
async function resolveDemoId(): Promise<string> {
  const { resolveDemoOrganization } = await import('./guards');
  return (await resolveDemoOrganization()).id;
}

/**
 * Lease-guarded entry point — the ONLY function the scheduler should call.
 * Returns ran=false when another replica holds the lease (no-op this tick).
 */
export async function runDemoSimulatorJob(now = new Date()): Promise<DemoSimulatorResult> {
  if (await claimJob(DEMO_SIMULATOR_JOB_NAME)) {
    try {
      const inner = await runDemoSimulatorOnce(now);
      await finishJob(DEMO_SIMULATOR_JOB_NAME, undefined, { ...inner });
      return { ran: true, ...inner };
    } catch (error) {
      await finishJob(DEMO_SIMULATOR_JOB_NAME, String(error)).catch(() => {});
      throw error;
    }
  }
  return { ran: false, activities: 0, heartbeats: 0, alerts: 0, screenshots: 0, locations: 0, sentiment: 0, errors: [] };
}
