/**
 * Orphan-file sweep for local screenshot storage.
 *
 * This module is intentionally SEPARATE from storage.ts so that production
 * routes (which import validation/utility functions from storage.ts) do not
 * pull in fs/promises through the module dependency graph. Turbopack traces
 * static fs imports even when the code path is guarded by runtime checks.
 *
 * Only the retention background job (src/lib/jobs/retention.ts) imports this.
 */
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import { isSupabaseStorage } from '@/lib/storage';

const SCREENSHOT_UPLOAD_DIR = join(process.cwd(), 'uploads', 'screenshots');

export interface OrphanSweepResult {
  scanned: number;
  removed: number;
  errors: string[];
}

/**
 * Load every file basename referenced by a Screenshot row (chunked so the
 * query stays bounded on large datasets). The returned set is used to decide
 * which on-disk files are orphans.
 */
async function collectReferencedFilenames(chunk = 2000): Promise<Set<string>> {
  const referenced = new Set<string>();
  let skip = 0;
  for (;;) {
    const rows = await db.screenshot.findMany({
      select: { filePath: true },
      skip,
      take: chunk,
    });
    for (const row of rows) {
      if (!row.filePath) continue;
      referenced.add(basename(row.filePath));
    }
    if (rows.length < chunk) break;
    skip += chunk;
  }
  return referenced;
}

/**
 * Remove physical screenshot files that no longer have a corresponding
 * Screenshot DB record.
 *
 * Safety:
 *  - Only inspects the screenshots storage root (never recurses, never
 *    touches other directories).
 *  - Never deletes a file referenced by a valid Screenshot row.
 *  - Files younger than `minAgeMs` (default 15 min) are skipped so an upload
 *    that has written its file but not yet committed its DB row is never
 *    misidentified as an orphan (idempotent: a later run catches leftovers).
 *  - Missing directory / malformed names are handled without throwing.
 *
 * Runs inside the existing retention background job — never per API request.
 */
export async function sweepOrphanScreenshotFiles(
  opts: { minAgeMs?: number; limit?: number } = {}
): Promise<OrphanSweepResult> {
  // Supabase Storage has no shared filesystem to sweep: objects live in
  // buckets and every write/delete already goes through the driver (failed
  // uploads remove their object best-effort). Orphan cleanup there is a
  // no-op by design.
  if (isSupabaseStorage()) {
    return { scanned: 0, removed: 0, errors: [] };
  }
  const minAgeMs = opts.minAgeMs ?? 15 * 60 * 1000;
  const limit = opts.limit ?? 1000;
  const result: OrphanSweepResult = { scanned: 0, removed: 0, errors: [] };

  let entries: string[];
  try {
    entries = await fs.readdir(SCREENSHOT_UPLOAD_DIR);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return result; // storage root does not exist yet — nothing to sweep
    }
    result.errors.push(`readdir failed: ${String((error as Error)?.message ?? error)}`);
    return result;
  }

  const referenced = await collectReferencedFilenames();
  const cutoff = Date.now() - minAgeMs;

  for (const entry of entries) {
    if (entry.startsWith('.') || !entry.includes('.')) continue; // ignore dotfiles / non-files
    const filePath = join(SCREENSHOT_UPLOAD_DIR, entry);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > cutoff) continue; // too fresh — possibly an in-flight upload
      if (referenced.has(entry)) continue; // referenced by a valid DB row — keep
      if (result.removed >= limit) {
        log.warn('screenshots.orphan_sweep.limit_reached', { limit });
        break;
      }
      await fs.unlink(filePath);
      result.removed += 1;
    } catch (error) {
      // ENOENT race (file removed between stat and unlink) is fine; anything
      // else is reported and the sweep continues.
      const code = (error as { code?: string })?.code;
      if (code !== 'ENOENT') {
        result.errors.push(`unlink ${entry}: ${String((error as Error)?.message ?? error)}`);
      }
    }
    result.scanned += 1;
  }

  log.info('screenshots.orphan_sweep', { scanned: result.scanned, removed: result.removed });
  return result;
}
