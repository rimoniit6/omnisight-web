import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { resolveOrgMonitoring, resolveRetentionDays } from '@/lib/jobs/settings';
import { APP_POLICY_VERSION_SETTING_KEY, DEFAULT_POLICY_VERSION, MAX_POLICY_PAYLOAD_ENTRIES } from '@/lib/policies/constants';
import { log, requestContext } from '@/lib/logger';

// GET /api/agent/config
// Agent fetches monitoring configuration (screenshot frequency, idle timeout, etc.)
//
// S-1 / MON-1: monitoring values resolve ONLY from the org-scoped
// OrganizationSetting table (via resolveOrgMonitoring, with deterministic
// defaults). There is NO global SystemSetting fallback and NO MonitoringPolicy
// dependency — Org A's configuration can never bleed into Org B. The
// organization's timezone (Organization.timezone) is the single source of
// truth for the agent's working-hours window (LM-5).
export async function GET(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    const orgId = authResult.employee!.organizationId;
    const employeeId = authResult.employee!.id;

    // Organization timezone — authoritative for the agent's working-hours
    // window. Falls back to UTC only when the org row is missing (never the
    // global SystemSetting).
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });

    // Full typed monitoring configuration from OrganizationSetting, applying
    // deterministic defaults for missing/corrupt stored values.
    const monitoring = await resolveOrgMonitoring(orgId);

    // Canonical break state for THIS employee (server-authoritative).
    const openBreak = await db.breakSession.findFirst({
      where: { employeeId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const breakState = {
      active: openBreak !== null,
      startedAt: openBreak ? openBreak.startedAt.toISOString() : null,
    };

    const config = {
      monitoring: {
        screenshotEnabled: monitoring.screenshot_enabled,
        screenshotFrequency: monitoring.screenshot_frequency, // minutes
        screenshotRetentionDays: await resolveRetentionDays(orgId, 'screenshot_retention_days'),
        appTrackingEnabled: monitoring.app_tracking,
        websiteTrackingEnabled: monitoring.website_tracking,
        // Telemetry expansion flags (fail-closed): each is org-scoped and
        // defaults false in the registry — the agent gates every collector on
        // config AND the matching consent type AND its own capability.
        locationTracking: monitoring.location_tracking,
        keystrokeLoggingEnabled: monitoring.keystroke_logging_enabled,
        webcamCaptureEnabled: monitoring.webcam_capture_enabled,
        // Agent-native (extension-free) website source — org-scoped, default
        // false (never silently enabled). Same Activity pipeline as the
        // extension; the agent additionally gates on activity_tracking consent.
        websiteNativeTracking: monitoring.website_native_tracking,
        idleDetectionEnabled: monitoring.idle_detection,
        idleTimeoutMinutes: monitoring.idle_timeout,
        workingHoursOnly: monitoring.working_hours_only,
        workStartTime: monitoring.work_start_time,
        workEndTime: monitoring.work_end_time,
        // LM-5: the org timezone drives the agent's working-hours window so the
        // agent never depends on the Windows machine's timezone.
        timezone: org?.timezone || 'UTC',    // Org-driven cadence (OrganizationSetting -> default), validated +
    // clamped server-side so the agent never sees a bad value.
    heartbeatInterval: monitoring.heartbeat_interval,
      },
      // Canonical break/privacy-mode state (server-authoritative). The agent
      // pauses every monitoring collector while `active` is true and resumes
      // on the next sync when it clears.
      break: breakState,
      features: {
        // Break/privacy mode is implemented end-to-end (server state → config
        // → agent collector pause/resume). Tamper detection remains
        // unimplemented by the agent — the flag stays false.
        breakModeEnabled: true,
        tamperDetectionEnabled: false,
        // Org-scoped USB monitoring flag (default false) — the agent may only
        // collect USB events when the org enables it AND the employee holds
        // usb_monitoring consent. Server re-enforces both on every upload.
        usbMonitoringEnabled: monitoring.usb_monitoring,
        // App policy enforcement (fail-closed, default false): when true the
        // agent monitors running processes against the org whitelist/blacklist
        // and reports violations. appPolicyTerminate additionally allows the
        // agent to TERMINATE blocked processes (destructive — explicit org
        // opt-in on top of enforcement).
        appPolicyEnforcement: monitoring.app_policy_enforcement,
        appPolicyTerminate: monitoring.app_policy_terminate,
      },
      limits: {
        maxScreenshotSize: 5 * 1024 * 1024, // 5MB
        maxActivitiesPerRequest: 100,
        maxBatchSize: 1000, // max activities in batch upload
      },
    };

    // ── App whitelist/blacklist policy payload (bounded, org-scoped) ──────
    // Only ACTIVE entries are shipped; identity fields that exist in the
    // schema are included. The version lets the agent detect unchanged/new/
    // stale policy without comparing full lists.
    const [policyRows, policyVersionRow] = await Promise.all([
      db.appListEntry.findMany({
        where: { organizationId: orgId, isActive: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_POLICY_PAYLOAD_ENTRIES,
        select: {
          id: true,
          appName: true,
          executableName: true,
          publisher: true,
          sha256: true,
          path: true,
          listType: true,
        },
      }),
      db.organizationSetting.findUnique({
        where: { organizationId_key: { organizationId: orgId, key: APP_POLICY_VERSION_SETTING_KEY } },
      }),
    ]);
    const policyVersion = policyVersionRow?.value ?? DEFAULT_POLICY_VERSION;

    const policy = {
      version: policyVersion,
      applications: policyRows.map((r) => ({
        id: r.id,
        listType: r.listType,
        appName: r.appName,
        executableName: r.executableName,
        publisher: r.publisher,
        sha256: r.sha256,
        path: r.path,
      })),
    };

    // ── Assignment display data (B.5: server is the single source of truth) ──
    // The employee's name, department and assigned projects are derived here
    // from the existing Employee -> Department and ProjectMember -> Project
    // relationships on every sync — the agent never stores a second conflicting
    // copy, so admin changes (e.g. reassign a department or remove a project)
    // are reflected on the agent's next config refresh.
    const employee = await db.employee.findUnique({
      where: { id: authResult.employee!.id },
      select: {
        employeeId: true,
        firstName: true,
        lastName: true,
        department: { select: { id: true, name: true } },
        projectMembers: {
          where: { leftAt: null },
          include: { project: { select: { id: true, name: true, status: true } } },
        },
      },
    });

    const assignment = {
      employeeId: employee?.employeeId ?? null,
      employeeName: employee ? `${employee.firstName} ${employee.lastName}` : null,
      department: employee?.department ? { id: employee.department.id, name: employee.department.name } : null,
      // Only assignable projects are surfaced (same rule as the approve dialog).
      projects: (employee?.projectMembers ?? [])
        .map((m) => m.project)
        .filter((p) => p.status === 'active' || p.status === 'on_hold')
        .map((p) => ({ id: p.id, name: p.name, status: p.status })),
    };

    return NextResponse.json({ config, assignment, policy });
  } catch (error) {
    log.error('api.agent.config.', { error: String('Agent config error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
