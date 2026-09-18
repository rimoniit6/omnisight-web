// OmniSight — Demo reset job (lease-guarded).
//
// Deletes ONLY demo-organization data (rows + synthetic screenshot storage
// objects) and re-seeds the deterministic baseline. Never executes an
// unscoped delete; every predicate is organizationId-scoped or limited to
// demo-org employee/device ids. Other organizations' rows and storage
// contents are untouched (verified by tests).
//
// Trigger policy: the demo seeder stamps a SystemSetting marker with the
// baseline creation time; a reset runs when the dataset is older than
// DEMO_RESET_AFTER_DAYS, or when triggered explicitly (admin/CLI).

import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { deleteScreenshot, isNotFound } from '@/lib/storage';
import { claimJob, finishJob } from '@/lib/jobs/run';
import { assertDemoOrg, DEMO_RESET_AFTER_DAYS, DEMO_RESET_JOB_NAME } from '@/lib/demo/guards';
import { wipeDemoData, seedDemoData, type DemoSeedResult } from '@/lib/demo/seed';

const BASELINE_KEY = 'demo_baseline_seeded_at';

export interface DemoResetResult {
  ran: boolean; // false when the lease was held elsewhere
  triggered: boolean; // true when the age threshold triggered it
  screenshotsRemoved: number;
  storageErrors: string[];
  seed?: DemoSeedResult;
}

/** Read the baseline age in days (Infinity when the marker is missing). */
export async function demoBaselineAgeDays(now = new Date()): Promise<number> {
  const row = await db.systemSetting.findUnique({ where: { key: BASELINE_KEY } });
  if (!row) return Infinity;
  const t = Date.parse(row.value);
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / (24 * 60 * 60 * 1000);
}

/**
 * Remove the demo org's screenshot storage objects through the existing
 * org-scoped storage helper (deleteScreenshot → screenshotKeyFromPath →
 * screenshots/<demoOrgId>/<basename>). Never hand-builds storage paths.
 */
async function removeDemoScreenshotObjects(demoOrgId: string): Promise<{ removed: number; errors: string[] }> {
  const { client: orgData } = await getPrismaForOrg(demoOrgId);
  const rows = await orgData.screenshot.findMany({
    where: { organizationId: demoOrgId },
    select: { filePath: true, thumbnailPath: true },
  });
  const errors: string[] = [];
  let removed = 0;
  for (const row of rows) {
    for (const p of [row.thumbnailPath, row.filePath]) {
      if (!p) continue;
      try {
        await deleteScreenshot(demoOrgId, p);
        removed++;
      } catch (e) {
        if (!isNotFound(e)) errors.push(`${p}: ${String(e)}`);
      }
    }
  }
  return { removed, errors };
}

/**
 * Core reset (wipe → storage cleanup → re-seed → stamp baseline marker).
 * Caller must hold the job lease.
 */
export async function resetDemoDataset(demoOrgId: string): Promise<DemoResetResult> {
  const demo = await assertDemoOrg(demoOrgId);

  // 1) Storage objects FIRST (they are referenced by the rows about to go).
  const storage = await removeDemoScreenshotObjects(demo.id);

  // 2) Demo-scoped row wipe + deterministic re-seed.
  await wipeDemoData(demo.id);
  const seed = await seedDemoData(demo.id);

  // 3) Stamp the baseline marker (reset-age anchor).
  await db.systemSetting.upsert({
    where: { key: BASELINE_KEY },
    create: { key: BASELINE_KEY, value: new Date().toISOString(), category: 'demo' },
    update: { value: new Date().toISOString() },
  });

  return { ran: true, triggered: false, screenshotsRemoved: storage.removed, storageErrors: storage.errors, seed };
}

/**
 * Lease-guarded reset entry: resets only when the baseline is older than
 * DEMO_RESET_AFTER_DAYS. Called from the scheduler (registered in run.ts) —
 * multiple replicas never double-run thanks to the JobRun lease.
 */
export async function runDemoResetJob(now = new Date()): Promise<DemoResetResult> {
  const age = await demoBaselineAgeDays(now);
  if (age < DEMO_RESET_AFTER_DAYS) {
    return { ran: false, triggered: false, screenshotsRemoved: 0, storageErrors: [] };
  }
  if (await claimJob(DEMO_RESET_JOB_NAME)) {
    try {
      const demoId = await (await import('@/lib/demo/guards')).resolveDemoOrganization().then((d) => d.id);
      const demo = await assertDemoOrg(demoId);
      const result = await resetDemoDataset(demo.id);
      await finishJob(DEMO_RESET_JOB_NAME, undefined, {
        screenshotsRemoved: result.screenshotsRemoved,
        seed: result.seed,
      });
      return result;
    } catch (error) {
      await finishJob(DEMO_RESET_JOB_NAME, String(error)).catch(() => {});
      throw error;
    }
  }
  return { ran: false, triggered: true, screenshotsRemoved: 0, storageErrors: [] };
}
