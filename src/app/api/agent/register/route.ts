import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getClientIp, verifyAgentPassword } from '@/lib/agent/auth';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { createOrgNotification } from '@/lib/notifications/service';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/register
// Windows agent calls this with employeeId + password + device info
// Creates a pending registration that admin must approve
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { employeeId, password, hostname, os, osVersion, processor, memory, macAddress, agentVersion } = body;

    // Validate required fields
    if (!employeeId || !password || !hostname) {
      return NextResponse.json(
        { error: 'Missing required fields: employeeId, password, hostname' },
        { status: 400 }
      );
    }

    // Rate limit per IP — agent credentials are the device binding gate
    const clientIp = getClientIp(req);
    const rl = await checkRateLimit(`agent-register:${clientIp}`, RATE_LIMITS.agentRegister.limit, RATE_LIMITS.agentRegister.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many registration attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    // Find employee by employeeId
    const employee = await db.employee.findFirst({
      where: { employeeId },
    });

    // Uniform 401 for every credential failure — an unknown employeeId, a
    // missing agent password, or a wrong password are indistinguishable
    // (no account enumeration).
    if (!employee) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Check if employee has a password set
    if (!employee.agentPassword) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Verify password (bcrypt, with legacy plaintext migration)
    const validPassword = await verifyAgentPassword(employee, password);
    if (!validPassword) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Check if employee is active
    if (employee.status !== 'active') {
      return NextResponse.json(
        { error: `Employee status is "${employee.status}". Contact your administrator.` },
        { status: 403 }
      );
    }

    // Check if already approved
    if (employee.agentApproved) {
      // Already approved — check if there's an existing registration to clean up
      const existingReg = await db.agentRegistration.findUnique({
        where: { employeeId: employee.id },
      });
      if (existingReg && existingReg.status === 'pending') {
        await db.agentRegistration.delete({ where: { id: existingReg.id } });
      }

      return NextResponse.json({
        success: true,
        message: 'Employee already approved. Use /api/agent/authenticate to get your token.',
        status: 'already_approved',
        employeeId: employee.employeeId,
        name: `${employee.firstName} ${employee.lastName}`,
      });
    }

    // Check if there's already a pending registration
    const existingPending = await db.agentRegistration.findUnique({
      where: { employeeId: employee.id },
    });

    if (existingPending && existingPending.status === 'pending') {
      // Update existing pending registration with new device info
      await db.agentRegistration.update({
        where: { id: existingPending.id },
        data: {
          hostname,
          operatingSystem: os || null,
          osVersion: osVersion || null,
          processor: processor || null,
          memory: memory || null,
          ipAddress: clientIp,
          macAddress: macAddress || null,
          agentVersion: agentVersion || null,
          deviceName: `${employee.firstName}'s ${os || 'PC'}`,
          updatedAt: new Date(),
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Registration updated. Waiting for admin approval.',
        status: 'pending',
        registrationId: existingPending.id,
        employeeId: employee.employeeId,
        name: `${employee.firstName} ${employee.lastName}`,
      });
    }

    // Create new pending registration + notification + alert + audit log atomically
    const registration = await db.$transaction(async (tx) => {
      const created = await tx.agentRegistration.create({
        data: {
          employeeId: employee.id,
          hostname,
          operatingSystem: os || null,
          osVersion: osVersion || null,
          processor: processor || null,
          memory: memory || null,
          ipAddress: clientIp,
          macAddress: macAddress || null,
          agentVersion: agentVersion || null,
          deviceName: `${employee.firstName}'s ${os || 'PC'}`,
          status: 'pending',
          organizationId: employee.organizationId,
        },
      });

      await createOrgNotification(tx, {
        title: 'New Agent Registration Request',
        message: `${employee.firstName} ${employee.lastName} (${employee.employeeId}) is requesting to register their device "${hostname}".`,
        type: 'security',
        priority: 'high',
        status: 'unread',
        employeeId: employee.id,
        organizationId: employee.organizationId,
      });

      await tx.alert.create({
        data: {
          title: 'Agent Registration Pending',
          description: `Employee ${employee.firstName} ${employee.lastName} (${employee.employeeId}) from IP ${clientIp} is requesting agent access on device "${hostname}" (${os || 'Unknown OS'}).`,
          type: 'security',
          severity: 'info',
          status: 'pending',
          source: 'agent',
          employeeId: employee.id,
          organizationId: employee.organizationId,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'device',
          description: `Agent registration requested by ${employee.firstName} ${employee.lastName} (${employee.employeeId}) from device "${hostname}"`,
          resourceId: employee.id,
          ipAddress: clientIp,
          organizationId: employee.organizationId,
        },
      });

      return created;
    });

    return NextResponse.json({
      success: true,
      message: 'Registration submitted. Waiting for admin approval.',
      status: 'pending',
      registrationId: registration.id,
      employeeId: employee.employeeId,
      name: `${employee.firstName} ${employee.lastName}`,
    }, { status: 201 });
  } catch (error) {
    log.error('api.agent.register.', { error: String('Agent register error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
