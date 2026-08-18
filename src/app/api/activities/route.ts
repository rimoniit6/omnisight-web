'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, validatePagination } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { isValidTimezone, zonedDayStart, zonedDayEnd } from '@/lib/timezone';

// GET /api/activities
// Organization-scoped activity feed with filters, pagination, search and
// DB-side summary statistics.
//
// Security & integrity:
//   - Organization is derived strictly from the verified session; a client
//     `organizationId` is never accepted.
//   - `employeeId` is ANDed with the employee's organization (foreign ids
//     return zero rows, never another org's data).
//   - Internal-agent processes are excluded with the NULL-safe filter — NULL
//     applicationName rows (all website/idle/screenshot/work_session rows) are
//     preserved; only actual internal agent processes are hidden.
//   - Pagination/dates are validated (400/422) BEFORE any query runs; pageSize
//     is capped so no unbounded query is possible.
//   - `summary` is a DB-side aggregation over the FULL matching dataset
//     (never the current page), so the UI stat cards are truthful totals.
//
// Date semantics (org-local): `from` is the start of the selected local day,
// `to` is the end of the selected local day (inclusive) — same convention as
// the employee-detail route and the dashboard's org-local daily buckets.

const ACTIVITY_TYPES = ['application', 'website', 'idle', 'screenshot', 'work_session'] as const;
const ACTIVITY_CATEGORIES = ['productive', 'neutral', 'unproductive', 'idle'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SEARCH_LENGTH = 100;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: activities are organization-scoped from the verified
    // session — never from client input. Org-less super_admins get an empty
    // payload (bootstrap state).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        data: [], total: 0, page: 1, pageSize: 15, totalPages: 0,
        summary: { total: 0, totalDuration: 0, productiveTime: 0, neutralTime: 0, unproductiveTime: 0 },
      });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);

    // ── Pagination (strict, capped) ────────────────────────────────────────
    const pagination = validatePagination(searchParams, { defaultPageSize: 15, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    // ── Filters (validated before any query) ──────────────────────────────
    const employeeId = searchParams.get('employeeId') || undefined;
    const type = searchParams.get('type') || undefined;
    if (type && !(ACTIVITY_TYPES as readonly string[]).includes(type)) {
      return NextResponse.json({ error: `Invalid type. Allowed: ${ACTIVITY_TYPES.join(', ')}` }, { status: 422 });
    }
    const category = searchParams.get('category') || undefined;
    if (category && !(ACTIVITY_CATEGORIES as readonly string[]).includes(category)) {
      return NextResponse.json({ error: `Invalid category. Allowed: ${ACTIVITY_CATEGORIES.join(', ')}` }, { status: 422 });
    }

    const dateFrom = searchParams.get('dateFrom') || searchParams.get('from') || undefined;
    const dateTo = searchParams.get('dateTo') || searchParams.get('to') || undefined;
    if (dateFrom && !isIsoDate(dateFrom)) {
      return NextResponse.json({ error: 'Invalid dateFrom. Use YYYY-MM-DD.' }, { status: 422 });
    }
    if (dateTo && !isIsoDate(dateTo)) {
      return NextResponse.json({ error: 'Invalid dateTo. Use YYYY-MM-DD.' }, { status: 422 });
    }

    const search = (searchParams.get('search') || '').trim().slice(0, MAX_SEARCH_LENGTH) || undefined;

    // ── Organization-local day boundaries ──────────────────────────────────
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
    const orgTz = org?.timezone && isValidTimezone(org.timezone) ? org.timezone : 'UTC';

    // ── Where (org-scoped, NULL-safe exclusion, validated filters) ────────
    // The NULL-safe exclusion is composed under explicit AND so the search OR
    // can never overwrite it (both carry an `OR` key).
    const where: Record<string, unknown> = {
      // Activity has no direct organizationId — scope via the employee relation.
      // Internal agent processes are excluded with the NULL-safe predicate
      // (NULL applicationName rows are KEPT — websites/idle/screenshots/sessions).
      employee: { organizationId: orgId },
      AND: [NON_INTERNAL_AGENT_ACTIVITY_FILTER],
    };
    if (employeeId) where.employeeId = employeeId;
    if (type) where.type = type;
    if (category) where.category = category;
    if (dateFrom || dateTo) {
      const ts: Record<string, unknown> = {};
      if (dateFrom) ts.gte = zonedDayStart(dateFrom, orgTz);
      if (dateTo) ts.lte = zonedDayEnd(dateTo, orgTz);
      where.timestamp = ts;
    }
    if (search) {
      (where.AND as unknown[]).push({
        OR: [
          { employee: { firstName: { contains: search, mode: 'insensitive' } } },
          { employee: { lastName: { contains: search, mode: 'insensitive' } } },
          { applicationName: { contains: search, mode: 'insensitive' } },
          { title: { contains: search, mode: 'insensitive' } },
          { url: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    // ── Rows + total + full-dataset summary (DB-side, one round-trip set) ──
    const [activities, total, summaryAgg] = await Promise.all([
      db.activity.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          device: { select: { id: true, name: true } },
        },
        orderBy: { timestamp: 'desc' },
        skip,
        take: pageSize,
      }),
      db.activity.count({ where }),
      db.activity.aggregate({
        where,
        _count: { id: true },
        _sum: { duration: true },
      }),
    ]);

    const categoryAgg = await Promise.all(
      ACTIVITY_CATEGORIES.filter((c) => c !== 'idle').map((c) =>
        db.activity.aggregate({ where: { ...where, category: c }, _sum: { duration: true } })
      )
    );

    const totalPages = Math.ceil(total / pageSize);
    return NextResponse.json({
      data: activities,
      total,
      page,
      pageSize,
      totalPages,
      summary: {
        total: summaryAgg._count.id,
        totalDuration: summaryAgg._sum.duration || 0,
        productiveTime: categoryAgg[0]._sum.duration || 0,
        neutralTime: categoryAgg[1]._sum.duration || 0,
        unproductiveTime: categoryAgg[2]._sum.duration || 0,
      },
    });
  } catch (error) {
    console.error('Activities GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch activities' }, { status: 500 });
  }
}
