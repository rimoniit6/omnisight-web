import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/logger';

// CUSTOMER_DB realtime delivery signal (see schema.prisma
// RealtimeScreenshotEvent). For an org whose employee/device/screenshot rows
// live in its own database (`orgData !== db`), the platform live-updates
// poller never sees the screenshot row, so the upload route writes this compact
// platform-side marker and the poller broadcasts 'new-screenshot' from it —
// keeping the realtime contract identical to a MANAGED org.
//
// Delivery is best-effort by design: the screenshot row + object are already
// durably stored before this runs, so a signal failure must never fail the
// upload (the next capture simply writes a fresh signal; the client refetch on
// reconnect/refresh reconciles from the API anyway — the DB is the source of
// truth, the socket is a delta layer). A duplicate write (retried capture) is
// idempotent on the client: invalidation is keyed by employeeId and the
// refetch is stateless.
export async function signalScreenshotRealtime(
  db: PrismaClient,
  orgData: PrismaClient,
  payload: {
    organizationId: string;
    employeeId: string;
    employeeName: string | null;
    appWindow: string | null;
    capturedAt: Date;
  }
): Promise<boolean> {
  // MANAGED org: the screenshot row itself is polled — no signal needed.
  if (orgData === db) return false;

  try {
    await db.realtimeScreenshotEvent.create({
      data: {
        organizationId: payload.organizationId,
        employeeId: payload.employeeId,
        employeeName: payload.employeeName,
        appWindow: payload.appWindow,
        capturedAt: payload.capturedAt,
      },
    });
    log.info('agent.screenshot.realtime_signal', {
      orgId: payload.organizationId.slice(0, 8),
      employeeId: payload.employeeId.slice(0, 12),
      capturedAt: payload.capturedAt.toISOString(),
    });
    return true;
  } catch (err) {
    // Never fail the upload for a best-effort notification.
    log.warn('agent.screenshot.realtime_signal_failed', {
      orgId: payload.organizationId.slice(0, 8),
      error: String((err as Error)?.message ?? err),
    });
    return false;
  }
}