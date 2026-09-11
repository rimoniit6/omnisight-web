'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, getPrismaForOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    // Admin-only mutation; org from session.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);
    const orgData = (await getPrismaForOrg(admin.organizationId)).client;

    const body = await req.json();
    const { ids, action } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'IDs array is required' }, { status: 400 });
    }

    if (action === 'archive') {
      const result = await orgData.employee.updateMany({
        where: { id: { in: ids }, organizationId: admin.organizationId },
        data: { status: 'archived' },
      });

      return NextResponse.json({ archived: result.count });
    }

    return NextResponse.json({ error: 'Invalid action. Supported: archive' }, { status: 400 });
  } catch (error) {
    log.error('api.employees.bulk.', { error: String('Employees bulk POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Bulk operation failed' }, { status: 500 });
  }
}
