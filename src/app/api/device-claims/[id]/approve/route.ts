'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, SAFE_EMPLOYEE_SELECT } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { createOrgNotification } from '@/lib/notifications/service';
import {
  createGuestBackedEmployee,
  grantGuestMonitoringConsents,
  resolveGuestPendingLimit,
} from '@/lib/guests';

// POST /api/device-claims/[id]/approve
// Approve & Activate a zero-touch device claim (admin-only, org-scoped).
//
// Two strongly-typed modes:
//
//   { mode: "employee", employeeId, projectIds? }   (DEFAULT — existing flow)
//     Binds the device to an EXISTING employee and activates it.
//
//   { mode: "guest" }
//     Creates a NEW person-level Guest enrollment backed by a synthesized
//     Employee row (Employee.type = 'guest') so every existing runtime
//     mechanism (AgentToken, AgentSession, Consent, telemetry, config,
//     heartbeat) works unchanged. NO employeeId is required and NO AgentAccount
//     is created. Monitoring consent (monitoring + activity_tracking) is
//     AUTO-GRANTED at approval, bound to the org's current published policies
//     — a guest has no employee portal, so the approving admin is the consent
//     authority. Types without a published policy are skipped (fail-closed).
//
// Guest approval transaction (atomic, serialized per device):
//   1. Authenticate admin + org scope.
//   2. Lock the Device row FOR UPDATE (serializes concurrent approvals for
//      the same device — the existing Employee lock pattern doesn't apply
//      because a guest has no pre-existing employee).
//   3. Re-read the claim under the lock; verify it is still PENDING and not
//      expired.
//   4. Verify the Device belongs to the admin's organization.
//   5. Verify no ACTIVE/PENDING Guest already owns the Device (the partial
//      unique indexes Guest_one_active_per_device / Guest_one_pending_per_device
//      are the DB backstop).
//   6. Verify the org's pending-guest cap is not reached.
//   7. Guarded claim update (pending → approved) — a concurrent approve of
//      the same claim matches zero rows and surfaces the existing 409.
//   8. Create Guest + guest-backed Employee; link Guest ↔ Employee; bind the
//      Device; set agentApproved (required by validateAgentToken / PATH A).
//   9. Auto-grant monitoring consent (via the audited state machine, bound to
//      the current published policies — see grantGuestMonitoringConsents).
//  10. Write audit log + notification.
//
// Approval means "this person/device is enrolled AND consented to standard
// monitoring". Only the two standard monitoring types are auto-granted;
// screenshot/keystroke/location/etc. remain separate, deliberate grants.
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
    const { mode, employeeId, projectIds } = body as {
      mode?: unknown;
      employeeId?: unknown;
      projectIds?: unknown;
    };
    const approvalMode = mode === 'guest' ? 'guest' : 'employee';

    const projects = Array.isArray(projectIds)
      ? [...new Set(projectIds.filter((p): p is string => typeof p === 'string' && p.length > 0))]
      : [];

    // Employee mode requires an explicit employee selection (existing contract).
    if (approvalMode === 'employee' && (typeof employeeId !== 'string' || employeeId.length === 0)) {
      return NextResponse.json({ error: 'Employee selection is required' }, { status: 422 });
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

    // ── EMPLOYEE MODE (existing behavior, unchanged) ───────────────────────
    if (approvalMode === 'employee') {
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
        // lock on the Employee row (SELECT ... FOR UPDATE). On PostgreSQL two
        // parallel approvals can otherwise interleave: each passes the pending
        // pre-check, then both activate their own device while deactivating
        // "the other active device" that neither has committed yet — leaving
        // TWO active devices. Locking the employee row forces strict ordering:
        // the second transaction waits, then sees the first device as online
        // and deactivates it. (On SQLite the single-writer lock masked this;
        // PG exposes real concurrency.)
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employee.id} FOR UPDATE`;

        // Re-check the claim is STILL pending inside the transaction (guarded
        // updateMany instead of an unconditional update): if a concurrent
        // reject/revoke of this same claim landed between the pre-check above
        // and now, we must NOT overwrite the newer state.
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
        // device. Their bound AgentTokens immediately fail closed
        // (validateAgentToken rejects non-online/offline devices).
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

        // Employee becomes agent-eligible (same semantics as the legacy
        // registration approval — required by validateAgentToken).
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
            description: `Zero-touch device "${claim.device.hostname || claim.device.name}" approved and assigned to ${employee.firstName} ${employee.lastName} (${employee.employeeId})${validProjects.length ? `, projects: ${validProjects.map((p) => p.name).join(', ')}` : ''}`,
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
    }

    // ── GUEST MODE (new — no employee selection required) ──────────────────
    const deviceHostname = claim.device.hostname || claim.device.name || 'Device';

    // Defensive: the claim is org-scoped, so the bound device belongs to the
    // same org by construction — assert it so the invariant is explicit.
    if (claim.device.organizationId !== admin.organizationId) {
      return NextResponse.json({ error: 'Device claim not found' }, { status: 404 });
    }

    const result = await db.$transaction(async (tx) => {
      // Serialize concurrent approvals for THIS device by locking the Device
      // row (the guest has no pre-existing Employee row to lock). The second
      // transaction waits, then its guarded claim update matches zero rows.
      await tx.$queryRaw`SELECT id FROM "Device" WHERE id = ${claim.deviceId} FOR UPDATE`;

      // Serialize the per-org guest cap across DIFFERENT devices: two
      // concurrent approvals for distinct devices each lock their own Device
      // row, so without this both could read the same below-cap count and
      // both pass. Locking the Organization row serializes ALL guest
      // approvals in the org — the cap can never be bypassed by concurrency
      // (and normal employee approval is a separate code path, unaffected).
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${admin.organizationId} FOR UPDATE`;

      // Re-read the claim under the lock — the pre-transaction snapshot may be
      // stale (TOCTOU guard, same pattern as discover).
      const lockedClaim = await tx.deviceClaim.findFirst({
        where: { id: claim.id, organizationId: admin.organizationId },
        include: { device: true },
      });
      if (!lockedClaim || lockedClaim.status !== 'pending') {
        throw new Error('CLAIM_NOT_PENDING_ANYMORE');
      }
      if (lockedClaim.expiresAt && lockedClaim.expiresAt < new Date()) {
        throw new Error('CLAIM_EXPIRED');
      }
      if (lockedClaim.device.organizationId !== admin.organizationId) {
        throw new Error('CLAIM_NOT_PENDING_ANYMORE');
      }

      // No ACTIVE or PENDING guest may already own this device (the partial
      // unique indexes are the concurrency backstop).
      const existingGuest = await tx.guest.findFirst({
        where: {
          deviceId: lockedClaim.deviceId,
          status: { in: ['ACTIVE', 'PENDING'] },
        },
        select: { id: true },
      });
      if (existingGuest) {
        throw new Error('GUEST_ALREADY_EXISTS');
      }

      // Per-org guest enrollment cap (org-scoped, configurable, NEVER affects
      // employee enrollment). Guest rows are created at approval (status
      // ACTIVE) — "pending" guests are pending DeviceClaims whose eventual
      // mode is unknown until the admin decides — so the cap counts existing
      // guest enrollments (ACTIVE/SUSPENDED) to bound guest population.
      const guestLimit = await resolveGuestPendingLimit(admin.organizationId);
      const guestCount = await tx.guest.count({
        where: { organizationId: admin.organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      });
      if (guestCount >= guestLimit) {
        throw new Error('GUEST_PENDING_LIMIT_REACHED');
      }

      // Guarded claim transition — exactly one concurrent approver wins.
      const claimClaimed = await tx.deviceClaim.updateMany({
        where: { id: lockedClaim.id, status: 'pending' },
        data: {
          status: 'approved',
          approvedBy: admin.userId,
          approvedAt: new Date(),
        },
      });
      if (claimClaimed.count !== 1) {
        throw new Error('CLAIM_NOT_PENDING_ANYMORE');
      }

      // Create Guest + synthesized guest-backed Employee (type = 'guest'),
      // link them, and bind the device. No AgentAccount. Monitoring consent is
      // auto-granted below (a guest has no employee portal to consent from, so
      // the approving admin is the consent authority).
      const { guest, employee } = await createGuestBackedEmployee(tx, {
        organizationId: admin.organizationId,
        deviceId: lockedClaim.deviceId,
        deviceHostname,
        approvedBy: admin.userId,
      });

      // Consent is NOT bypassed: each type goes through the shared audited
      // state machine and binds to the org's CURRENT published policy version
      // (same semantics as the Consent page bulk-grant). Types without a
      // published policy are skipped — collection stays fail-closed for them.
      const grantedConsents = await grantGuestMonitoringConsents(tx, {
        employeeId: employee.id,
        organizationId: admin.organizationId,
        performedBy: admin.email,
      });

      await tx.device.update({
        where: { id: lockedClaim.deviceId },
        data: {
          employeeId: employee.id,
          status: 'online',
          lastHeartbeat: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'guest_approved',
          resource: 'guest',
          resourceId: guest.id,
          description: `Device "${deviceHostname}" approved as GUEST (${employee.employeeId}) — enrolled without employee credentials; monitoring consent auto-granted${grantedConsents.length ? ` (${grantedConsents.join(', ')})` : ' (none: no published policies)'}`,
          userId: admin.userId,
          ipAddress: clientIp,
          organizationId: admin.organizationId,
        },
      });

      await createOrgNotification(tx, {
        title: 'Guest Approved',
        message: `Device "${deviceHostname}" was approved as a guest and is now active.`,
        type: 'security',
        priority: 'high',
        status: 'unread',
        entityType: 'guest',
        entityId: guest.id,
        employeeId: employee.id,
        deviceId: lockedClaim.deviceId,
        organizationId: admin.organizationId,
      });

      return tx.guest.findUnique({
        where: { id: guest.id },
        // Never include the full employee row — it carries agentPassword.
        include: { device: true, employee: { select: SAFE_EMPLOYEE_SELECT } },
      });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    // A claim that was concurrently rejected/revoked mid-approve is surfaced
    // as a 409 (not 500) — the caller can re-read the claim and react.
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
    if (error instanceof Error && error.message === 'GUEST_ALREADY_EXISTS') {
      return NextResponse.json(
        { error: 'This device is already enrolled as a guest.' },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === 'GUEST_PENDING_LIMIT_REACHED') {
      return NextResponse.json(
        { error: 'The guest enrollment limit for this organization has been reached. Revoke or convert existing guests first.' },
        { status: 422 }
      );
    }
    console.error('DeviceClaim approve error:', error);
    return NextResponse.json({ error: 'Failed to approve device' }, { status: 500 });
  }
}
