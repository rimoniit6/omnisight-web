import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isValidLicenseFormat } from '@/lib/licenses';
import { log, requestContext } from '@/lib/logger';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';

// POST /api/license/validate — PUBLIC validation endpoint.
//
// Self-hosted OmniSight instances call this on startup (and periodically) to
// prove the LICENSE_KEY configured in their env is current. Cloud mode never
// calls it. It is intentionally unauthenticated — the license key ITSELF is
// the credential.
//
// SECURITY rules observed here:
//   - The key is looked up by exact match; it is NEVER echoed back in the
//     response or in any reason string.
//   - Rate-limited per IP (fail-closed via the shared limiter).
//   - Failure reasons are generic and never reveal the submitted key.
//
// Response: { valid, reason?, data?: { expiresAt, organizationId, organizationName, plan } }

export async function POST(req: NextRequest) {
  try {
    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `license-validate:${clientIp}`,
      RATE_LIMITS.licenseValidate.limit,
      RATE_LIMITS.licenseValidate.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { valid: false, reason: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { key?: unknown };
    const rawKey = typeof body.key === 'string' ? body.key.trim().toUpperCase() : '';
    if (!rawKey) {
      return NextResponse.json({ valid: false, reason: 'missing_key' });
    }
    if (!isValidLicenseFormat(rawKey)) {
      return NextResponse.json({ valid: false, reason: 'invalid_format' });
    }

    const license = await db.licenseKey.findUnique({
      where: { key: rawKey },
      select: {
        id: true,
        isActive: true,
        isRevoked: true,
        validUntil: true,
        organizationId: true,
        organization: { select: { id: true, name: true } },
        plan: {
          select: { id: true, name: true, maxDevices: true, retentionDays: true, features: true },
        },
      },
    });

    // Not found: return a generic reason (never reveal whether a key exists).
    if (!license) {
      return NextResponse.json({ valid: false, reason: 'invalid_key' });
    }

    const now = new Date();
    if (license.isRevoked) {
      return NextResponse.json({ valid: false, reason: 'revoked' });
    }
    if (!license.isActive) {
      return NextResponse.json({ valid: false, reason: 'inactive' });
    }
    if (license.validUntil.getTime() <= now.getTime()) {
      return NextResponse.json({ valid: false, reason: 'expired' });
    }

    // Success — record the verification (touching only this row).
    await db.licenseKey
      .update({
        where: { id: license.id },
        data: {
          lastVerifiedAt: now,
          verificationCount: { increment: 1 },
        },
      })
      .catch((err) => {
        // Non-fatal: report the license as valid even if auditing fails.
        log.warn('api.license.validate.touch_failed', { error: String(err) }, requestContext(req));
      });

    return NextResponse.json({
      valid: true,
      data: {
        expiresAt: license.validUntil.toISOString(),
        organizationId: license.organizationId,
        organizationName: license.organization.name,
        plan: {
          id: license.plan.id,
          name: license.plan.name,
          maxDevices: license.plan.maxDevices,
          retentionDays: license.plan.retentionDays,
          features: license.plan.features,
        },
      },
    });
  } catch (error) {
    log.error('api.license.validate', { error: String(error) }, requestContext(req));
    // Never reveal the key or internal detail; fail as invalid on error.
    return NextResponse.json({ valid: false, reason: 'server_error' }, { status: 500 });
  }
}
