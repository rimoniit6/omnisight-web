import { NextRequest, NextResponse } from 'next/server';
import { requireSessionOrg, requireValidLicense, apiError } from '@/lib/api';
import { isSelfHosted } from '@/lib/config';
import { log, requestContext } from '@/lib/logger';

// GET /api/self-hosted/license-status — the org's current self-hosted license
// state for the license-status settings page.
//
// Cloud mode: not applicable (returns mode:'cloud', licensed:true).
// Self-hosted mode: reports the current license validity as stored in DB.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSessionOrg(req);
    if (!session.ok) return apiError(session.status === 401 ? 'Unauthorized' : 'Forbidden', session.status);

    if (!isSelfHosted) {
      // Cloud tenants are not license-gated.
      return NextResponse.json({ data: { mode: 'cloud', licensed: true } });
    }

    const check = await requireValidLicense(session.organizationId as string);

    if (!check.ok) {
      return NextResponse.json({ data: { mode: 'self_hosted', licensed: false, reason: check.reason } });
    }

    return NextResponse.json({
      data: {
        mode: 'self_hosted',
        licensed: true,
        license: {
          key: check.license.key,
          validUntil: check.license.validUntil,
          plan: check.license.plan,
        },
      },
    });
  } catch (error) {
    log.error('api.selfhosted.license-status', { error: String(error) }, requestContext(req));
    return apiError('Failed to load license status', 500);
  }
}
