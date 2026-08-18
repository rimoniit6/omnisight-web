'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';

export async function POST(req: NextRequest) {
  try {
    // Admin-only mutation; org from session.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json();
    const { ids, action } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'IDs array is required' }, { status: 400 });
    }

    if (action === 'archive') {
      const result = await db.employee.updateMany({
        where: { id: { in: ids }, organizationId: admin.organizationId },
        data: { status: 'archived' },
      });

      return NextResponse.json({ archived: result.count });
    }

    return NextResponse.json({ error: 'Invalid action. Supported: archive' }, { status: 400 });
  } catch (error) {
    console.error('Employees bulk POST error:', error);
    return NextResponse.json({ error: 'Bulk operation failed' }, { status: 500 });
  }
}
