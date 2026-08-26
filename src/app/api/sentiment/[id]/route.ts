'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Tenant isolation: a sentiment record is only visible to users of the
    // same organization (concealed as 404 otherwise).
    const scope = await requireSessionOrg(req);
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ error: 'Sentiment record not found' }, { status: 404 });
    }
    const orgId = scope.organizationId;

    const { id } = await params;
    if (!id || id.length > 64) {
      return NextResponse.json({ error: 'Invalid sentiment record id' }, { status: 400 });
    }
    const record = await db.sentimentRecord.findFirst({
      where: { id, employee: { organizationId: orgId } },
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
            employeeId: true,
            avatar: true,
            status: true,
            joinDate: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!record) {
      return NextResponse.json(
        { error: 'Sentiment record not found' },
        { status: 404 }
      );
    }

    // Parse JSON fields for the response
    let parsedSignals: unknown = null;
    try {
      parsedSignals = JSON.parse(record.signals || '{}');
    } catch {
      parsedSignals = record.signals;
    }

    let parsedRiskFactors: string[] = [];
    try {
      parsedRiskFactors = JSON.parse(record.riskFactors || '[]');
    } catch {
      parsedRiskFactors = [];
    }

    return NextResponse.json({
      data: {
        ...record,
        signals: parsedSignals,
        riskFactors: parsedRiskFactors,
      },
    });
  } catch (error) {
    log.error('api.sentiment.id.', { error: String('Sentiment GET by ID error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to fetch sentiment record' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Mutation: admin-or-above role AND the record must belong to the
    // caller's organization.
    const scope = await requireAdminOrg(req);
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    if (!id || id.length > 64) {
      return NextResponse.json({ error: 'Invalid sentiment record id' }, { status: 400 });
    }
    const existing = await db.sentimentRecord.findFirst({
      where: { id, employee: { organizationId: scope.organizationId } },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Sentiment record not found' }, { status: 404 });
    }
    await db.sentimentRecord.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('api.sentiment.id.', { error: String('Sentiment DELETE error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to delete sentiment record' },
      { status: 500 }
    );
  }
}
