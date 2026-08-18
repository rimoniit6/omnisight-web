'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, SAFE_EMPLOYEE_SELECT } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { DEVICE_ELIGIBLE_STATUSES, ActiveDeviceConflictError } from '@/lib/agent/activation';
import { createOrgNotification } from '@/lib/notifications/service';

// POST /api/agent-registrations/[id]/approve
// Approve a pending agent registration (admin-only, org-scoped).
//
// Parity with the zero-touch claims approve path:
//   - Rate-limited per IP (same class of admin write as claim approve/reject).
//   - Enforces ONE ACTIVE DEVICE PER EMPLOYEE (the existing product rule from
//     src/lib/agent/activation.ts, shared with the zero-touch path): if the
//     employee already holds an eligible device, the approval fails with
//     409 ACTIVE_DEVICE_EXISTS and the enclosing transaction rolls back —
//     ZERO mutation (registration stays pending, no device, no notification).
//     (Deliberately NOT the zero-touch "deactivate the old device" behavior —
//     this legacy path predates it; a blocked admin resolves the conflict
//     explicitly, then re-approves.)
//   - The approval notification carries entityType/entityId so it links to the
//     created device like the claims-approve notification does.
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

    // Resolve the registration INSIDE the caller's organization. A
    // registration id from another org is indistinguishable from a missing
    // one (404), so cross-tenant ids can never be actioned.
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
      // Enforce the single-active-device rule BEFORE any write (shared rule +
      // error with the zero-touch path in src/lib/agent/activation.ts). The
      // Employee row is locked FOR UPDATE — the same serialization point the
      // zero-touch approve uses — so two concurrent approvals for the same
      // employee cannot both succeed. Any conflict throws and rolls back the
      // whole transaction: zero mutation.
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${registration.employeeId} FOR UPDATE`;
      const existingActiveDevice = await tx.device.findFirst({
        where: {
          organizationId: registration.organizationId,
          employeeId: registration.employeeId,
          status: { in: [...DEVICE_ELIGIBLE_STATUSES] },
        },
        select: { id: true },
      });
      if (existingActiveDevice) {
        throw new ActiveDeviceConflictError();
      }

      // Update registration status to approved
      await tx.agentRegistration.update({
        where: { id },
        data: { status: 'approved' },
      });

      // Update employee's agentApproved to true
      await tx.employee.update({
        where: { id: registration.employeeId },
        data: { agentApproved: true },
      });

      // Create a Device record using the registration's system info
      const device = await tx.device.create({
        data: {
          name: registration.deviceName || `${registration.employee.firstName}'s ${registration.operatingSystem || 'PC'}`,
          hostname: registration.hostname,
          operatingSystem: registration.operatingSystem,
          osVersion: registration.osVersion,
          processor: registration.processor,
          memory: registration.memory,
          ipAddress: registration.ipAddress,
          macAddress: registration.macAddress,
          agentVersion: registration.agentVersion,
          status: 'online',
          organizationId: registration.organizationId,
          employeeId: registration.employeeId,
        },
      });

      // Create a notification about the approval (org preference honored).
      await createOrgNotification(tx, {
        title: 'Agent Registration Approved',
        message: `Agent registration for ${registration.employee.firstName} ${registration.employee.lastName} (${registration.employee.employeeId}) has been approved. Device "${registration.hostname}" is now active.`,
        type: 'security',
        priority: 'high',
        status: 'unread',
        organizationId: registration.organizationId,
        entityType: 'device',
        entityId: device.id,
        employeeId: registration.employeeId,
        deviceId: device.id,
      });

      // Create an audit log entry
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device',
          description: `Agent registration approved for ${registration.employee.firstName} ${registration.employee.lastName} (${registration.employee.employeeId}) on device "${registration.hostname}"`,
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
    // Single-active-device conflict: the transaction rolled back (zero
    // mutation). Same error shape as the zero-touch claims approve route.
    if (error instanceof ActiveDeviceConflictError) {
      return NextResponse.json({ error: 'ACTIVE_DEVICE_EXISTS' }, { status: 409 });
    }
    console.error('AgentRegistration approve error:', error);
    return NextResponse.json(
      { error: 'Failed to approve registration' },
      { status: 500 }
    );
  }
}
