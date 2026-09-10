import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiSuccess, apiError, authError } from '@/lib/api';

// GET /api/super-admin/storage — platform storage overview (Phase 5 §18).
// Control-plane ONLY: active driver, aggregate object COUNTS (metadata rows,
// never file content or per-org operational data), organization retention
// policy distribution and the last retention cleanup job run. Exact byte-level
// accounting is NOT tracked today and is reported as unavailable — never
// fabricated.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return authError(admin);

    const [screenshotObjects, audioObjects, reportObjects, retentionSettings, jobRuns] =
      await Promise.all([
        db.screenshot.count(),
        db.audioRecording.count(),
        db.report.count(),
        db.organizationSetting.findMany({
          where: { key: 'screenshot_retention_days' },
          select: { value: true },
        }),
        db.jobRun.findMany({
          where: { job: 'retention_cleanup' },
          orderBy: { lastRunAt: 'desc' },
          take: 3,
          select: {
            id: true,
            status: true,
            lastRunAt: true,
            lastDurationMs: true,
            lastError: true,
          },
        }),
      ]);

    // Retention policy distribution across organizations (control-plane config).
    const retentionByDays = new Map<string, number>();
    for (const s of retentionSettings) {
      const key = s.value || '0';
      retentionByDays.set(key, (retentionByDays.get(key) ?? 0) + 1);
    }

    let driverKind = 'local';
    try {
      const { resolveStorageDriver } = await import('@/lib/storage');
      driverKind = resolveStorageDriver().kind;
    } catch {
      driverKind = 'misconfigured';
    }

    return apiSuccess({
      driver: driverKind,
      objectCounts: {
        screenshots: screenshotObjects,
        audio: audioObjects,
        reports: reportObjects,
      },
      // Byte-level usage is not tracked by the current architecture.
      bytesUsed: null,
      byteAccounting: 'unavailable',
      retention: {
        byDays: Array.from(retentionByDays.entries()).map(([days, count]) => ({
          days: days === '0' ? 'unlimited' : days,
          organizations: count,
        })),
        organizationsConfigured: retentionSettings.length,
      },
      cleanup: jobRuns.map((r) => ({
        status: r.status,
        lastRunAt: r.lastRunAt?.toISOString() ?? null,
        durationMs: r.lastDurationMs,
        error: r.lastError ? 'See job logs' : null,
      })),
    });
  } catch {
    return apiError('Failed to load storage overview', 500);
  }
}