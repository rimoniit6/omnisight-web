'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { parseISO, startOfDay, subDays } from 'date-fns';
import { log, requestContext } from '@/lib/logger';
import { reverseGeocode } from '@/lib/geocoding';

// GET /api/employees/[id]/location?from&to&page&pageSize
// Admin telemetry: geolocation history for one employee.
//
//   - Employee lookup is org-scoped (foreign ids → 404).
//   - Exposes ONLY latitude/longitude/accuracy/recordedAt — no address, no
//     reverse geocoding, no raw device metadata (none of it exists in the
//     schema).
//   - `latest` is the most recent fix in the filtered range; `history` is
//     strictly paginated (page ≥ 1, pageSize 1..100).
//   - Manager+ read scope, same convention as employee activities.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);

  const rawPage = searchParams.get('page');
  const rawPageSize = searchParams.get('pageSize');
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawPageSize === null ? 25 : Number(rawPageSize);
  if (
    (rawPage !== null && (!Number.isInteger(page) || page < 1)) ||
    (rawPageSize !== null && (!Number.isInteger(pageSize) || pageSize < 1)) ||
    pageSize > 100
  ) {
    return NextResponse.json(
      { error: 'page must be a positive integer and pageSize must be between 1 and 100' },
      { status: 422 }
    );
  }

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  if (fromParam && !isIsoDate(fromParam)) {
    return NextResponse.json({ error: 'Invalid from. Use YYYY-MM-DD.' }, { status: 422 });
  }
  if (toParam && !isIsoDate(toParam)) {
    return NextResponse.json({ error: 'Invalid to. Use YYYY-MM-DD.' }, { status: 422 });
  }

  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const now = new Date();
    let startDate: Date;
    let endDate: Date;
    if (fromParam && toParam) {
      startDate = startOfDay(parseISO(fromParam));
      endDate = new Date(parseISO(toParam));
      endDate.setHours(23, 59, 59, 999);
    } else if (fromParam) {
      startDate = startOfDay(parseISO(fromParam));
      endDate = now;
    } else {
      startDate = startOfDay(subDays(now, 6));
      endDate = now;
    }

    // LocationEvent has no direct organizationId — scope via the employee.
    const where = { employeeId: id, recordedAt: { gte: startDate, lte: endDate } };

    const [history, total, latest] = await Promise.all([
      db.locationEvent.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.locationEvent.count({ where }),
      db.locationEvent.findFirst({ where, orderBy: { recordedAt: 'desc' } }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const mapFix = (e: { id: string; latitude: number; longitude: number; accuracy: number | null; recordedAt: Date; source: string }) => ({
      id: e.id,
      latitude: e.latitude,
      longitude: e.longitude,
      accuracy: e.accuracy,
      recordedAt: e.recordedAt.toISOString(),
      source: e.source,
    });

    // Reverse geocode the latest location for address display (free, cached)
    let latestAddress: string | null = null;
    if (latest) {
      const geo = await reverseGeocode(latest.latitude, latest.longitude);
      latestAddress = geo?.shortAddress ?? null;
    }

    return NextResponse.json({
      latest: latest ? { ...mapFix(latest), address: latestAddress } : null,
      history: history.map(mapFix),
      total,
      page,
      pageSize,
      totalPages,
    });
  } catch (error) {
    log.error('api.employees.id.location.', { error: String('Admin location telemetry error:') }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
