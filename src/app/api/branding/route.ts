import { NextRequest, NextResponse } from 'next/server';
import { getEffectiveBranding } from '@/lib/branding';
import { authenticateRequest, authError } from '@/lib/api';

/**
 * GET /api/branding
 *
 * Returns the effective branding for the current user's organization context.
 * Public after authentication — any authenticated user can read branding.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });

    const orgId = auth.activeOrganizationId || auth.organizationId || null;
    const branding = await getEffectiveBranding(orgId);

    return NextResponse.json({ data: branding });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch branding' }, { status: 500 });
  }
}
