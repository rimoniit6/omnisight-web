import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

// GET /api/screenshots — paginated list with filters
export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: screenshots are organization-scoped from the verified
    // session — never from client input. Org-less super_admins get an empty
    // payload (bootstrap state).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 24, totalPages: 0 });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId') || undefined;
    const deviceId = searchParams.get('deviceId') || undefined;
    const dateFrom = searchParams.get('dateFrom') || undefined;
    const dateTo = searchParams.get('dateTo') || undefined;
    const flagged = searchParams.get('flagged');
    const search = searchParams.get('search') || undefined;
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize')) || 24));

    const where: Record<string, unknown> = { organizationId: orgId };

    if (employeeId) where.employeeId = employeeId;
    if (deviceId) where.deviceId = deviceId;
    if (flagged === 'true') where.flagged = true;
    if (dateFrom || dateTo) {
      const capturedAt: Record<string, unknown> = {};
      if (dateFrom) capturedAt.gte = new Date(dateFrom);
      if (dateTo) capturedAt.lte = new Date(dateTo);
      where.capturedAt = capturedAt;
    }
    if (search) {
      where.OR = [
        { appWindow: { contains: search } },
        { employee: { firstName: { contains: search } } },
        { employee: { lastName: { contains: search } } },
      ];
    }

    const [screenshots, total] = await Promise.all([
      db.screenshot.findMany({
        where,
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true, avatar: true },
          },
          device: { select: { id: true, name: true, hostname: true, status: true } },
        },
        orderBy: { capturedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.screenshot.count({ where }),
    ]);

    return NextResponse.json({
      data: screenshots,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Screenshots list error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
