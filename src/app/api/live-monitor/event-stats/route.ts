'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { localDayKey, zonedDayStart } from '@/lib/timezone';

// GET /api/live-monitor/event-stats?range=today|24h|7d
//
// LM-P2-2: authoritative DB-backed Event Stats. Counts are aggregated
// server-side with org-scoped COUNT queries over a validated time window —
// NEVER derived from the client's 80-event WebSocket log. The live event
// stream (websocket) remains responsible for live delivery; this endpoint is
// the source of truth for the "Event Stats" card.
//
// Metric semantics (each matches the Live Monitor event type it feeds):
//   devices       — Device rows updated in the window (status changes,
//                   registrations, heartbeats — any persisted device activity;
//                   there is no separate status-change history table).
//   activity      — Activity rows (application/website) in the window.
//   notifications — Notification rows (the "Alert" card) in the window.
//   break         — Activity rows titled "Break Mode …" in the window.
//   screenshot    — Screenshot rows in the window.
//   registration  — AgentRegistration rows in the window.
//   usb           — UsbEvent rows in the window.
//   deviceClaim   — DeviceClaim rows in the window (zero-touch approval queue).
//   guest         — Guest enrollment rows created in the window (P3-2: the
//                   Live Monitor "Guest" event maps to its own stat card —
//                   it was previously mislabeled under deviceClaim).
//   projectTime   — automatically-tracked TimeEntry rows (source ACTIVITY_AUTO)
//                   created in the window (the "Project Time Updated" event).
//   total         — sum of the above.
//
// NOTE: agentBuild was previously counted here but has been removed as part
// of the Agent Software web UI removal (the AgentBuild table no longer exists).
export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: organization identity ALWAYS comes from the verified
    // session JWT — never from a client-supplied parameter. An org-less
    // super_admin (bootstrap state) receives a valid EMPTY stat set — never
    // global business data.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return emptyStats();

    const orgId = scope.organizationId;

    // Validate the time range (default "today").
    const { searchParams } = new URL(req.url);
    const range = searchParams.get('range') || 'today';
    if (!['today', '24h', '7d'].includes(range)) {
      return NextResponse.json({ error: "range must be 'today', '24h', or '7d'" }, { status: 400 });
    }

    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;
    let from: Date;
    let timezone = 'UTC';

    if (range === 'today') {
      // Org-local calendar day (S-6): the org timezone is the single source
      // of truth for the local day boundary — never a UTC split.
      const org = await db.organization.findUnique({
        where: { id: orgId },
        select: { timezone: true },
      });
      timezone = org?.timezone || 'UTC';
      from = zonedDayStart(localDayKey(now, timezone), timezone);
    } else if (range === '24h') {
      from = new Date(now.getTime() - DAY_MS);
    } else {
      from = new Date(now.getTime() - 7 * DAY_MS);
    }

    // ── Org-scoped, time-scoped COUNT aggregations (no row fetching) ───────
    // Activity/Break derive org through the employee relation (Activity has no
    // organizationId column); the rest carry organizationId directly. All
    // filters are indexed (createdAt / organizationId+createdAt).
    const [devices, activity, notifications, screenshot, registration, usb, breakCount, projectTime, deviceClaim, guestCount, alertCount] = await Promise.all([
      db.device.count({ where: { organizationId: orgId, updatedAt: { gte: from } } }),
      db.activity.count({
        where: {
          type: { in: ['application', 'website'] },
          // Break-mode rows are counted under `break`, never here — each row
          // contributes to exactly one category (no double counting).
          NOT: { title: { contains: 'Break Mode' } },
          createdAt: { gte: from },
          employee: { organizationId: orgId },
        },
      }),
      db.notification.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
      db.screenshot.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
      db.agentRegistration.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
      db.usbEvent.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
      db.activity.count({
        where: {
          title: { contains: 'Break Mode' },
          createdAt: { gte: from },
          employee: { organizationId: orgId },
        },
      }),
      db.timeEntry.count({ where: { organizationId: orgId, source: 'ACTIVITY_AUTO', createdAt: { gte: from } } }),
      db.deviceClaim.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
      db.guest.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
      db.alert.count({ where: { organizationId: orgId, createdAt: { gte: from } } }),
    ]);

    return NextResponse.json({
      data: {
        range,
        timezone,
        from: from.toISOString(),
        to: now.toISOString(),
        counts: {
          devices,
          activity,
          notifications,
          break: breakCount,
          screenshot,
          registration,
          usb,
          projectTime,
          deviceClaim,
          guest: guestCount,
          alert: alertCount,
          total: devices + activity + notifications + breakCount + screenshot + registration + usb + projectTime + deviceClaim + guestCount + alertCount,
        },
      },
    });
  } catch (error) {
    console.error('Event stats GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch event statistics' }, { status: 500 });
  }
}

function emptyStats() {
  return NextResponse.json({
    data: {
      range: 'today',
      timezone: 'UTC',
      from: null,
      to: new Date().toISOString(),
      counts: { devices: 0, activity: 0, notifications: 0, break: 0, screenshot: 0, registration: 0, usb: 0, projectTime: 0, deviceClaim: 0, guest: 0, alert: 0, total: 0 },
    },
  });
}
