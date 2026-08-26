'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { Prisma } from '@prisma/client';
import { log, requestContext } from '@/lib/logger';
import {
  createAgentAccount,
  setAgentAccountStatus,
  verifyAgentCredential,
  getAgentAccountByEmployee,
  toPublicAccount,
} from '@/lib/agent-account';

// GET /api/employees/[id]/agent-account
// Returns the safe account shape, or { data: null } when no account exists.
// Admin+ only — lockout/status information is management-sensitive.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdminOrg(req);
  if (!admin.ok) return authError(admin);

  const { id } = await params;
  const employee = await db.employee.findFirst({
    where: { id, organizationId: admin.organizationId },
    select: { id: true, agentAccount: { select: { id: true, agentId: true, status: true, lastLoginAt: true, failedLoginCount: true, lockedUntil: true, passwordChangedAt: true, createdAt: true, updatedAt: true } } },
  });
  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
  }
  if (!employee.agentAccount) {
    return NextResponse.json({ data: null });
  }
  return NextResponse.json({ data: employee.agentAccount });
}

// POST /api/employees/[id]/agent-account
// Create an AgentAccount for an employee (admin+ only, org-scoped).
// Body: { password }
// Optional: { agentId } — defaults to the employee's Employee.employeeId.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdminOrg(req);
  if (!admin.ok) return authError(admin);

  const clientIp = getClientIpFromHeaders(req.headers);
  const rl = await checkRateLimit(`agent-account-write:${clientIp}`, RATE_LIMITS.agentAccountWrite.limit, RATE_LIMITS.agentAccountWrite.windowMs);
  if (!rl.allowed) {
    return NextResponse.json({ error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` }, { status: 429 });
  }

  const { id } = await params;
  const body = await req.json();
  const { password, agentId } = body as { password?: unknown; agentId?: unknown };

  if (typeof password !== 'string' || password.length === 0) {
    return NextResponse.json({ error: 'Password is required' }, { status: 400 });
  }

  // Validate agentId format if supplied (never trusted blindly — verified server-side).
  if (agentId !== undefined && (typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 64)) {
    return NextResponse.json({ error: 'Agent ID must be 1-64 characters' }, { status: 400 });
  }

  // Employee must exist in the admin's organization.
  const employee = await db.employee.findFirst({
    where: { id, organizationId: admin.organizationId },
    select: { id: true, employeeId: true, firstName: true, lastName: true },
  });
  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
  }

  // Check for existing account BEFORE attempting create (cleaner error message than P2002).
  const existing = await db.agentAccount.findUnique({ where: { employeeId: employee.id } });
  if (existing) {
    return NextResponse.json({ error: 'Agent account already exists for this employee' }, { status: 409 });
  }

  try {
    const account = await createAgentAccount({
      employeeId: employee.id,
      agentId: typeof agentId === 'string' && agentId.trim().length > 0 ? agentId.trim() : undefined,
      password,
    });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'agent_account',
        resourceId: account.id,
        description: `Agent account created for ${employee.firstName} ${employee.lastName} (${account.agentId})`,
        userId: admin.userId,
        organizationId: admin.organizationId,
        ipAddress: clientIp,
      },
    });

    return NextResponse.json({ data: account }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'INVALID_PASSWORD') {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // P2002 — duplicate agentId (race condition after pre-check)
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined) ?? [];
      if (target.includes('agentId')) {
        return NextResponse.json({ error: 'This agent ID is already in use. Try a different ID.' }, { status: 409 });
      }
      return NextResponse.json({ error: 'Agent account already exists for this employee' }, { status: 409 });
    }
    log.error('api.employees.id.agent-account.', { error: String('AgentAccount POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create agent account' }, { status: 500 });
  }
}

// PATCH /api/employees/[id]/agent-account
// Update status: { "status": "active" | "disabled" }
// Only the status field is accepted — all other fields are silently ignored.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdminOrg(req);
  if (!admin.ok) return authError(admin);

  const clientIp = getClientIpFromHeaders(req.headers);
  const rl = await checkRateLimit(`agent-account-write:${clientIp}`, RATE_LIMITS.agentAccountWrite.limit, RATE_LIMITS.agentAccountWrite.windowMs);
  if (!rl.allowed) {
    return NextResponse.json({ error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` }, { status: 429 });
  }

  const { id } = await params;
  const body = await req.json();
  const { status } = body as { status?: unknown };

  if (status !== 'active' && status !== 'disabled') {
    return NextResponse.json({ error: 'Status must be "active" or "disabled"' }, { status: 400 });
  }

  const employee = await db.employee.findFirst({
    where: { id, organizationId: admin.organizationId },
    select: { id: true, firstName: true, lastName: true, agentAccount: { select: { id: true } } },
  });
  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
  }
  if (!employee.agentAccount) {
    return NextResponse.json({ error: 'No agent account exists for this employee' }, { status: 404 });
  }

  const account = await setAgentAccountStatus(employee.agentAccount.id, status as 'active' | 'disabled');

  await db.auditLog.create({
    data: {
      action: 'update',
      resource: 'agent_account',
      resourceId: account.id,
      description: `Agent account ${status === 'active' ? 'enabled' : 'disabled'} for ${employee.firstName} ${employee.lastName} (${account.agentId})`,
      userId: admin.userId,
      organizationId: admin.organizationId,
      ipAddress: clientIp,
    },
  });

  return NextResponse.json({ data: account });
}