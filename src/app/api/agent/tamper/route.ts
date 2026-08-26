import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken, getClientIp } from '@/lib/agent/auth';
import { createOrgNotification, createOrgAlert, NotificationValidationError } from '@/lib/notifications/service';
import { ALERT_SEVERITIES } from '@/lib/notifications/constants';
import { serializeMetadata, validateDescription } from '@/lib/notifications/validation';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/tamper
// Agent reports tamper detection events
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    const body = await req.json();
    const { type, description, severity, metadata } = body as {
      type: string;
      description: string;
      severity?: string;
      metadata?: Record<string, unknown>;
    };

    const validTypes = ['agent_stopped', 'process_killed', 'screenshot_blocked', 'uninstall_attempt', 'config_changed', 'suspicious_activity'];
    if (!type || !validTypes.includes(type)) {
      return NextResponse.json({ error: 'Invalid tamper type' }, { status: 400 });
    }

    // N-7: severity must be canonical. The agent's legacy vocabulary
    // (high/medium/low) is normalized to the canonical Alert severity set
    // (error/warning/info); anything else is rejected — never persisted.
    const descErr = validateDescription(description);
    if (descErr) return NextResponse.json({ error: descErr }, { status: 422 });
    let canonicalSeverity: string;
    if (!severity) {
      canonicalSeverity = 'warning';
    } else if ((ALERT_SEVERITIES as readonly string[]).includes(severity)) {
      canonicalSeverity = severity;
    } else if (severity === 'high') {
      canonicalSeverity = 'error';
    } else if (severity === 'medium') {
      canonicalSeverity = 'warning';
    } else if (severity === 'low') {
      canonicalSeverity = 'info';
    } else {
      return NextResponse.json({ error: 'severity must be info, warning, error, or critical' }, { status: 422 });
    }

    let metadataJson: string | null;
    try {
      metadataJson = serializeMetadata(metadata);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 422 });
    }

    const orgId = authResult.employee!.organizationId;
    const employeeId = authResult.employee!.id;
    const employeeName = `${authResult.employee!.firstName} ${authResult.employee!.lastName}`;

    const alert = await db.$transaction(async (tx) => {
      // Create alert (N-7 validated severity, structured employee linkage).
      const created = await createOrgAlert(tx, {
        title: `Tamper: ${type.replace(/_/g, ' ')}`,
        description: description || `Tamper event: ${type}`,
        type: 'security',
        severity: canonicalSeverity,
        status: 'pending',
        source: 'agent',
        metadata: metadataJson ? (JSON.parse(metadataJson) as Record<string, unknown>) : null,
        employeeId,
        organizationId: orgId,
      });

      // Create notification (org preference honored via the shared service).
      await createOrgNotification(tx, {
        title: `Security: ${type.replace(/_/g, ' ')}`,
        message: `Tamper event for ${employeeName}: ${description || type}`,
        type: 'security',
        priority: canonicalSeverity === 'critical' ? 'critical' : canonicalSeverity === 'error' ? 'high' : 'medium',
        status: 'unread',
        employeeId,
        organizationId: orgId,
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'alert',
          description: `Tamper alert: ${type} for ${employeeId}`,
          resourceId: created.id,
          ipAddress: getClientIp(req),
          organizationId: orgId,
        },
      });

      return created;
    });

    return NextResponse.json({
      success: true,
      alertId: alert.id,
      message: 'Tamper event reported',
    });
  } catch (error) {
    if (error instanceof NotificationValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    log.error('api.agent.tamper.', { error: String('Tamper detection error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
