'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, SAFE_EMPLOYEE_SELECT } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { createOrgNotification } from '@/lib/notifications/service';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent-registrations/[id]/reject
// Reject a pending agent registration (admin-only, org-scoped).
// Rate-limited per IP — same class of admin write as the claims reject route.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `agent-registration:${clientIp}`,
      RATE_LIMITS.agentRegistrationWrite.limit,
      RATE_LIMITS.agentRegistrationWrite.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const { id } = await params;
    const body = await req.json();
    const { reason } = body as { reason?: string };

    // Resolve the registration INSIDE the caller's organization only.
    const registration = await db.agentRegistration.findFirst({
      where: { id, organizationId: admin.organizationId },
      // Employee fields are used for the audit description only — never load
      // the full row (it carries agentPassword).
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeId: true } },
      },
    });

    if (!registration) {
      return NextResponse.json(
        { error: 'Registration not found' },
        { status: 404 }
      );
    }

    // Verify status is pending
    if (registration.status !== 'pending') {
      return NextResponse.json(
        { error: `Registration is already "${registration.status}"` },
        { status: 400 }
      );
    }

    const updatedRegistration = await db.$transaction(async (tx) => {
      // Update registration status to rejected with reason
      await tx.agentRegistration.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectionReason: reason || null,
        },
      });

      // Create a notification about the rejection (org preference honored).
      await createOrgNotification(tx, {
        title: 'Agent Registration Rejected',
        message: `Agent registration for ${registration.employee.firstName} ${registration.employee.lastName} (${registration.employee.employeeId}) has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
        type: 'security',
        priority: 'medium',
        status: 'unread',
        organizationId: registration.organizationId,
        employeeId: registration.employeeId,
      });

      // Create an audit log entry
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device',
          description: `Agent registration rejected for ${registration.employee.firstName} ${registration.employee.lastName} (${registration.employee.employeeId}) on device "${registration.hostname}"${reason ? `. Reason: ${reason}` : ''}`,
          resourceId: registration.employeeId,
          organizationId: registration.organizationId,
        },
      });

      // Return the updated registration with employee data. Never include the
      // full employee row — it carries agentPassword.
      return tx.agentRegistration.findUnique({
        where: { id },
        include: { employee: { select: SAFE_EMPLOYEE_SELECT } },
      });
    });

    return NextResponse.json({
      success: true,
      data: updatedRegistration,
    });
  } catch (error) {
    log.error('api.agent-registrations.id.reject.', { error: String('AgentRegistration reject error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to reject registration' },
      { status: 500 }
    );
  }
}
