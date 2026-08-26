import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';

// GET /api/anomalies/[id] — Get single anomaly (org-scoped)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const { id } = await params;
    // Tenant isolation: the anomaly must belong to the caller's organization.
    const anomaly = await db.anomaly.findFirst({
      where: { id, organizationId: org.id },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeId: true, avatar: true, designation: true, departmentId: true, department: { select: { name: true } } } },
        device: { select: { id: true, name: true, hostname: true, operatingSystem: true, status: true } },
      },
    });

    if (!anomaly) {
      return NextResponse.json({ error: 'Anomaly not found' }, { status: 404 });
    }

    return NextResponse.json(anomaly);
  } catch (error) {
    log.error('api.anomalies.id.', { error: String('Anomaly GET by ID error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch anomaly' }, { status: 500 });
  }
}

// PUT /api/anomalies/[id] — Update anomaly status (manager+)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const { id } = await params;
    const body = await req.json();
    const { status } = body as { status?: string; resolvedBy?: string };

    // F-4: client-supplied resolvedBy is NEVER trusted — the authenticated
    // actor's identity is always the resolver.
    void body;

    if (!status || !['detected', 'investigating', 'resolved', 'false_positive'].includes(status)) {
      return NextResponse.json({ error: 'Valid status required: detected, investigating, resolved, false_positive' }, { status: 400 });
    }

    const updateData: Record<string, unknown> = { status };
    if (status === 'resolved' || status === 'false_positive') {
      updateData.resolvedAt = new Date();
      updateData.resolvedBy = auth.email;
      // F-14: a closed record releases its dedupe slot so the same
      // org+employee+type can legitimately re-trigger later.
      updateData.dedupeKey = null;
    } else {
      updateData.resolvedAt = null;
      updateData.resolvedBy = null;
    }

    // Tenant isolation: update only within the caller's organization.
    const anomaly = await db.anomaly.updateMany({
      where: { id, organizationId: org.id },
      data: updateData,
    });
    if (anomaly.count === 0) {
      return NextResponse.json({ error: 'Anomaly not found' }, { status: 404 });
    }

    const updated = await db.anomaly.findUnique({ where: { id } });

    // Audit log with actor
    if (updated) {
      await db.auditLog.create({
        data: {
          action: 'update',
          resource: 'anomaly',
          resourceId: id,
          description: `Anomaly "${updated.title}" status changed to ${status}`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });
    }

    return NextResponse.json(updated);
  } catch (error) {
    log.error('api.anomalies.id.', { error: String('Anomaly PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update anomaly' }, { status: 500 });
  }
}
