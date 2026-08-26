'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

async function scopedOrg(req: NextRequest): Promise<{ ok: true; organizationId: string } | { ok: false; response: NextResponse }> {
  const scope = await requireSessionOrg(req);
  if (!scope.ok) return { ok: false, response: authError(scope) };
  if (!scope.organizationId) {
    return { ok: false, response: NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 }) };
  }
  return { ok: true, organizationId: scope.organizationId };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scoped = await scopedOrg(req);
    if (!scoped.ok) return scoped.response;

    const { id } = await params;
    const body = await req.json();
    const { status } = body;

    if (!id) {
      return NextResponse.json({ error: 'Insight ID is required' }, { status: 400 });
    }

    if (!status || !['acknowledged', 'dismissed', 'actioned', 'active'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status. Must be one of: acknowledged, dismissed, actioned, active' }, { status: 400 });
    }

    const insight = await db.aiInsight.findFirst({ where: { id, organizationId: scoped.organizationId } });
    if (!insight) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }

    const updated = await db.aiInsight.update({
      where: { id },
      data: {
        status,
        actionTaken: status === 'acknowledged' ? 'Acknowledged by user' : status === 'actioned' ? 'Action taken on this insight' : undefined,
      },
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    log.error('api.insights.id.', { error: String('Insight update error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update insight' }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scoped = await scopedOrg(req);
    if (!scoped.ok) return scoped.response;

    const { id } = await params;
    const insight = await db.aiInsight.findFirst({ where: { id, organizationId: scoped.organizationId } });
    if (!insight) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }
    return NextResponse.json({ data: insight });
  } catch (error) {
    log.error('api.insights.id.', { error: String('Insight GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch insight' }, { status: 500 });
  }
}
