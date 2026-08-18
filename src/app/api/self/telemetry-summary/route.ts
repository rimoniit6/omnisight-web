import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { excludeInternalAgentActivities } from '@/lib/agent-process';

// GET /api/self/telemetry-summary?employeeId=xxx
// Manager+ role (enforced by the proxy); employee scoped to caller's org.
//
// Lightweight summary of the four telemetry capabilities for the Employee
// Portal Overview. Every metric is gated INDEPENDENTLY on the employee's
// active consent AND the org monitoring config — a revoked consent or a
// disabled flag returns `available: false` so the UI can show the real state
// instead of fabricating or leaking data. Raw telemetry (full panels) lives
// in Employee Details; this endpoint never returns raw keyboard data, full
// URLs, or webcam frames.

const DAYS = 30;

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

    const orgId = scoped.organizationId;

    // Consent + config gates — evaluated once, applied to every metric below.
    const [consent, monitoring] = await Promise.all([
      Promise.all([
        hasActiveConsent(employeeId, 'activity_tracking'),
        hasActiveConsent(employeeId, 'keystroke'),
        hasActiveConsent(employeeId, 'location'),
        hasActiveConsent(employeeId, 'webcam_access'),
      ]),
      resolveOrgMonitoring(orgId),
    ]);
    const [activityConsent, keystrokeConsent, locationConsent, webcamConsent] = consent;

    const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    // ── Website (bare domains only — normalized server-side at ingestion) ──
    let topDomains: Array<{ domain: string; visits: number; totalSeconds: number; lastSeen: string }> = [];
    if (activityConsent && monitoring.website_tracking) {
      const rows = excludeInternalAgentActivities(
        await db.activity.findMany({
          where: { employeeId, type: 'website', timestamp: { gte: cutoff } },
          select: { url: true, duration: true, timestamp: true },
          orderBy: { timestamp: 'desc' },
          take: 500,
        })
      );
      const map = new Map<string, { domain: string; visits: number; totalSeconds: number; lastSeen: string }>();
      for (const r of rows) {
        if (!r.url) continue;
        const domain = r.url;
        const e = map.get(domain) ?? { domain, visits: 0, totalSeconds: 0, lastSeen: r.timestamp.toISOString() };
        e.visits += 1;
        e.totalSeconds += Math.max(0, r.duration);
        if (r.timestamp.toISOString() > e.lastSeen) e.lastSeen = r.timestamp.toISOString();
        map.set(domain, e);
      }
      topDomains = [...map.values()]
        .sort((a, b) => b.totalSeconds - a.totalSeconds)
        .slice(0, 5)
        .map((e) => ({ ...e, totalSeconds: Math.round(e.totalSeconds) }));
    }

    // ── Keyboard (aggregate only — never raw key data) ──
    let keyboard = { intervals: 0, totalKeystrokes: 0, totalActiveTypingSeconds: 0 };
    if (keystrokeConsent && monitoring.keystroke_logging_enabled) {
      const agg = await db.keyboardActivity.aggregate({
        where: { employeeId, intervalStart: { gte: cutoff } },
        _count: { id: true },
        _sum: { keystrokeCount: true, activeTypingSeconds: true },
      });
      keyboard = {
        intervals: agg._count.id,
        totalKeystrokes: agg._sum.keystrokeCount ?? 0,
        totalActiveTypingSeconds: agg._sum.activeTypingSeconds ?? 0,
      };
    }

    // ── Location (latest fix only — no history, no reverse geocoding) ──
    let latestLocation: { latitude: number; longitude: number; accuracy: number; recordedAt: string } | null = null;
    if (locationConsent && monitoring.location_tracking) {
      const latest = await db.locationEvent.findFirst({
        where: { employeeId },
        orderBy: { recordedAt: 'desc' },
        select: { latitude: true, longitude: true, accuracy: true, recordedAt: true },
      });
      if (latest) latestLocation = { ...latest, recordedAt: latest.recordedAt.toISOString() };
    }

    // ── Webcam (session state only — never frames) ──
    let webcamSession: { id: string; status: string; startedAt: string | null } | null = null;
    if (webcamConsent && monitoring.webcam_capture_enabled) {
      const session = await db.webcamSession.findFirst({
        where: { employeeId, status: 'active' },
        orderBy: { startedAt: 'desc' },
        select: { id: true, status: true, startedAt: true },
      });
      if (session) webcamSession = { ...session, startedAt: session.startedAt ? session.startedAt.toISOString() : null };
    }

    return NextResponse.json({
      data: {
        websites: {
          available: activityConsent && monitoring.website_tracking,
          consentGranted: activityConsent,
          configEnabled: monitoring.website_tracking,
          topDomains,
        },
        keyboard: {
          available: keystrokeConsent && monitoring.keystroke_logging_enabled,
          consentGranted: keystrokeConsent,
          configEnabled: monitoring.keystroke_logging_enabled,
          ...keyboard,
        },
        location: {
          available: locationConsent && monitoring.location_tracking,
          consentGranted: locationConsent,
          configEnabled: monitoring.location_tracking,
          latest: latestLocation,
        },
        webcam: {
          available: webcamConsent && monitoring.webcam_capture_enabled,
          consentGranted: webcamConsent,
          configEnabled: monitoring.webcam_capture_enabled,
          session: webcamSession,
        },
      },
    });
  } catch (error) {
    console.error('Self telemetry-summary GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch telemetry summary' }, { status: 500 });
  }
}
