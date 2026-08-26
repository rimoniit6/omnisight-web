import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { validatePagination } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/self/anomalies?employeeId=xxx&status=&severity=
// Manager+ role (enforced by middleware); employee scoped to caller's org.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    // Tenant-scoped lookup: employee must belong to the caller's org
    const { employee: scoped, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !scoped) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    const status = searchParams.get('status');
    const severity = searchParams.get('severity');

    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    // Build where clause
    const where: Record<string, unknown> = { employeeId: scoped.id };
    if (status) where.status = status;
    if (severity) where.severity = severity;

    // Fetch paginated anomalies with basic employee info
    const [anomalies, total] = await Promise.all([
      db.anomaly.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeId: true,
              firstName: true,
              lastName: true,
              avatar: true,
              designation: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.anomaly.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    return NextResponse.json({
      data: anomalies,
      total,
      page,
      pageSize,
      totalPages,
    });
  } catch (error) {
    log.error('api.self.anomalies.', { error: String('Self Anomalies GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch anomalies' }, { status: 500 });
  }
}
