'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, SAFE_EMPLOYEE_SELECT } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/agent-registrations
// List legacy agent registrations for the caller's organization (admin session).
// Also serves:
//   - ?summary=true — org-wide status counts (server-side groupBy) so the
//     approvals page stats are always the full queue, never a first page.
//   - ?q= — org-scoped search over hostname / device name and the bound
//     employee's names (case-insensitive).
//   - pageSize is clamped (1..100, default 10) exactly like the device-claims
//     list so a malformed client cannot force an unbounded query.
export async function GET(req: NextRequest) {
  try {
    // Admin-side endpoint: requires a valid session and is org-scoped.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const parsePageNumber = (value: string | null, fallback: number) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const page = Math.max(1, parsePageNumber(searchParams.get('page'), 1));
    const pageSize = Math.min(100, Math.max(1, parsePageNumber(searchParams.get('pageSize'), 10)));
    const q = (searchParams.get('q') ?? '').trim().slice(0, 100);
    const wantSummary = searchParams.get('summary') === 'true';

    const emptySummary = { pending: 0, approved: 0, rejected: 0, expired: 0, total: 0 };

    // Org-less super-admin: no business data to list — return an empty page
    // (consistent with the org-less dashboard and the device-claims list).
    if (!scope.organizationId) {
      return NextResponse.json({
        data: [],
        total: 0,
        page,
        pageSize,
        totalPages: 0,
        ...(wantSummary ? { summary: emptySummary } : {}),
      });
    }

    const where: Record<string, unknown> = { organizationId: scope.organizationId };
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { hostname: { contains: q, mode: 'insensitive' } },
        { deviceName: { contains: q, mode: 'insensitive' } },
        { employee: { firstName: { contains: q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: q, mode: 'insensitive' } } },
        { employee: { employeeId: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [registrations, total, summaryRows] = await Promise.all([
      db.agentRegistration.findMany({
        where,
        // Never include the full employee row — it carries agentPassword.
        include: {
          employee: { select: SAFE_EMPLOYEE_SELECT },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.agentRegistration.count({ where }),
      wantSummary
        ? db.agentRegistration.groupBy({
            by: ['status'],
            where: { organizationId: scope.organizationId },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{ status: string; _count: { _all: number } }>),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    const summary: Record<string, number> = { ...emptySummary };
    for (const row of summaryRows) {
      if (row.status in summary) summary[row.status] = row._count._all;
    }
    summary.total = summary.pending + summary.approved + summary.rejected + summary.expired;

    return NextResponse.json({
      data: registrations,
      total,
      page,
      pageSize,
      totalPages,
      ...(wantSummary ? { summary } : {}),
    });
  } catch (error) {
    log.error('api.agent-registrations.', { error: String('AgentRegistrations GET error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to fetch agent registrations' },
      { status: 500 }
    );
  }
}