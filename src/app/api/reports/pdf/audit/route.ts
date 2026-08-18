import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateAuditReport } from '@/lib/pdf-generator';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { getSessionOrg, authError, requireManagerOrg, isValidDate, parseJsonBody, BodyParseError } from '@/lib/api';

export async function POST(request: NextRequest) {
  try {
    // S-3: PDF report generation requires manager-or-above.
    const scope = await requireManagerOrg(request);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(request);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { dateFrom, dateTo, action, resource, user } = body as {
      dateFrom?: string; dateTo?: string; action?: string; resource?: string; user?: string;
    };

    // Parse date range — default to current month if not provided
    const startDate = dateFrom ? new Date(dateFrom) : startOfMonth(new Date());
    const endDate = dateTo ? new Date(dateTo) : endOfMonth(new Date());
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return NextResponse.json(
        { error: 'Invalid date range. Provide valid ISO dates for dateFrom/dateTo.' },
        { status: 422 },
      );
    }

    // Build where clause with filters — ALWAYS org-scoped: an org-bound admin
    // can only ever see their own organization's audit logs.
    const where: Record<string, unknown> = { organizationId: orgId };

    if (dateFrom || dateTo) {
      where.createdAt = { gte: startDate, lte: endDate };
    }

    if (action) {
      where.action = action;
    }

    if (resource) {
      where.resource = resource;
    }

    if (user) {
      where.userId = user;
    }

    // Fetch audit logs (limit to 200 for PDF)
    const auditLogs = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    // Compute summary stats from the filtered logs
    const totalActions = auditLogs.length;
    const loginLogout = auditLogs.filter(
      (log) => log.action === 'login' || log.action === 'logout',
    ).length;
    const creates = auditLogs.filter((log) => log.action === 'create').length;
    const updates = auditLogs.filter((log) => log.action === 'update').length;
    const deletes = auditLogs.filter((log) => log.action === 'delete').length;

    // Fetch organization
    const sessionOrg = await getSessionOrg(request);
    const org = sessionOrg
      ? await db.organization.findUnique({ where: { id: sessionOrg.id }, select: { name: true } })
      : null;

    // Generate PDF
    const pdfBuffer = await generateAuditReport(
      auditLogs.map((log) => ({
        id: log.id,
        timestamp: log.createdAt,
        action: log.action,
        resource: log.resource,
        description: log.description,
        userName: log.userId || 'System',
        ipAddress: log.ipAddress || 'N/A',
      })),
      {
        dateRange: { start: startDate, end: endDate },
        action: action || undefined,
        resource: resource || undefined,
        user: user || undefined,
      },
      {
        totalActions,
        loginLogout,
        creates,
        updates,
        deletes,
      },
      {
        organization: org?.name || 'OmniSight',
      },
    );

    const filename = `audit-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('PDF generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 },
    );
  }
}
