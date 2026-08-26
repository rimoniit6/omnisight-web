import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { validateAgentToken } from '@/lib/agent/auth';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { validatePolicyViolationInput, violationDedupeKey } from '@/lib/policies/validation';
import { createOrgNotification } from '@/lib/notifications/service';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/policy-violations
// Agent reports a real enforcement event: a running process matched a
// blacklist policy and was blocked (and, when the org enables termination,
// terminated).
//
// SECURITY:
//   - organizationId / employeeId / deviceId are ALWAYS derived from the
//     authenticated agent token — never from the client payload.
//   - Ingestion is gated on the org monitoring flag app_policy_enforcement
//     (fail closed): if the org disables enforcement, no violation rows can
//     be created by any agent.
//   - policyId must reference an ACTIVE policy row in the SAME organization —
//     a foreign or deactivated policy id is rejected (404 semantics, no leak).
//   - Duplicates (same device + policy + executable within the dedupe window)
//     are deduplicated at the DB level by the unique dedupeKey.
//   - Every violation is audit-logged with the server-derived employee and a
//     high-severity notification with deep-link metadata (entityType
//     'policy_violation', entityId, actionUrl '/policies').
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }
    const employee = authResult.employee!;
    const orgId = employee.organizationId;

    // Org config gate (fail closed): enforcement must be explicitly enabled.
    const monitoring = await resolveOrgMonitoring(orgId);
    if (monitoring.app_policy_enforcement !== true) {
      return NextResponse.json(
        { error: 'App policy enforcement is not enabled for this organization' },
        { status: 403 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validated = validatePolicyViolationInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 422 });
    }
    const input = validated.value;

    // The matched policy must exist and be ACTIVE in this organization. A
    // foreign/deactivated policy id is concealed identically to a missing one
    // (no cross-org information leak).
    const policy = await db.appListEntry.findFirst({
      where: { id: input.policyId, organizationId: orgId, isActive: true },
      select: { id: true, appName: true, listType: true },
    });
    if (!policy) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    const occurredAt = input.occurredAt ?? new Date();
    const dedupeKey = violationDedupeKey({
      organizationId: orgId,
      deviceId: authResult.deviceId ?? null,
      policyId: input.policyId,
      executableName: input.executableName,
      occurredAt,
    });

    try {
      const created = await db.$transaction(async (tx) => {
        const row = await tx.policyViolation.create({
          data: {
            organizationId: orgId,
            employeeId: employee.id,
            deviceId: authResult.deviceId ?? null,
            policyId: input.policyId,
            executableName: input.executableName,
            processPath: input.processPath,
            action: 'blocked',
            severity: input.severity,
            metadata:
              Object.keys(input.metadata).length > 0
                ? (input.metadata as unknown as Prisma.InputJsonValue)
                : undefined,
            dedupeKey,
            occurredAt,
          },
        });

        // Auditable event — bound to the server-derived actor (employee).
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'policy_violation',
            resourceId: row.id,
            description: `Blocked process ${input.executableName} (matched blacklist policy "${policy.appName}") for ${employee.firstName} ${employee.lastName}`,
            userId: null, // agent-initiated — actor is the employee via employeeId metadata
            organizationId: orgId,
          },
        });

        // High-value violations (high/critical) generate a notification with
        // the app-wide deep-link convention. Org preference is honored via
        // the shared service; structured employee linkage is populated.
        if (input.severity === 'high' || input.severity === 'critical') {
          await createOrgNotification(tx, {
            title: `Policy Violation: ${policy.appName} blocked`,
            message: `${employee.firstName} ${employee.lastName}: ${input.executableName} was blocked by the app policy.`,
            type: 'policy_violation',
            priority: input.severity === 'critical' ? 'critical' : 'high',
            status: 'unread',
            actionUrl: '/policies',
            entityType: 'policy_violation',
            entityId: row.id,
            employeeId: employee.id,
            organizationId: orgId,
          });
        }

        return row;
      });

      return NextResponse.json({ success: true, violationId: created.id, duplicate: false }, { status: 201 });
    } catch (error) {
      // DB-level dedupe: an identical violation within the window (or a
      // concurrent duplicate) hits the unique dedupeKey — no-op success.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json({ success: true, violationId: null, duplicate: true }, { status: 200 });
      }
      throw error;
    }
  } catch (error) {
    log.error('api.agent.policy-violations.', { error: String('Agent policy-violation POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to report policy violation' }, { status: 500 });
  }
}
