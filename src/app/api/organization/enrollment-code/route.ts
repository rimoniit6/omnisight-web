'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log, requestContext } from '@/lib/logger';
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  ENROLLMENT_CODE_SETTING_KEY,
  ENROLLMENT_CODE_EXPIRES_KEY,
  ENROLLMENT_CODE_DEFAULT_TTL_MS,
} from '@/lib/agent/auth';

// POST   /api/organization/enrollment-code — generate/rotate the org's
//        zero-touch enrollment code (admin-only, org-scoped). Only the SHA-256
//        hash is stored; the plaintext code is returned EXACTLY ONCE so the
//        admin can provision it to agents (env WL_ENROLLMENT_CODE / MDM).
// DELETE /api/organization/enrollment-code — disable zero-touch enrollment for
//        the org (removes the setting; anonymous discovers then fail closed).
//
// The organization is ALWAYS the authenticated admin's org — a client-supplied
// organizationId is never accepted. Both mutations are audited.
export async function POST(req: NextRequest) {
  try {
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(`enrollment-code:${scope.organizationId}:${clientIp}`, RATE_LIMITS.deviceClaimWrite.limit, RATE_LIMITS.deviceClaimWrite.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const code = generateEnrollmentCode();
    const hash = hashEnrollmentCode(code);
    const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_DEFAULT_TTL_MS).toISOString();

    // Store hash and expiration atomically
    await db.organizationSetting.upsert({
      where: {
        organizationId_key: { organizationId: scope.organizationId, key: ENROLLMENT_CODE_SETTING_KEY },
      },
      update: { value: hash, category: 'agent' },
      create: {
        organizationId: scope.organizationId,
        key: ENROLLMENT_CODE_SETTING_KEY,
        value: hash,
        category: 'agent',
      },
    });
    await db.organizationSetting.upsert({
      where: {
        organizationId_key: { organizationId: scope.organizationId, key: ENROLLMENT_CODE_EXPIRES_KEY },
      },
      update: { value: expiresAt, category: 'agent' },
      create: {
        organizationId: scope.organizationId,
        key: ENROLLMENT_CODE_EXPIRES_KEY,
        value: expiresAt,
        category: 'agent',
      },
    });

    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'settings',
        resourceId: scope.organizationId,
        description: 'Zero-touch device enrollment code generated/rotated for the organization',
        userId: scope.userId,
        ipAddress: clientIp,
        organizationId: scope.organizationId,
      },
    });

    return NextResponse.json({
      success: true,
      code,
      expiresAt,
      message: 'Enrollment code issued. It is returned only once — provision it to agents before it is needed.',
    });
  } catch (error) {
    log.error('api.organization.enrollment-code.', { error: String('Enrollment code POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);

    const clientIp = getClientIpFromHeaders(req.headers);

    const removed = await db.organizationSetting.deleteMany({
      where: {
        organizationId: scope.organizationId,
        key: { in: [ENROLLMENT_CODE_SETTING_KEY, ENROLLMENT_CODE_EXPIRES_KEY] },
      },
    });

    if (removed.count > 0) {
      await db.auditLog.create({
        data: {
          action: 'delete',
          resource: 'settings',
          resourceId: scope.organizationId,
          description: 'Zero-touch device enrollment code disabled for the organization',
          userId: scope.userId,
          ipAddress: clientIp,
          organizationId: scope.organizationId,
        },
      });
    }

    return NextResponse.json({ success: true, enabled: removed.count > 0 });
  } catch (error) {
    log.error('api.organization.enrollment-code.', { error: String('Enrollment code DELETE error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/organization/enrollment-code — return enrollment code STATUS only.
// Never returns the plaintext code. Admin-only, org-scoped.
export async function GET(req: NextRequest) {
  try {
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);

    const setting = await db.organizationSetting.findUnique({
      where: {
        organizationId_key: { organizationId: scope.organizationId, key: ENROLLMENT_CODE_SETTING_KEY },
      },
      select: { value: true, updatedAt: true },
    });

    const expiresSetting = await db.organizationSetting.findUnique({
      where: {
        organizationId_key: { organizationId: scope.organizationId, key: ENROLLMENT_CODE_EXPIRES_KEY },
      },
      select: { value: true },
    });

    const expiresAt = expiresSetting?.value || null;
    const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false;

    return NextResponse.json({
      configured: !!setting,
      active: !!setting && !isExpired,
      expiresAt,
      revoked: !setting,
      createdAt: setting?.updatedAt || null,
    });
  } catch (error) {
    log.error('api.organization.enrollment-code.', { error: String('Enrollment code GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
