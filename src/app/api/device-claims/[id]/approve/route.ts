'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, SAFE_EMPLOYEE_SELECT } from '@/lib/api';
import { checkDeviceEntitlement } from '@/lib/device-entitlement';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { createOrgNotification } from '@/lib/notifications/service';
import { log, requestContext } from '@/lib/logger';

// POST /api/device-claims/[id]/approve
// Approve & Activate a device claim (admin-only, org-scoped).
//
//   { mode: "employee", employeeId, projectIds? }   (DEFAULT)
//     Binds the device to an EXISTING employee and activates it. The Employee
//     row keeps type = 'employee' (the default) and NO web account is created.
//

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(`device-claim:${clientIp}`, RATE_LIMITS.deviceClaimWrite.limit, RATE_LIMITS.deviceClaimWrite.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const { id } = await params;
    const body = await req.json();
    const { employeeId, projectIds } = body as {
      employeeId?: unknown;
      projectIds?: unknown;
    };

    const projects = Array.isArray(projectIds)
      ? [...new Set(projectIds.filter((p): p is string => typeof p === 'string' && p.length > 0))]
      : [];

    // Employee mode requires an explicit employee selection.
    if (typeof employeeId !== 'string' || employeeId.length === 0) {
      return NextResponse.json({ error: 'Employee selection is required' }, { status: 422 });
    }

    // V1 commercial device entitlement — server-authoritative enforcement.
    // MANAGED: rejected when the active-device count has reached the
    // subscription/plan entitlement. CUSTOMER_DB (and legacy PRIVATE) are
    // ALWAYS unlimited — this check can never cap them.
    const entitlement = await checkDeviceEntitlement(admin.organizationId);
    if (!entitlement.allowed) {
      return NextResponse.json(
        { error: entitlement.reason ?? 'Device entitlement reached', code: 'DEVICE_ENTITLEMENT_REACHED', currentCount: entitlement.currentCount, limit: entitlement.limit },
        { status: 403 }
      );
    }

    // Claim must be pending and inside the admin's organization (cross-org ids
    // are indistinguishable from missing ones → 404).
    const claim = await db.deviceClaim.findFirst({
      where: { id, organizationId: admin.organizationId },
      include: { device: true },
    });
    if (!claim) {
      return NextResponse.json({ error: 'Device claim not found' }, { status: 404 });
    }
    if (claim.status !== 'pending') {
      return NextResponse.json(
        { error: `Device claim is already "${claim.status}"` },
        { status: 400 }
      );
    }
    if (claim.expiresAt && claim.expiresAt < new Date()) {
      return NextResponse.json(
        { error: 'This device claim has expired. The device must re-register.' },
        { status: 422 }
      );
    }

    // Employee must exist in the SAME organization.
    const employee = await db.employee.findFirst({
      where: { id: employeeId as string, organizationId: admin.organizationId },
      include: { department: true },
    });
    if (!employee) {
      return NextResponse.json(
        { error: 'Selected employee does not exist in your organization' },
        { status: 422 }
      );
    }

    // Validate every project belongs to the org and is assignable.
    const validProjects = projects.length
      ? await db.project.findMany({
          where: {
            id: { in: projects },
            organizationId: admin.organizationId,
          },
        })
      : [];
    if (validProjects.length !== projects.length) {
      return NextResponse.json(
        { error: 'One or more selected projects do not exist in your organization' },
        { status: 422 }
      );
    }
    const badStatus = validProjects.find((p) => p.status === 'completed' || p.status === 'cancelled');
    if (badStatus) {
      return NextResponse.json(
        { error: `Project "${badStatus.name}" is not assignable (status: ${badStatus.status})` },
        { status: 422 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      // Serialize concurrent approvals for the SAME employee by taking a row
      // lock on the Employee row (SELECT ... FOR UPDATE).
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employee.id} FOR UPDATE`;

      // Re-check the entitlement inside the transaction so two concurrent
      // approvals cannot both squeeze through the pre-transaction check when
      // only ONE slot remains (last-slot race guard).
      const org = await tx.organization.findUnique({
        where: { id: admin.organizationId },
        select: { activeDeviceCount: true },
      });
      if (entitlement.limit !== null && (org?.activeDeviceCount ?? 0) >= entitlement.limit) {
        throw new Error('DEVICE_ENTITLEMENT_REACHED');
      }

      // Re-check the claim is STILL pending inside the transaction (guarded
      // updateMany instead of an unconditional update).
      const claimClaimed = await tx.deviceClaim.updateMany({
        where: { id: claim.id, status: 'pending' },
        data: {
          status: 'approved',
          employeeId: employee.id,
          approvedBy: admin.userId,
          approvedAt: new Date(),
        },
      });
      if (claimClaimed.count !== 1) {
        throw new Error('CLAIM_NOT_PENDING_ANYMORE');
      }

      // ONE ACTIVE DEVICE PER EMPLOYEE: deactivate the employee's other
      // active devices so the newly approved device becomes the sole active
      // device. Count how many were online so we can decrement activeDeviceCount.
      const deactivatedOnline = await tx.device.findMany({
        where: {
          organizationId: admin.organizationId,
          employeeId: employee.id,
          id: { not: claim.deviceId },
          status: 'online',
        },
        select: { id: true },
      });
      await tx.device.updateMany({
        where: {
          organizationId: admin.organizationId,
          employeeId: employee.id,
          id: { not: claim.deviceId },
          status: { in: ['online', 'offline'] },
        },
        data: { status: 'inactive' },
      });

      // Activate + bind the device.
      await tx.device.update({
        where: { id: claim.deviceId },
        data: {
          employeeId: employee.id,
          status: 'online',
          lastHeartbeat: new Date(),
        },
      });

      // Adjust activeDeviceCount: decrement for deactivated online devices,
      // increment for the newly approved device (net change may be zero).
      const netDelta = 1 - deactivatedOnline.length;
      if (netDelta !== 0) {
        await tx.organization.updateMany({
          where: { id: admin.organizationId },
          data: { activeDeviceCount: netDelta > 0 ? { increment: netDelta } : { decrement: -netDelta } },
        });
      }

      // Employee becomes agent-eligible (required by validateAgentToken).
      await tx.employee.update({
        where: { id: employee.id },
        data: { agentApproved: true },
      });

      // Assign projects via the EXISTING ProjectMember model.
      if (validProjects.length > 0) {
        for (const project of validProjects) {
          await tx.projectMember.upsert({
            where: { projectId_employeeId: { projectId: project.id, employeeId: employee.id } },
            update: { leftAt: null },
            create: {
              projectId: project.id,
              employeeId: employee.id,
              organizationId: admin.organizationId,
              role: 'member',
            },
          });
        }
      }

      // Audit log.
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'device',
          description: `Device "${claim.device.hostname || claim.device.name}" approved and assigned to ${employee.firstName} ${employee.lastName} (${employee.employeeId})${validProjects.length ? `, projects: ${validProjects.map((p) => p.name).join(', ')}` : ''}`,
          resourceId: claim.deviceId,
          userId: admin.userId,
          ipAddress: clientIp,
          organizationId: admin.organizationId,
        },
      });

      // Notification (org preference honored; structured device linkage).
      await createOrgNotification(tx, {
        title: 'Device Approved',
        message: `Device "${claim.device.hostname || claim.device.name}" was approved and assigned to ${employee.firstName} ${employee.lastName}.`,
        type: 'security',
        priority: 'high',
        status: 'unread',
        entityType: 'device',
        entityId: claim.deviceId,
        employeeId: employee.id,
        deviceId: claim.deviceId,
        organizationId: admin.organizationId,
      });

      return tx.deviceClaim.findUnique({
        where: { id: claim.id },
        // Never include the full employee row — it carries agentPassword.
        include: { device: true, employee: { select: SAFE_EMPLOYEE_SELECT } },
      });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    // A claim that was concurrently rejected/revoked mid-approve is surfaced
    // as a 409 (not 500).
    if (error instanceof Error && error.message === 'CLAIM_NOT_PENDING_ANYMORE') {
      return NextResponse.json(
        { error: 'This device claim is no longer pending. Refresh and try again.' },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === 'CLAIM_EXPIRED') {
      return NextResponse.json(
        { error: 'This device claim has expired. The device must re-register.' },
        { status: 422 }
      );
    }
    if (error instanceof Error && error.message === 'DEVICE_ENTITLEMENT_REACHED') {
      return NextResponse.json(
        { error: 'Device entitlement reached. Increase the subscription\'s device quantity to enroll more devices.', code: 'DEVICE_ENTITLEMENT_REACHED' },
        { status: 403 }
      );
    }
    log.error('api.device-claims.id.approve.', { error: String('DeviceClaim approve error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to approve device' }, { status: 500 });
  }
}
