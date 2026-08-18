import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createAgentSession } from '@/lib/agent/session';
import { verifyAgentCredential } from '@/lib/agent-account';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { getUserAgent } from '@/lib/session';

// POST /api/agent/login
// Agent authentication using the Admin-created AgentAccount credentials.
// The employee receives their Agent ID + password from the Admin and enters
// them into the OmniSight Agent EXE. The server resolves the Employee +
// Organization from the verified AgentAccount — NEVER from client input.
//
// On success it issues a SHORT-LIVED AgentSession. The session is NOT a device
// credential: it only authorizes the authenticated branch of
// POST /api/agent/discover (and logout). Reusing the 24h device-bound
// AgentToken here would wrongly grant a not-yet-approved device access to
// heartbeat/activity/screenshot, so the token types are deliberately separate.
//
// CRITICAL: uniform 401 for every failure mode — no account enumeration.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agentId, password } = body as {
      agentId?: unknown;
      password?: unknown;
    };

    if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 64) {
      return NextResponse.json({ error: 'Missing or invalid agentId' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      return NextResponse.json({ error: 'Missing or invalid password' }, { status: 400 });
    }

    // Spoof-resistant client IP — the brute-force rate limit is per real IP.
    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(`agent-login:${clientIp}`, RATE_LIMITS.agentLogin.limit, RATE_LIMITS.agentLogin.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many login attempts. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    // verifyAgentCredential handles: bcrypt check, legacy plaintext upgrade,
    // lockout, disabled-account rejection — all returning the UNIFORM ok=false
    // shape so no information is leaked.
    const result = await verifyAgentCredential({ agentId, password });
    if (!result.ok) {
      // Uniform 401 — same response whether the account is missing, disabled,
      // locked, or the password is wrong.
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const { account, employee: empVerified } = result;

    // Employee must be active (checked server-side, never from client).
    if (empVerified.status !== 'active') {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Organization must be active (server-derived; uniform 401 — no leak).
    const org = await db.organization.findUnique({
      where: { id: empVerified.organizationId },
      select: { status: true },
    });
    if (!org || org.status !== 'active') {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Fetch employee name for the response.
    const employeeRecord = await db.employee.findUnique({
      where: { id: empVerified.id },
      select: { id: true, employeeId: true, firstName: true, lastName: true, organizationId: true },
    });
    if (!employeeRecord) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Issue a login-only AgentSession (server-derived employee + org). We do
    // NOT delete existing sessions or device tokens here — device concurrency
    // (one ACTIVE device per employee) is a separate, approval-time concern.
    const { token, expiresAt } = await createAgentSession({
      employeeId: employeeRecord.id,
      organizationId: employeeRecord.organizationId,
      ipAddress: clientIp,
    });

    // Audit the login (safe fields only — never the password or token value).
    // S-08: capture the sanitized User-Agent (the agent sends WorkLensAgent/x).
    await db.auditLog.create({
      data: {
        action: 'login',
        resource: 'agent_account',
        resourceId: account.id,
        description: `Agent login: ${agentId} (${employeeRecord.employeeId})`,
        userId: employeeRecord.id,
        ipAddress: clientIp,
        userAgent: getUserAgent(req),
        organizationId: employeeRecord.organizationId,
      },
    });

    log.info('agent.login', {
      employeeId: employeeRecord.employeeId.slice(0, 12),
      ip: clientIp,
    });

    return NextResponse.json({
      success: true,
      token,
      expiresAt: expiresAt.toISOString(),
      employee: {
        id: employeeRecord.id,
        employeeId: employeeRecord.employeeId,
        name: `${employeeRecord.firstName} ${employeeRecord.lastName}`,
      },
    });
  } catch (error) {
    log.error('agent.login.error', { err: error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}