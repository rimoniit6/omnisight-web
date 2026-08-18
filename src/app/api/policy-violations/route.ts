import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, validatePagination } from '@/lib/api';
import type { Prisma } from '@prisma/client';

const MAX_SEARCH_LENGTH = 100;

// GET /api/policy-violations — List org-scoped enforcement events.
// Tenant isolation: organization comes ONLY from the verified session.
// Strict pagination: malformed page/pageSize -> 422 (never NaN to Prisma).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }

    const severity = searchParams.get('severity') || '';
    const search = (searchParams.get('search') || '').trim();
    if (severity && !['low', 'medium', 'high', 'critical'].includes(severity)) {
      return NextResponse.json({ error: 'severity must be low, medium, high or critical' }, { status: 422 });
    }
    if (search.length > MAX_SEARCH_LENGTH) {
      return NextResponse.json({ error: `search must be at most ${MAX_SEARCH_LENGTH} characters` }, { status: 422 });
    }

    const where: Prisma.PolicyViolationWhereInput = { organizationId: orgId };
    if (severity) where.severity = severity;
    if (search) where.executableName = { contains: search };

    const [rows, total, summaryRows] = await Promise.all([
      db.policyViolation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
      db.policyViolation.count({ where }),
      // Summary counts via DB-side aggregation — never loaded into memory.
      db.policyViolation.groupBy({
        by: ['severity'],
        where: { organizationId: orgId },
        _count: { _all: true },
      }),
    ]);

    // Every violation row has action 'blocked' — the blocked count equals the
    // total. Severity distribution comes from the DB-side groupBy (no large
    // dataset loaded into memory).
    const summary = { total: 0, blocked: 0, low: 0, medium: 0, high: 0, critical: 0 };
    for (const s of summaryRows) {
      const count = s._count._all;
      summary.total += count;
      if (s.severity === 'low') summary.low += count;
      if (s.severity === 'medium') summary.medium += count;
      if (s.severity === 'high') summary.high += count;
      if (s.severity === 'critical') summary.critical += count;
    }
    summary.blocked = summary.total;

    return NextResponse.json({
      data: rows,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(total / pagination.pageSize),
      summary,
    });
  } catch (error) {
    console.error('Policy violations GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch policy violations' }, { status: 500 });
  }
}
