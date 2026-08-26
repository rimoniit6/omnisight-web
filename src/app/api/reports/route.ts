'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, getSessionOrg, requireManagerOrg, validatePagination, parseJsonBody, BodyParseError, isValidDate } from '@/lib/api';
import { parseBoundedRange } from '@/lib/export';
import { log, requestContext } from '@/lib/logger';

// P3-3: report generation only accepts known types/formats — never free-form
// values that could be stored as misleading report metadata.
const REPORT_TYPES = new Set(['productivity', 'attendance', 'activity', 'department', 'device', 'employee']);
const REPORT_FORMATS = new Set(['pdf', 'csv', 'json', 'excel']);

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: list only the caller's organization.
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    // P3-2: validated pagination (page >= 1, pageSize capped) + optional type
    // filter. total reflects the FILTERED dataset, never the unfiltered one.
    const { searchParams } = new URL(req.url);
    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const typeFilter = searchParams.get('type');
    const where: Record<string, unknown> = { organizationId: org.id };
    if (typeFilter) where.type = typeFilter;

    const [rows, total] = await Promise.all([
      db.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.pageSize,
        select: {
          id: true,
          title: true,
          type: true,
          format: true,
          status: true,
          periodStart: true,
          periodEnd: true,
          generatedBy: true,
          createdAt: true,
          updatedAt: true,
          // Internal payload + filesystem path are used ONLY to derive hasData
          // and are never returned (S-4): no filePath, no raw report
          // payload/PII exposure. A report may carry its payload in the DB
          // (data) OR on disk (filePath) — either one means it has data.
          data: true,
          filePath: true,
        },
      }),
      db.report.count({ where }),
    ]);

    // S-4: expose hasData instead of the raw payload / filesystem path.
    const reports = rows.map(({ data, filePath, ...rest }) => ({
      ...rest,
      // A report has data when its payload lives in the DB (data) OR on
      // disk (filePath) — either one means the report is populated. Empty
      // strings count as "no data".
      hasData:
        (data != null && data !== '') ||
        (filePath != null && filePath !== ''),
    }));

    return NextResponse.json({
      data: reports,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(total / pagination.pageSize),
    });
  } catch (error) {
    log.error('api.reports.', { error: String('Reports GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch reports' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // S-3: report generation requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { title, type, format, startDate, endDate } = body as {
      title?: string; type?: string; format?: string; startDate?: string; endDate?: string;
    };
    if (!title || typeof title !== 'string') return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    if (!type || typeof type !== 'string' || !REPORT_TYPES.has(type)) {
      return NextResponse.json({ error: `Invalid report type. Must be one of: ${Array.from(REPORT_TYPES).join(', ')}` }, { status: 422 });
    }
    const finalFormat = (format && typeof format === 'string' ? format : 'pdf');
    if (!REPORT_FORMATS.has(finalFormat)) {
      return NextResponse.json({ error: `Invalid format. Must be one of: ${Array.from(REPORT_FORMATS).join(', ')}` }, { status: 422 });
    }
    if (title.length > 300) return NextResponse.json({ error: 'Title is too long (max 300 characters)' }, { status: 422 });

    const periodStart = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const periodEnd = endDate ? new Date(endDate) : new Date();
    if (!isValidDate(periodStart) || !isValidDate(periodEnd)) {
      return NextResponse.json({ error: 'Invalid date range. Provide valid ISO dates for startDate/endDate.' }, { status: 422 });
    }

    // WM-02 / WM-04: reject inverted ranges and windows wider than 90 days —
    // report metadata must never be misleading and generation must never scan
    // the whole table on a direct API call.
    const bounded = parseBoundedRange(
      startDate ? new Date(startDate).toISOString() : '',
      endDate ? new Date(endDate).toISOString() : ''
    );
    if (bounded.error) {
      return NextResponse.json({ error: bounded.error.message }, { status: bounded.error.status });
    }

    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    // Create + audit in one transaction (actor = verified session user).
    // Intentional non-idempotency: each POST is an explicit "generate" action
    // and creates a new report row (same as the daily-report flow).
    const { report } = await db.$transaction(async (tx) => {
      const created = await tx.report.create({
        data: {
          title,
          type,
          format: finalFormat,
          status: 'completed',
          organizationId: org.id,
          periodStart,
          periodEnd,
          generatedBy: scope.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'report',
          resourceId: created.id,
          description: `Report "${title}" (${type}) created by ${scope.email}`,
          userId: scope.userId,
          organizationId: org.id,
        },
      });
      return { report: created };
    });
    return NextResponse.json({ data: report }, { status: 201 });
  } catch (error) {
    log.error('api.reports.', { error: String('Reports POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to generate report' }, { status: 500 });
  }
}
