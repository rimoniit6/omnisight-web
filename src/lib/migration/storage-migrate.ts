// OmniSight — org-scoped STORAGE object migration for approved infrastructure
// change requests.
//
// Copies ONLY objects whose ownership is provable:
//   • Database-backed: Screenshot.filePath / thumbnailPath and
//     AudioRecording.filePath rows of THIS organization → their storage keys
//     via the same key derivation the application uses
//     (screenshots/<orgId>/<name>, audio/<orgId>/<name>).
//   • Nothing else is copied. If the org's DB rows reference objects that do
//     not exist at the source, that object is counted as missing and the
//     verification reports it — ambiguous/potentially-unrelated platform
//     objects are NEVER copied wholesale (fail-closed ownership).
//
// Idempotent: an object already present at the destination with the expected
// size is skipped, so interrupted runs resume without duplicating work.
// Progress (objects/bytes done/total) comes from real copy operations only.
//
// FULL-ORGANIZATION CUTOVER (storage):
//   • zeroDrift on a successful run = every object referenced by the org's DB
//     rows at the verification instant was already present at the destination
//     (new rows/objects created during the transfer make it zeroDrift=false).
//   • The in-flight gap is closed deterministically at activation by
//     drainStorageCutover (below): the source driver is captured BEFORE the
//     routing flip, then passes re-collect the org's DB-referenced objects and
//     copy any still missing to the destination until a pass changes nothing —
//     post-flip objects are written straight to the destination by the live app.

import type { PrismaClient } from '@prisma/client';
import { basename } from 'path';
import { db } from '@/lib/db';
import { getOrgStorage } from '@/lib/org-storage';
import { storage as platformStorage, isNotFound } from '@/lib/storage';
import { SCREENSHOTS_BUCKET } from '@/lib/storage/types';
import { SupabaseStorageDriver } from '@/lib/storage/supabase';
import type { StorageDriver } from '@/lib/storage/types';
import { log } from '@/lib/logger';
import { sanitizeProbeErrorForLog } from '@/lib/infra-connect';

function userSafeError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  const sanitized = sanitizeProbeErrorForLog({ message: raw });
  return sanitized.length > 0 ? sanitized.slice(0, 300) : 'Unknown storage failure';
}

function screenshotKeyFor(orgId: string, filePath: string): string {
  return `${SCREENSHOTS_BUCKET}/${orgId}/${basename(filePath || '')}`;
}

function audioKeyFor(orgId: string, filePath: string): string {
  // AudioRecording.filePath is the full storage key: audio/<orgId>/<uuid>.<ext>
  const normalized = filePath.replace(/^\/+/, '');
  if (normalized.startsWith(`audio/${orgId}/`)) return normalized;
  // Defensive: re-derive from basename if the row predates the key layout.
  return `audio/${orgId}/${basename(filePath || '')}`;
}

interface ProgressPatch {
  objectsDone: number;
  objectsTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

interface StorageRef {
  key: string;
  expectedSize: number | null;
}

/** Collect the org's provably-owned object references from `client` (the org's
 * current data DB — platform before a DB cutover, the org's own after). */
export async function collectOrgStorageRefs(
  orgId: string,
  client: PrismaClient = db
): Promise<StorageRef[]> {
  const refs: StorageRef[] = [];
  const screenshots = await client.screenshot.findMany({
    where: { organizationId: orgId },
    select: { filePath: true, fileSize: true, thumbnailPath: true, thumbnailSize: true },
  });
  for (const s of screenshots) {
    refs.push({ key: screenshotKeyFor(orgId, s.filePath), expectedSize: s.fileSize });
    if (s.thumbnailPath) {
      refs.push({ key: screenshotKeyFor(orgId, s.thumbnailPath), expectedSize: s.thumbnailSize });
    }
  }
  const audio = await client.audioRecording.findMany({
    where: { organizationId: orgId },
    select: { filePath: true, fileSize: true },
  });
  for (const a of audio) {
    refs.push({ key: audioKeyFor(orgId, a.filePath), expectedSize: a.fileSize });
  }
  return refs;
}

async function objectSize(driver: StorageDriver, key: string): Promise<number | null> {
  try {
    const bytes = await driver.get(key);
    return bytes.length;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export interface StorageMigrationOutcome {
  ok: boolean;
  errorStage?: 'storage' | 'verify';
  errorMessage?: string;
  objectsDone: number;
  objectsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  missingSourceObjects: number;
  /**
   * True when the destination already held every object referenced by the org's
   * DB rows at the final verification instant (no in-flight drift). Rows that
   * keep arriving during the transfer make this false — the gap is closed by
   * drainStorageCutover at activation.
   */
  zeroDrift: boolean;
}

/**
 * Run the org-scoped storage migration from the org's CURRENT source driver
 * (org-dedicated if already active, else the platform driver) to the APPROVED
 * destination project. Never copies anything not referenced by this org's DB
 * rows.
 */
export async function runStorageMigration(
  orgId: string,
  destination: { url: string; key: string },
  onProgress: (patch: ProgressPatch) => Promise<void>
): Promise<StorageMigrationOutcome> {
  const objectsTotal = { n: 0 };
  const bytesTotal = { n: 0 };
  const objectsDone = { n: 0 };
  const bytesDone = { n: 0 };
  let missingSourceObjects = 0;

  try {
    const sourceRes = await getOrgStorage(orgId);
    const source: StorageDriver = sourceRes.mode === 'org' ? sourceRes.driver : platformStorage();
    const destinationDriver: StorageDriver = new SupabaseStorageDriver(destination.url.replace(/\/+$/, ''), destination.key);

    const refs = await collectOrgStorageRefs(orgId);
    const refsAtSnapshot = refs.length;

    // Totals from actual source objects (truthful; missing files count as 0).
    for (const ref of refs) {
      const size = await objectSize(source, ref.key);
      if (size === null) {
        missingSourceObjects += 1;
        continue;
      }
      objectsTotal.n += 1;
      bytesTotal.n += size;
    }
    await onProgress({ objectsDone: 0, objectsTotal: objectsTotal.n, bytesDone: 0, bytesTotal: bytesTotal.n });

    for (const ref of refs) {
      const size = await objectSize(source, ref.key);
      if (size === null) continue; // counted as missing; verification reports it
      const destSize = await objectSize(destinationDriver, ref.key);
      if (destSize === size) {
        // Already migrated (resume) — counts toward done, no re-copy.
        objectsDone.n += 1;
        bytesDone.n += size;
        await onProgress({ objectsDone: objectsDone.n, objectsTotal: objectsTotal.n, bytesDone: bytesDone.n, bytesTotal: bytesTotal.n });
        continue;
      }
      const bytes = await source.get(ref.key);
      await destinationDriver.put(ref.key, { bytes, contentType: guessContentType(ref.key) });
      objectsDone.n += 1;
      bytesDone.n += bytes.length;
      await onProgress({ objectsDone: objectsDone.n, objectsTotal: objectsTotal.n, bytesDone: bytesDone.n, bytesTotal: bytesTotal.n });
    }

    // ── Verification: every DB-referenced object must resolve at the destination ──
    // Re-collect refs at verification time: if new screenshot/audio rows landed
    // during the copy, refs grew and zeroDrift is false (their objects sit
    // platform-side until activation's drain).
    const refsNow = await collectOrgStorageRefs(orgId);
    let unresolved = 0;
    for (const ref of refsNow) {
      const size = await objectSize(destinationDriver, ref.key);
      if (size === null) unresolved += 1;
    }
    if (unresolved > 0) {
      return {
        ok: false, errorStage: 'verify',
        errorMessage: `Storage verification failed: ${unresolved} referenced object(s) missing at the destination`,
        objectsDone: objectsDone.n, objectsTotal: objectsTotal.n, bytesDone: bytesDone.n, bytesTotal: bytesTotal.n,
        missingSourceObjects, zeroDrift: false,
      };
    }

    return {
      ok: true,
      objectsDone: objectsDone.n, objectsTotal: objectsTotal.n,
      bytesDone: bytesDone.n, bytesTotal: bytesTotal.n,
      missingSourceObjects,
      zeroDrift: refsNow.length <= refsAtSnapshot,
    };
  } catch (err) {
    log.error('migration.storage.failed', { error: userSafeError(err) });
    return {
      ok: false, errorStage: 'storage', errorMessage: userSafeError(err),
      objectsDone: objectsDone.n, objectsTotal: objectsTotal.n,
      bytesDone: bytesDone.n, bytesTotal: bytesTotal.n,
      missingSourceObjects, zeroDrift: false,
    };
  }
}

function guessContentType(key: string): string {
  const ext = basename(key).split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'mp3' || ext === 'wav' || ext === 'webm' || ext === 'm4a') return 'audio/mpeg';
  return 'application/octet-stream';
}

export interface StorageDrainOutcome extends StorageMigrationOutcome {
  passes: number;
  copiedThisRun: number;
}

/**
 * STORAGE cutover drain to fixpoint. Must be called AFTER the storage routing
 * flip: `source` is the org's PRE-flip storage driver (captured just before the
 * settings switch), `refsClient` is the org's CURRENT data DB (the source of
 * the object references — after a database cutover it is the org's own DB).
 *
 * New rows/objects written between the snapshot transfer and the flip are still
 * referenced only in the destination-facing refs set; passes re-collect the refs
 * and copy any object missing (or size-mismatched) at the destination from the
 * pre-flip source until one full pass changes nothing. Post-flip, new objects
 * are written straight to the destination by the live app, so the loop
 * converges. Fails instead of looping forever when the refs keep growing.
 */
export async function drainStorageCutover(
  orgId: string,
  source: StorageDriver,
  destination: { url: string; key: string },
  refsClient: PrismaClient,
  opts: { maxPasses?: number } = {}
): Promise<StorageDrainOutcome> {
  const maxPasses = opts.maxPasses ?? 50;
  const destinationDriver: StorageDriver = new SupabaseStorageDriver(destination.url.replace(/\/+$/, ''), destination.key);
  const copied = { n: 0 };
  const bytesDone = { n: 0 };
  let settledPass = 0;

  try {
    for (let pass = 1; pass <= maxPasses; pass++) {
      const refs = await collectOrgStorageRefs(orgId, refsClient);
      let passCopies = 0;
      for (const ref of refs) {
        const destSize = await objectSize(destinationDriver, ref.key);
        // Already consistent (either the snapshot copy or a prior drain pass).
        if (destSize === ref.expectedSize) continue;
        const srcSize = await objectSize(source, ref.key);
        if (srcSize === null) continue; // gone from the source too — nothing to copy
        if (destSize === srcSize) {
          bytesDone.n += srcSize;
          continue;
        }
        const bytes = await source.get(ref.key);
        await destinationDriver.put(ref.key, { bytes, contentType: guessContentType(ref.key) });
        passCopies += 1;
        copied.n += 1;
        bytesDone.n += bytes.length;
      }
      if (passCopies === 0) {
        settledPass = pass;
        break;
      }
    }

    // Final verification: every object referenced by the org's rows now must
    // resolve at the destination (post-flip references land there directly).
    let unresolved = 0;
    let bytesTotal = 0;
    const refs = await collectOrgStorageRefs(orgId, refsClient);
    for (const ref of refs) {
      const size = await objectSize(destinationDriver, ref.key);
      if (size === null) { unresolved += 1; continue; }
      bytesTotal += size;
    }
    if (unresolved > 0) {
      return {
        ok: false, errorStage: 'verify',
        errorMessage: `Storage cutover verification failed: ${unresolved} referenced object(s) missing at the destination`,
        objectsDone: copied.n, objectsTotal: refs.length, bytesDone: bytesDone.n, bytesTotal,
        missingSourceObjects: 0, zeroDrift: false,
        passes: settledPass || maxPasses, copiedThisRun: copied.n,
      };
    }
    return {
      ok: true,
      objectsDone: copied.n, objectsTotal: refs.length,
      bytesDone: bytesDone.n, bytesTotal,
      missingSourceObjects: 0, zeroDrift: true,
      passes: settledPass || maxPasses, copiedThisRun: copied.n,
    };
  } catch (err) {
    log.error('migration.storage.cutover.failed', { error: userSafeError(err) });
    return {
      ok: false, errorStage: 'storage', errorMessage: userSafeError(err),
      objectsDone: copied.n, objectsTotal: 0, bytesDone: bytesDone.n, bytesTotal: 0,
      missingSourceObjects: 0, zeroDrift: false,
      passes: settledPass, copiedThisRun: copied.n,
    };
  }
}
