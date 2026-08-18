import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';

// POST /api/anomalies/batch — Batch update anomaly statuses (manager+)
// All ids are verified against the caller's organization before updating —
// a cross-org id is silently excluded (and reported) rather than updated.
export async function POST(req: NextRequest) {
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

    const body = await req.json();
    const { ids, status } = body as { ids?: string[]; status?: string; resolvedBy?: string };

    // F-4: client-supplied resolvedBy is NEVER trusted — the authenticated
    // actor is recorded as the resolver for every record.
    void body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }
    if (!status || !['detected', 'investigating', 'resolved', 'false_positive'].includes(status)) {
      return NextResponse.json({ error: 'Valid status required' }, { status: 400 });
    }

    // Tenant isolation: restrict the update to anomalies in the caller's org.
    const scopedIds = (
      await db.anomaly.findMany({
        where: { id: { in: ids }, organizationId: org.id },
        select: { id: true },
      })
    ).map((a) => a.id);

    if (scopedIds.length === 0) {
      return NextResponse.json({ error: 'No anomalies found in your organization' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { status };
    if (status === 'resolved' || status === 'false_positive') {
      updateData.resolvedAt = new Date();
      updateData.resolvedBy = auth.email;
      // F-14: closed records release their dedupe slots (re-trigger allowed).
      updateData.dedupeKey = null;
    } else {
      // Reverting to an open status must not leave stale resolution metadata
      // (mirrors the single-record PUT behavior).
      updateData.resolvedAt = null;
      updateData.resolvedBy = null;
    }

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.anomaly.updateMany({
        where: { id: { in: scopedIds } },
        data: updateData,
      });

      // F-24: include the affected IDs in the audit trail (safe summarized
      // representation; no telemetry contents).
      const idSummary = scopedIds.length > 10 ? `${scopedIds.length} anomalies` : scopedIds.join(', ');
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'anomaly',
          resourceId: scopedIds.join(','),
          description: `Batch updated anomalies to status: ${status} (${idSummary})`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });

      return updated;
    });

    return NextResponse.json({
      success: true,
      updated: result.count,
      status,
      excluded: ids.length - scopedIds.length,
    });
  } catch (error) {
    console.error('Anomaly batch update error:', error);
    return NextResponse.json({ error: 'Failed to batch update anomalies' }, { status: 500 });
  }
}
