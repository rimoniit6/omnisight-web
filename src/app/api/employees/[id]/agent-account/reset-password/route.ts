'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { resetAgentAccountPassword, toPublicAccount } from '@/lib/agent-account';
import { log, requestContext } from '@/lib/logger';

// POST /api/employees/[id]/agent-account/reset-password
// Admin can reset an AgentAccount's password. Body: { "password": "..." }
// Validates strength, bcrypt-hashes, clears lockout, updates passwordChangedAt.
// Returns the safe account shape — never the password or hash.
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
  const { password } = body as { password?: unknown };

  if (typeof password !== 'string' || password.length === 0) {
    return NextResponse.json({ error: 'Password is required' }, { status: 400 });
  }

  const employee = await db.employee.findFirst({
    where: { id, organizationId: admin.organizationId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      agentAccount: { select: { id: true, agentId: true, status: true, passwordChangedAt: true } },
    },
  });
  if (!employee) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
  }
  if (!employee.agentAccount) {
    return NextResponse.json({ error: 'No agent account exists for this employee' }, { status: 404 });
  }

  try {
    // "Set up Agent Account" flow: a migrated placeholder account (disabled
    // with passwordChangedAt === null — backfilled without a real credential)
    // is ACTIVATED by the same reset call. A deliberately disabled account
    // (passwordChangedAt set) stays disabled — the admin enables it explicitly.
    const isPlaceholder =
      employee.agentAccount.status === 'disabled' && employee.agentAccount.passwordChangedAt === null;
    const account = await resetAgentAccountPassword(employee.agentAccount.id, password, {
      activate: isPlaceholder,
    });

    await db.auditLog.create({
      data: {
        action: 'reset',
        resource: 'agent_account',
        resourceId: account.id,
        description: isPlaceholder
          ? `Agent account set up for ${employee.firstName} ${employee.lastName} (${account.agentId})`
          : `Agent account password reset for ${employee.firstName} ${employee.lastName} (${account.agentId})`,
        userId: admin.userId,
        organizationId: admin.organizationId,
        ipAddress: clientIp,
      },
    });

    return NextResponse.json({ data: account });
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'INVALID_PASSWORD') {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    log.error('api.employees.id.agent-account.reset-password.', { error: String('AgentAccount reset-password error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}