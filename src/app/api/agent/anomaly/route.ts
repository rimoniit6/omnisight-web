import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import {
  anomalyDedupeKey,
  stringifyAnomalyMetadata,
  MetadataTooLargeError,
  isValidAnomalyType,
  isValidAnomalySeverity,
  isValidAnomalyScore,
  isValidAnomalyConfidence,
} from '@/lib/anomalies/constants';
import { createOrgAlert, createOrgNotification } from '@/lib/notifications/service';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/anomaly — Agent reports an anomaly detected on the endpoint.
//
// Authentication uses the SAME canonical validateAgentToken() as every other
// protected agent route (signature, expiration, revocation, agent-approval,
// employee active state, AgentAccount status, device-active state) — there is
// no weaker bespoke token check here. Employee, organization and device are
// ALL server-derived from the token; a client-supplied deviceId is ignored so
// an anomaly can never be attributed to a foreign device.
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json(
        { error: authResult.error ?? 'Authentication required' },
        { status: 401 }
      );
    }
    const employee = authResult.employee!;

    const body = await req.json();
    const { type, severity, title, description, score, confidence, metadata } = body as {
      type: string;
      severity?: string;
      title: string;
      description: string;
      score?: number;
      confidence?: number;
      metadata?: Record<string, unknown>;
      deviceId?: string; // ACCEPTED BUT IGNORED — device attribution is server-derived
    };

    if (!type || !title || !description) {
      return NextResponse.json({ error: 'type, title, and description required' }, { status: 400 });
    }

    // F-12: canonical enum + bounds validation — a malicious agent must not be
    // able to store arbitrary type strings (they would pollute the stats
    // buckets and break the UI TYPE_CONFIG fallback) or out-of-range scores.
    // Unknown type/severity values are rejected outright (422) rather than
    // silently coerced, matching the manual POST route's contract.
    if (!isValidAnomalyType(type)) {
      return NextResponse.json({ error: `type must be one of the supported anomaly types` }, { status: 422 });
    }
    const validSeverity = isValidAnomalySeverity(severity)
      ? severity
      : 'medium';
    const validScore =
      typeof score === 'number' && isValidAnomalyScore(score)
        ? score
        : 50;

    // F-16: agent-supplied metadata is size-bounded at the boundary.
    let serializedMetadata: string | null = null;
    try {
      serializedMetadata = stringifyAnomalyMetadata(metadata);
    } catch (error) {
      if (error instanceof MetadataTooLargeError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }

    // Organization + employee + device are derived from the authenticated
    // agent token — never from the request body.
    const orgId = employee.organizationId;
    const deviceId = authResult.deviceId ?? null;

    // Use the agent-reported confidence when valid; otherwise derive a
    // deterministic value from the reported score — never a fixed constant.
    const validConfidence =
      typeof confidence === 'number' && isValidAnomalyConfidence(confidence)
        ? confidence
        : Math.min(0.95, 0.5 + validScore / 200);

    // F-14: the unique dedupeKey prevents same-org+employee+type spam within
    // the day bucket (and races) — a duplicate report is acknowledged, not
    // stored again. The day bucket rolls over so legitimate next-day reports
    // still land.
    const dedupeKey = anomalyDedupeKey(orgId, employee.id, type, new Date());

    // Create anomaly + alert + notification atomically
    try {
      const anomaly = await db.$transaction(async (tx) => {
        const created = await tx.anomaly.create({
          data: {
            type,
            severity: validSeverity,
            status: 'detected',
            title,
            description,
            score: validScore,
            confidence: validConfidence,
            employeeId: employee.id,
            deviceId,
            metadata: serializedMetadata,
            dedupeKey,
            organizationId: orgId,
          },
        });

        // Auto-create alert for critical/high
        if (validSeverity === 'critical' || validSeverity === 'high') {
          await createOrgAlert(tx, {
            title: `Agent Anomaly: ${title}`,
            description,
            type: 'security',
            severity: validSeverity === 'critical' ? 'critical' : 'error',
            status: 'pending',
            source: 'agent',
            metadata: { anomalyId: created.id, employeeId: employee.id },
            employeeId: employee.id,
            deviceId,
            organizationId: orgId,
          });

          // F-10: deep-link metadata follows the app-wide notification
          // convention (actionUrl '/anomalies' + entityType/entityId). Org
          // preference is honored via the shared service.
          await createOrgNotification(tx, {
            title: `Anomaly Detected: ${title}`,
            message: `${employee.firstName} ${employee.lastName}: ${description.substring(0, 100)}`,
            type: 'anomaly_detected',
            priority: validSeverity === 'critical' ? 'critical' : 'high',
            status: 'unread',
            actionUrl: '/anomalies',
            entityType: 'anomaly',
            entityId: created.id,
            employeeId: employee.id,
            deviceId,
            organizationId: orgId,
          });
        }

        return created;
      });

      return NextResponse.json({ success: true, anomalyId: anomaly.id, duplicate: false }, { status: 201 });
    } catch (error) {
      // F-14: a duplicate (or concurrent) report hit the unique dedupeKey.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json({ success: true, anomalyId: null, duplicate: true }, { status: 200 });
      }
      throw error;
    }
  } catch (error) {
    log.error('api.agent.anomaly.', { error: String('Agent anomaly POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to report anomaly' }, { status: 500 });
  }
}
