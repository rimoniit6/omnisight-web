import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authError, requireManagerOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { safeTimezone, localDayKey, addDaysToKey } from '@/lib/timezone';

// GET /api/workday-summaries — read the org's daily rollups.
// Org scope is derived from the VERIFIED session (requireManagerOrg), never
// from client input. Optional query params:
//   from, to   — org-local day keys (YYYY-MM-DD). Defaults to the trailing 7
//                local days ending today (in the ORG timezone). Range is
//                bounded to 90 days (the product reporting window).
//   employeeId — restrict to one employee (validated to belong to the org;
//                a foreign employee id → 404, never an empty cross-org leak).
// Response is bounded (take, max 500) and ordered newest-first; per-employee
// ranges used by dashboards/reports are small (≤ 90 rows), so no cursor
// pagination is needed for the supported surface.

const MAX_READ_RANGE_DAYS = 90;
const MAX_TAKE = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDayKey(v: string | null): v is string {
  if (!v || !DAY_RE.test(v)) return false;
  const t = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

export async function GET(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const org = await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
    const tz = safeTimezone(org?.timezone ?? 'UTC');
    const todayKey = localDayKey(new Date(), tz);

    const rawFrom = req.nextUrl.searchParams.get('from');
    const rawTo = req.nextUrl.searchParams.get('to');
    const rawEmployeeId = req.nextUrl.searchParams.get('employeeId');

    let fromKey = rawFrom;
    let toKey = rawTo;
    if (!fromKey && !toKey) {
      toKey = todayKey;
      fromKey = addDaysToKey(todayKey, -6);
    }
    if (!validDayKey(fromKey) || !validDayKey(toKey)) {
      return NextResponse.json(
        { error: 'from/to must be YYYY-MM-DD day keys' },
        { status: 422 }
      );
    }
    if (fromKey > toKey) {
      return NextResponse.json(
        { error: 'from must not be after to' },
        { status: 422 }
      );
    }
    // Bounded range — string math is safe for zero-padded ISO keys.
    const rangeDays = Math.round((Date.parse(`${toKey}T00:00:00.000Z`) - Date.parse(`${fromKey}T00:00:00.000Z`)) / 86_400_000) + 1;
    if (rangeDays > MAX_READ_RANGE_DAYS) {
      return NextResponse.json(
        { error: `Range exceeds the ${MAX_READ_RANGE_DAYS}-day reporting window` },
        { status: 422 }
      );
    }

    const where: Prisma.WorkDaySummaryWhereInput = { organizationId: orgId, workDate: { gte: fromKey, lte: toKey } };
    if (rawEmployeeId) {
      const employee = await db.employee.findFirst({
        where: { id: rawEmployeeId, organizationId: orgId },
        select: { id: true },
      });
      if (!employee) {
        return NextResponse.json({ error: 'Employee not found in this organization' }, { status: 404 });
      }
      where.employeeId = rawEmployeeId;
    }

    const takeRaw = Number(req.nextUrl.searchParams.get('take') ?? '200');
    const take = Number.isFinite(takeRaw) && takeRaw > 0 ? Math.min(takeRaw, MAX_TAKE) : 200;
    const summaries = await db.workDaySummary.findMany({
      where,
      orderBy: [{ workDate: 'desc' }, { employeeId: 'asc' }],
      take: Number.isFinite(take) && take > 0 ? take : 200,
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });

    return NextResponse.json({ data: summaries });
  } catch {
    log.error('api.workday-summaries.', { error: String('Work day summary GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch work day summaries' }, { status: 500 });
  }
}
