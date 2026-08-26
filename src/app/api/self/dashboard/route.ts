import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { safeTimezone, orgDayWindow, localDayKey, zonedDayStart, addDaysToKey, zonedDayOfWeek } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';

// GET /api/self/dashboard?employeeId=xxx
// Manager+ role (enforced by middleware); employee scoped to caller's org.
//
// Contract: returns the flat shape consumed by SelfPortalPage (DashboardData).
// Every numeric field is always present (0 when there is no activity data) so
// the UI never receives undefined for a number.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    // Tenant-scoped lookup: employee must belong to the caller's org
    const { employee: scoped, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !scoped) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    // Fetch employee with department
    const employee = await db.employee.findUnique({
      where: { id: scoped.id },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        avatar: true,
        designation: true,
        status: true,
        joinDate: true,
        leaveDate: true,
        organizationId: true,
        department: { select: { id: true, name: true } },
        organization: { select: { timezone: true } },
      },
    });

    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // ── Org-local day windows (P2-3) ──────────────────────────────────────
    // "today" / "this week" are the ORGANIZATION's calendar days — never the
    // server's local zone. Organization.timezone is the single source of truth
    // (the reference deployment defaults to Asia/Dhaka).
    const orgTz = safeTimezone(employee.organization?.timezone);
    const now = new Date();
    const { dayStart: todayStart, dayEnd: todayEnd } = orgDayWindow(orgTz, now);

    // Monday of the org-local week.
    const todayKey = localDayKey(now, orgTz);
    const dayOfWeek = zonedDayOfWeek(now, orgTz); // 0=Sun … 6=Sat
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayKey = addDaysToKey(todayKey, -daysSinceMonday);
    const weekStart = zonedDayStart(mondayKey, orgTz);

    const prevWeekEnd = new Date(weekStart.getTime() - 1);
    const prevWeekStart = zonedDayStart(addDaysToKey(mondayKey, -7), orgTz);

    // Load the FULL 14-day window (prev week + this week) in ONE round trip;
    // today, this week and the previous week are all derived from the same
    // rows — three queries became one.
    const windowActivities = excludeInternalAgentActivities(await db.activity.findMany({
      where: {
        employeeId: employee.id,
        timestamp: { gte: prevWeekStart, lte: todayEnd },
      },
      select: { duration: true, category: true, timestamp: true, applicationName: true },
    }));

    const weekActivities = windowActivities.filter(
      (a) => a.timestamp >= weekStart
    );

    const todayActivities = weekActivities.filter(
      (a) => a.timestamp >= todayStart && a.timestamp <= todayEnd
    );

    const todayTotalSeconds = todayActivities.reduce((sum, a) => sum + a.duration, 0);
    const todayProductive = todayActivities
      .filter((a) => a.category === 'productive')
      .reduce((sum, a) => sum + a.duration, 0);
    const todayUnproductive = todayActivities
      .filter((a) => a.category === 'unproductive')
      .reduce((sum, a) => sum + a.duration, 0);
    const todayNeutral = todayActivities
      .filter((a) => a.category === 'neutral')
      .reduce((sum, a) => sum + a.duration, 0);

    const weekTotalSeconds = weekActivities.reduce((sum, a) => sum + a.duration, 0);
    const weekProductive = weekActivities
      .filter((a) => a.category === 'productive')
      .reduce((sum, a) => sum + a.duration, 0);

    // Weekly productivity percentage (real data): productive share of total
    const weeklyProductivity = weekTotalSeconds > 0
      ? Math.round((weekProductive / weekTotalSeconds) * 100)
      : 0;

    // --- Previous full week (for productivityChange) — derived from the
    // same 14-day window query above. ---
    const prevWeekActivities = windowActivities.filter(
      (a) => a.timestamp >= prevWeekStart && a.timestamp <= prevWeekEnd
    );

    const prevWeekTotal = prevWeekActivities.reduce((sum, a) => sum + a.duration, 0);
    const prevWeekProductive = prevWeekActivities
      .filter((a) => a.category === 'productive')
      .reduce((sum, a) => sum + a.duration, 0);
    const prevWeekPct = prevWeekTotal > 0 ? (prevWeekProductive / prevWeekTotal) * 100 : 0;

    // Percentage-point change vs. the previous week (can be negative)
    const productivityChange = prevWeekTotal > 0
      ? +(weeklyProductivity - prevWeekPct).toFixed(1)
      : 0;

    // --- Device count, online status and names ---
    const devices = await db.device.findMany({
      where: { employeeId: employee.id },
      select: { id: true, name: true, status: true, lastHeartbeat: true },
    });

    const totalDevices = devices.length;
    // Live online status — heartbeat freshness, not the sticky status column.
    const onlineDevices = devices.filter((d) => effectiveDeviceStatus(d.status, d.lastHeartbeat) === 'online').length;
    const deviceNames = devices.map((d) => d.name).filter(Boolean);

    // --- Consent summary ---
    const allConsentTypes = [
      'monitoring',
      'screenshot',
      'activity_tracking',
      'keystroke',
      'usb_monitoring',
      'webcam_access',
      'location',
      'email_monitoring',
    ];

    const consents = await db.consent.findMany({
      where: { employeeId: employee.id },
      select: { consentType: true, status: true },
    });

    const grantedCount = consents.filter((c) => c.status === 'granted').length;
    const pendingCount = consents.filter((c) => c.status === 'pending').length;

    // Ensure all 8 types exist — count missing as pending
    const missingTypes = allConsentTypes.filter(
      (t) => !consents.some((c) => c.consentType === t)
    );
    const totalConsentTypes = 8;
    const effectivePending = pendingCount + missingTypes.length;

    // --- Recent anomalies (last 7 days) ---
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const recentAnomalyCount = await db.anomaly.count({
      where: {
        employeeId: employee.id,
        createdAt: { gte: sevenDaysAgo },
      },
    });

    return NextResponse.json({
      data: {
        employee: {
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          phone: employee.phone,
          avatar: employee.avatar,
          designation: employee.designation,
          status: employee.status,
          joinDate: employee.joinDate,
          department: employee.department?.name || null,
        },
        // Flat contract consumed by SelfPortalPage — seconds-based (UI divides by 3600)
        todayHours: todayTotalSeconds,
        productiveToday: todayProductive,
        unproductiveToday: todayUnproductive,
        weeklyProductivity,
        productivityChange,
        timeBreakdown: {
          productive: +((todayProductive / 3600)).toFixed(2),
          neutral: +((todayNeutral / 3600)).toFixed(2),
          unproductive: +((todayUnproductive / 3600)).toFixed(2),
        },
        deviceOnline: onlineDevices,
        deviceTotal: totalDevices,
        deviceNames,
        consentGranted: grantedCount,
        consentTotal: totalConsentTypes,
        consentPending: effectivePending,
        recentAnomalies: recentAnomalyCount,
      },
    });
  } catch (error) {
    log.error('api.self.dashboard.', { error: String('Self Dashboard GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch self dashboard' }, { status: 500 });
  }
}
