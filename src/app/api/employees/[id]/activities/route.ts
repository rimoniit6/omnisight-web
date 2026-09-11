'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, getPrismaForOrg } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { safeTimezone, zonedDayStart, addDaysToKey, localDayKey } from '@/lib/timezone';
import { subDays } from 'date-fns';
import { log, requestContext } from '@/lib/logger';

// GET /api/employees/[id]/activities?from&to&page&pageSize
// Paginated, org-scoped activity timeline for a single employee.
//
//   - Employee lookup is org-scoped (foreign ids → 404, never a leak).
//   - Date filtering uses a half-open interval: >= start AND < endExclusive.
//     The `to` parameter is an inclusive YYYY-MM-DD day key; internally it is
//     converted to the NEXT day's local midnight (endExclusive) so the
//     comparison is `timestamp < endExclusive`. This avoids timestamp precision
//     bugs and correctly includes the entire selected end day.
//   - Internal-agent processes are excluded with the NULL-safe predicate so
//     website/idle/screenshot/work_session rows (NULL applicationName) are
//     preserved and the timeline totals match the detail stats.
//   - Strict pagination: page ≥ 1, pageSize 1..100, stable timestamp-desc
//     ordering — the complete dataset stays reachable page by page.

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
  const pageSize = rawPageSize === null ? 50 : Number(rawPageSize);
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
    const orgData = scope.organizationId ? (await getPrismaForOrg(scope.organizationId)).client : db;

    // Org-scoped employee lookup — foreign/nonexistent ids are concealed as 404.
    const employee = await orgData.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true, organizationId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Organization-local day boundaries — "today" means today in the org's
    // timezone (same convention as /api/activities), never the server's UTC
    // midnight.
    //
    // Half-open interval: >= startOfDay(from) AND < startOfDay(to + 1 day).
    // The `to` param is an inclusive day key; endExclusive is the NEXT day's
    // local midnight so `timestamp < endExclusive` includes the entire `to` day.
    const org = await db.organization.findUnique({
      where: { id: employee.organizationId },
      select: { timezone: true },
    });
    const orgTz = safeTimezone(org?.timezone);

    const now = new Date();
    let startDate: Date;
    let endExclusive: Date;
    if (fromParam && toParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      // Half-open: endExclusive = next day's local midnight
      endExclusive = zonedDayStart(addDaysToKey(toParam, 1), orgTz);
    } else if (fromParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      endExclusive = now;
    } else {
      startDate = zonedDayStart(localDayKey(subDays(now, 6), orgTz), orgTz);
      endExclusive = now;
    }

    const timestampFilter = endExclusive === now
      ? { gte: startDate }
      : { gte: startDate, lt: endExclusive };

    const [activities, total] = await Promise.all([
      orgData.activity.findMany({
        where: {
          employeeId: id,
          timestamp: timestampFilter,
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          device: { select: { id: true, name: true } },
        },
      }),
      orgData.activity.count({
        where: {
          employeeId: id,
          timestamp: timestampFilter,
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
      }),
    ]);

    return NextResponse.json({
      data: activities,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch {
    log.error('api.employees.id.activities.', { error: String('Employee activities error:') }, requestContext(request));
    return NextResponse.json({ error: 'Failed to fetch employee activities' }, { status: 500 });
  }
}
