'use server';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireManagerOrg, authError } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { safeTimezone, zonedDayStart, addDaysToKey, localDayKey } from '@/lib/timezone';
import { subDays } from 'date-fns';
import { parseExportRange, generateCSV, type ExportColumn } from '@/lib/export';
import { log, requestContext } from '@/lib/logger';

// GET /api/employees/[id]/activities/export?from&to
// Server-side CSV export of an employee's activity for the selected date range.
//
// Security:
//   - Requires manager+ role (proxy gates /api to auth, this handler enforces
//     manager+ as defense-in-depth).
//   - Employee lookup is org-scoped — foreign/nonexistent ids return 404.
//   - Date range is validated at the API boundary.
//
// The export uses the same half-open interval as the activity timeline:
//   >= startOfDay(from) AND < startOfDay(to + 1 day)
//
// Bounded pagination (keyset) prevents unbounded memory use for large datasets.

const EXPORT_PAGE_SIZE = 2000;
const MAX_EXPORT_ROWS = 100_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const ACTIVITY_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'timestamp', label: 'Timestamp', format: 'datetime', width: 22 },
  { key: 'type', label: 'Activity Type', format: 'string', width: 16 },
  { key: 'applicationName', label: 'Application', format: 'string', width: 24 },
  { key: 'title', label: 'Title', format: 'string', width: 32 },
  { key: 'url', label: 'URL', format: 'string', width: 28 },
  { key: 'category', label: 'Category', format: 'string', width: 16 },
  { key: 'duration', label: 'Duration', format: 'duration', width: 12 },
  { key: 'device', label: 'Device', format: 'string', width: 20 },
];

type ActivityExportRow = {
  id: string;
  timestamp: Date;
  type: string;
  title: string | null;
  url: string | null;
  applicationName: string | null;
  category: string | null;
  duration: number;
  device: { name: string } | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  if (fromParam && !isIsoDate(fromParam)) {
    return NextResponse.json({ error: 'Invalid from. Use YYYY-MM-DD.' }, { status: 422 });
  }
  if (toParam && !isIsoDate(toParam)) {
    return NextResponse.json({ error: 'Invalid to. Use YYYY-MM-DD.' }, { status: 422 });
  }

  // Validate date range at API boundary
  const range = parseExportRange(fromParam || '', toParam || '');
  if (range.error) {
    return NextResponse.json({ error: range.error.message }, { status: range.error.status });
  }

  try {
    // Auth: manager+ role + org scope
    const auth = await requireManagerOrg(request);
    if (!auth.ok) return authError(auth);

    // Org-scoped employee lookup — foreign/nonexistent ids are concealed as 404.
    const employee = await db.employee.findFirst({
      where: { id, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) },
      select: { id: true, firstName: true, lastName: true, organizationId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Organization-local day boundaries (half-open interval)
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
      endExclusive = zonedDayStart(addDaysToKey(toParam, 1), orgTz);
    } else if (fromParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      endExclusive = now;
    } else if (toParam) {
      // Only `to` provided — start from 90 days ago (default window)
      startDate = zonedDayStart(localDayKey(subDays(now, 89), orgTz), orgTz);
      endExclusive = zonedDayStart(addDaysToKey(toParam, 1), orgTz);
    } else {
      // No range — default to last 90 days
      startDate = zonedDayStart(localDayKey(subDays(now, 89), orgTz), orgTz);
      endExclusive = now;
    }

    // Keyset cursor for bounded memory
    const baseWhere: Prisma.ActivityWhereInput = {
      employeeId: employee.id,
      organizationId: employee.organizationId,
      timestamp: { gte: startDate, lt: endExclusive },
      ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
    };

    const include = { device: { select: { id: true, name: true } } };
    const orderBy: Prisma.ActivityOrderByWithRelationInput[] = [
      { timestamp: 'desc' },
      { id: 'desc' },
    ];

    // Collect rows page-by-page with a hard cap
    const collected: ActivityExportRow[] = [];
    let page = await db.activity.findMany({
      where: baseWhere,
      include,
      orderBy,
      take: EXPORT_PAGE_SIZE,
    });

    while (page.length > 0 && collected.length < MAX_EXPORT_ROWS) {
      for (const row of page) {
        if (collected.length >= MAX_EXPORT_ROWS) break;
        collected.push(row);
      }
      if (page.length < EXPORT_PAGE_SIZE || collected.length >= MAX_EXPORT_ROWS) break;
      const last = page[page.length - 1];
      page = await db.activity.findMany({
        where: {
          ...baseWhere,
          OR: [
            { timestamp: { lt: last.timestamp } },
            { timestamp: last.timestamp, id: { lt: last.id } },
          ],
        },
        include,
        orderBy,
        take: EXPORT_PAGE_SIZE,
      });
    }

    if (collected.length >= MAX_EXPORT_ROWS) {
      log.warn('api.employees.id.activities.export.capped', {
        employeeId: employee.id,
        cap: MAX_EXPORT_ROWS,
      }, requestContext(request));
    }

    // Map to export rows
    const data = collected.map((a) => ({
      timestamp: a.timestamp.toISOString(),
      type: a.type,
      applicationName: a.applicationName || '',
      title: a.title || '',
      url: a.url || '',
      category: a.category || '',
      duration: a.duration,
      device: a.device?.name || '',
    }));

    // Generate CSV
    const employeeName = `${employee.firstName}-${employee.lastName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const fromLabel = fromParam || 'start';
    const toLabel = toParam || 'now';
    const filename = `employee-activity-${employeeName}-${fromLabel}-to-${toLabel}`;

    const csv = generateCSV(ACTIVITY_EXPORT_COLUMNS, data);

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'export',
        resource: 'activity',
        resourceId: employee.id,
        description: `Exported ${data.length} activity records for employee ${employee.firstName} ${employee.lastName} (${fromLabel} to ${toLabel})`,
        userId: auth.userId,
        organizationId: auth.organizationId,
        metadata: JSON.stringify({
          employeeId: employee.id,
          from: fromLabel,
          to: toLabel,
          rowCount: data.length,
          format: 'csv',
        }),
      },
    });

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    });
  } catch {
    log.error('api.employees.id.activities.export.', {
      error: String('Employee activity export error:'),
    }, requestContext(request));
    return NextResponse.json(
      { error: 'Failed to export activities' },
      { status: 500 }
    );
  }
}
