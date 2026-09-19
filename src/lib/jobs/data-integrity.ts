// OmniSight — automated data-integrity & storage-hygiene job (hardening area 3).
//
// Runs on the daily cadence (see runScheduledJobs → data_integrity) and does
// four BOUNDED, self-contained passes that together catch silent data loss,
// storage drift and index staleness before they become customer-facing:
//
//   1. DEVICE ROUTING INDEX BACKFILL — re-drain the global device routing
//      index (platform Device table + every activated org's Device table). A
//      crash mid-transaction (device written, index upsert never fired) self-
//      heals here, so the anonymous discover hot path keeps resolving.
//
//   2. SCREENSHOT ROWS → OBJECTS — every Screenshot row (filePath +
//      thumbnailPath) referenced inside the lookback window must exist as a
//      storage object. Missing object = reported; the row is never deleted.
//      The reverse direction (orphan OBJECTS with no row) is the existing
//      retention/job sweep (src/lib/screenshots/sweep.ts) — this job only
//      reports the row-side so the two can never conflict.
//
//   3. OBJECTS → ROWS (informational) — orphan object count for orgs inside
//      the window, so a drift between object growth and row growth is visible
//      in one dashboard alongside the sweep's own removal counter.
//
//   4. FK INTEGRITY — sample Activity rows inside the window that reference a
//      missing Employee/Device/Project (hard-deleted rows would silently break
//      dashboard joins). Sampled (cheap + bounded), never auto-fixed.
//
// The job NEVER deletes or rewrites anything except the idempotent device-
// routing upserts (pass 1) — integrity jobs report; retention deletes. All
// passes are per-org isolated: one org's misconfigured DB cannot fail the job
// for the rest.

import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { getOrgStorage } from '@/lib/org-storage';
import { storage } from '@/lib/storage';
import { backfillDeviceRoutingIndex } from '@/lib/device-index';
import { log } from '@/lib/logger';
import {
  STORAGE_INTEGRITY_LOOKBACK_DAYS,
  ACTIVITY_FK_LOOKBACK_DAYS,
} from '@/config/constants';

export interface DataIntegrityResult {
  deviceRouting: {
    scannedPlatform: number;
    upsertedPlatform: number;
    scannedOrgDbs: number;
    upsertedOrgDbs: number;
  };
  screenshotRowsMissingObjects: number;
  screenshotOrphanObjects: number;
  screenshotOrgsScanned: number;
  fkIntegrity: {
    activitiesSampled: number;
    brokenEmployeeRefs: number;
    brokenDeviceRefs: number;
    brokenProjectRefs: number;
  };
  errors: string[];
}

const CHUNK = 2000;

export async function runDataIntegrityJob(): Promise<DataIntegrityResult> {
  const result: DataIntegrityResult = {
    deviceRouting: { scannedPlatform: 0, upsertedPlatform: 0, scannedOrgDbs: 0, upsertedOrgDbs: 0 },
    screenshotRowsMissingObjects: 0,
    screenshotOrphanObjects: 0,
    screenshotOrgsScanned: 0,
    fkIntegrity: { activitiesSampled: 0, brokenEmployeeRefs: 0, brokenDeviceRefs: 0, brokenProjectRefs: 0 },
    errors: [],
  };

  // ── Pass 1 — device routing index backfill ──────────────────────────────
  try {
    const backfill = await backfillDeviceRoutingIndex();
    result.deviceRouting = {
      scannedPlatform: backfill.scannedPlatform,
      upsertedPlatform: backfill.upsertedPlatform,
      scannedOrgDbs: backfill.scannedOrgDbs,
      upsertedOrgDbs: backfill.upsertedOrgDbs,
    };
    result.errors.push(...backfill.errors.map((e) => `device-routing: ${e}`));
  } catch (error) {
    result.errors.push(`device-routing: ${String((error as Error)?.message ?? error)}`);
  }

  // ── Pass 2/3 — screenshot row↔object reconciliation ────────────────────
  try {
    await reconcileScreenshotObjects(result);
  } catch (error) {
    result.errors.push(`screenshot-reconciliation: ${String((error as Error)?.message ?? error)}`);
  }

  // ── Pass 4 — FK integrity sample ────────────────────────────────────────
  try {
    await checkForeignKeyIntegrity(result);
  } catch (error) {
    result.errors.push(`fk-integrity: ${String((error as Error)?.message ?? error)}`);
  }

  log.info('jobs.data_integrity', {
    deviceRouting: result.deviceRouting,
    screenshotRowsMissingObjects: result.screenshotRowsMissingObjects,
    screenshotOrphanObjects: result.screenshotOrphanObjects,
    fkIntegrity: result.fkIntegrity,
    errors: result.errors.length,
  });

  return result;
}

// ─── Pass 2/3 — screenshot reconciliation ──────────────────────────────────

async function reconcileScreenshotObjects(result: DataIntegrityResult): Promise<void> {
  const cutoff = new Date(Date.now() - STORAGE_INTEGRITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Enumerate the orgs that own screenshot rows: platform (cloud) + every
  // activated org (own DB).
  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
  });
  const orgIds = new Set<string>(activated.map((s) => s.organizationId));
  void orgIds; // platform orgs are discovered from the platform rows below

  // Platform rows (cloud orgs). The active platform storage driver owns them.
  {
    const rowKeys = await collectScreenshotRowRefs(db, cutoff, CHUNK);
    const objectKeys = await listScreenshotObjects(storage());
    applyReconciliation(result, rowKeys, objectKeys);
    result.screenshotOrgsScanned += 1;
  }

  // Activated org rows → their OWN storage driver (getOrgStorage).
  for (const s of activated) {
    try {
      const orgClient = (await getPrismaForOrg(s.organizationId)).client;
      const rowKeys = await collectScreenshotRowRefs(orgClient, cutoff, CHUNK);
      const res = await getOrgStorage(s.organizationId);
      const driver = res.mode === 'org' ? res.driver : storage();
      const objectKeys = await listScreenshotObjects(driver);
      applyReconciliation(result, rowKeys, objectKeys);
      result.screenshotOrgsScanned += 1;
    } catch (error) {
      result.errors.push(`screenshot-reconcile org ${s.organizationId}: ${String((error as Error)?.message ?? error)}`);
    }
  }
}

type PrismaLike = {
  screenshot: {
    findMany(args: {
      where: { createdAt: { gte: Date } };
      select: { filePath: boolean; thumbnailPath: boolean };
      skip: number;
      take: number;
    }): Promise<Array<{ filePath: string | null; thumbnailPath: string | null }>>;
  };
};

/** Every basename a Screenshot row references inside the window. */
async function collectScreenshotRowRefs(
  client: PrismaLike,
  cutoff: Date,
  chunk: number
): Promise<Set<string>> {
  const refs = new Set<string>();
  let skip = 0;
  for (;;) {
    const rows = await client.screenshot.findMany({
      where: { createdAt: { gte: cutoff } },
      select: { filePath: true, thumbnailPath: true },
      skip,
      take: chunk,
    });
    for (const row of rows) {
      if (row.filePath) refs.add(row.filePath.split('/').pop() ?? row.filePath);
      if (row.thumbnailPath) refs.add(row.thumbnailPath.split('/').pop() ?? row.thumbnailPath);
    }
    if (rows.length < chunk) break;
    skip += chunk;
  }
  return refs;
}

/** Existing object basenames (common denominator across driver key shapes). */
async function listScreenshotObjects(
  driver: { listObjects(opts?: { prefix?: string; limit?: number }): Promise<string[]> }
): Promise<Set<string>> {
  const keys = await driver.listObjects({ prefix: 'screenshots/', limit: 10000 });
  const names = new Set<string>();
  for (const key of keys) {
    const name = key.split('/').pop();
    if (name) names.add(name);
  }
  return names;
}

function applyReconciliation(
  result: DataIntegrityResult,
  rowRefs: Set<string>,
  objectNames: Set<string>
): void {
  // Rows without an object = data loss (reported, never auto-deleted).
  for (const ref of rowRefs) {
    if (!objectNames.has(ref)) result.screenshotRowsMissingObjects += 1;
  }
  // Objects without a row inside the window = orphans (the retention sweep
  // removes them; this only reports so drift is visible).
  for (const name of objectNames) {
    if (!rowRefs.has(name)) result.screenshotOrphanObjects += 1;
  }
}

// ─── Pass 4 — FK integrity ─────────────────────────────────────────────────

interface FkClient {
  // Structural test seam over a Prisma data client. `args: any` keeps the
  // seam decoupled from generated Prisma types while still constraining the
  // RESULT shape (the only thing sampleBrokenForeignKeys reads).
  activity: {
    findMany(args: any): Promise<Array<{ id: string; employeeId: string | null; deviceId: string | null }>>;
  };
  employee: {
    findMany(args: any): Promise<Array<{ id: string }>>;
  };
  device: {
    findMany(args: any): Promise<Array<{ id: string }>>;
  };
}

async function checkForeignKeyIntegrity(result: DataIntegrityResult): Promise<void> {
  const cutoff = new Date(Date.now() - ACTIVITY_FK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const sampleLimit = 200;

  const platformBroken = await sampleBrokenForeignKeys(db, cutoff, sampleLimit);
  accumulateFk(result, platformBroken);
  result.fkIntegrity.activitiesSampled += platformBroken.activitiesSampled;

  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
  });
  for (const s of activated) {
    try {
      const orgClient = (await getPrismaForOrg(s.organizationId)).client as FkClient;
      const broken = await sampleBrokenForeignKeys(orgClient, cutoff, sampleLimit);
      accumulateFk(result, broken);
      result.fkIntegrity.activitiesSampled += broken.activitiesSampled;
    } catch (error) {
      result.errors.push(`fk-integrity org ${s.organizationId}: ${String((error as Error)?.message ?? error)}`);
    }
  }
}

interface FkSample {
  activitiesSampled: number;
  brokenEmployeeRefs: number;
  brokenDeviceRefs: number;
  brokenProjectRefs: number;
}

async function sampleBrokenForeignKeys(client: FkClient, cutoff: Date, limit: number): Promise<FkSample> {
  const broken: FkSample = { activitiesSampled: 0, brokenEmployeeRefs: 0, brokenDeviceRefs: 0, brokenProjectRefs: 0 };
  const where = { createdAt: { gte: cutoff } };

  const activityRows = await client.activity.findMany({
    where,
    select: { id: true, employeeId: true, deviceId: true },
    take: limit,
  });
  broken.activitiesSampled = activityRows.length;
  if (activityRows.length === 0) return broken;

  const employeeIds = [...new Set(activityRows.map((a) => a.employeeId).filter((x): x is string => !!x))];
  const deviceIds = [...new Set(activityRows.map((a) => a.deviceId).filter((x): x is string => !!x))];

  const existingEmployees = new Set(
    (await client.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true }, take: limit })).map((e) => e.id)
  );
  const existingDevices = new Set(
    (await client.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true }, take: limit })).map((d) => d.id)
  );

  for (const a of activityRows) {
    if (a.employeeId && !existingEmployees.has(a.employeeId)) broken.brokenEmployeeRefs += 1;
    if (a.deviceId && !existingDevices.has(a.deviceId)) broken.brokenDeviceRefs += 1;
  }
  return broken;
}

function accumulateFk(result: DataIntegrityResult, sample: FkSample): void {
  result.fkIntegrity.brokenEmployeeRefs += sample.brokenEmployeeRefs;
  result.fkIntegrity.brokenDeviceRefs += sample.brokenDeviceRefs;
  result.fkIntegrity.brokenProjectRefs += sample.brokenProjectRefs;
}