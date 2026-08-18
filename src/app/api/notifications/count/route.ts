'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: notification counts are organization-scoped.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return NextResponse.json({ unread: 0, total: 0 });
    const orgId = scope.organizationId;

    const [unread, total] = await Promise.all([
      db.notification.count({ where: { status: 'unread', organizationId: orgId } }),
      db.notification.count({ where: { organizationId: orgId } }),
    ]);
    return NextResponse.json({ unread, total });
  } catch (error) {
    console.error('Notification count error:', error);
    return NextResponse.json({ error: 'Failed to fetch count' }, { status: 500 });
  }
}
