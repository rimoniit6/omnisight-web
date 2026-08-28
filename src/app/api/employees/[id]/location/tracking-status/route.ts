'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { log, requestContext } from '@/lib/logger';

// GET /api/employees/[id]/location/tracking-status
// Returns whether location tracking is enabled for the org and whether
// the employee has granted location consent. Used by the LocationPanel
// to display clear status messages.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true, organizationId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const [consentGranted, monitoring] = await Promise.all([
      hasActiveConsent(employee.id, 'location'),
      resolveOrgMonitoring(employee.organizationId),
    ]);

    return NextResponse.json({
      consentGranted,
      trackingEnabled: monitoring.location_tracking === true,
    });
  } catch {
    log.error('api.employees.id.location.tracking-status.', { error: 'Tracking status error' }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
